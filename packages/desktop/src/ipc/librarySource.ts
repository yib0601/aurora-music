/**
 * 媒体库来源（本机目录 / WebDAV 网络存储）在主进程侧的注册表与扫描实现。
 *
 * 为什么扫描放在主进程：
 * - 远端曲目的元数据要按字节区间读取（Range GET），渲染层的 fetch 受 CORS 约束，
 *   而 NAS 的 WebDAV 几乎不会返回 Access-Control-Allow-Origin；
 * - 来源配置（含口令）留在主进程，渲染层只持有 sourceId，播放走 aurora-remote://
 *   协议代理，口令既不进数据库也不进渲染层持久化。
 */

import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { parseBuffer } from 'music-metadata'
import {
  getMediaProvider,
  storagePathFor,
  storagePathPrefix,
  buildRemoteAudioUrl,
  guessAudioMime,
  normalizeHeadParsedDuration,
  METADATA_HEAD_BYTES,
  WebdavError,
  type LibrarySourceConfig,
  type MediaProvider,
  type RemoteEntry,
} from '@aurora/shared'
import type { Track } from '../types'
import {
  insertTracks,
  getTracksByPaths,
  deleteMissingRemoteTracks,
  deleteTracksBySourcePrefix,
} from './database'

/** sourceId → 来源配置。由渲染层在启动与配置变更时同步（syncLibrarySources） */
const registry = new Map<string, LibrarySourceConfig>()

export function syncLibrarySources(sources: LibrarySourceConfig[]): void {
  registry.clear()
  for (const s of sources) {
    // 口令只留在主进程内存里，其余字段本就可公开
    if (s?.id) registry.set(s.id, s)
  }
  console.log('[LibrarySource] 已同步来源配置:', registry.size, '个')
}

export function getLibrarySource(id: string): LibrarySourceConfig | undefined {
  return registry.get(id)
}

/**
 * 取来源对应的 provider。未注册的 kind（例如将来新增但尚未实现的 smb）
 * 会给出可读错误而不是静默失败。
 */
function providerFor(cfg: LibrarySourceConfig): MediaProvider {
  const provider = getMediaProvider(cfg.kind)
  if (!provider) throw new Error(`暂不支持的媒体库来源类型：${cfg.kind}`)
  return provider
}

/** 按扩展名给出一个占位标题/艺术家，与本地扫描的命名惯例保持一致 */
function fallbackMetaFromName(name: string): { title: string; artist: string } {
  const stem = name.replace(/\.[^.]+$/, '')
  const m = stem.match(/^(.{1,50}?)\s*-\s*(.{1,100})$/)
  if (m) return { title: m[2].trim(), artist: m[1].trim() }
  return { title: stem, artist: '未知艺术家' }
}

/**
 * 通过 Range 读取文件头并解析元数据。
 * 时长修正见 @aurora/shared 的 normalizeHeadParsedDuration（截断缓冲区下的 MPEG 时长陷阱）。
 */
async function parseRemoteMetadata(
  provider: MediaProvider,
  cfg: LibrarySourceConfig,
  entry: RemoteEntry
): Promise<Partial<Track>> {
  const headLength = Math.max(1, Math.min(entry.size || METADATA_HEAD_BYTES, METADATA_HEAD_BYTES))
  const resp = await provider.openRange(cfg, entry.path, 0, headLength - 1)
  // 非 2xx 一律按传输层失败处理（抛 WebdavError）：远端拒绝/文件已消失时，
  // 不该用文件名兜底把一条读不到音源的记录写进曲库
  if (!resp.ok && resp.status !== 206) {
    throw new WebdavError(`读取远端文件失败：HTTP ${resp.status}`, resp.status)
  }
  const buf = new Uint8Array(await resp.arrayBuffer())
  const md = await parseBuffer(buf, { mimeType: guessAudioMime(entry.name) }, { duration: true, skipCovers: true })

  const duration = normalizeHeadParsedDuration(md.format, buf.length, entry.size || buf.length)

  const stem = entry.name
  const fallback = fallbackMetaFromName(stem)
  let title = md.common.title || fallback.title
  let artist = md.common.artist || fallback.artist
  if (!artist) artist = '未知艺术家'

  return {
    title,
    artist,
    album: md.common.album || '未知专辑',
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
  provider: MediaProvider,
  cfg: LibrarySourceConfig,
  entry: RemoteEntry,
  existing?: Track
): Promise<Track> {
  let meta: Partial<Track>
  let parsedSize: number | undefined = entry.size || undefined
  try {
    meta = await parseRemoteMetadata(provider, cfg, entry)
  } catch (err) {
    if (err instanceof WebdavError) throw err
    const fallback = fallbackMetaFromName(entry.name)
    console.warn('[LibrarySource] 元数据解析失败，按文件名兜底入库:', entry.path, (err as Error).message)
    meta = { title: fallback.title, artist: fallback.artist, album: '未知专辑', duration: 0 }
    parsedSize = undefined
  }
  return {
    id: existing?.id ?? uuidv4(),
    path: storagePathFor(cfg.id, entry.path),
    sourceId: cfg.id,
    remoteUrl: buildRemoteAudioUrl(cfg.id, entry.path),
    title: meta.title || fallbackMetaFromName(entry.name).title,
    artist: meta.artist || '未知艺术家',
    album: meta.album || '未知专辑',
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
  if (!cfg) throw new Error(`未知的媒体库来源：${sourceId}`)
  const provider = providerFor(cfg)

  const failedDirs: string[] = []
  const entries = await provider.listAudio(cfg, {
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
          return await buildRemoteTrack(provider, cfg, entry, existing)
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
      `[LibrarySource]「${cfg.name}」有 ${failedDirs.length} 个目录列举失败，本次跳过缺失清理，避免误删曲库`
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
  if (track.coverPath) return track.coverPath
  if (!track.sourceId || !track.remoteUrl) return null
  const cfg = registry.get(track.sourceId)
  if (!cfg) return null
  const parsed = track.path.startsWith(storagePathPrefix(track.sourceId))
    ? track.path.slice(storagePathPrefix(track.sourceId).length)
    : null
  if (!parsed) return null

  try {
    const provider = providerFor(cfg)
    const head = await provider.openRange(cfg, parsed, 0, METADATA_HEAD_BYTES - 1)
    // 网络/服务端错误必须抛错，不能返回 null：渲染层只对「确认无内嵌封面」缓存结果，
    // 返回 null 会被当成"这首没有封面"缓存一整个会话，NAS 短暂不可达后封面就再也不补了
    if (!head.ok && head.status !== 206) {
      throw new Error(`读取远端文件失败：HTTP ${head.status}`)
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
  if (!cfg) return { ok: false, message: '来源配置不存在' }
  const provider = getMediaProvider(cfg.kind)
  if (!provider) return { ok: false, message: `暂不支持的媒体库来源类型：${cfg.kind}` }
  try {
    return await provider.probe(cfg)
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}
