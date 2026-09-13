/**
 * WebDAV 媒体库客户端（协议层，不含任何平台 API，双端共用）
 *
 * 与 musicSource.ts 的「在线歌源」不同：在线歌源是无状态搜索接口（地址易失、
 * 不入库），WebDAV 是持久媒体库（地址长期有效、需要入库、需要鉴权）。因此
 * 这里只做三件事：列举远端目录（PROPFIND）、读远端字节区间（Range GET）、
 * 探测连接可用性；元数据解析与入库由各平台层负责。
 *
 * 鉴权统一走 Authorization 头，绝不把用户名/密码拼进 URL——远端地址会作为
 * Track 的展示字段与数据库主键的一部分落盘，拼进 URL 就等于把口令明文写库。
 */

import { fetchWithTimeout } from './fetchWithTimeout'

/** 媒体库来源配置（区别于在线歌源的 OnlineSourceConfig） */
export interface LibrarySourceConfig {
  id: string
  /** 来源类型：本机目录 / WebDAV 网络存储 */
  kind: 'local' | 'webdav'
  /** 展示名（如「家里的群晖」） */
  name: string
  /** webdav：服务地址（含协议与端口），如 https://nas.example.com:5006/dav */
  baseUrl?: string
  /** webdav：用户名（Basic 鉴权；留空表示匿名访问） */
  username?: string
  /**
   * webdav：口令。
   * ⚠️ 目前与在线歌源的请求头一样由渲染层持久化，后续应迁移到主进程
   * safeStorage 加密存储；本字段只用于构造请求头，绝不进入 Track / URL。
   */
  password?: string
  /** webdav：媒体库根目录（相对 baseUrl），留空表示 baseUrl 本身 */
  rootPath?: string
  enabled: boolean
}

/** 远端目录项（path 为相对 rootPath 的路径，统一用 / 分隔，不带前后斜杠） */
export interface RemoteEntry {
  path: string
  name: string
  isDirectory: boolean
  /** 字节数（目录为 0；服务器未提供时为 0） */
  size: number
  /** 毫秒时间戳（服务器未提供时为 0） */
  lastModified: number
}

/** 可扫描的音频扩展名（与桌面端本地扫描保持一致） */
export const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav', '.wma', '.opus',
])

/**
 * 列举时要跳过的目录名：
 * - @eaDir / #recycle：群晖的缩略图与回收站，混进来会让曲库出现大量重复与垃圾条目
 * - .DS_Store 等以点开头的隐藏目录由通用规则覆盖
 */
const SKIP_DIR_NAMES = new Set(['@eaDir', '#recycle', '@Recycle', '$RECYCLE.BIN', 'System Volume Information'])

export function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || SKIP_DIR_NAMES.has(name)
}

export function isAudioFileName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return AUDIO_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

/** 从文件名推断音频 MIME（music-metadata 的类型提示，缺失时它会自行嗅探） */
export function guessAudioMime(name: string): string | undefined {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return undefined
  const map: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.wav': 'audio/wav',
    '.wma': 'audio/x-ms-wma',
  }
  return map[name.slice(dot).toLowerCase()]
}

/** 音乐库扫描时用于解析元数据的文件头字节数 */
export const METADATA_HEAD_BYTES = 1024 * 1024

/** 解析器给出的、与本函数判断相关的 format 字段子集 */
export interface ParsedAudioFormat {
  container?: string
  codecProfile?: string
  numberOfSamples?: number
  duration?: number
}

/**
 * 修正「只读了文件头」时得到的时长。
 *
 * 远端曲目不可能为了读时长把整首歌拉下来，只能取前 1MB 交给解析器；而
 * music-metadata 对 MPEG 的时长有三种来源，对截断输入的正确处理各不相同
 * （下列行为已用 music-metadata 10.9.1 实测确认，构造 1000 帧 CBR MP3、
 * 只喂前 100 帧：完整解析 26.12s，截断解析 2.61s，恰好 1/10）：
 *
 * 1. CBR（codecProfile === 'CBR'）：finalize() 用 tokenizer.fileInfo.size 按帧长
 *    反推总采样数，fileInfo.size 就是我们给的截断长度 → 时长与读取长度严格成正比，
 *    按 真实大小/已读大小 等比还原即可（实测误差 0.000%）；此类 numberOfSamples 必定有值。
 * 2. 有 Xing/LAME 头：时长来自文件头里的帧数/音乐长度，与读取长度无关，精确 → 原样保留。
 *    ⚠️ 此时 numberOfSamples 不会被设置。
 * 3. 无 Xing 头的 VBR：解析器读到「流末尾」后按帧数算时长，而我们的流末尾只是
 *    截断缓冲区的末尾 → 时长被按截断比例低估且无法还原（真实码率未知）。
 *    此类 numberOfSamples 有值。宁可置 0（列表显示 0:00，播放时由 audio 元素补全），
 *    也不留一个错误数字——错误时长会被写进数据库长期留存。
 *
 * 注意第 2、3 种情况的判别依据（numberOfSamples 是否设置）依赖 music-metadata 的
 * 内部实现，升级该依赖时需重新验证此函数。
 */
export function normalizeHeadParsedDuration(
  format: ParsedAudioFormat,
  headBytes: number,
  totalBytes: number
): number {
  const duration = format.duration || 0
  if (duration <= 0) return 0
  // 文件没被截断（整首都在文件头范围内）时解析结果就是完整的，直接采信
  if (!headBytes || !totalBytes || totalBytes <= headBytes) return duration
  // 非 MPEG 格式（FLAC 的 STREAMINFO、OGG/MP4 的头部等）时长来自格式头，与读取长度无关
  if (format.container !== 'MPEG') return duration
  if (format.codecProfile === 'CBR') return duration * (totalBytes / headBytes)
  if (format.numberOfSamples != null) return 0
  return duration
}

// ─── URL 与鉴权 ───────────────────────────────────────────────

/** 去掉尾部斜杠，保证与相对路径拼接时只有一个分隔符 */
export function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || '').trim().replace(/\/+$/, '')
}

/** 用 / 拼接并逐段编码（中文、空格、# 等字符不编码会让 PROPFIND 直接 404） */
export function joinUrl(baseUrl: string, ...segments: string[]): string {
  const base = normalizeBaseUrl(baseUrl)
  const tail = segments
    .filter((s) => s !== undefined && s !== null && String(s) !== '')
    .join('/')
    .split('/')
    .filter((s) => s !== '')
    .map((s) => encodeURIComponent(s))
    .join('/')
  return tail ? `${base}/${tail}` : base
}

/**
 * UTF-8 安全的 Basic 鉴权头。
 * 不用 Buffer：本模块同时被 Electron 主进程与浏览器/移动端 WebView 打包引用，
 * 渲染进程里没有 Buffer；btoa 只接受 latin1，中文用户名直接调用会抛
 * InvalidCharacterError，所以先用 TextEncoder 取字节再逐字节转字符。
 */
export function buildAuthHeader(username?: string, password?: string): string | null {
  if (!username && !password) return null
  const raw = `${username ?? ''}:${password ?? ''}`
  const bytes = new TextEncoder().encode(raw)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return `Basic ${btoa(bin)}`
}

/** 统一的请求头：鉴权 + UA（部分 NAS 会按 UA 拒绝非浏览器客户端） */
export function webdavHeaders(cfg: LibrarySourceConfig, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'AuroraMusic/1.0 (WebDAV)',
    ...(extra || {}),
  }
  const auth = buildAuthHeader(cfg.username, cfg.password)
  if (auth) headers.Authorization = auth
  return headers
}

/** 远端相对路径 → 完整请求地址（rootPath 与 relPath 逐段编码后拼接） */
export function resolveRemoteUrl(cfg: LibrarySourceConfig, relPath: string): string {
  return joinUrl(normalizeBaseUrl(cfg.baseUrl || ''), cfg.rootPath || '', relPath)
}

// ─── aurora-remote:// 播放地址 ────────────────────────────────
//
// 远端音频不能把地址（更不用说口令）直接交给 <audio src>，因此统一走
// 主进程注册的自定义协议代理：aurora-remote://<sourceId>/<相对路径>。
// 主进程按 sourceId 找到配置，带鉴权转发 Range 请求。

export const REMOTE_SCHEME = 'aurora-remote'

export function buildRemoteAudioUrl(sourceId: string, relPath: string): string {
  const encoded = relPath
    .split('/')
    .filter((s) => s !== '')
    .map((s) => encodeURIComponent(s))
    .join('/')
  return `${REMOTE_SCHEME}://${sourceId}/${encoded}`
}

export function isRemoteAudioUrl(url: string): boolean {
  return url.startsWith(`${REMOTE_SCHEME}://`)
}

export function parseRemoteAudioUrl(url: string): { sourceId: string; path: string } | null {
  if (!isRemoteAudioUrl(url)) return null
  const rest = url.slice(`${REMOTE_SCHEME}://`.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  const sourceId = rest.slice(0, slash)
  const path = rest
    .slice(slash + 1)
    .split('/')
    .map((s) => decodeURIComponent(s))
    .join('/')
  if (!sourceId || !path) return null
  return { sourceId, path }
}

/**
 * 远端曲目在本地库中的存储坐标：`webdav:<sourceId>/<相对路径>`。
 * 前缀把来源编进 path，使 tracks.path 的 UNIQUE 约束天然按来源隔离
 * （两个 NAS 上同名的 Music/a.mp3 不会互相顶掉），且无需重建表结构。
 */
export function storagePathFor(sourceId: string, relPath: string): string {
  return `webdav:${sourceId}/${relPath}`
}

/** 某个来源在 tracks.path 中的前缀，用于按来源清理或精确查询 */
export function storagePathPrefix(sourceId: string): string {
  return `webdav:${sourceId}/`
}

// ─── PROPFIND 响应解析 ────────────────────────────────────────

/** XML 实体解码（href 里的 &amp; 与中文百分号编码都要还原） */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function tagText(block: string, tag: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i')
  const m = re.exec(block)
  return m ? decodeXmlEntities(m[1]) : null
}

/**
 * href → 相对 rootPath 的路径。
 * 服务器返回的形态不统一：可能只有路径（/dav/Music/a.mp3），也可能是完整 URL
 * （部分反向代理会返回绝对地址），也可能带百分号编码与尾部斜杠。
 */
function hrefToRelPath(href: string, baseUrl: string, rootPath: string): string | null {
  let pathname = href.trim()
  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname
    } catch {
      return null
    }
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    decoded = pathname
  }

  // 截掉 baseUrl 的路径前缀（baseUrl 可能是 https://host/dav 这种带子路径的形式）
  let basePath = ''
  try {
    basePath = new URL(normalizeBaseUrl(baseUrl)).pathname
  } catch {
    basePath = ''
  }
  if (basePath && basePath !== '/' && decoded.startsWith(basePath)) {
    decoded = decoded.slice(basePath.length)
  }
  if (rootPath) {
    const rp = `/${rootPath.replace(/^\/+|\/+$/g, '')}`
    if (decoded.startsWith(rp)) decoded = decoded.slice(rp.length)
  }
  const rel = decoded.replace(/^\/+|\/+$/g, '')
  return rel
}

/**
 * 解析 207 Multi-Status 响应体。
 *
 * 不使用 DOMParser：Electron 主进程是纯 Node 环境，没有 DOMParser；
 * 引入 xml2js 之类的依赖只为解析这 4 个字段并不划算，且此函数保持纯函数
 * 便于单元测试（服务器实现的怪异行为主要在命名空间前缀与 propstat 分组上）。
 *
 * @param baseUrl  用于截掉 href 的路径前缀
 * @param rootPath 媒体库根目录（相对 baseUrl）
 * @param selfPath 发起请求的目录本身，结果里要剔除（服务器总会把它自己带回来）
 */
export function parseMultiStatus(
  xml: string,
  baseUrl: string,
  rootPath: string,
  selfPath: string
): RemoteEntry[] {
  const entries: RemoteEntry[] = []
  const responseRe = /<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi
  let block: RegExpExecArray | null

  while ((block = responseRe.exec(xml)) !== null) {
    const body = block[1]
    const href = tagText(body, 'href')
    if (!href) continue

    // 优先取状态为 200 的 propstat：部分服务器（如某些群晖固件）会同时返回
    // 一个 404 propstat（含未实现的属性），先取到的如果不是 200 会解析出空属性
    const propstatRe = /<(?:[\w-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?propstat>/gi
    const propBlocks: string[] = []
    let ps: RegExpExecArray | null
    while ((ps = propstatRe.exec(body)) !== null) propBlocks.push(ps[1])
    const okBlock = propBlocks.find((b) => /<(?:\w+:)?status\b[^>]*>\s*HTTP\/[\d.]+\s+2\d\d/i.test(b))
    const propSource = okBlock ?? body

    const relPath = hrefToRelPath(href, baseUrl, rootPath)
    if (relPath === null) continue
    if (relPath === selfPath) continue
    if (!relPath) continue

    const resourceType = tagText(propSource, 'resourcetype')
    // <D:resourcetype><D:collection/></D:resourcetype> 为目录；
    // 自闭合 <D:resourcetype/> 时 tagText 匹配不到，按文件处理
    const isDirectory =
      resourceType !== null
        ? /<(?:[\w-]+:)?collection\b/i.test(resourceType)
        : /<(?:[\w-]+:)?collection\b[^>]*\/>/i.test(propSource)

    const sizeRaw = tagText(propSource, 'getcontentlength')
    const size = sizeRaw && /^\d+$/.test(sizeRaw.trim()) ? parseInt(sizeRaw.trim(), 10) : 0

    const mtimeRaw = tagText(propSource, 'getlastmodified')
    let lastModified = 0
    if (mtimeRaw) {
      const t = Date.parse(mtimeRaw)
      if (!Number.isNaN(t)) lastModified = t
    }

    const name = relPath.split('/').pop() || relPath
    entries.push({ path: relPath, name, isDirectory, size, lastModified })
  }

  return entries
}

// ─── 请求 ─────────────────────────────────────────────────────

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <D:getcontentlength/>
    <D:getlastmodified/>
  </D:prop>
</D:propfind>`

export class WebdavError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'WebdavError'
  }
}

/** 单个目录列举（Depth: 1）。超时按媒体库规模放宽到 20s（大目录 + 慢 NAS） */
export async function listWebdavDir(
  cfg: LibrarySourceConfig,
  relPath: string,
  timeoutMs = 20000
): Promise<RemoteEntry[]> {
  const url = resolveRemoteUrl(cfg, relPath)
  let resp: Response
  try {
    resp = await fetchWithTimeout(
      url,
      { method: 'PROPFIND', headers: webdavHeaders(cfg, { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }), body: PROPFIND_BODY },
      timeoutMs
    )
  } catch (err) {
    throw new WebdavError(`无法连接到网络存储「${cfg.name}」：${(err as Error).message}`)
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new WebdavError(`网络存储「${cfg.name}」鉴权失败（HTTP ${resp.status}），请检查用户名与口令`, resp.status)
  }
  if (resp.status === 404) {
    throw new WebdavError(`网络存储「${cfg.name}」路径不存在：${cfg.rootPath || '/'}`, 404)
  }
  if (resp.status !== 207 && resp.status !== 200) {
    throw new WebdavError(`网络存储「${cfg.name}」返回异常状态 HTTP ${resp.status}`, resp.status)
  }
  const xml = await resp.text()
  return parseMultiStatus(xml, cfg.baseUrl || '', cfg.rootPath || '', relPath)
}

/** 探测连接：列举根目录并返回前几个音频文件，供设置页「测试连接」使用 */
export async function testWebdavConnection(
  cfg: LibrarySourceConfig
): Promise<{ ok: boolean; message: string; sample?: string[] }> {
  try {
    const entries = await listWebdavDir(cfg, '')
    const dirs = entries.filter((e) => e.isDirectory).length
    const files = entries.filter((e) => !e.isDirectory).length
    const audio = entries.filter((e) => !e.isDirectory && isAudioFileName(e.name)).map((e) => e.name)
    return {
      ok: true,
      message: `连接成功：根目录下 ${dirs} 个子目录、${files} 个文件${audio.length ? `，其中 ${audio.length} 个音频` : ''}`,
      sample: audio.slice(0, 5),
    }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

/**
 * 读取远端字节区间（用于元数据解析与 Range 探测）。
 * 服务器不支持 Range 时按 200 返回整个文件，调用方需自行判断（见 openRangeSafely）。
 */
export async function openWebdavRange(
  cfg: LibrarySourceConfig,
  relPath: string,
  start: number,
  end: number,
  timeoutMs = 30000
): Promise<Response> {
  const url = resolveRemoteUrl(cfg, relPath)
  let resp: Response
  try {
    resp = await fetchWithTimeout(
      url,
      { method: 'GET', headers: webdavHeaders(cfg, { Range: `bytes=${start}-${end}` }) },
      timeoutMs
    )
  } catch (err) {
    // 统一包成 WebdavError：调用方据此区分「传输层失败（可重试，不应写库）」
    // 与「文件内容解析失败（格式问题，该用文件名兜底入库）」
    throw new WebdavError(`无法读取网络存储「${cfg.name}」：${(err as Error).message}`)
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new WebdavError(`网络存储「${cfg.name}」鉴权失败（HTTP ${resp.status}）`, resp.status)
  }
  return resp
}

export interface WalkOptions {
  /** 并发目录数（NAS 的 PROPFIND 通常较慢，4 是吞吐与负载的折中） */
  concurrency?: number
  /** 硬上限，防止误选根目录导致把整个 NAS 拉进曲库 */
  maxEntries?: number
  /** 单个目录失败时回调（权限不足/临时故障），不中断整体扫描 */
  onError?: (dirPath: string, err: Error) => void
  /** 每发现一个音频文件立即回调，用于渐进式入库 */
  onAudio?: (entry: RemoteEntry) => void
  /** 外部取消信号 */
  shouldStop?: () => boolean
}

/**
 * 递归列举媒体库中的全部音频文件（广度优先 + 有限并发）。
 *
 * 与本地 fs.walkDir 的差异：网络请求失败不能当成「目录已空」，否则会把
 * 临时的网络抖动变成「曲目被删除」从而清空用户曲库——因此单目录失败只
 * 回调 onError 并跳过该分支，整体继续。
 */
export async function walkWebdavAudio(
  cfg: LibrarySourceConfig,
  options: WalkOptions = {}
): Promise<RemoteEntry[]> {
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const maxEntries = options.maxEntries ?? 200000
  const result: RemoteEntry[] = []

  // 根目录单独列举且不吞异常：这是区分「库确实是空的」与「服务器连不上/口令错」
  // 的唯一依据。若把它也降级成"跳过"，用户配错口令时会看到一个空曲库，
  // 而上层无法判断该不该清理旧记录。
  const rootEntries = await listWebdavDir(cfg, '')
  const queue: string[] = []

  const consume = (entries: RemoteEntry[]): boolean => {
    for (const entry of entries) {
      if (result.length >= maxEntries) return false
      if (entry.isDirectory) {
        if (!shouldSkipDir(entry.name)) queue.push(entry.path)
      } else if (isAudioFileName(entry.name)) {
        result.push(entry)
        options.onAudio?.(entry)
      }
    }
    return true
  }

  if (!consume(rootEntries)) return result

  while (queue.length > 0) {
    if (options.shouldStop?.()) break
    const batch = queue.splice(0, concurrency)
    const listings = await Promise.all(
      batch.map(async (dir) => {
        try {
          return await listWebdavDir(cfg, dir)
        } catch (err) {
          // 单个子目录失败（权限不足 / 网络抖动）只跳过该分支，绝不当成「目录已空」，
          // 否则一次抖动就可能让上层误判曲目被删除
          options.onError?.(dir, err as Error)
          return [] as RemoteEntry[]
        }
      })
    )
    for (const entries of listings) {
      if (!consume(entries)) return result
    }
  }

  return result
}
