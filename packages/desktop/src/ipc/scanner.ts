import fs from 'fs'
import path from 'path'
import { parseBuffer } from 'music-metadata'
import iconv from 'iconv-lite'
import { v4 as uuidv4 } from 'uuid'
import type { Track } from '../types'
import { insertTrack, getTrackByPath } from './database'

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav', '.wma', '.opus'])

export interface ScanProgress {
  current: number
  total: number
  file: string
}

export type ProgressCallback = (progress: ScanProgress) => void

async function walkDir(dir: string, files: string[] = []): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true })
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

async function processFile(
  filePath: string,
  userData: string,
  coverCache: Map<string, string>
): Promise<Track | null> {
  try {
    const existing = getTrackByPath(filePath)
    if (existing) return existing

    const stat = await fs.promises.stat(filePath)
    const buf = await fs.promises.readFile(filePath)

    let metadata
    try {
      metadata = await parseBuffer(buf, { mimeType: getMimeType(filePath) }, { duration: true })
    } catch {
      return null
    }

    let title = metadata.common.title || path.basename(filePath, path.extname(filePath))
    let artist = metadata.common.artist || '未知艺术家'
    let album = metadata.common.album || '未知专辑'

    if (metadata.common.title && /[\u0000-\u001f]/.test(metadata.common.title)) {
      const fileBuf = fs.readFileSync(filePath)
      const asStr = decodeGbk(fileBuf)
      const titleMatch = asStr.match(/TIT2[\s\S]{0,200}/)
      if (titleMatch) {
        title = titleMatch[0].replace(/^TIT2[\s\S]{0,10}/, '').trim()
      }
    }

    const trackId = uuidv4()
    let coverPath: string | undefined

    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const pic = metadata.common.picture[0]
      try {
        const coverDest = getCoverCachePath(userData, trackId)
        await fs.promises.writeFile(coverDest, pic.data)
        coverPath = coverDest
        coverCache.set(album + '|' + artist, coverDest)
      } catch {
      }
    } else {
      const key = album + '|' + artist
      if (coverCache.has(key)) {
        coverPath = coverCache.get(key)
      }
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
      fileSize: stat.size,
      addedAt: Date.now(),
      playCount: 0,
      liked: false,
    }

    insertTrack(track)
    return track
  } catch (err) {
    console.error('Error processing file:', filePath, err)
    return null
  }
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/opus',
    '.wav': 'audio/wav',
    '.wma': 'audio/x-ms-wma',
  }
  return map[ext] || 'audio/mpeg'
}

export async function scanFolder(
  rootPath: string,
  userData: string,
  onProgress?: ProgressCallback
): Promise<Track[]> {
  const files = await walkDir(rootPath)
  const tracks: Track[] = []
  const coverCache = new Map<string, string>()

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    onProgress?.({ current: i + 1, total: files.length, file: path.basename(file) })
    const track = await processFile(file, userData, coverCache)
    if (track) {
      tracks.push(track)
    }
  }

  return tracks
}
