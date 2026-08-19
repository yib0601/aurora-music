import fs from 'fs'
import path from 'path'
import { parseFile } from 'music-metadata'
import iconv from 'iconv-lite'
import { v4 as uuidv4 } from 'uuid'
import type { Track } from '../types'
import { insertTracks, getTracksByPaths, deleteTracksWithMissingFiles, updateTrack } from './database'

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

function getCoverCachePath(userData: string, trackId: string): string {
  const dir = path.join(userData, 'aurora-music', 'covers')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return path.join(dir, `${trackId}.jpg`)
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
      if (existing.fileSize === stat.size) return existing
    }

    let metadata
    try {
      metadata = await parseFile(filePath, { duration: true, skipCovers: true })
    } catch (err) {
      console.error('parseFile failed for', filePath, err)
      return null
    }

    let title = metadata.common.title || path.basename(filePath, path.extname(filePath))
    const artist = metadata.common.artist || '未知艺术家'
    const album = metadata.common.album || '未知专辑'

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
  if (track.coverPath) return track.coverPath
  try {
    const metadata = await parseFile(track.path, { duration: false })
    const pic = metadata.common.picture?.[0]
    if (!pic) return null
    const coverDest = getCoverCachePath(userData, track.id)
    await fs.promises.writeFile(coverDest, pic.data)
    updateTrack(track.id, { coverPath: coverDest })
    return coverDest
  } catch (err) {
    console.warn('封面提取失败:', track.path, err)
    return null
  }
}
