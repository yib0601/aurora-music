import type { DownloadQuality, OnlineSourceConfig, OnlineSearchOptions, OnlineTrackSearchResult } from './types'
import { fetchWithTimeout } from './fetchWithTimeout'

// 统一默认请求头（部分接口对 UA 敏感），可被源配置的 headers 覆盖
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
}

/** 从响应 JSON 中容错提取结果数组（数组 / results / data / data.song.list / songs / list） */
function extractItems(json: any): any[] {
  if (Array.isArray(json)) return json
  if (json && typeof json === 'object') {
    if (Array.isArray(json.results)) return json.results
    if (Array.isArray(json.data)) {
      // data 可能是数组也可能是 { song: { list: [] } } 这类嵌套，递归一层
      return Array.isArray(json.data)
        ? json.data
        : Array.isArray(json.data?.song?.list)
          ? json.data.song.list
          : []
    }
    if (Array.isArray(json.songs)) return json.songs
    if (Array.isArray(json.list)) return json.list
  }
  return []
}

/** 音质档位的常见扁平字段命名（宽松兼容），值为该音质的播放/下载地址 */
const QUALITY_FIELD_NAMES: Record<DownloadQuality, string[]> = {
  '128': ['url_128', 'url128', '128k', 'lqUrl'],
  '320': ['url_320', 'url320', '320k', 'hqUrl'],
  flac: ['url_flac', 'urlflac', 'flacUrl', 'sqUrl', 'losslessUrl'],
}

/** 从结果项提取多音质地址：优先 qualityUrls 对象，其次常见扁平字段；均无则 undefined */
function extractQualityUrls(item: any): Partial<Record<DownloadQuality, string>> | undefined {
  const urls: Partial<Record<DownloadQuality, string>> = {}
  // qualityUrls / quality_urls 对象：{ "128": url, "320": url, "flac": url }
  const obj = item.qualityUrls || item.quality_urls
  if (obj && typeof obj === 'object') {
    for (const q of ['128', '320', 'flac'] as DownloadQuality[]) {
      if (typeof obj[q] === 'string' && obj[q]) urls[q] = obj[q]
    }
  }
  for (const q of ['128', '320', 'flac'] as DownloadQuality[]) {
    if (urls[q]) continue
    for (const field of QUALITY_FIELD_NAMES[q]) {
      const v = item[field]
      if (typeof v === 'string' && v) {
        urls[q] = v
        break
      }
    }
  }
  return Object.keys(urls).length > 0 ? urls : undefined
}

/**
 * 单个音乐源搜索（协议执行器核心）
 * - apiUrl 中 {query} 替换为 URL 编码后的搜索词；可选 {quality} 替换为音质档位（128/320/flac）
 * - 响应宽松解析：无播放地址的条目跳过，字段名多种命名兼容
 */
export async function searchMusicSource(
  source: OnlineSourceConfig,
  query: string,
  quality?: DownloadQuality
): Promise<OnlineTrackSearchResult[]> {
  if (!source.apiUrl || !source.apiUrl.includes('{query}')) {
    throw new Error(`源「${source.name}」的接口地址无效，必须包含 {query} 占位符`)
  }

  const url = source.apiUrl
    .replace('{query}', encodeURIComponent(query))
    .replace('{quality}', quality || '128')
  const resp = await fetchWithTimeout(
    url,
    { headers: { ...DEFAULT_HEADERS, ...(source.headers || {}) } },
    10000
  )
  if (!resp.ok) throw new Error(`源「${source.name}」返回 HTTP ${resp.status}`)

  const json = (await resp.json()) as any
  const rawItems = extractItems(json)

  const results: OnlineTrackSearchResult[] = []
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue
    // 兼容多种字段命名：audioUrl/url/playUrl/play_url/link
    const audioUrl = item.audioUrl || item.url || item.playUrl || item.play_url || item.link
    if (!audioUrl || typeof audioUrl !== 'string') continue // 无播放地址的结果跳过
    const rawId = item.id ?? item.songId ?? item.song_id ?? item.mid
    const idStr = rawId != null ? String(rawId) : String(results.length)
    results.push({
      id: `${source.id}-${idStr}`,
      title: String(item.title || item.name || item.songName || '未知歌曲'),
      artist: String(item.artist || item.singer || item.artists || '未知艺术家'),
      album: String(item.album || item.albumName || ''),
      duration: Number(item.duration || item.interval || 0) || 0,
      coverUrl:
        item.coverUrl || item.cover || item.picUrl || item.pic || item.albumPic || undefined,
      audioUrl,
      qualityUrls: extractQualityUrls(item),
      audioSource: typeof item.qualitySource === 'string' && item.qualitySource ? item.qualitySource : undefined,
      audioQuality: typeof item.quality === 'string' && item.quality ? item.quality : undefined,
      source: source.id,
      sourceName: source.name,
    })
  }
  return results
}

/** 有损音频地址特征：.mp3/.ogg/.m4a/.aac 等（含查询串），无损为 .flac/.wav */
const LOSSY_AUDIO_EXT_RE = /\.(mp3|ogg|m4a|aac)([?#]|$)/i

/** 源声称无损但地址实为有损格式（跨平台取址回落的典型特征，曲目匹配常不可靠） */
export function isSuspiciousAudio(result: OnlineTrackSearchResult): boolean {
  return result.audioQuality === 'flac' && LOSSY_AUDIO_EXT_RE.test(result.audioUrl)
}

/**
 * 可疑音源校正（纯函数，便于单测）：
 * 部分第三方源在请求无损时，元数据取自 A 平台、音频却跨平台回落到 B 后端凑数，
 * 曲目匹配不可靠（歌手对、录音是别人的）。检测到「声称 flac 但地址为有损格式」的
 * 条目时，用同一次搜索中 128 档（源的基础档，通常元数据与音频同源、匹配正确）里
 * 同 id 的结果替换音频地址；找不到同 id 时保持原样。
 */
export function correctSuspiciousAudioSources(
  results: OnlineTrackSearchResult[],
  baseline: OnlineTrackSearchResult[]
): OnlineTrackSearchResult[] {
  const byId = new Map<string, OnlineTrackSearchResult>()
  for (const b of baseline) if (b.id && !byId.has(b.id)) byId.set(b.id, b)
  return results.map((r) => {
    if (!isSuspiciousAudio(r)) return r
    const alt = byId.get(r.id)
    if (!alt || isSuspiciousAudio(alt)) return r
    return {
      ...r,
      audioUrl: alt.audioUrl,
      qualityUrls: alt.qualityUrls ?? r.qualityUrls,
      audioSource: alt.audioSource ?? r.audioSource,
      audioQuality: alt.audioQuality ?? r.audioQuality,
    }
  })
}

/**
 * 聚合在线搜索：并发调用所有启用的源
 * - 单源失败不影响其他源；全部失败时抛错，前端展示直白的中文网络错误提示
 * - 请求音质非 128 时额外拉一次 128 基线档，用于可疑音源校正（见 correctSuspiciousAudioSources）
 */
export async function searchOnlineTracks(
  query: string,
  options?: OnlineSearchOptions
): Promise<OnlineTrackSearchResult[]> {
  const trimmed = (query || '').trim()
  const sources = (options?.sources || []).filter((s) => s && s.enabled && s.apiUrl)
  if (!trimmed || sources.length === 0) return []

  const quality = options?.quality
  const needBaseline = !!quality && quality !== '128'
  const settled = await Promise.allSettled(
    sources.map((s) => searchMusicSource(s, trimmed, quality))
  )
  const results: OnlineTrackSearchResult[] = []
  let allFailed = true
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]
    if (r.status === 'fulfilled') {
      allFailed = false
      results.push(...r.value)
    } else {
      console.warn(`[歌源] 「${sources[i].name}」搜索失败:`, r.reason)
    }
  }
  if (allFailed) {
    throw new Error('所有音乐源请求失败，请检查网络连接或源配置')
  }

  if (!needBaseline) return results

  // 基线档仅用于校正，失败静默忽略
  const baselineSettled = await Promise.allSettled(
    sources.map((s) => searchMusicSource(s, trimmed, '128'))
  )
  const baseline: OnlineTrackSearchResult[] = []
  for (const r of baselineSettled) if (r.status === 'fulfilled') baseline.push(...r.value)
  return correctSuspiciousAudioSources(results, baseline)
}
