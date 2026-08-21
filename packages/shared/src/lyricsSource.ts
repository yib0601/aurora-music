import type { LyricsSourceConfig, LyricsSearchOptions, LyricsSearchResult } from './types'

// 统一默认请求头，可被源配置的 headers 覆盖
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'Aurora-Music (https://github.com/yib0601/aurora-music)',
  Accept: 'application/json',
}

interface LyricsCandidate {
  /** 带时间标签的同步歌词（优先） */
  synced: string | null
  /** 纯文本歌词（兜底） */
  plain: string | null
  name: string
  artist: string
  duration: number
}

/** 从响应 JSON 中容错提取候选列表：单对象视为单条候选，数组/包裹结构取数组 */
function extractItems(json: any): any[] {
  if (Array.isArray(json)) return json
  if (json && typeof json === 'object') {
    if (Array.isArray(json.results)) return json.results
    if (Array.isArray(json.data)) return json.data
    if (Array.isArray(json.songs)) return json.songs
    if (Array.isArray(json.list)) return json.list
    return [json]
  }
  return []
}

function toCandidate(item: any, fallbackName: string, fallbackArtist: string): LyricsCandidate | null {
  if (!item || typeof item !== 'object') return null
  const synced = item.syncedLyrics || item.lrc || item.lyric || null
  const plain = item.plainLyrics || item.lyrics || null
  if (!synced && !plain) return null
  return {
    synced: typeof synced === 'string' ? synced : null,
    plain: typeof plain === 'string' ? plain : null,
    name: String(item.trackName || item.name || item.title || fallbackName),
    artist: String(item.artistName || item.artist || item.singer || fallbackArtist),
    duration: Number(item.duration) || 0,
  }
}

/**
 * 单个歌词源搜索（协议执行器核心）
 * - apiUrl 占位符替换：{track}/{query} 歌曲名、{artist} 艺术家、{album} 专辑、{duration} 时长（秒）
 * - 多条候选时优先带时间标签的歌词，同优先级中选时长最接近的
 */
export async function searchLyricsSource(
  source: LyricsSourceConfig,
  query: string,
  artist?: string,
  album?: string,
  duration?: number
): Promise<LyricsSearchResult | null> {
  if (!source.apiUrl || !/\{(track|query)\}/.test(source.apiUrl)) {
    throw new Error(`歌词源「${source.name}」的接口地址无效，必须包含 {track} 或 {query} 占位符`)
  }

  const url = source.apiUrl
    .replace(/\{track\}/g, encodeURIComponent(query))
    .replace(/\{query\}/g, encodeURIComponent(query))
    .replace(/\{artist\}/g, encodeURIComponent(artist || ''))
    .replace(/\{album\}/g, encodeURIComponent(album || ''))
    .replace(/\{duration\}/g, duration && duration > 0 ? String(Math.round(duration)) : '')

  const resp = await fetch(url, {
    headers: { ...DEFAULT_HEADERS, ...(source.headers || {}) },
    signal: AbortSignal.timeout(8000),
  })
  if (!resp.ok) throw new Error(`歌词源「${source.name}」返回 HTTP ${resp.status}`)

  const json = (await resp.json()) as any
  const candidates = extractItems(json)
    .map((item) => toCandidate(item, query, artist || ''))
    .filter((c): c is LyricsCandidate => c !== null)
  if (candidates.length === 0) return null

  // 选择策略：带同步歌词的候选加基础分；有参考时长时扣掉时长差，取总分最高者
  const targetDur = duration && duration > 0 ? Math.round(duration) : 0
  let best = candidates[0]
  let bestScore = -Infinity
  for (const c of candidates) {
    let score = c.synced ? 1000 : 0
    if (targetDur > 0 && c.duration > 0) score -= Math.abs(c.duration - targetDur)
    if (score > bestScore) {
      best = c
      bestScore = score
    }
  }

  const lrc = best.synced || best.plain
  if (!lrc) return null
  return { lrc, name: best.name, artist: best.artist }
}

/**
 * 歌词聚合搜索：按配置顺序依次尝试各源，首个命中即返回
 * - 单源失败（网络错误/404）跳过并尝试下一个源
 */
export async function searchLyrics(
  query: string,
  artist?: string,
  album?: string,
  duration?: number,
  options?: LyricsSearchOptions
): Promise<LyricsSearchResult | null> {
  const trimmed = (query || '').trim()
  const sources = (options?.sources || []).filter((s) => s && s.enabled && s.apiUrl)
  if (!trimmed || sources.length === 0) return null

  for (const source of sources) {
    try {
      const result = await searchLyricsSource(source, trimmed, artist, album, duration)
      if (result) return result
    } catch (err) {
      console.warn(`[歌词源] 「${source.name}」搜索失败:`, err)
    }
  }
  return null
}
