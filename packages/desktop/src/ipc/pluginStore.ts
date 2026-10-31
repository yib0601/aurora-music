/**
 * 已安装插件的落盘层（主进程唯一的文件 I/O 入口）。
 *
 * ## 目录布局
 *
 * `<userData>/aurora-music/plugins/<pluginId>/`
 *   ├── manifest.json     作者写的清单（**逐字节**保存，哈希按它的字节算）
 *   └── install.json      本机写的安装记录（sha256 / 安装时间 / 来源）
 *
 * 为什么一个插件一个目录而不是三个平铺目录：卸载 = 删一个目录（`fs.rm(recursive)`），
 * 不会留下"清单删了但安装记录还在"的孤儿文件。这一点在真实卸载路径上很重要 ——
 * 孤儿记录会让插件在下次启动时"复活"，而用户明明已经点过卸载。
 *
 * ## 为什么哈希按**文件字节**算，而不是规范化后的 JSON
 *
 * 「URL 钉的是地址，不是内容」是插件供应链里最根本的问题（见 docs/plugins.md）：
 * 仓库可以 force-push、分支每天前进。所以安装记录里必须存一份能复现的内容指纹。
 * 若按"解析后重新序列化"的 JSON 算哈希，作者改一个缩进或键序就会让哈希变，
 * 而他其实没改任何语义 —— 那等于逼作者用我们的格式化工具，且第三方工具无法复现。
 *
 * 按原始字节算 + 校验时按同一份字节算，是唯一能被任意第三方工具复现的做法。
 *
 * ## 边界
 *
 * 本文件**不做**任何业务判断：清单合法性由 shared 的 `validatePluginManifest` 负责，
 * 冲突判定由 `canInstall` 负责，注册由 `registerInstalledPlugin` 负责。
 * 这里只回答"文件里是什么、文件怎么写、磁盘上有什么"。
 */

import { app, net } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { auroraError } from '@aurora/shared'
import type {
  InstalledPlugin,
  InstalledPluginScan,
  ManifestIssue,
  PluginInstallRecord,
  PluginManifest,
} from '@aurora/shared'
import { validatePluginManifest } from '@aurora/shared'

/** 插件根目录（惰性解析：主进程早期 app 尚未 ready 时不能取 userData） */
function pluginsRoot(): string {
  return path.join(app.getPath('userData'), 'aurora-music', 'plugins')
}

/** 单个插件的目录 */
function pluginDir(pluginId: string): string {
  return path.join(pluginsRoot(), pluginId)
}

/**
 * 插件 id → 目录名前的校验。
 *
 * id 会成为路径的一段，**必须**在拼接前挡掉 `..` / 分隔符 / 绝对路径。
 * 清单校验期已经用 `PLUGIN_ID_PATTERN` 验过，这里是对"磁盘内容被人手改过"
 * 与"IPC 入参来自渲染层"这两种情况的二次防线：路径穿越的后果是删掉任意目录。
 */
function safePluginId(pluginId: unknown): string {
  if (typeof pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(pluginId)) {
    throw auroraError('desktop.error.plugin.invalidId', { id: String(pluginId ?? '') })
  }
  return pluginId
}

/** 计算一段字节的 sha256（小写 hex） */
export function sha256OfBytes(bytes: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

/**
 * 读取本地文件字节。
 *
 * 大小上限 1 MiB：清单是一份声明（端点 + 字段映射），正常只有几 KB。
 * 允许 1 MiB 是给"作者塞了详细说明/多语言文案"留余量，同时挡住
 * "拿一个 GB 级文件当插件装"这种把主进程卡死的输入。
 */
const MAX_MANIFEST_BYTES = 1024 * 1024

export function readManifestBytes(filePath: string): Buffer {
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) {
    throw auroraError('desktop.error.plugin.manifestNotFile', { path: filePath })
  }
  if (stat.size > MAX_MANIFEST_BYTES) {
    throw auroraError('desktop.error.plugin.manifestTooLarge', {
      size: stat.size,
      limit: MAX_MANIFEST_BYTES,
    })
  }
  return fs.readFileSync(filePath)
}

/**
 * 从字节解析清单：先按 UTF-8 解码，再 JSON.parse，再 schema 校验。
 *
 * 三步各自的失败原因都要保留下来（用户看到的是"这个文件哪里不对"，
 * 而不是笼统的"安装失败"）：
 * - 非 UTF-8 → 编码问题
 * - 非 JSON   → 语法问题（错误信息里带 JSON.parse 的位置）
 * - 结构不对  → 逐条 issues
 */
export function parseManifestBytes(
  bytes: Buffer,
  sourceLabel: string
): { ok: true; manifest: PluginManifest } | { ok: false; message: string; issues: ManifestIssue[] } {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return {
      ok: false,
      message: `AURORA_PLUGIN_NOT_UTF8:${sourceLabel}`,
      issues: [],
    }
  }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    return {
      ok: false,
      message: `AURORA_PLUGIN_BAD_JSON:${sourceLabel}:${err instanceof Error ? err.message : String(err)}`,
      issues: [],
    }
  }

  const validation = validatePluginManifest(json)
  if (!validation.ok) {
    return { ok: false, message: 'AURORA_PLUGIN_INVALID_MANIFEST', issues: validation.issues }
  }
  return { ok: true, manifest: validation.manifest }
}

/**
 * 下载一份清单（用于「从 URL 安装」）。
 *
 * 两个刻意的约束：
 * 1. **只接受 http(s)**：`file://` 或别的协议不该能从 UI 触发（本地文件走"选文件"那条路）。
 * 2. **限制大小与超时**：远程清单是第三方内容，一个永不结束的响应会把安装流程挂死。
 *    `net.fetch` 用 Electron 的 Node 网络栈，因此不受渲染层 CORS 约束，
 *    也不会带 Origin（参考 `pluginHost.ts` 里汽水插件的实测结论）。
 */
const DOWNLOAD_TIMEOUT_MS = 15000

export async function downloadManifest(url: string): Promise<Buffer> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw auroraError('desktop.error.plugin.badUrl', { url })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw auroraError('desktop.error.plugin.badUrl', { url })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await net.fetch(parsed.href, {
      signal: controller.signal,
      // 不跟随到非 http(s)：本函数的协议校验只覆盖第一跳
      redirect: 'follow',
    })
    if (!response.ok) {
      throw auroraError('desktop.error.plugin.downloadHttpStatus', { status: response.status })
    }
    const length = Number(response.headers.get('content-length') || 0)
    if (length > MAX_MANIFEST_BYTES) {
      throw auroraError('desktop.error.plugin.manifestTooLarge', {
        size: length,
        limit: MAX_MANIFEST_BYTES,
      })
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > MAX_MANIFEST_BYTES) {
      // content-length 可能缺失或撒谎：读完之后再判一次
      throw auroraError('desktop.error.plugin.manifestTooLarge', {
        size: buffer.byteLength,
        limit: MAX_MANIFEST_BYTES,
      })
    }
    return buffer
  } catch (err) {
    if (controller.signal.aborted) {
      throw auroraError('desktop.error.plugin.downloadTimeout', { ms: DOWNLOAD_TIMEOUT_MS })
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把清单写到磁盘（原子写）。
 *
 * 先写临时目录再 `rename`：进程在写一半时崩掉，不会留下一个"目录存在但清单是半截"
 * 的插件。半截清单在下次启动时会被扫描判成 broken，用户看到的是一个莫名其妙的
 * 坏插件条目 —— 而真实原因是上次安装没写完。
 *
 * @returns 落盘后的清单路径
 */
export function writeInstalledPlugin(
  manifest: PluginManifest,
  bytes: Buffer,
  record: PluginInstallRecord,
  /** B 档脚本的源码（已拉取的那一份）。有脚本块的插件必须给，否则运行期回源没有备用 */
  scriptBody?: string | null
): string {
  const id = safePluginId(manifest.id)
  const dir = pluginDir(id)
  const staging = `${dir}.tmp-${process.pid}-${Date.now()}`

  fs.mkdirSync(staging, { recursive: true, mode: 0o700 })
  try {
    fs.writeFileSync(path.join(staging, 'manifest.json'), bytes, { mode: 0o600 })
    fs.writeFileSync(path.join(staging, 'install.json'), JSON.stringify(record, null, 2), {
      mode: 0o600,
    })
    // B 档脚本：**正文落盘，运行期只读本地副本**。
    // 不落盘就等于每次播放都回源拉一次 —— 用户确认过的代码会在下次播放时变成别的东西
    // （仓库可以 force-push、分支每天前进），那是供应链攻击最省事的形式。
    if (typeof scriptBody === 'string' && scriptBody.trim()) {
      fs.writeFileSync(path.join(staging, 'script.js'), scriptBody, { mode: 0o600 })
    }
    // 已存在时先删除（重装 / 修复路径）；rm 是幂等的
    fs.rmSync(dir, { recursive: true, force: true })
    fs.renameSync(staging, dir)
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw err
  }
  return path.join(dir, 'manifest.json')
}

/** 读取某插件已落盘的脚本文本；没有（或读不出）返回 null */
export function readInstalledScript(pluginId: string): string | null {
  try {
    return fs.readFileSync(path.join(pluginDir(safePluginId(pluginId)), 'script.js'), 'utf8')
  } catch {
    return null
  }
}

/**
 * 校验磁盘上那份清单的字节哈希是否仍与安装记录一致。
 *
 * 这是"内容哈希钉死"的落点：用户装的时候是这一份字节，之后每次启动都核对。
 * 不一致说明文件被改过（作者更新了 / 别的东西写入了），**必须拒绝加载**并让用户
 * 重新确认 —— 悄悄加载一份内容变了的第三方插件，正是这条约束要防的事。
 */
export function verifyInstalledBytes(
  manifestPath: string,
  record: PluginInstallRecord
): { ok: true; bytes: Buffer } | { ok: false; actual: string; expected: string } {
  const bytes = readManifestBytes(manifestPath)
  const actual = sha256OfBytes(bytes)
  if (actual !== record.sha256) {
    return { ok: false, actual, expected: record.sha256 }
  }
  return { ok: true, bytes }
}

/** 读安装记录（不存在或格式不对返回 null，由调用方按"坏目录"处理） */
export function readInstallRecord(recordPath: string): PluginInstallRecord | null {
  try {
    const raw = fs.readFileSync(recordPath, 'utf8')
    const json = JSON.parse(raw) as Partial<PluginInstallRecord>
    if (
      typeof json?.id !== 'string' ||
      typeof json.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(json.sha256)
    ) {
      return null
    }
    return {
      id: json.id,
      version: typeof json.version === 'string' ? json.version : '',
      sha256: json.sha256,
      installedAt: typeof json.installedAt === 'number' ? json.installedAt : 0,
      origin: typeof json.origin === 'string' ? json.origin : '',
    }
  } catch {
    return null
  }
}

/**
 * 扫描插件目录。
 *
 * 容错原则：**一个坏目录不能让整次扫描失败**。否则用户会遇到最不可解释的一种现象 ——
 * "我装了三个插件，重启后全都消失了"，而真实原因只是其中一个文件写坏了。
 * 坏条目进 `broken`，其余照常返回。
 */
export function scanInstalledPlugins(): InstalledPluginScan {
  const root = pluginsRoot()
  const plugins: InstalledPlugin[] = []
  const broken: InstalledPluginScan['broken'] = []

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    // 目录不存在 = 一个插件都没装（首次启动的正常情况）
    return { plugins, broken }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // 原子写的临时目录（`<id>.tmp-...`）不是插件，跳过
    if (entry.name.includes('.tmp-')) continue

    const dir = path.join(root, entry.name)
    const manifestPath = path.join(dir, 'manifest.json')
    const recordPath = path.join(dir, 'install.json')

    const record = readInstallRecord(recordPath)
    if (!record) {
      broken.push({ path: recordPath, issues: [], message: 'AURORA_PLUGIN_RECORD_INVALID' })
      continue
    }

    let bytes: Buffer
    try {
      bytes = readManifestBytes(manifestPath)
    } catch (err) {
      broken.push({
        path: manifestPath,
        issues: [],
        message: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    const actual = sha256OfBytes(bytes)
    if (actual !== record.sha256) {
      // 内容被改过：拒绝加载（这是哈希锁定的意义所在）
      broken.push({
        path: manifestPath,
        issues: [],
        message: `AURORA_PLUGIN_HASH_MISMATCH:{expected:${record.sha256},actual:${actual}}`,
      })
      continue
    }

    const parsed = parseManifestBytes(bytes, manifestPath)
    if (!parsed.ok) {
      broken.push({ path: manifestPath, issues: parsed.issues, message: parsed.message })
      continue
    }

    // 目录名与清单 id 不一致：说明有人手动改过目录名。id 决定注册键与卸载目标，
    // 以**清单里的 id** 为准（那才是作者声明的东西），但要让用户知道这事。
    if (parsed.manifest.id !== entry.name) {
      broken.push({
        path: dir,
        issues: [],
        message: `AURORA_PLUGIN_DIR_MISMATCH:{dir:${entry.name},id:${parsed.manifest.id}}`,
      })
      continue
    }

    // B 档脚本：把已落盘的正文读出来挂到清单旁（运行期由插件用它，不回源）。
    // 缺了也不算坏插件 —— 那种情况 preflight 会给出「脚本不可用」，
    // 用户能据此重新安装，而不是看到整个插件凭空消失。
    const scriptPath = path.join(dir, 'script.js')
    let scriptBody: string | null = null
    try {
      scriptBody = fs.readFileSync(scriptPath, 'utf8')
    } catch {
      scriptBody = null
    }

    // 清单声明了脚本哈希 → 校验落盘脚本的字节。
    // 不一致说明脚本文件被改过（或作者更新了清单里的 sha256 而脚本没跟着换），
    // 必须拒绝加载：这与清单本身的哈希校验是同一条纪律。
    if (parsed.manifest.script && scriptBody !== null) {
      const expected = parsed.manifest.script.sha256
      if (expected) {
        const actual = sha256OfBytes(Buffer.from(scriptBody, 'utf8'))
        if (actual !== expected.toLowerCase()) {
          broken.push({
            path: scriptPath,
            issues: [],
            message: `AURORA_PLUGIN_SCRIPT_HASH_MISMATCH:{expected:${expected.toLowerCase()},actual:${actual}}`,
          })
          continue
        }
      }
    }

    plugins.push({
      manifest: parsed.manifest,
      record,
      path: manifestPath,
      ...(scriptBody === null ? {} : { scriptBody }),
    })
  }

  return { plugins, broken }
}

/** 卸载：删掉整个插件目录（幂等） */
export function removeInstalledPlugin(pluginId: string): void {
  const id = safePluginId(pluginId)
  fs.rmSync(pluginDir(id), { recursive: true, force: true })
}

/** 某插件是否在磁盘上有目录（诊断用；注册状态以 shared 的登记为准） */
export function hasInstalledDir(pluginId: string): boolean {
  try {
    return fs.statSync(pluginDir(safePluginId(pluginId))).isDirectory()
  } catch {
    return false
  }
}

/** 插件根目录绝对路径（供「打开所在目录」用） */
export function installedPluginsRoot(): string {
  return pluginsRoot()
}

/**
 * 拉取 B 档脚本正文（安装时调用一次）。
 *
 * 与 `downloadManifest` 分开而不是共用一个泛型下载器：**上限不同**。
 * 清单是一份声明（几 KB，上限 1 MiB 是宽裕的），而音源脚本是正经的 JS 程序，
 * 打包过的 Liscript 常见几十 KB 到几 MB。共用一个上限要么卡死脚本、要么
 * 让清单校验形同虚设。
 */
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024
const SCRIPT_DOWNLOAD_TIMEOUT_MS = 30000

export async function downloadScriptBody(
  url: string,
  headers?: Record<string, string>
): Promise<{ text: string; sha256: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw auroraError('desktop.error.plugin.badUrl', { url })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw auroraError('desktop.error.plugin.badUrl', { url })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SCRIPT_DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await net.fetch(parsed.href, {
      signal: controller.signal,
      redirect: 'follow',
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    })
    if (!response.ok) {
      throw auroraError('desktop.error.plugin.downloadHttpStatus', { status: response.status })
    }
    const length = Number(response.headers.get('content-length') || 0)
    if (length > MAX_SCRIPT_BYTES) {
      throw auroraError('desktop.error.plugin.manifestTooLarge', {
        size: length,
        limit: MAX_SCRIPT_BYTES,
      })
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > MAX_SCRIPT_BYTES) {
      throw auroraError('desktop.error.plugin.manifestTooLarge', {
        size: buffer.byteLength,
        limit: MAX_SCRIPT_BYTES,
      })
    }
    const text = buffer.toString('utf8')
    if (!text.trim()) {
      // 空脚本装上去等于一个永远取不到址的源：安装期就拒绝，别留给运行期
      throw auroraError('desktop.error.plugin.installFailed', { detail: 'empty script body' })
    }
    return { text, sha256: sha256OfBytes(buffer) }
  } catch (err) {
    if (controller.signal.aborted) {
      throw auroraError('desktop.error.plugin.downloadTimeout', {
        ms: SCRIPT_DOWNLOAD_TIMEOUT_MS,
      })
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
