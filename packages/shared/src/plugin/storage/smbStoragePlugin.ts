/**
 * SMB / CIFS 协议实现（`@marsaud/smb2`）。
 *
 * ## 与 SFTP 同一套注入模式
 *
 * 依赖只装在桌面端，shared 不声明它：桌面端把 SMB2 模块传进来，移动端不传。
 * 理由与 `sftpStoragePlugin.ts` 相同（保持 shared 的 dependencies 干净）。
 *
 * ## SMB 与 HTTP/SFTP 的一个关键差异：**没有 Range**
 *
 * SMB 协议本身按字节偏移读取（`readFile` 支持 offset/length），但 `@marsaud/smb2`
 * 的 `readFile` 是**整文件读进内存**（它内部按块读，但对外一次性返回 Buffer）。
 * 所以：
 *
 * - `openRange` 可以精确实现（读 offset..offset+length 那一段）
 * - `openStream` **无法原样透传** `Range` 头：`bytes=-N`（尾段）需要先知道文件长度，
 *   然后从 `size-N` 读到末尾 —— 这能实现，但结果是"把那段读进内存再返回"，
 *   不是真正的流式。
 *
 * 这意味着大文件（无损音乐动辄 30~80MB）的 seek 会有内存与延迟代价。
 * 如实记录在这里，不假装它是流式的。
 *
 * ## 认证
 *
 * SMB2 支持 NTLM（用户名 + 口令 + 可选域）。访客共享（无凭证）也常见 ——
 * 用户名口令都留空时按 guest 试。
 */

import type { LibrarySourceConfig, RemoteEntry, WalkOptions } from '../../webdav'
import { AUDIO_EXTENSIONS, shouldSkipDir } from '../../webdav'
import type { StoragePlugin, StorageProbeResult } from './types'
import { storageStringField } from './fields'

/**
 * `@marsaud/smb2` 的最小接口（只声明用到的部分）。
 *
 * 与 ssh2 同样的理由：不让 shared 的依赖列表里出现这个包。
 */
export interface Smb2Client {
  readdir(
    path: string,
    callback: (err: Error | null, files?: Smb2FileEntry[]) => void
  ): void
  readFile(
    path: string,
    options: { offset?: number; length?: number },
    callback: (err: Error | null, buffer?: Buffer) => void
  ): void
  stat(path: string, callback: (err: Error | null, stats?: Smb2Stats) => void): void
  exists(path: string, callback: (exists: boolean) => void): void
}

export interface Smb2FileEntry {
  name: string
  birthtime?: Date
  mtime?: Date
  size?: number
  isDirectory?: () => boolean
}

export interface Smb2Stats {
  size?: number
  mtime?: Date
  isDirectory?: () => boolean
}

/** 构造函数：`new SMB2(options)` */
export type Smb2Constructor = new (options: Smb2Options) => Smb2Client

export interface Smb2Options {
  share: string
  domain?: string
  username?: string
  password?: string
  autoCloseTimeout?: number
  debug?: boolean
}

/** 注入点：桌面端启动时注册真实模块（移动端不注册） */
let smb2Module: Smb2Constructor | null = null

export function setSmb2Module(mod: Smb2Constructor | null): void {
  smb2Module = mod
}

/** 当前是否具备 SMB 能力 */
export function smb2Available(): boolean {
  return Boolean(smb2Module)
}

/** 单次操作超时：SMB 在主机不可达时会挂很久 */
const OP_TIMEOUT_MS = 30000

/** 从声明式字段取连接参数 */
function optionsOf(cfg: LibrarySourceConfig): Smb2Options {
  const host = storageStringField(cfg, 'host') || ''
  const shareName = storageStringField(cfg, 'share') || ''
  const port = storageStringField(cfg, 'port')
  // UNC 路径：\\host\share。端口不是标准 SMB 的路径组成部分，
  // 445 是默认端口，显式指定只在非默认端口时拼上（`host:port` 不是标准写法，
  // 但许多实现支持；不支持时会得到一个明确的连接错误而不是静默错库）
  const server = port && port !== '445' ? `${host}:${port}` : host
  return {
    share: `\\\\${server}\\${shareName}`,
    domain: storageStringField(cfg, 'domain') || undefined,
    username: storageStringField(cfg, 'username') || undefined,
    password: storageStringField(cfg, 'password') || undefined,
    autoCloseTimeout: 5000,
  }
}

/** 共享内子目录（用户配的 rootPath），去掉首尾斜杠并统一为正斜杠 */
function rootOf(cfg: LibrarySourceConfig): string {
  const raw = storageStringField(cfg, 'rootPath') || ''
  return raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

/** 相对路径 → SMB 路径（SMB2 用反斜杠） */
export function smbPathOf(cfg: LibrarySourceConfig, relPath: string): string {
  const root = rootOf(cfg)
  const rel = String(relPath || '').replace(/^\/+/, '').replace(/\//g, '\\')
  if (root && rel) return `${root}\\${rel}`
  return root || rel || ''
}

/** 建客户端（不清连接：SMB2 自带 autoCloseTimeout，比手工关更可靠） */
function clientOf(cfg: LibrarySourceConfig): Smb2Client {
  if (!smb2Module) {
    throw new Error('SMB_UNAVAILABLE: the smb2 module is not registered on this platform')
  }
  const options = optionsOf(cfg)
  if (!options.share || options.share === '\\\\\\') {
    throw new Error('SMB_BAD_CONFIG: host and share are required')
  }
  return new smb2Module(options)
}

/** 带超时的回调包装（主机不可达时回调可能永远不来） */
function withTimeout<T>(
  task: (done: (err: Error | null, value?: T) => void) => void,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      reject(new Error(`SMB_TIMEOUT: ${label} took longer than ${OP_TIMEOUT_MS}ms`))
    }, OP_TIMEOUT_MS)
    task((err, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(value as T)
    })
  })
}

/** 是否音频文件（复用 webdav 的扩展名表） */
function isAudioName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return AUDIO_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

/**
 * 递归列举音频文件（与 `walkSftpAudio` / `walkWebdavAudio` 同构）。
 *
 * 并发给 4：SMB 会话对并发请求有上限，而单共享顺序列举在大库上会明显慢。
 */
async function walkSmbAudio(
  cfg: LibrarySourceConfig,
  options: WalkOptions = {}
): Promise<RemoteEntry[]> {
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const maxEntries = options.maxEntries ?? 20000
  const client = clientOf(cfg)
  const out: RemoteEntry[] = []
  const queue: string[] = ['']
  let visited = 0

  const listDir = async (relDir: string): Promise<RemoteEntry[]> => {
    try {
      const files = await withTimeout<Smb2FileEntry[]>((done) => {
        client.readdir(smbPathOf(cfg, relDir), (err, list) => done(err, list))
      }, 'readdir')
      const entries: RemoteEntry[] = []
      for (const item of files || []) {
        const name = String(item.name || '')
        if (!name || name === '.' || name === '..') continue
        const isDir = typeof item.isDirectory === 'function' ? item.isDirectory() : false
        const relPath = relDir ? `${relDir}/${name}` : name
        entries.push({
          path: relPath,
          name,
          isDirectory: isDir,
          size: Number(item.size || 0),
          lastModified: item.mtime instanceof Date ? item.mtime.getTime() : 0,
        })
      }
      return entries
    } catch (err) {
      options.onError?.(relDir, err instanceof Error ? err : new Error(String(err)))
      return []
    }
  }

  while (queue.length > 0 && out.length < maxEntries) {
    if (options.shouldStop?.()) break
    const batch = queue.splice(0, concurrency)
    const results = await Promise.all(batch.map((dir) => listDir(dir)))
    for (const entries of results) {
      for (const entry of entries) {
        visited += 1
        if (visited > maxEntries * 10) break
        if (entry.isDirectory) {
          if (shouldSkipDir(entry.name)) continue
          queue.push(entry.path)
          continue
        }
        if (!isAudioName(entry.name)) continue
        out.push(entry)
        options.onAudio?.(entry)
        if (out.length >= maxEntries) break
      }
      if (out.length >= maxEntries) break
    }
  }

  return out
}

/** 读一段字节（数值区间）—— SMB 的读本身就带 offset/length，能精确实现 */
async function openSmbRange(
  cfg: LibrarySourceConfig,
  relPath: string,
  start: number,
  end: number
): Promise<Response> {
  const client = clientOf(cfg)
  const length = Math.max(0, end - start + 1)
  const buffer = await withTimeout<Buffer>((done) => {
    client.readFile(smbPathOf(cfg, relPath), { offset: start, length }, (err, data) => done(err, data))
  }, 'readFile')
  return new Response(buffer as unknown as BodyInit, {
    status: 206,
    headers: {
      'Content-Length': String(buffer.length),
      'Accept-Ranges': 'bytes',
      'Content-Type': guessType(relPath),
    },
  })
}

/**
 * 打开字节流（Range 透传）。
 *
 * **如实说明：这不是流式**。`@marsaud/smb2` 没有暴露"读一块给我回调一次"的接口，
 * `readFile` 一次性返回 Buffer，所以这里只能把请求的那一段读进内存再包成 Response。
 *
 * 三种 Range 形态都支持（`bytes=a-b` / `bytes=a-` / `bytes=-N`），
 * 代价是大文件 seek 会有内存与延迟开销 —— 见文件头注释。
 */
async function openSmbStream(
  cfg: LibrarySourceConfig,
  relPath: string,
  init: { range?: string } = {}
): Promise<Response> {
  const client = clientOf(cfg)
  const path = smbPathOf(cfg, relPath)
  const range = parseSmbRangeHeader(init.range)

  if (!range) {
    // 无 Range：整文件（与 webdav 的 openStream 行为一致）
    const buffer = await withTimeout<Buffer>((done) => {
      client.readFile(path, {}, (err, data) => done(err, data))
    }, 'readFile')
    return new Response(buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Length': String(buffer.length),
        'Accept-Ranges': 'bytes',
        'Content-Type': guessType(relPath),
      },
    })
  }

  // 有 Range：先 stat 拿总长度（尾段换算是必须的，其余形态也要给出 Content-Range）
  const stats = await withTimeout<Smb2Stats>((done) => {
    client.stat(path, (err, data) => done(err, data))
  }, 'stat')
  const total = Number(stats?.size || 0)

  let start: number
  let end: number
  if (range.kind === 'closed') {
    start = range.start
    end = Math.min(range.end, total > 0 ? total - 1 : range.end)
  } else if (range.kind === 'open') {
    start = range.start
    end = total > 0 ? total - 1 : start
  } else {
    // `bytes=-N`：最后 N 字节
    start = Math.max(0, total - range.length)
    end = Math.max(start, total - 1)
  }
  const length = Math.max(0, end - start + 1)

  const buffer = await withTimeout<Buffer>((done) => {
    client.readFile(path, { offset: start, length }, (err, data) => done(err, data))
  }, 'readFile')

  return new Response(buffer as unknown as BodyInit, {
    status: 206,
    headers: {
      'Content-Range': `bytes ${start}-${start + buffer.length - 1}/${total || '*'}`,
      'Content-Length': String(buffer.length),
      'Accept-Ranges': 'bytes',
      'Content-Type': guessType(relPath),
    },
  })
}

function guessType(relPath: string): string {
  const lower = relPath.toLowerCase()
  if (lower.endsWith('.flac')) return 'audio/flac'
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.m4a') || lower.endsWith('.aac')) return 'audio/mp4'
  if (lower.endsWith('.ogg') || lower.endsWith('.opus')) return 'audio/ogg'
  return 'audio/mpeg'
}

/** 解析 Range 头（与 SFTP 那份语义一致；两处都导出是为了各自可独立测试） */
export function parseSmbRangeHeader(
  value: string | undefined
):
  | { kind: 'closed'; start: number; end: number }
  | { kind: 'open'; start: number }
  | { kind: 'suffix'; length: number }
  | null {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value).trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return null
  if (!rawStart) {
    const length = Number(rawEnd)
    return Number.isFinite(length) && length > 0 ? { kind: 'suffix', length } : null
  }
  const start = Number(rawStart)
  if (!Number.isFinite(start) || start < 0) return null
  if (!rawEnd) return { kind: 'open', start }
  const end = Number(rawEnd)
  if (!Number.isFinite(end) || end < start) return null
  return { kind: 'closed', start, end }
}

/** 字段声明 */
export const SMB_STORAGE_FIELDS = [
  {
    key: 'host',
    labelKey: 'sources.smb.hostLabel',
    kind: 'text',
    required: true,
    placeholderKey: 'sources.smb.hostPlaceholder',
  },
  {
    key: 'share',
    labelKey: 'sources.smb.shareLabel',
    kind: 'text',
    required: true,
    placeholderKey: 'sources.smb.sharePlaceholder',
    hintKey: 'sources.smb.shareHint',
  },
  {
    key: 'port',
    labelKey: 'sources.smb.portLabel',
    kind: 'text',
    placeholderKey: 'sources.smb.portPlaceholder',
  },
  {
    key: 'domain',
    labelKey: 'sources.smb.domainLabel',
    kind: 'text',
    placeholderKey: 'sources.smb.domainPlaceholder',
  },
  {
    key: 'username',
    labelKey: 'sources.smb.usernameLabel',
    kind: 'text',
  },
  {
    key: 'password',
    labelKey: 'sources.smb.passwordLabel',
    kind: 'password',
    hintKey: 'sources.smb.passwordHint',
  },
  {
    key: 'rootPath',
    labelKey: 'sources.smb.rootLabel',
    kind: 'path',
    placeholderKey: 'sources.smb.rootPlaceholder',
  },
] as const satisfies StoragePlugin['fields']

/** SMB / CIFS 存储插件 */
export const smbStoragePlugin: StoragePlugin = {
  id: 'smb',
  displayNameKey: 'sources.smb.title',
  descriptionKey: 'sources.smb.desc',
  version: '1.0.0',
  fields: SMB_STORAGE_FIELDS,

  listAudio: (cfg, options) => walkSmbAudio(cfg, options),
  // 只实现 openRange 与 openStream 中的**两者**：openStream 会在有 Range 时
  // 精确读取那一段，行为比 openRange 更完整（能处理尾段），所以优先它。
  openRange: (cfg, relPath, start, end) => openSmbRange(cfg, relPath, start, end),
  openStream: (cfg, relPath, init) => openSmbStream(cfg, relPath, init),

  async probe(cfg): Promise<StorageProbeResult> {
    if (!smb2Available()) {
      return { ok: false, message: 'SMB_UNAVAILABLE' }
    }
    try {
      const client = clientOf(cfg)
      const sample = await withTimeout<Smb2FileEntry[]>((done) => {
        client.readdir(rootOf(cfg) || '', (err, list) => done(err, list))
      }, 'probe')
      return {
        ok: true,
        message: 'ok',
        sample: (sample || [])
          .filter((item) => item.name && item.name !== '.' && item.name !== '..')
          .slice(0, 5)
          .map((item) => item.name),
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  },
}
