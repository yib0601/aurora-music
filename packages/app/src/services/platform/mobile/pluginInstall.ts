/**
 * 插件的安装 / 卸载（移动端）。
 *
 * ## 与桌面端的关系：同一套纪律，不同的原语
 *
 * 桌面端走主进程 IPC（`pluginInstall.ts`），移动端没有独立主进程 ——
 * 插件注册表就在 WebView 进程里，落盘走 `@capacitor/filesystem`，
 * 下载走 `CapacitorHttp`（原生 HTTP，不受 CORS 约束）。
 * 所以两条链路**不能共用代码**，但必须共用纪律：
 *
 * - 安装前完成全部校验（清单结构 / id 冲突 / 权限 / 主机白名单）
 * - 内容哈希按原始字节算，装完后每次启动核对
 * - B 档脚本安装时拉取并落盘，运行期不回源
 * - 一个坏插件不让其余插件消失
 *
 * 这些纪律的可验证部分已经沉在 shared 的纯函数里（`validatePluginManifest`、
 * `canInstall`、`mountInstalled`），本文件只负责 I/O 与顺序。
 *
 * ## 移动端特有的两个约束
 *
 * 1. **没有"选本地文件"**：Capacitor 的文件选择需要额外的原生插件，
 *    而"填一个网址"已覆盖绝大多数场景。所以移动端只提供 URL 安装。
 * 2. **下载体积上限更紧**（清单 1 MiB / 脚本 4 MiB，与桌面端同数值）：
 *    手机流量与内存都不该被一份失控的响应拖垮；超过即拒绝。
 */

import { CapacitorHttp } from '@capacitor/core'
import {
  buildPluginCatalog,
  canInstall,
  installManifestIntoRuntime,
  mountInstalled,
  removeManifestFromRuntime,
  type ManifestIssue,
  type PluginCatalogEntry,
  type PluginInstallRecord,
  type PluginInstallResult,
  TRUSTED_PLUGIN_KEYS,
  hexToBytes,
  verifyManifestSignature,
} from '@aurora/shared'
import {
  parseManifestText,
  removeInstalledPlugin,
  scanInstalledPlugins,
  sha256OfBytes,
  writeInstalledPlugin,
} from './pluginStore'

/** 清单体积上限（与桌面端同一数值：声明文件，正常只有几 KB） */
const MAX_MANIFEST_BYTES = 1024 * 1024
/** 脚本体积上限（与桌面端同一数值：脚本是正经 JS 程序） */
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024
/** 单次下载预算 */
const DOWNLOAD_TIMEOUT_MS = 20000

/** 安装进行中标记（防连点重入：安装是"下载 → 校验 → 写盘 → 注册"的串行流程） */
let installing = false

/**
 * 用原生 HTTP 拉一个文本资源。
 *
 * 为什么不用 `fetch`：WebView 的 fetch 受 CORS 约束，而插件清单常常托管在
 * 不返回 `Access-Control-Allow-Origin` 的静态服务上（GitHub Raw 就是典型）。
 * `CapacitorHttp` 走原生网络栈，不受同源策略限制 —— 这与封面/歌源请求选它的理由一致。
 */
async function fetchText(
  url: string,
  headers: Record<string, string> | undefined,
  maxBytes: number
): Promise<{ text: string; sha256: string }> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('AURORA_PLUGIN_BAD_URL')
  }
  const response = await CapacitorHttp.get({
    url,
    headers: headers || {},
    // 让原生层按文本读回来：二进制清单没有意义（清单是 JSON）
    responseType: 'text',
    connectTimeout: DOWNLOAD_TIMEOUT_MS,
    readTimeout: DOWNLOAD_TIMEOUT_MS,
  })

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`AURORA_PLUGIN_DOWNLOAD_HTTP_STATUS:{status:${response.status}}`)
  }

  // `data` 可能是字符串，也可能被解析成对象（原生层会按 content-type 试探）
  const text =
    typeof response.data === 'string'
      ? response.data
      : response.data == null
        ? ''
        : JSON.stringify(response.data)

  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength > maxBytes) {
    throw new Error(`AURORA_PLUGIN_TOO_LARGE:{size:${bytes.byteLength},limit:${maxBytes}}`)
  }
  if (!text.trim()) {
    throw new Error('AURORA_PLUGIN_EMPTY_BODY')
  }
  return { text, sha256: await sha256OfBytes(bytes) }
}

/**
 * Ed25519 验签（WebCrypto）。
 *
 * raw 32 字节公钥要包成 SPKI DER 才能被 `importKey` 接受 —— 前缀与桌面端
 * （node:crypto 那条）**必须一致**，否则同一个签名在两端结论会不一样。
 * 这个前缀不是可选项：它是 ASN.1 里 Ed25519 的固定编码头（OID 1.3.101.112）。
 *
 * 运行环境不支持 Ed25519 时**抛错**而不是返回 false：调用方据此走 invalid 分支拒绝安装。
 * 理由见 `performInstall` 里那段注释 —— 不能把"验不了"当成"没签名"。
 */
async function verifyEd25519WebCrypto(
  sigHex: string,
  publicKeyHex: string,
  message: string
): Promise<boolean> {
  const keyBytes = hexToBytes(publicKeyHex)
  if (!keyBytes || keyBytes.length !== 32) return false
  const sigBytes = hexToBytes(sigHex)
  if (!sigBytes || sigBytes.length !== 64) return false

  const prefix = hexToBytes('302a300506032b6570032100')
  if (!prefix) return false
  const spki = new Uint8Array(prefix.length + keyBytes.length)
  spki.set(prefix, 0)
  spki.set(keyBytes, prefix.length)

  const key = await crypto.subtle.importKey('spki', spki, { name: 'Ed25519' }, false, ['verify'])
  return crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    sigBytes as unknown as ArrayBuffer,
    new TextEncoder().encode(message)
  )
}

/**
 * 执行一次安装。
 *
 * 顺序与桌面端逐条对齐（见 `pluginInstall.performInstall` 的注释）：
 * 校验 → 冲突检查 → B 档脚本拉取 → 写盘 → 注册。
 * 任何一步失败都**不留半成品**。
 */
export async function performInstall(input: {
  manifestText: string
  origin: string
  locale?: string
}): Promise<PluginInstallResult> {
  // 1) 内容哈希（按原始文本字节）
  const manifestBytes = new TextEncoder().encode(input.manifestText)
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    return { ok: false, message: 'AURORA_PLUGIN_TOO_LARGE', issues: [] }
  }
  const sha256 = await sha256OfBytes(manifestBytes)

  // 2) 结构校验
  const parsed = parseManifestText(input.manifestText, input.origin)
  if (!parsed.ok) {
    return { ok: false, message: parsed.message, issues: parsed.issues }
  }
  const manifest = parsed.manifest

  // 3) 冲突检查（安装期就挡下，不能依赖注册期的"替换实现"语义）
  const allowed = canInstall(manifest)
  if (!allowed.ok) {
    return {
      ok: false,
      message: allowed.code === 'builtin' ? 'AURORA_PLUGIN_BUILTIN_ID' : 'AURORA_PLUGIN_DUPLICATE_ID',
      issues: [{ path: 'id', code: 'duplicate', value: manifest.id }],
    }
  }

  // 3.5) 签名校验（Ed25519）
  //
  // 与桌面端同一语义：未签名放行；签名者不在信任表放行但标注；
  // **签名存在且校验失败必须拒绝**。
  //
  // 移动端的 WebCrypto 对 Ed25519 的支持随系统 WebView 版本变化：
  // 不支持时 `verify` 会抛错 → 走 invalid 分支 → 拒绝安装。
  // 这个方向是刻意选的：**不能**把"验不了"当成"没签名"放过去，
  // 那会让"给手机装个签名插件"变成绕过校验的路径。
  if (manifest.signature) {
    const verdict = await verifyManifestSignature(manifest, {
      trustedKeys: TRUSTED_PLUGIN_KEYS,
      verify: verifyEd25519WebCrypto,
    })
    if (verdict.status === 'invalid') {
      return { ok: false, message: 'AURORA_PLUGIN_SIGNATURE_INVALID', issues: [] }
    }
  }

  // 4) B 档：先把脚本拉下来再落盘（失败则整次安装失败）
  let scriptBody: string | null = null
  if (manifest.script) {
    try {
      const fetched = await fetchText(manifest.script.url, manifest.script.headers, MAX_SCRIPT_BYTES)
      const declared = manifest.script.sha256?.toLowerCase()
      if (declared && declared !== fetched.sha256) {
        return { ok: false, message: 'AURORA_PLUGIN_SCRIPT_HASH_MISMATCH_REQUESTED', issues: [] }
      }
      scriptBody = fetched.text
    } catch (err) {
      return { ok: false, message: describeFetchError(err), issues: [] }
    }
  }

  // 5) 落盘
  const record: PluginInstallRecord = {
    id: manifest.id,
    version: manifest.version,
    sha256,
    installedAt: Date.now(),
    origin: input.origin,
  }
  await writeInstalledPlugin(manifest, input.manifestText, record, scriptBody)

  // 6) 注册进运行期（含脚本正文，装完立即可用，不必重启）
  mountInstalled({
    plugins: [
      {
        manifest,
        record,
        path: '',
        ...(scriptBody === null ? {} : { scriptBody }),
      },
    ],
    broken: [],
  })
  installManifestIntoRuntime(manifest)

  const entries = await listCatalogEntries(input.locale ?? 'zh-CN')
  return {
    ok: true,
    entry: entries.entries.find((entry) => entry.id === manifest.id && entry.provenance === 'installed'),
  }
}

/** 从网址安装 */
export async function installFromUrl(
  url: string,
  locale = 'zh-CN'
): Promise<PluginInstallResult> {
  if (installing) return { ok: false, message: 'AURORA_PLUGIN_BUSY', issues: [] }
  const text = String(url || '').trim()
  if (!text) return { ok: false, message: 'AURORA_PLUGIN_BAD_URL', issues: [] }

  installing = true
  try {
    const fetched = await fetchText(text, undefined, MAX_MANIFEST_BYTES)
    return await performInstall({ manifestText: fetched.text, origin: text, locale })
  } catch (err) {
    return { ok: false, message: describeFetchError(err), issues: [] }
  } finally {
    installing = false
  }
}

/** 卸载：先摘运行期实现，再删磁盘目录（顺序与桌面端一致，理由见那边注释） */
export async function performUninstall(
  pluginId: string,
  locale = 'zh-CN'
): Promise<PluginInstallResult> {
  const removed = removeManifestFromRuntime(pluginId)
  if (!removed) return { ok: false, message: 'AURORA_PLUGIN_NOT_INSTALLED', issues: [] }
  await removeInstalledPlugin(pluginId)
  void locale
  return { ok: true }
}

/** 组装插件目录（内置 + 已安装 + 坏文件） */
export async function listCatalogEntries(locale = 'zh-CN'): Promise<{
  entries: PluginCatalogEntry[]
  broken: Array<{ path: string; message?: string }>
}> {
  const scan = await scanInstalledPlugins()
  return {
    entries: buildPluginCatalog(scan.plugins, locale),
    broken: scan.broken.map((item) => ({ path: item.path, message: item.message })),
  }
}

/**
 * 启动时挂载磁盘上的全部已安装插件。
 *
 * 必须在 UI 首帧之前调用：否则渲染层第一次问插件目录时是空的，
 * 过一会儿插件才"自己冒出来"。逐条容错（`mountInstalled` 的职责）。
 */
export async function mountInstalledPlugins(): Promise<{ mounted: string[]; broken: number }> {
  let scan
  try {
    scan = await scanInstalledPlugins()
  } catch (err) {
    // 扫盘失败（权限 / 存储异常）不该阻止应用启动
    console.error('[plugin] 扫描插件目录失败:', err)
    return { mounted: [], broken: 0 }
  }
  const result = mountInstalled(scan)
  if (result.mounted.length > 0) {
    console.log(`[plugin] 已挂载 ${result.mounted.length} 个已安装插件:`, result.mounted.join(', '))
  }
  if (scan.broken.length > 0) {
    console.warn(`[plugin] ${scan.broken.length} 个插件文件无法加载:`)
    for (const item of scan.broken) console.warn('  -', item.path, item.message || '')
  }
  for (const item of result.skipped) {
    console.warn(`[plugin] 已跳过插件 ${item.id}: ${item.reason}`)
  }
  return { mounted: result.mounted, broken: scan.broken.length }
}

/** 下载/校验失败 → 可归因的原因码（渲染层据此翻文案，不在本层烧中文） */
function describeFetchError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  // 已知的结构化码原样透出；其余是网络层原文（原样带出，不吞技术细节）
  if (text.startsWith('AURORA_PLUGIN_')) return text
  return `AURORA_PLUGIN_DOWNLOAD_FAILED:{reason:${text}}`
}

/** 供测试重置"安装中"标记（真实流程里它由 finally 保证复位） */
export function resetInstallingFlagForTest(): void {
  installing = false
}

export type { ManifestIssue }
