/**
 * SFTP 协议实现（ssh2）。
 *
 * ## 为什么在 shared 里，依赖却在 desktop
 *
 * 存储插件契约住在 shared（双端共用），但**协议实现依赖 `ssh2` 只有桌面端装**。
 * 所以本模块对 `ssh2` 的引用必须是**可注入的**：桌面端把 `ssh2` 模块传进来，
 * 移动端不传（那里根本没有 Node 的 TCP 栈）。
 *
 * 这个设计的直接好处：`shared` 的 `dependencies` 保持干净
 * （现在只有 lz-string），打包时不会把 ssh2 拖进渲染层。
 *
 * ## 连接生命周期：一次操作一个连接，用完即断
 *
 * 不维护连接池。理由：
 * 1. **NAS 的 SFTP 会话数有限**，长连容易撞上限且用户看不到原因；
 * 2. 连接泄漏的后果很重（NAS 侧会话占满后连管理员都进不去），
 *    而"每次新建"是最不容易泄漏的形态；
 * 3. 扫描是一次性的批量操作（每个目录一次 list），单次握手约 100~300ms，
 *    相对扫描整体耗时（大库可能几十秒）可忽略。
 *
 * 代价：播放时的每次 seek 都要重新握手。这是真实的体验代价 ——
 * 所以 `openStream` 的 Range 请求会走**同一条连接**的读流，
 * 而不是"先读全量再切"（见下方实现）。
 *
 * ## 认证
 *
 * 支持密码与私钥两种。私钥口令（passphrase）与私钥文件内容分开存：
 * 用 `safeStorage` 存的是「密码 / 私钥内容 / passphrase」三个敏感字段，
 * 由调用方分流（与 WebDAV 的口令同一处理路径）。
 */

import type { LibrarySourceConfig, RemoteEntry, WalkOptions } from '../../webdav'
import { AUDIO_EXTENSIONS, shouldSkipDir } from '../../webdav'
import type { StoragePlugin, StorageProbeResult } from './types'
import { storageFieldValue, storageStringField } from './fields'

/**
 * `ssh2` 模块的最小接口（只声明我们用到的部分）。
 *
 * 为什么不用 `import type { Client } from 'ssh2'`：那会让 shared 声明依赖 ssh2，
 * 与"依赖只装在桌面端"矛盾。这里手写最小形状，桌面端传真实模块进来
 * （结构兼容即可，不需要类型强制一致）。
 */
export interface Ssh2Module {
  Client: new () => Ssh2Client
}

export interface Ssh2Client {
  on(event: 'ready' | 'error' | 'close' | 'end', handler: (err?: Error) => void): void
  connect(config: Ssh2ConnectConfig): void
  end(): void
  sftp(callback: (err: Error | undefined, sftp: Ssh2Sftp) => void): void
}

export interface Ssh2ConnectConfig {
  host: string
  port?: number
  username?: string
  password?: string
  privateKey?: string | Buffer
  passphrase?: string
  readyTimeout?: number
}

export interface Ssh2Sftp {
  readdir(
    path: string,
    callback: (err: Error | undefined, list: Ssh2FileEntry[]) => void
  ): void
  stat(
    path: string,
    callback: (err: Error | undefined, stats: Ssh2Stats) => void
  ): void
  createReadStream(path: string, options?: { start?: number; end?: number }): Ssh2ReadStream
  realpath(path: string, callback: (err: Error | undefined, resolved: string) => void): void
}

export interface Ssh2FileEntry {
  filename: string
  longname: string
  attrs: Ssh2Stats
}

export interface Ssh2Stats {
  size?: number
  mtime?: number
  mode?: number
  isDirectory?: () => boolean
  isFile?: () => boolean
}

export interface Ssh2ReadStream {
  on(event: 'data' | 'end' | 'error', handler: (chunk?: unknown) => void): void
  destroy(): void
}

/** 注入点：桌面端启动时注册真实 `ssh2` 模块（移动端不注册） */
let ssh2Module: Ssh2Module | null = null

/** 注册 ssh2（桌面端主进程调用一次） */
export function setSsh2Module(mod: Ssh2Module | null): void {
  ssh2Module = mod
}

/** 当前是否具备 SFTP 能力（缺依赖时插件仍会出现在列表里，但 probe 会给出可读原因） */
export function ssh2Available(): boolean {
  return Boolean(ssh2Module)
}

/** 单次连接超时：NAS 的 SSH 握手通常很快，慢说明网络或服务有问题，早点失败好过挂着 */
const CONNECT_TIMEOUT_MS = 15000
/** 单次读目录超时 */
const OP_TIMEOUT_MS = 30000

/** 从字段声明里取连接参数（`settings` 优先、旧扁平字段兜底，由 storageFieldValue 统一） */
function connectionOf(cfg: LibrarySourceConfig): Ssh2ConnectConfig {
  const host = storageStringField(cfg, 'host') || ''
  const portText = storageStringField(cfg, 'port')
  const port = Number(portText)
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 22,
    username: storageStringField(cfg, 'username') || undefined,
    password: storageStringField(cfg, 'password') || undefined,
    privateKey: storageStringField(cfg, 'privateKey') || undefined,
    passphrase: storageStringField(cfg, 'passphrase') || undefined,
    readyTimeout: CONNECT_TIMEOUT_MS,
  }
}

/** 根目录：用户配的 `rootPath`（相对 SFTP 的登录目录），去掉首尾斜杠 */
function rootOf(cfg: LibrarySourceConfig): string {
  const raw = storageStringField(cfg, 'rootPath') || ''
  return raw.replace(/^\/+|\/+$/g, '')
}

/** 把相对路径拼成 SFTP 绝对路径（相对路径以登录目录为基准） */
function remotePathOf(cfg: LibrarySourceConfig, relPath: string): string {
  const root = rootOf(cfg)
  const rel = String(relPath || '').replace(/^\/+/, '')
  if (root && rel) return `${root}/${rel}`
  return root || rel || '.'
}

/**
 * 建连接并执行一次操作。
 *
 * `run` 在 ready 后被调用，**无论成败都会 end()** —— 连接泄漏在 NAS 上是硬故障
 * （会话占满后管理员都进不去），所以这里用 try/finally 保证收场。
 */
async function withConnection<T>(
  cfg: LibrarySourceConfig,
  run: (sftp: Ssh2Sftp) => Promise<T>
): Promise<T> {
  if (!ssh2Module) {
    throw new Error('SFTP_UNAVAILABLE: the ssh2 module is not registered on this platform')
  }
  const config = connectionOf(cfg)
  if (!config.host) throw new Error('SFTP_BAD_CONFIG: host is required')

  const client = new ssh2Module.Client()
  let settled = false
  const cleanup = () => {
    try {
      client.end()
    } catch {
      /* 已经断开：无害 */
    }
  }

  const connected = new Promise<void>((resolve, reject) => {
    client.on('ready', () => resolve())
    client.on('error', (err) => {
      if (!settled) reject(err || new Error('SFTP_CONNECT_FAILED'))
    })
    client.on('close', () => {
      if (!settled) reject(new Error('SFTP_CONNECTION_CLOSED'))
    })
    client.connect(config)
  })

  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    cleanup()
    // 超时也要 reject，否则调用方会一直等一个永远不会 ready 的连接
  }, CONNECT_TIMEOUT_MS)

  try {
    await connected
    clearTimeout(timer)
    const sftp = await new Promise<Ssh2Sftp>((resolve, reject) => {
      client.sftp((err, session) => (err ? reject(err) : resolve(session)))
    })
    return await run(sftp)
  } finally {
    clearTimeout(timer)
    settled = true
    cleanup()
  }
}

/** 带超时的回调包装（ssh2 的回调在连接半死时可能永远不来） */
function withOpTimeout<T>(task: (done: (err: Error | undefined, value?: T) => void) => void, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      reject(new Error(`SFTP_TIMEOUT: ${label} took longer than ${OP_TIMEOUT_MS}ms`))
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

/** 是否音频文件（复用 webdav 那份扩展名表，避免两处口径漂移） */
function isAudioName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return AUDIO_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

/**
 * 递归列举音频文件（广度优先 + 有限并发）。
 *
 * 与 `walkWebdavAudio` 同构：同样的 `WalkOptions`（并发 / 上限 / 回调 / 取消），
 * 因为它服务于同一套扫描流程。差异只有"怎么读一个目录"。
 */
async function walkSftpAudio(
  cfg: LibrarySourceConfig,
  options: WalkOptions = {}
): Promise<RemoteEntry[]> {
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const maxEntries = options.maxEntries ?? 20000
  const out: RemoteEntry[] = []
  const queue: string[] = ['']
  let visited = 0

  /** 一个目录的读取（每次一个独立连接：见文件头「连接生命周期」） */
  const listDir = async (relDir: string): Promise<RemoteEntry[]> => {
    try {
      return await withConnection(cfg, (sftp) =>
        withOpTimeout<Ssh2FileEntry[]>((done) => {
          sftp.readdir(remotePathOf(cfg, relDir) || '.', (err, list) => done(err, list))
        }, 'readdir').then((list) => {
          const entries: RemoteEntry[] = []
          for (const item of list) {
            const name = String(item.filename || '')
            // `.` / `..` 在部分服务端会出现在 readdir 结果里
            if (!name || name === '.' || name === '..') continue
            const isDir = typeof item.attrs?.isDirectory === 'function' ? item.attrs.isDirectory() : false
            const relPath = relDir ? `${relDir}/${name}` : name
            entries.push({
              path: relPath,
              name,
              isDirectory: isDir,
              size: Number(item.attrs?.size || 0),
              lastModified: Number(item.attrs?.mtime || 0) * 1000,
            })
          }
          return entries
        })
      )
    } catch (err) {
      // 单目录失败不中断整体扫描（权限不足 / 临时故障），由调用方决定怎么呈现
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
        if (visited > maxEntries * 10) break // 防御性上限：防止病态目录结构把内存吃满
        if (entry.isDirectory) {
          // 跳过隐藏 / 系统目录（与 webdav 同一判据）
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

/**
 * 打开一个文件的字节流（支持 Range）。
 *
 * 实现要点：ssh2 的 `createReadStream(path, {start, end})` 的 `end` 是**闭区间**，
 * 而 HTTP 的 `bytes=start-end` 也是闭区间 —— 两者语义一致，不需要 +1/-1 调整。
 * 这正是不能只用 `openRange` 的原因：后者收的是数值区间，表达不了 `bytes=-N`（尾段）。
 */
async function openSftpStream(
  cfg: LibrarySourceConfig,
  relPath: string,
  init: { range?: string } = {}
): Promise<Response> {
  const range = parseRangeHeader(init.range)
  return await withConnection(cfg, (sftp) => {
    return new Promise<Response>((resolve, reject) => {
      const target = remotePathOf(cfg, relPath)
      // `bytes=-N`（尾段）需要知道文件长度才能换算成绝对区间
      const startReading = (totalSize: number | null) => {
        let start: number | undefined
        let end: number | undefined
        if (range) {
          if (range.kind === 'closed') {
            start = range.start
            end = range.end
          } else if (range.kind === 'open') {
            start = range.start
          } else if (range.kind === 'suffix' && totalSize !== null) {
            start = Math.max(0, totalSize - range.length)
            end = totalSize - 1
          }
        }
        const stream = sftp.createReadStream(
          target,
          start === undefined ? undefined : { start, ...(end === undefined ? {} : { end }) }
        )
        const chunks: Buffer[] = []
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk as Buffer)))
        stream.on('end', () => {
          const body = Buffer.concat(chunks)
          if (range && totalSize !== null) {
            // 206 语义：告诉调用方这是部分内容
            resolve(
              new Response(body, {
                status: 206,
                headers: {
                  'Content-Range': `bytes ${start ?? 0}-${(start ?? 0) + body.length - 1}/${totalSize}`,
                  'Content-Length': String(body.length),
                  'Accept-Ranges': 'bytes',
                  'Content-Type': guessAudioType(relPath),
                },
              })
            )
            return
          }
          resolve(
            new Response(body, {
              status: 200,
              headers: {
                'Content-Length': String(body.length),
                'Accept-Ranges': 'bytes',
                'Content-Type': guessAudioType(relPath),
              },
            })
          )
        })
        stream.on('error', (err) => reject(err))
      }

      // 需要长度（尾段请求 或 想给出 206 的 Content-Range）时先 stat
      if (range?.kind === 'suffix' || range) {
        sftp.stat(target, (err, stats) => {
          if (err) {
            // stat 失败时仍尝试读（有些服务端不实现 stat），但无法给 206
            startReading(null)
            return
          }
          startReading(Number(stats?.size || 0))
        })
        return
      }
      startReading(null)
    })
  })
}

/** 由扩展名推 MIME（少样本，够 <audio> 用） */
function guessAudioType(relPath: string): string {
  const lower = relPath.toLowerCase()
  if (lower.endsWith('.flac')) return 'audio/flac'
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.m4a') || lower.endsWith('.aac')) return 'audio/mp4'
  if (lower.endsWith('.ogg') || lower.endsWith('.opus')) return 'audio/ogg'
  return 'audio/mpeg'
}

/** 解析 Range 头（只认 HTTP 的 bytes 单位；三种形态） */
export function parseRangeHeader(
  value: string | undefined
): { kind: 'closed'; start: number; end: number } | { kind: 'open'; start: number } | { kind: 'suffix'; length: number } | null {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value).trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return null
  // `bytes=-N`：最后 N 个字节
  if (!rawStart) {
    const length = Number(rawEnd)
    return Number.isFinite(length) && length > 0 ? { kind: 'suffix', length } : null
  }
  const start = Number(rawStart)
  if (!Number.isFinite(start) || start < 0) return null
  // `bytes=N-`：从 N 到文件尾
  if (!rawEnd) return { kind: 'open', start }
  const end = Number(rawEnd)
  if (!Number.isFinite(end) || end < start) return null
  return { kind: 'closed', start, end }
}

/** 字段声明：UI 据此通用渲染表单（设置页零改动） */
export const SFTP_STORAGE_FIELDS = [
  {
    key: 'host',
    labelKey: 'sources.sftp.hostLabel',
    kind: 'text',
    required: true,
    placeholderKey: 'sources.sftp.hostPlaceholder',
  },
  {
    key: 'port',
    labelKey: 'sources.sftp.portLabel',
    kind: 'text',
    placeholderKey: 'sources.sftp.portPlaceholder',
  },
  {
    key: 'username',
    labelKey: 'sources.sftp.usernameLabel',
    kind: 'text',
  },
  {
    key: 'password',
    labelKey: 'sources.sftp.passwordLabel',
    kind: 'password',
    hintKey: 'sources.sftp.passwordHint',
  },
  {
    key: 'privateKey',
    labelKey: 'sources.sftp.privateKeyLabel',
    kind: 'password',
    hintKey: 'sources.sftp.privateKeyHint',
  },
  {
    key: 'rootPath',
    labelKey: 'sources.sftp.rootLabel',
    kind: 'path',
    placeholderKey: 'sources.sftp.rootPlaceholder',
  },
] as const satisfies StoragePlugin['fields']

/** SFTP 存储插件 */
export const sftpStoragePlugin: StoragePlugin = {
  id: 'sftp',
  displayNameKey: 'sources.sftp.title',
  descriptionKey: 'sources.sftp.desc',
  version: '1.0.0',
  fields: SFTP_STORAGE_FIELDS,

  listAudio: (cfg, options) => walkSftpAudio(cfg, options),
  openStream: (cfg, relPath, init) => openSftpStream(cfg, relPath, init),

  /**
   * 探测：列举根目录。
   *
   * 缺依赖时给**可读原因**而不是抛错 —— 用户看到的是"本机没有 SFTP 支持"
   * 而不是一个看不懂的模块加载错误。
   */
  async probe(cfg): Promise<StorageProbeResult> {
    if (!ssh2Available()) {
      return { ok: false, message: 'SFTP_UNAVAILABLE' }
    }
    try {
      const entries = await withConnection(cfg, (sftp) =>
        withOpTimeout<Ssh2FileEntry[]>((done) => {
          sftp.readdir(remotePathOf(cfg, '') || '.', (err, list) => done(err, list))
        }, 'probe').then((list) =>
          list
            .filter((item) => item.filename && item.filename !== '.' && item.filename !== '..')
            .slice(0, 5)
            .map((item) => item.filename)
        )
      )
      return { ok: true, message: 'ok', sample: entries }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  },
}

/** 供测试与诊断：把根目录拼成远端路径 */
export function sftpRemotePathOf(cfg: LibrarySourceConfig, relPath: string): string {
  return remotePathOf(cfg, relPath)
}

/** 供测试：读连接参数 */
export function sftpConnectionOf(cfg: LibrarySourceConfig): Ssh2ConnectConfig {
  void storageFieldValue // 保持导入（fields 取值走的是 storageStringField）
  return connectionOf(cfg)
}
