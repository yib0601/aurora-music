/**
 * 媒体库来源（本机目录 / 网络存储）在主进程侧的注册表与扫描实现。
 *
 * 为什么扫描放在主进程：
 * - 远端曲目的元数据要按字节区间读取（Range GET），渲染层的 fetch 受 CORS 约束，
 *   而多数网络存储实现不会返回 Access-Control-Allow-Origin；
 * - 播放走 aurora-remote:// 协议代理，渲染层只持有 sourceId。
 *
 * 口令**不在**这些配置里：它由 `storageCredentials` 经 `safeStorage` 加密单独落盘，
 * 只在调用插件前的一瞬间并进配置副本（见 `withStorageSecrets`）。
 * 因此本文件的 `registry` 里存的是可公开的非敏感配置，落盘、日志、IPC 都安全。
 */

import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { parseBuffer } from 'music-metadata'
import {
  auroraError,
  storagePluginOf,
  librarySourcePluginId,
  isStorageTransportError,
  markTransportError,
  storagePathFor,
  storagePathPrefix,
  buildRemoteAudioUrl,
  guessAudioMime,
  normalizeHeadParsedDuration,
  METADATA_HEAD_BYTES,
  type LibrarySourceConfig,
  type RemoteEntry,
  type StoragePlugin,
} from '@aurora/shared'
import type { Track } from '../types'
import {
  insertTracks,
  getTracksByPaths,
  deleteMissingRemoteTracks,
  deleteTracksBySourcePrefix,
  updateTrack,
} from './database'
import { registerCoverFile } from './mediaCache'
import { withStorageSecrets } from './storageCredentials'
import { mainTranslate } from '../i18n'
// 与本地按需提取共用同一份「悬空路径」判定，避免两处各写一份阈值
import { isUsableCoverFile } from './coverFile'

/** sourceId → 来源配置。由渲染层在启动与配置变更时同步（syncLibrarySources） */
const registry = new Map<string, LibrarySourceConfig>()

export function syncLibrarySources(sources: LibrarySourceConfig[]): void {
  registry.clear()
  for (const s of sources) {
    // 这里存的全是可公开字段：口令单独走 storageCredentials，不在配置里
    if (s?.id) registry.set(s.id, s)
  }
  console.log('[LibrarySource] 已同步来源配置:', registry.size, '个')
}

export function getLibrarySource(id: string): LibrarySourceConfig | undefined {
  return registry.get(id)
}

/**
 * 取来源对应的存储插件（**唯一查法**）。
 *
 * 历史上有两套并存：`providerFor()` 走 `getMediaProvider(cfg.kind)`，
 * 而 `probeLibrarySource()` 又裸查了一次同样的表 —— 判定口径分叉的典型形态。
 * 现在统一走 `storagePluginOf(cfg)`（内部 = `librarySourcePluginId` + 注册表）。
 *
 * 未注册的插件（例如配置里写了一个本版本尚未实现的协议）给出可读错误，
 * 而不是静默失败或回落到别的协议执行。
 */
function pluginFor(cfg: LibrarySourceConfig): StoragePlugin {
  const plugin = storagePluginOf(cfg)
  if (!plugin) {
    throw auroraError('desktop.error.source.kindUnsupported', {
      pluginId: librarySourcePluginId(cfg),
    })
  }
  return plugin
}

/**
 * 插件能力的接线校验：列举与按区间读是扫描管线的两件必需品。
 *
 * 能力用「方法是否存在」表达（`docs/plugins.md` 的范式），缺失即该插件
 * 无法支持本功能——给出明确错误，而不是等运行时 `undefined is not a function`。
 */
function requireListAudio(plugin: StoragePlugin) {
  const fn = plugin.listAudio
  if (typeof fn !== 'function') {
    throw auroraError('desktop.error.source.capabilityMissing', {
      pluginId: plugin.id,
      capability: 'listAudio',
    })
  }
  return fn.bind(plugin)
}

function requireOpenRange(plugin: StoragePlugin) {
  const fn = plugin.openRange
  if (typeof fn !== 'function') {
    throw auroraError('desktop.error.source.capabilityMissing', {
      pluginId: plugin.id,
      capability: 'openRange',
    })
  }
  return fn.bind(plugin)
}

/**
 * 取远端字节流，供 `aurora-remote://` 协议处理器使用。
 *
 * 优先 `openStream`：`Range` 头**原样透传**，播放器的 `bytes=-N`（尾段）这类
 * 非 `start-end` 形态才能工作，206 与 `Content-Range` 也原样回给调用方。
 *
 * 插件只实现 `openRange` 时回落：把 `bytes=<start>-<end>` 解析成数值区间。
 * 这条路径表达不了 `bytes=-N` / 开区间——属**正常降级**，不是错误：
 * 返回空 416，让播放器按「不支持该 Range 形态」处理（它会改用无 Range 请求）。
 *
 * 口令在这里注入（`withStorageSecrets`）：插件按声明式字段 `password` 取值，
 * 而口令不在配置里、只在主进程的加密存储里。
 */
export async function proxyRemoteAudio(
  cfg: LibrarySourceConfig,
  plugin: StoragePlugin,
  relPath: string,
  range?: string
): Promise<Response> {
  const sealed = withStorageSecrets(cfg)
  if (typeof plugin.openStream === 'function') {
    return plugin.openStream(sealed, relPath, { range })
  }

  const openRange = requireOpenRange(plugin)
  const parsedRange = parseByteRange(range)
  if (!parsedRange) {
    // 无 Range 头 = 请求整个文件，可完整走 openRange；
    // 有 Range 但形态表达不了（尾段 / 开区间）= 明确告知不支持该形态
    if (range) return new Response('', { status: 416 })
    const head = await openRange(sealed, relPath, 0, Number.MAX_SAFE_INTEGER)
    return head
  }
  return openRange(sealed, relPath, parsedRange.start, parsedRange.end)
}

/**
 * 解析 `bytes=<start>-<end>` 形态。
 *
 * 只接受两端都给全的闭区间：
 * - `bytes=0-1023` → `{start: 0, end: 1023}`
 * - `bytes=-1024`（尾段）、`bytes=1024-`（开区间）→ null
 *   （`openRange` 是数值区间 API，表达不了「从末尾数」或「到文件末」，
 *    后者还需要先知道文件大小；交给上层按 416 降级处理）
 */
function parseByteRange(range: string | undefined): { start: number; end: number } | null {
  if (!range) return null
  const m = /^bytes=(\d+)-(\d+)$/i.exec(range.trim())
  if (!m) return null
  const start = Number(m[1])
  const end = Number(m[2])
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return { start, end }
}

/**
 * 按扩展名给出一个占位标题/艺术家，与本地扫描的命名惯例保持一致。
 *
 * 占位值（"未知艺术家"/"未知专辑"）是**落库哨兵**，同时参与匹配
 * （见 shared/coverMatch 的 PLACEHOLDER_ARTISTS 与 scanner 的 META_PLACEHOLDERS），
 * 本地化会让匹配失效、并让同一首歌在不同语言下入库成不同记录，因此保持字面量。
 */
function fallbackMetaFromName(name: string): { title: string; artist: string } {
  const stem = name.replace(/\.[^.]+$/, '')
  const m = stem.match(/^(.{1,50}?)\s*-\s*(.{1,100})$/)
  if (m) return { title: m[2].trim(), artist: m[1].trim() }
  return { title: stem, artist: '未知艺术家' } // i18n-exempt: 落库哨兵值，参与匹配
}

/**
 * 通过 Range 读取文件头并解析元数据。
 * 时长修正见 @aurora/shared 的 normalizeHeadParsedDuration（截断缓冲区下的 MPEG 时长陷阱）。
 */
async function parseRemoteMetadata(
  plugin: StoragePlugin,
  cfg: LibrarySourceConfig,
  entry: RemoteEntry
): Promise<Partial<Track>> {
  const headLength = Math.max(1, Math.min(entry.size || METADATA_HEAD_BYTES, METADATA_HEAD_BYTES))
  const openRange = requireOpenRange(plugin)
  const resp = await openRange(withStorageSecrets(cfg), entry.path, 0, headLength - 1)
  // 非 2xx 一律按传输层失败处理（抛带 status 与传输层标记的错误）：远端拒绝/文件已消失时，
  // 不该用文件名兜底把一条读不到音源的记录写进曲库
  if (!resp.ok && resp.status !== 206) {
    // 必须保持「传输层错误」语义：调用方据此区分「传输层失败（可重试、不得写库）」。
    // 用 markTransportError 打标记（结构化判据），不引入具体错误类。
    // message 走字典渲染成当前语言的成品句（该错误最终经 events 或 reject 上屏）。
    throw markTransportError(
      auroraError('desktop.error.source.remoteReadFailed', { status: resp.status })
    )
  }
  const buf = new Uint8Array(await resp.arrayBuffer())
  const md = await parseBuffer(buf, { mimeType: guessAudioMime(entry.name) }, { duration: true, skipCovers: true })

  const duration = normalizeHeadParsedDuration(md.format, buf.length, entry.size || buf.length)

  const stem = entry.name
  const fallback = fallbackMetaFromName(stem)
  let title = md.common.title || fallback.title
  let artist = md.common.artist || fallback.artist
  if (!artist) artist = '未知艺术家' // i18n-exempt: 落库哨兵值，参与匹配

  return {
    title,
    artist,
    album: md.common.album || '未知专辑', // i18n-exempt: 落库哨兵值，参与匹配
    year: md.common.year,
    genre: md.common.genre?.[0],
    duration,
    trackNumber: typeof md.common.track.no === 'number' ? md.common.track.no : undefined,
  }
}

/**
 * 把远端目录项转成库内 Track（保留已有记录的 id / 播放统计 / 收藏）。
 *
 * 解析失败分两类处理：
 * - 传输层失败（抛 WebdavError：断网、超时、401）：向上抛，由调用方保留旧记录、
 *   不写入新记录——用一次网络抖动换来的占位元数据污染曲库是不可接受的；
 * - 格式解析失败（如 moov 原子在文件尾的 M4A，只读文件头拿不到元数据）：用文件名
 *   兜底入库。宁可元数据粗糙（标题取自文件名、时长 0），也不能把这首歌整个丢掉——
 *   用户看到的是「少了一张专辑」而不是「元数据不全」，后者可恢复、前者不可见。
 *   此时刻意不写 fileSize：跳过重解析的条件是「大小未变」，留空可让下次扫描重试，
 *   解析成功后自然补齐（代价只是这类少数文件的重复 Range 请求）。
 */
async function buildRemoteTrack(
  plugin: StoragePlugin,
  cfg: LibrarySourceConfig,
  entry: RemoteEntry,
  existing?: Track
): Promise<Track> {
  let meta: Partial<Track>
  let parsedSize: number | undefined = entry.size || undefined
  try {
    meta = await parseRemoteMetadata(plugin, cfg, entry)
  } catch (err) {
    // 结构判定，不依赖具体错误类：传输层失败（断网 / 超时 / 401）向上抛，
    // 由调用方保留旧记录、不写入新记录
    if (isStorageTransportError(err)) throw err
    const fallback = fallbackMetaFromName(entry.name)
    console.warn('[LibrarySource] 元数据解析失败，按文件名兜底入库:', entry.path, (err as Error).message)
    meta = { title: fallback.title, artist: fallback.artist, album: '未知专辑', duration: 0 } // i18n-exempt: 落库哨兵值
    parsedSize = undefined
  }
  return {
    id: existing?.id ?? uuidv4(),
    path: storagePathFor(cfg.id, entry.path),
    sourceId: cfg.id,
    remoteUrl: buildRemoteAudioUrl(cfg.id, entry.path),
    title: meta.title || fallbackMetaFromName(entry.name).title,
    artist: meta.artist || '未知艺术家', // i18n-exempt: 落库哨兵值，参与匹配
    album: meta.album || '未知专辑', // i18n-exempt: 落库哨兵值，参与匹配
    year: meta.year,
    genre: meta.genre,
    duration: meta.duration ?? 0,
    trackNumber: meta.trackNumber,
    // 远端封面按需提取（ensureCover 会走 Range），扫描阶段不拉图片
    coverPath: existing?.coverPath,
    fileSize: parsedSize,
    addedAt: existing?.addedAt ?? Date.now(),
    lastPlayedAt: existing?.lastPlayedAt,
    playCount: existing?.playCount ?? 0,
    liked: existing?.liked ?? false,
  }
}

/** 并发解析上限：受 NAS 并发连接数与网络往返限制，比本地扫描更保守 */
const REMOTE_CONCURRENCY = 4

export interface LibraryScanResult {
  tracks: Track[]
  /** 本次扫描是否完整可信（不完整时调用方不得据此清理旧记录） */
  complete: boolean
  /** 列举失败的目录数（供 UI 提示） */
  failedDirs: number
}

/**
 * 扫描一个媒体库来源并入库（协议无关：列举与读字节都经 MediaProvider）。
 *
 * 与本地扫描的关键差异——**清理策略**：
 * 远端的一次网络抖动就会让某个目录列举失败，若照搬本地"列表里没有的就删掉"，
 * 用户出门在外连不上家里的 NAS 就会丢掉整个曲库。因此只在「根目录列举成功 +
 * 全部子目录均无失败」时才执行缺失清理，否则只新增/更新，绝不删除。
 */
export async function scanLibrarySource(
  sourceId: string,
  onTrack?: (track: Track) => void
): Promise<LibraryScanResult> {
  const cfg = registry.get(sourceId)
  if (!cfg) throw auroraError('desktop.error.source.unknown', { id: sourceId })
  const plugin = pluginFor(cfg)
  const listAudio = requireListAudio(plugin)

  const failedDirs: string[] = []
  const entries = await listAudio(withStorageSecrets(cfg), {
    concurrency: REMOTE_CONCURRENCY,
    onError: (dir, err) => {
      failedDirs.push(dir)
      console.warn('[LibrarySource] 目录列举失败，已跳过:', cfg.name, dir || '/', err.message)
    },
  })

  const storagePaths = entries.map((e) => storagePathFor(cfg.id, e.path))
  const existingByPath = getTracksByPaths(storagePaths)

  const tracks: Track[] = []
  const toInsert: Track[] = []

  for (let i = 0; i < entries.length; i += REMOTE_CONCURRENCY) {
    const batch = entries.slice(i, i + REMOTE_CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (entry) => {
        const storagePath = storagePathFor(cfg.id, entry.path)
        const existing = existingByPath.get(storagePath)
        // 大小未变则直接复用，保留播放统计/收藏，也避免重复的 Range 请求
        if (existing && existing.fileSize && existing.fileSize === entry.size) return existing
        try {
          return await buildRemoteTrack(plugin, cfg, entry, existing)
        } catch (err) {
          // 走到这里只可能是传输层失败（格式问题已在 buildRemoteTrack 内兜底）：
          // 保留已有记录的旧元数据，新文件本次跳过、留待下次扫描
          console.warn('[LibrarySource] 读取失败，本次跳过:', entry.path, (err as Error).message)
          return existing ?? null
        }
      })
    )
    for (let j = 0; j < results.length; j++) {
      const track = results[j]
      if (!track) continue
      tracks.push(track)
      onTrack?.(track)
      const existing = existingByPath.get(track.path)
      if (!existing || existing.fileSize !== track.fileSize) toInsert.push(track)
    }
  }

  if (toInsert.length > 0) insertTracks(toInsert)

  const complete = failedDirs.length === 0
  if (complete) {
    const removed = deleteMissingRemoteTracks(storagePathPrefix(cfg.id), new Set(storagePaths))
    if (removed > 0) console.log('[LibrarySource] 清理已不存在的远端曲目:', removed)
  } else {
    console.warn(
      `[LibrarySource]「${cfg.name}」有 ${failedDirs.length} 个目录列举失败，本次跳过缺失清理，避免误删曲库` // i18n-exempt: 开发者日志，不进界面
    )
  }

  return { tracks, complete, failedDirs: failedDirs.length }
}

/** 移除某个媒体库来源的全部曲目记录（用户在设置里删除来源时调用），返回删除条数 */
export function removeLibrarySourceTracks(sourceId: string): number {
  const removed = deleteTracksBySourcePrefix(storagePathPrefix(sourceId))
  if (removed > 0) console.log('[LibrarySource] 已移除来源曲目:', sourceId, removed)
  return removed
}

/**
 * 按需补齐远端曲目的封面：与本地 ensureCover 同样的语义，但用 Range 读文件头
 * （内嵌封面总在文件前部），命中封面则落盘缓存并写回 coverPath。
 */
export async function ensureRemoteCover(track: Track, userData: string): Promise<string | null> {
  // 悬空路径不能早退：本地缓存文件被清掉后，库里会留下指向已删文件的 coverPath，
  // 早退返回它会被渲染层当成成功结果缓存一整个会话，远端封面再也补不回来
  if (isUsableCoverFile(track.coverPath)) return track.coverPath!
  if (track.coverPath) updateTrack(track.id, { coverPath: undefined })
  if (!track.sourceId || !track.remoteUrl) return null
  const cfg = registry.get(track.sourceId)
  if (!cfg) return null
  const parsed = track.path.startsWith(storagePathPrefix(track.sourceId))
    ? track.path.slice(storagePathPrefix(track.sourceId).length)
    : null
  if (!parsed) return null

  try {
    const plugin = pluginFor(cfg)
    const openRange = requireOpenRange(plugin)
    const head = await openRange(withStorageSecrets(cfg), parsed, 0, METADATA_HEAD_BYTES - 1)
    // 网络/服务端错误必须抛错，不能返回 null：渲染层只对「确认无内嵌封面」缓存结果，
    // 返回 null 会被当成"这首没有封面"缓存一整个会话，NAS 短暂不可达后封面就再也不补了
    if (!head.ok && head.status !== 206) {
      throw auroraError('desktop.error.source.remoteReadFailed', { status: head.status })
    }
    const buf = new Uint8Array(await head.arrayBuffer())
    const md = await parseBuffer(buf, { mimeType: guessAudioMime(parsed) }, { duration: false })
    const pic = md.common.picture?.[0]
    // 解析成功但确实没有内嵌图片：这才是真正的"无封面"，返回 null 让渲染层缓存
    if (!pic) return null
    const data = pic.data instanceof Uint8Array ? pic.data : new Uint8Array(pic.data)
    const ext = coverExtensionFor(data, pic.format)
    const dir = path.join(userData, 'aurora-music', 'covers')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, `${track.id}${ext}`)
    await fs.promises.writeFile(dest, data)
    // 登记进媒体缓存配额：封面与音频、歌词共用一份总容量
    registerCoverFile(track.id, dest)
    return dest
  } catch (err) {
    console.warn('[LibrarySource] 远端封面提取失败:', track.path, (err as Error).message)
    throw err
  }
}

/** 判断封面真实格式（与本地扫描同一套字节判定，避免按声明存错扩展名） */
function coverExtensionFor(data: Uint8Array, declaredFormat?: string): string {
  if (data && data.length >= 12) {
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return '.jpg'
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return '.png'
    if (
      data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
    ) {
      return '.webp'
    }
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return '.gif'
  }
  const m = (declaredFormat || '').toLowerCase()
  if (m.includes('png')) return '.png'
  if (m.includes('webp')) return '.webp'
  if (m.includes('gif')) return '.gif'
  return '.jpg'
}

/** 探测来源可用性（设置页「测试连接」）：只列举根目录，不递归、不入库 */
export async function probeLibrarySource(sourceId: string): Promise<{ ok: boolean; message: string; sample?: string[] }> {
  const cfg = registry.get(sourceId)
  if (!cfg) return { ok: false, message: mainTranslate()('desktop.error.source.notFound') }
  const plugin = storagePluginOf(cfg)
  if (!plugin) {
    return {
      ok: false,
      message: mainTranslate()('desktop.error.source.kindUnsupported', {
        pluginId: librarySourcePluginId(cfg),
      }),
    }
  }
  // 探测能力同样按「方法是否存在」判定：没有 probe 的插件不该显示「测试连接」入口，
  // 这里给出明确结论而不是抛错
  if (typeof plugin.probe !== 'function') {
    return {
      ok: false,
      message: mainTranslate()('desktop.error.source.capabilityMissing', {
        pluginId: plugin.id,
        capability: 'probe',
      }),
    }
  }
  try {
    return await plugin.probe(withStorageSecrets(cfg))
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}
