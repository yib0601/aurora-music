import { lyricEndpointOf } from '@aurora/shared'
import type { LyricLine, LyricsSourceConfig } from '@/types'
import { platform } from '@/services/platform'
import { useLibraryStore } from '@/stores/libraryStore'

export function parseLRC(content: string): LyricLine[] {
  const lines = content.split(/\r?\n/)
  const result: LyricLine[] = []

  // 标准 LRC 方括号时间戳 [00:41.20]
  const squareTagRegex = /\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g
  // 逐字（卡拉OK）LRC 尖括号时间戳 <00:41.207>
  const angleTagRegex = /<(\d{2}):(\d{2})(?:\.(\d{1,3}))?>/g

  const toTime = (match: RegExpMatchArray) => {
    const minutes = parseInt(match[1], 10)
    const seconds = parseInt(match[2], 10)
    const millisStr = match[3] || '0'
    const millis = parseInt(millisStr.padEnd(3, '0').slice(0, 3), 10)
    return minutes * 60 + seconds + millis / 1000
  }

  let hasAnyTimeTag = false
  const pendingNoTag: string[] = []

  for (const line of lines) {
    const text = line
      .replace(squareTagRegex, '')
      .replace(angleTagRegex, '')
      .trim()
    if (!text) continue

    const squareMatches = [...line.matchAll(squareTagRegex)]
    const angleMatches = [...line.matchAll(angleTagRegex)]

    if (squareMatches.length === 0 && angleMatches.length === 0) {
      // 无时间标签的行先暂存，待后续判断
      pendingNoTag.push(text)
      continue
    }

    hasAnyTimeTag = true
    if (squareMatches.length > 0) {
      // 行级时间戳：每个方括号标签生成一条（支持一行多时间戳）
      for (const match of squareMatches) {
        result.push({ time: toTime(match), text })
      }
    } else {
      // 逐字歌词行：整行文字合并为一条完整歌词，取首个尖括号时间为行时间
      result.push({ time: toTime(angleMatches[0]), text })
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

/**
 * 把「音源」翻成歌词执行器认识的源列表 —— 歌词能力随音源走，不再有独立的歌词源配置。
 *
 * 服务地址形态的音源由协议派生出歌词端点（服务端自描述里的 endpoints.lyric 优先，
 * 没有自描述时回落默认路径，见 shared/src/auroraPreset.ts 的 lyricEndpointOf），
 * 于是用户只填一条音源，搜索 / 歌单解析 / 歌词三种能力一起到位。
 * 派生出端点（含 {track}/{artist}/{duration} 占位符）的源才参与；顺序即音源的配置顺序。
 */
function lyricsSourcesFromLibrary(): LyricsSourceConfig[] {
  const { onlineSources } = useLibraryStore.getState()
  const out: LyricsSourceConfig[] = []
  for (const source of onlineSources) {
    if (!source.enabled) continue
    // 脚本源（kind='lx'）只提供取址，不经 aurora 端点协议，没有歌词能力
    if (source.kind === 'lx') continue
    const sourceUrl = lyricEndpointOf(source)
    if (!sourceUrl) continue
    out.push({
      id: source.id,
      name: source.name,
      sourceUrl,
      ...(source.headers ? { headers: source.headers } : {}),
      enabled: true,
    })
  }
  return out
}

export async function searchOnlineLyrics(
  query: string,
  artist?: string,
  album?: string,
  duration?: number
): Promise<OnlineLyricsResult | null> {
  if (!platform.searchLyrics) return null
  // 下传音源派生的歌词源：命中即返回；全部未命中时执行器内部回退到内置源兜底
  const sources = lyricsSourcesFromLibrary()
  try {
    return await platform.searchLyrics(query, artist, album, duration, { sources })
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
  // 2. 在线搜索（按用户配置的歌词源，传入 album 和 duration 提高匹配精度）
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
