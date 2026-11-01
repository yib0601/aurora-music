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
  notePluginFailure,
  pluginStartupReport,
  removeManifestFromRuntime,
  type ManifestIssue,
  type PluginCatalogEntry,
  type PluginInstallRecord,
  type PluginInstallResult,
  type PluginStartupReport,
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
 * 最近一次启动挂载的结果（`pluginInstallGateway.startup()` 与启动提示都读它）。
 *
 * 存模块级而不是让调用方自己去挂一遍：移动端没有主进程的 IPC 通道，
 * 启动挂载只在 `main.tsx` 发起一次，UI 需要的是"那一刻的结果"。
 */
let startupReport: PluginStartupReport | null = null

/** 本次启动的插件报告；还没挂载过（如单测直接驱动流程函数）时现算一份 */
export function lastPluginStartupReport(): PluginStartupReport {
  return startupReport ?? pluginStartupReport()
}

/**
 * 启动时挂载磁盘上的全部已安装插件。
 *
 * 必须在 UI 首帧之前调用：否则渲染层第一次问插件目录时是空的，
 * 过一会儿插件才"自己冒出来"。逐条容错（`mountInstalled` 的职责）。
 *
 * **绝不抛错**：调用方是 `main.tsx` 顶层的 fire-and-forget，抛出去只会变成一条
 * unhandled rejection；插件坏了不该影响启动。失败由报告交给 UI 提示。
 */
export async function mountInstalledPlugins(): Promise<PluginStartupReport> {
  const report = await collectStartupReport()
  startupReport = report
  return report
}

async function collectStartupReport(): Promise<PluginStartupReport> {
  let scan: Awaited<ReturnType<typeof scanInstalledPlugins>>
  try {
    scan = await scanInstalledPlugins()
  } catch (err) {
    // 扫盘失败（权限 / 存储异常）不该阻止应用启动
    console.error('[plugin] 扫描插件目录失败:', err)
    return pluginStartupReport({ mounted: [], broken: 0 })
  }
  let mounted: string[] = []
  try {
    const result = mountInstalled(scan)
    mounted = result.mounted
    if (result.mounted.length > 0) {
      console.log(`[plugin] 已挂载 ${result.mounted.length} 个已安装插件:`, result.mounted.join(', '))
    }
    for (const item of result.skipped) {
      console.warn(`[plugin] 已跳过插件 ${item.id}: ${item.reason}`)
    }
  } catch (err) {
    // `mountInstalled` 内部已逐条隔离，走到这里是它自身出问题：已安装插件全不可用，
    // 内置插件与本地播放不受影响。
    notePluginFailure('installed', '', err)
    console.error('[plugin] 挂载已安装插件失败:', err)
  }
  if (scan.broken.length > 0) {
    console.warn(`[plugin] ${scan.broken.length} 个插件文件无法加载:`)
    for (const item of scan.broken) console.warn('  -', item.path, item.message || '')
  }
  return pluginStartupReport({ mounted, broken: scan.broken.length })
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
