import { Filesystem, Directory } from '@capacitor/filesystem'
import { Capacitor } from '@capacitor/core'
import * as mm from 'music-metadata-browser'
import type { Track } from '@/types'
import { MobileDatabase } from './database'

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav', '.wma', '.opus',
])

/**
 * 递归遍历目录，收集所有音频文件路径
 * Capacitor Filesystem.readdir 在 Android 上需要以 Directory.ExternalStorage 为根
 */
async function walkDir(dirPath: string, files: string[] = []): Promise<string[]> {
  let entries
  try {
    entries = await Filesystem.readdir({ path: dirPath, directory: Directory.ExternalStorage })
  } catch (err) {
    // 单个目录不可读（权限/损坏）不应中断整个扫描，跳过即可
    console.warn('walkDir: 无法读取目录，已跳过:', dirPath, err)
    return files
  }
  for (const entry of entries.files) {
    const fullPath = dirPath.endsWith('/') ? `${dirPath}${entry.name}` : `${dirPath}/${entry.name}`
    if (entry.type === 'directory' && !entry.name.startsWith('.')) {
      await walkDir(fullPath, files)
    } else if (entry.type === 'file') {
      const ext = entry.name.split('.').pop()?.toLowerCase()
      if (ext && AUDIO_EXTENSIONS.has(`.${ext}`)) {
        files.push(fullPath)
      }
    }
  }
  return files
}

/** 获取封面缓存目录路径（应用专属目录下 aurora-music/covers） */
async function getCoverCachePath(trackId: string): Promise<string> {
  const dir = 'aurora-music/covers'
  try {
    await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true })
  } catch (err: any) {
    // 目录已存在不报错
    if (err?.message && !/exist/i.test(err.message)) throw err
  }
  return `${dir}/${trackId}.jpg`
}

/** 获取歌词缓存目录路径（应用专属目录下 aurora-music/lyrics） */
async function getLyricsPath(trackId: string): Promise<string> {
  const dir = 'aurora-music/lyrics'
  try {
    await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true })
  } catch (err: any) {
    if (err?.message && !/exist/i.test(err.message)) throw err
  }
  return `${dir}/${trackId}.lrc`
}

async function processFile(
  filePath: string,
  coverCache: Map<string, string>,
  db: MobileDatabase
): Promise<Track | null> {
  try {
    const fileName = filePath.split('/').pop() || filePath

    // 复用已有记录（与桌面端 scanner.ts 一致：按 path 查询已有记录，避免重复解析）
    // 提前到读文件之前：已有记录无需任何 IO，避免每次扫描重复读大文件
    const existing = await db.getTrackByPath(filePath)
    if (existing) return existing

    // 通过 Capacitor 本地文件协议 fetch 读取（流式解码），
    // 不能用 Filesystem.readFile：它会把整个文件转成 base64 字符串，
    // 大文件（如 40MB flac）原生侧需分配 ~1.4 倍文件大小的堆内存，直接 OOM 崩溃
    const absPath = `/storage/emulated/0/${filePath.replace(/^\/+/, '')}`
    const resp = await fetch(Capacitor.convertFileSrc(absPath))
    if (!resp.ok) {
      console.warn('读取音频文件失败:', filePath, resp.status)
      return null
    }
    const blob = await resp.blob()

    let metadata
    try {
      metadata = await mm.parseBlob(blob, { duration: true })
    } catch (err) {
      console.error('parseBlob failed for', filePath, err)
      return null
    }

    const title = metadata.common.title || fileName.replace(/\.[^.]+$/, '')
    const artist = metadata.common.artist || '未知艺术家'
    const album = metadata.common.album || '未知专辑'

    const trackId = crypto.randomUUID()
    let coverPath: string | undefined

    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const pic = metadata.common.picture[0]
      try {
        const coverDest = await getCoverCachePath(trackId)
        // 将 pic.data (Uint8Array) 转 base64 写入
        let bin = ''
        const buf = pic.data instanceof Uint8Array ? pic.data : new Uint8Array(pic.data)
        const chunk = 0x8000
        for (let i = 0; i < buf.length; i += chunk) {
          bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk) as any)
        }
        const b64 = btoa(bin)
        await Filesystem.writeFile({
          path: coverDest,
          directory: Directory.Data,
          data: b64,
          recursive: true,
        })
        // 获取可直接在 WebView 中加载的 URL：
        // Filesystem.getUri 返回 file:///data/data/<pkg>/files/aurora-music/covers/xxx.jpg
        // Capacitor.convertFileSrc 把 file:// 转成 capacitor://localhost/... 或 https://localhost/_capacitor_file_/...
        // 直接存可访问 URL 到 coverPath，UI 层 getCoverSrc 原样返回即可
        const { uri } = await Filesystem.getUri({ path: coverDest, directory: Directory.Data })
        coverPath = Capacitor.convertFileSrc(uri)
        coverCache.set(album + '|' + artist, coverPath)
      } catch (err) {
        console.warn('保存封面失败:', err)
      }
    } else {
      const key = album + '|' + artist
      if (coverCache.has(key)) coverPath = coverCache.get(key)
    }

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
      coverPath,
      // 移动端拿 fileSize 需额外 stat，跳过避免重复 IO（与桌面端一致保留此字段，置为 undefined）
      fileSize: undefined,
      addedAt: Date.now(),
      playCount: 0,
      liked: false,
    }
    await db.insertTrack(track)
    return track
  } catch (err) {
    console.error('处理文件失败:', filePath, err)
    return null
  }
}

export async function scanFolder(
  rootPath: string,
  db: MobileDatabase,
  onTrack?: (track: Track) => void
): Promise<Track[]> {
  console.log('[Mobile] scanFolder starting:', rootPath)
  const files = await walkDir(rootPath)
  console.log('[Mobile] scanFolder found files:', files.length)

  // 清理数据库中存在但文件已不存在的记录（与桌面端一致）
  const removed = await db.deleteTracksWithMissingFiles(rootPath, new Set(files))
  if (removed > 0) console.log('[Mobile] scanFolder removed stale tracks:', removed)

  const tracks: Track[] = []
  const coverCache = new Map<string, string>()

  for (const file of files) {
    const track = await processFile(file, coverCache, db)
    if (track) {
      tracks.push(track)
      // 立即通知 UI 追加显示（渐进式刷新），不等全部扫描完
      if (onTrack) onTrack(track)
    }
  }

  return tracks
}

/** 读取本地缓存的歌词文件，不存在返回 null */
export async function readLyricsFile(trackId: string): Promise<string | null> {
  try {
    const path = await getLyricsPath(trackId)
    const result = await Filesystem.readFile({ path, directory: Directory.Data })
    // data:application/octet-stream;base64,xxxx 或直接 base64
    const raw = result.data as string
    const b64 = raw.includes(',') ? raw.split(',')[1] : raw
    // atob 返回的是 Latin-1 二进制字符串，需反解 UTF-8，否则中文会乱码
    // (写入端用 btoa(unescape(encodeURIComponent(lyrics))) 做 UTF-8 编码，这里做对称解码)
    return decodeURIComponent(escape(atob(b64)))
  } catch {
    return null
  }
}

/** 保存歌词到本地，返回保存的路径 */
export async function saveLyricsFile(lyrics: string, trackId: string): Promise<string> {
  const path = await getLyricsPath(trackId)
  const b64 = btoa(unescape(encodeURIComponent(lyrics)))
  await Filesystem.writeFile({
    path,
    directory: Directory.Data,
    data: b64,
    recursive: true,
  })
  return path
}
