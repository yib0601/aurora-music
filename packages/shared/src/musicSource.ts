import type { OnlineSourceConfig, OnlineSearchOptions, OnlineTrackSearchResult } from './types'

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

/**
 * 单个音乐源搜索（协议执行器核心）
 * - apiUrl 中 {query} 替换为 URL 编码后的搜索词
 * - 响应宽松解析：无播放地址的条目跳过，字段名多种命名兼容
 */
export async function searchMusicSource(
  source: OnlineSourceConfig,
  query: string
): Promise<OnlineTrackSearchResult[]> {
  if (!source.apiUrl || !source.apiUrl.includes('{query}')) {
    throw new Error(`源「${source.name}」的接口地址无效，必须包含 {query} 占位符`)
  }

  const url = source.apiUrl.replace('{query}', encodeURIComponent(query))
  const resp = await fetch(url, {
    headers: { ...DEFAULT_HEADERS, ...(source.headers || {}) },
    signal: AbortSignal.timeout(10000),
  })
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
      source: source.id,
      sourceName: source.name,
    })
  }
  return results
}

/**
 * 聚合在线搜索：并发调用所有启用的源
 * - 单源失败不影响其他源；全部失败时抛错，前端展示直白的中文网络错误提示
 */
export async function searchOnlineTracks(
  query: string,
  options?: OnlineSearchOptions
): Promise<OnlineTrackSearchResult[]> {
  const trimmed = (query || '').trim()
  const sources = (options?.sources || []).filter((s) => s && s.enabled && s.apiUrl)
  if (!trimmed || sources.length === 0) return []

  const settled = await Promise.allSettled(
    sources.map((s) => searchMusicSource(s, trimmed))
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
  return results
}
