import type { LyricLine } from '@/types'
import { platform } from '@/services/platform'

export function parseLRC(content: string): LyricLine[] {
  const lines = content.split(/\r?\n/)
  const result: LyricLine[] = []

  const timeTagRegex = /\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g

  let hasAnyTimeTag = false
  const pendingNoTag: string[] = []

  for (const line of lines) {
    const matches = [...line.matchAll(timeTagRegex)]
    const text = line.replace(timeTagRegex, '').trim()
    if (!text) continue

    if (matches.length === 0) {
      // 无时间标签的行先暂存，待后续判断
      pendingNoTag.push(text)
      continue
    }

    hasAnyTimeTag = true
    for (const match of matches) {
      const minutes = parseInt(match[1], 10)
      const seconds = parseInt(match[2], 10)
      const millisStr = match[3] || '0'
      const millis = parseInt(millisStr.padEnd(3, '0').slice(0, 3), 10)
      const time = minutes * 60 + seconds + millis / 1000
      result.push({ time, text })
    }
  }

  // 如果整个歌词没有任何时间标签，作为纯文本歌词处理
  // 按行顺序分配时间，每行间隔 5 秒（仅用于滚动定位，无实际同步意义）
  if (!hasAnyTimeTag && pendingNoTag.length > 0) {
    return pendingNoTag.map((text, idx) => ({ time: idx * 5, text }))
  }

  result.sort((a, b) => a.time - b.time)
  return result
}

export function findActiveLine(lines: LyricLine[], currentTime: number): number {
  if (lines.length === 0) return -1

  let left = 0
  let right = lines.length - 1
  let result = -1

  while (left <= right) {
    const mid = Math.floor((left + right) / 2)
    if (lines[mid].time <= currentTime) {
      result = mid
      left = mid + 1
    } else {
      right = mid - 1
    }
  }

  return result
}

export function formatLyricTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export interface OnlineLyricsResult {
  lrc: string | null
  name: string
  artist: string
}

export async function searchOnlineLyrics(
  query: string,
  artist?: string,
  album?: string,
  duration?: number
): Promise<OnlineLyricsResult | null> {
  if (!platform.searchLyrics) return null
  try {
    return await platform.searchLyrics(query, artist, album, duration)
  } catch {
    return null
  }
}

export async function loadLyricsForTrack(track: {
  id: string
  title: string
  artist: string
  album?: string
  duration?: number
}): Promise<string | null> {
  // 1. 先读本地缓存
  if (platform.readLyrics) {
    const local = await platform.readLyrics(track.id)
    if (local) return local
  }
  // 2. 在线搜索（LRCLIB，传入 album 和 duration 提高匹配精度）
  const online = await searchOnlineLyrics(
    track.title,
    track.artist,
    track.album,
    track.duration
  )
  if (online?.lrc) {
    // 保存到本地缓存
    if (platform.saveLyrics) {
      await platform.saveLyrics(online.lrc, track.id)
    }
    return online.lrc
  }
  return null
}
