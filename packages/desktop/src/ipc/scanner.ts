import fs from 'fs'
import path from 'path'
import { parseFile } from 'music-metadata'
import iconv from 'iconv-lite'
import { v4 as uuidv4 } from 'uuid'
import type { Track } from '../types'
import { insertTracks, getTracksByPaths, deleteTracksWithMissingFiles, countTracksByFolder, updateTrack } from './database'
import { registerCoverFile } from './mediaCache'
import { isUsableCoverFile } from './coverFile'
import { auroraError, searchOnlineTracks, fetchWithTimeout, firstArtistOf, cleanTitleForQuery, tradToSimp, pickCoverCandidate } from '@aurora/shared'
import type { OnlineSearchOptions } from '@aurora/shared'

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav', '.wma', '.opus'])

async function walkDir(dir: string, files: string[] = []): Promise<string[]> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (err) {
    // 单个目录不可读（权限/损坏）不应中断整个扫描，跳过即可
    console.warn('walkDir: 无法读取目录，已跳过:', dir, err)
    return files
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      await walkDir(fullPath, files)
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (AUDIO_EXTENSIONS.has(ext)) {
        files.push(fullPath)
      }
    }
  }
  return files
}

function decodeGbk(buffer: Buffer): string {
  try {
    return iconv.decode(buffer, 'gbk')
  } catch {
    return buffer.toString('utf8')
  }
}

/**
 * 判断封面扩展名：以**真实字节**为准，声明类型仅作兜底。
 * 不能只信 pic.format——部分打标工具会在 FLAC/MP3 里把 PNG 封面声明成
 * image/jpeg（实测曲库中确有此类文件），按声明存成 .jpg 会让 cover-local
 * 协议以错误的 Content-Type 提供图片。
 */
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
    if (data[0] === 0x42 && data[1] === 0x4d) return '.bmp'
  }
  const m = (declaredFormat || '').toLowerCase()
  if (m.includes('png')) return '.png'
  if (m.includes('webp')) return '.webp'
  if (m.includes('gif')) return '.gif'
  if (m.includes('bmp')) return '.bmp'
  return '.jpg'
}

function getCoverCachePath(userData: string, trackId: string, ext = '.jpg'): string {
  const dir = path.join(userData, 'aurora-music', 'covers')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return path.join(dir, `${trackId}${ext}`)
}

/**
 * 解析单个音频文件。
 * 性能关键点：skipCovers=true 跳过嵌入图片读取（封面改为按需提取），
 * 这是扫描提速的最大来源。
 */
async function processFile(
  filePath: string,
  stat: fs.Stats,
  userData: string,
  existingByPath: Map<string, Track>
): Promise<Track | null> {
  try {
    const existing = existingByPath.get(filePath)
    if (existing) {
      // 文件未变化（大小一致）直接复用，保留播放统计/收藏等用户数据；
      // 文件被修改（重新打标签/替换）则继续往下重新解析
      if (existing.fileSize === stat.size) {
        // 老版本未按「艺术家 - 歌名」拆分文件名留下的占位记录，
        // 重扫时补一次重解析修正元数据（幂等，修正后即不再触发）
        const legacyUntagged = existing.artist === '未知艺术家' && existing.title.includes('-') // i18n-exempt: 落库哨兵值，参与匹配
        if (!legacyUntagged) return existing
      }
    }

    let metadata
    try {
      metadata = await parseFile(filePath, { duration: true, skipCovers: true })
    } catch (err) {
      console.error('parseFile failed for', filePath, err)
      return null
    }

    const stem = path.basename(filePath, path.extname(filePath))
    let title = metadata.common.title || stem
    let artist = metadata.common.artist || ''
    if (!artist) {
      // 无艺术家标签时按「艺术家 - 歌名」文件名惯例拆分（音乐平台下载的常见命名）；
      // 否则 artist=未知艺术家 会让在线封面/歌词的匹配查询完全失效
      const m = stem.match(/^(.{1,50}?)\s*-\s*(.{1,100})$/)
      if (m) {
        artist = m[1].trim()
        if (!metadata.common.title) title = m[2].trim()
      }
    }
    if (!artist) artist = '未知艺术家' // i18n-exempt: 落库哨兵值，参与匹配
    const album = metadata.common.album || '未知专辑' // i18n-exempt: 落库哨兵值，参与匹配

    if (metadata.common.title && /[\u0000-\u001f]/.test(metadata.common.title)) {
      // GBK 兜底：标签在文件头部，只读前 64KB，避免把整个大文件读进内存
      const fd = await fs.promises.open(filePath, 'r')
      try {
        const headBuf = Buffer.alloc(64 * 1024)
        const { bytesRead } = await fd.read(headBuf, 0, headBuf.length, 0)
        const asStr = decodeGbk(headBuf.subarray(0, bytesRead))
        const titleMatch = asStr.match(/TIT2[\s\S]{0,200}/)
        if (titleMatch) {
          title = titleMatch[0].replace(/^TIT2[\s\S]{0,10}/, '').trim()
        }
      } finally {
        await fd.close()
      }
    }

    // 重新解析时保留原记录 id，保证封面文件名与播放统计延续
    const trackId = existing?.id ?? uuidv4()

    const track: Track = {
      id: trackId,
      path: filePath,
      title,
      artist,
      album,
      year: metadata.common.year,
      genre: metadata.common.genre?.[0],
      duration: metadata.format.duration || 0,
      trackNumber: typeof metadata.common.track.no === 'number' ? metadata.common.track.no : undefined,
      // 封面延迟到按需提取（getTrackById 时补齐），扫描阶段不读图片数据
      coverPath: existing?.coverPath,
      fileSize: stat.size,
      // 重新解析时保留原有的入库时间、播放统计与收藏状态
      addedAt: existing?.addedAt ?? Date.now(),
      lastPlayedAt: existing?.lastPlayedAt,
      playCount: existing?.playCount ?? 0,
      liked: existing?.liked ?? false,
    }

    return track
  } catch (err) {
    console.error('Error processing file:', filePath, err)
    return null
  }
}

/** 并发上限：受限于磁盘 IO 与 music-metadata 的 CPU 开销，8 是经验值 */
const PARSE_CONCURRENCY = 8

/**
 * 扫描指定目录，返回本次扫描到的全部曲目。
 * @param onTrack 可选回调：每解析完一首立即触发，用于渐进式刷新 UI
 *   （注意：并发批次内回调顺序非顺序，但 UI 端 addTracks 是去重追加，乱序无影响）
 */
export async function scanFolder(
  rootPath: string,
  userData: string,
  onTrack?: (track: Track) => void
): Promise<Track[]> {
  console.log('scanFolder starting:', rootPath)
  const files = await walkDir(rootPath)
  console.log('scanFolder found files:', files.length)

  // 一个文件都没扫到，但库里本来有该目录的记录 → 几乎不可能是「用户清空了音乐」，
  // 更常见的是网络共享（SMB/NFS）未挂载、外置盘掉线或根目录权限临时异常：
  // 挂载点丢失后目录往往仍然存在（只是空），isReadableDir 判不出来，walkDir 会
  // 返回空列表。若照常执行缺失清理，一次挂载故障就会把整个曲库清空。
  // 因此这里保守跳过清理并告警，用户仍可通过设置页移除该目录来主动清库。
  if (files.length === 0) {
    const known = countTracksByFolder(rootPath)
    if (known > 0) {
      console.warn(
        `scanFolder: 未发现任何音频文件但库中有 ${known} 条记录，已跳过缺失清理（疑似共享未挂载或权限异常）:`, // i18n-exempt: 开发者日志，不进界面
        rootPath
      )
      return []
    }
  }

  // 清理数据库中存在但文件已不存在的记录（歌曲被删除/移动后同步移除）
  const removed = deleteTracksWithMissingFiles(rootPath, new Set(files))
  if (removed > 0) console.log('scanFolder removed stale tracks:', removed)

  // 批量预取已有记录（一次 SQL），替代逐文件查询
  const existingByPath = getTracksByPaths(files)

  const tracks: Track[] = []
  const toInsert: Track[] = []

  // 并发解析：未变化的文件直接复用，只有新增/修改的文件才真正解析元数据
  for (let i = 0; i < files.length; i += PARSE_CONCURRENCY) {
    const batch = files.slice(i, i + PARSE_CONCURRENCY)
    const stats = await Promise.all(
      batch.map((f) => fs.promises.stat(f).catch(() => null))
    )
    const results = await Promise.all(
      batch.map((file, j) => {
        const stat = stats[j]
        if (!stat) return null
        return processFile(file, stat, userData, existingByPath)
      })
    )
    for (let j = 0; j < results.length; j++) {
      const track = results[j]
      const stat = stats[j]
      if (!track || !stat) continue
      tracks.push(track)
      // 立即通知 UI 追加显示（渐进式刷新），不等全部扫描完
      if (onTrack) onTrack(track)
      // 只有新解析的（不在已有记录里、或大小变化重新解析的）才需要写库
      const existing = existingByPath.get(batch[j])
      if (!existing || existing.fileSize !== stat.size) {
        toInsert.push(track)
      }
    }
  }

  // 批量事务插入，替代逐条 INSERT
  if (toInsert.length > 0) {
    insertTracks(toInsert)
  }

  return tracks
}

/**
 * 按需补齐封面：扫描阶段为提速跳过了嵌入图片读取，
 * 当 UI 需要某曲目的封面而记录中无 coverPath 时，单独提取并缓存。
 */
export async function ensureCover(track: Track, userData: string): Promise<string | null> {
  // 悬空路径不能早退（见 isUsableCoverFile）：早退会把一个不存在的文件当成功结果
  // 返回，渲染层缓存后封面就永久空了
  if (isUsableCoverFile(track.coverPath)) return track.coverPath!
  if (track.coverPath) updateTrack(track.id, { coverPath: undefined })
  try {
    const metadata = await parseFile(track.path, { duration: false })
    const pic = metadata.common.picture?.[0]
    if (!pic) return null
    const data = pic.data instanceof Uint8Array ? pic.data : new Uint8Array(pic.data)
    const coverDest = getCoverCachePath(userData, track.id, coverExtensionFor(data, pic.format))
    await fs.promises.writeFile(coverDest, data)
    // 登记进媒体缓存配额：封面与音频、歌词共用一份总容量
    registerCoverFile(track.id, coverDest)
    updateTrack(track.id, { coverPath: coverDest })
    return coverDest
  } catch (err) {
    // 抛错而非返回 null：渲染层只对"确认无内嵌封面"缓存结果，
    // 失败（文件暂不可读/解析异常）不缓存，会退避重试
    console.warn('封面提取失败:', track.path, err)
    throw err
  }
}

// 落库哨兵值：与 shared/coverMatch 的 PLACEHOLDER_ARTISTS 同一组取值，
// 本地化会让匹配失效（另见下方 fetchOnlineCover 的查询词清洗）
const META_PLACEHOLDERS = new Set(['未知艺术家', '未知专辑', '未知歌曲']) // i18n-exempt: 参与匹配的领域数据

/**
 * 在线补齐封面：文件无内嵌封面时的兜底。
 * 用「艺术家 + 标题」搜索用户配置的在线歌源，取标题匹配、歌手门禁通过的候选
 * 封面下载并落盘缓存（见 shared/coverMatch：歌手不符或带版本标记的一律不选，
 * 宁可无图也不贴错封面）。无匹配返回 null；网络/下载失败抛错
 * （渲染层按"失败可重试"处理，不会当作无封面缓存）。
 */
export async function fetchOnlineCover(
  track: Track,
  userData: string,
  options?: OnlineSearchOptions
): Promise<string | null> {
  // 同 ensureCover：悬空路径不早退，否则在线兜底会被一个已删的缓存文件拦住
  if (isUsableCoverFile(track.coverPath)) return track.coverPath!
  if (track.coverPath) updateTrack(track.id, { coverPath: undefined })
  const rawArtist = META_PLACEHOLDERS.has(track.artist) ? '' : track.artist
  const rawTitle = META_PLACEHOLDERS.has(track.title) ? '' : track.title
  // 查询词清洗：第一艺术家 + 去演唱者后缀的标题，并统一转简体（歌源多以简体索引）
  const artist = firstArtistOf(rawArtist)
  const title = cleanTitleForQuery(rawTitle, rawArtist)
  const query = tradToSimp(`${artist} ${title}`).trim()
  if (!query) return null

  const candidates = await searchOnlineTracks(query, options)
  const best = pickCoverCandidate(candidates, {
    title: rawTitle,
    artist: rawArtist,
    duration: track.duration,
    album: track.album,
  })
  if (!best?.coverUrl) return null

  const resp = await fetchWithTimeout(
    best.coverUrl,
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    },
    15000
  )
  if (!resp.ok) throw auroraError('desktop.error.source.coverHttpStatus', { status: resp.status })
  const buf = new Uint8Array(await resp.arrayBuffer())
  if (buf.length < 100) throw auroraError('desktop.error.source.coverInvalid')

  const coverDest = getCoverCachePath(userData, track.id, coverExtensionFor(buf))
  await fs.promises.writeFile(coverDest, buf)
  registerCoverFile(track.id, coverDest)
  updateTrack(track.id, { coverPath: coverDest })
  return coverDest
}
