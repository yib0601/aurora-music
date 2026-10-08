import type { DownloadQuality, OnlineSourceConfig, OnlineSearchOptions, OnlineTrackSearchResult } from './types'
import { searchEndpointOf } from './auroraPreset'
import { fetchWithTimeout, isTimeoutError } from './fetchWithTimeout'
import { getLxHostDeps } from './lxHost'
import { resolveLxScript, searchLxSourceForAggregate } from './lxResolver'

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
 * 单个音乐源搜索超时：与在线音乐的 10s 预算同量级（搜索是并发多源，单源不该拖长首屏）
 */
const SEARCH_TIMEOUT_MS = 10000

/**
 * 单个音乐源搜索（协议执行器核心）
 * - 端点由音源地址在执行时解析（searchEndpointOf），其中 {query} 替换为 URL 编码后的搜索词；
 *   可选 {quality} 替换为音质档位（128/320/flac）
 * - 响应宽松解析：无播放地址的条目跳过，字段名多种命名兼容
 */
export async function searchMusicSource(
  source: OnlineSourceConfig,
  query: string,
  quality?: DownloadQuality
): Promise<OnlineTrackSearchResult[]> {
  const endpoint = searchEndpointOf(source)
  if (!endpoint.includes('{query}')) {
    throw new Error(`源「${source.name}」的接口地址无效，必须包含 {query} 占位符`)
  }

  const url = endpoint
    .replace('{query}', encodeURIComponent(query))
    .replace('{quality}', quality || '128')
  let resp: Response
  try {
    resp = await fetchWithTimeout(
      url,
      { headers: { ...DEFAULT_HEADERS, ...(source.headers || {}) } },
      SEARCH_TIMEOUT_MS
    )
  } catch (err) {
    // 超时给中文结论：搜索是并发多源的，哪个源超时了要一眼看出
    if (isTimeoutError(err)) throw new Error(`源「${source.name}」请求超时（${SEARCH_TIMEOUT_MS}ms）`)
    throw new Error(`源「${source.name}」请求失败：${(err as Error).message}`)
  }
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
 * 用「条目自带的 128 档地址」就地替换，等价于拿一次额外 128 搜索来校正。
 * 服务端协议里主档响应会回填 qualityUrls / url_128（多音质直链），
 * 其中 128 档就是这个源的基础档、元数据与音频同源。可用于校正时完全不必再打一次网络。
 */
function correctSuspiciousFromOwnBaseline(
  results: OnlineTrackSearchResult[]
): OnlineTrackSearchResult[] {
  return results.map((r) => {
    if (!isSuspiciousAudio(r)) return r
    const own128 = r.qualityUrls?.['128']
    if (!own128) return r
    // 替换后必须 128 档自身不再可疑，否则保持原样（与 correctSuspiciousAudioSources 同口径）
    if (isSuspiciousAudio({ ...r, audioQuality: '128', audioUrl: own128 })) return r
    return { ...r, audioUrl: own128, audioQuality: '128' }
  })
}

/** 结果里是否还存在「声称无损、地址却有损」的可疑条目 */
function hasSuspicious(results: OnlineTrackSearchResult[]): boolean {
  return results.some((r) => isSuspiciousAudio(r))
}

/**
 * 搜索结果短 TTL 缓存（含并发合流）
 *
 * 为什么值得：搜索结果被「浮层反复开关 / 改字又改回 / 键盘上下切词」反复命中，
 * 而每次 miss 都是一轮完整上游链路。缓存只在内存、进程退出即失效，不落盘、不外发。
 * 取舍：TTL 取 30s——远小于上游直链自身时效（QQ vkey 数小时），
 * 又不至于让用户感知到「搜索结果不新鲜」。失败结果不缓存，避免把一次抖动固化半分钟。
 */
const SEARCH_CACHE_TTL_MS = 30_000
const SEARCH_CACHE_MAX = 200
const searchCache = new Map<string, { at: number; value: OnlineTrackSearchResult[] }>()
const searchInFlight = new Map<string, Promise<OnlineTrackSearchResult[]>>()

/** 清空搜索缓存（音源配置变更时调用）：合流中的请求不受影响，其完成后也不再写入 */
export function clearSearchCache(): void {
  searchCache.clear()
  searchInFlight.clear()
}

/**
 * ─── 形态分派（翻译层入口）─────────────────────────────────────
 *
 * 本文件其余部分是**原生协议**的执行：端点组装、响应解析、聚合。源形态差异
 * （服务协议 / 脚本宿主）只允许出现在下面这三个函数里，上层（UI / 播放 / 下载 /
 * 歌单导入）永远只拿到同一份 OnlineTrackSearchResult 与同一套语义。
 * 新增源形态时改这里 + sourceProbe（探测）+ 平台层的 resolveTrackAudio（取址）。
 */

/** 脚本形态是否具备检索所需的最小条件（它没有 aurora 端点，不能沿用端点判空） */
function isLxUsable(source: OnlineSourceConfig): boolean {
  return source.kind === 'lx' && !!source.enabled && !!String(source.sourceUrl || '').trim()
}

/** 源是否应参与聚合搜索：脚本形态走宿主，其余走端点判定 */
export function isSearchableSource(source: OnlineSourceConfig | null | undefined): boolean {
  if (!source) return false
  if (source.kind === 'lx') return isLxUsable(source)
  return !!source.enabled && !!searchEndpointOf(source)
}

/**
 * 单源搜索的缓存键前缀（纯函数，便于单测）。
 *
 * 脚本形态必须用「id + kind + 脚本地址」兜底：它没有 aurora 端点，若继续拿
 * searchEndpointOf 拼键，多个脚本源会一起退化成同一个空端点前缀 → 缓存串味。
 * 其余形态键形不变（仍是解析出的端点地址），保证既有缓存语义与测试口径不漂移。
 */
export function sourceCacheKeyOf(source: OnlineSourceConfig): string {
  if (source.kind === 'lx') return `lx\u0001${source.id}\u0001${String(source.sourceUrl || '').trim()}`
  return searchEndpointOf(source)
}

/**
 * 单源检索分派：脚本形态交给宿主（结果同样被包成原生结构后返回），其余走协议端点。
 * 脚本形态的条目可能只有元信息（`audioUrl` 为空串 + `trackRef` 令牌），
 * 地址由取址门面按需向源索取 —— 这一点对上层是透明的。
 */
function searchOneSource(
  source: OnlineSourceConfig,
  query: string,
  quality?: DownloadQuality
): Promise<OnlineTrackSearchResult[]> {
  return source.kind === 'lx'
    ? searchLxSourceForAggregate(source, query, getLxHostDeps())
    : searchMusicSource(source, query, quality)
}

/** 单源搜索 + 缓存。命中内存直接返回；同刻同键并发共享同一次网络执行（后到的等前一个）。
 *
 * key 同时纳入「解析出的端点地址」：用户改了音源地址而 id 未变时，缓存必须立刻失效。
 * 返回同一份数组引用——调用方只做遍历与拼接，不就地修改，无需拷贝。
 */
function searchSourceCached(
  source: OnlineSourceConfig,
  query: string,
  quality?: DownloadQuality
): Promise<OnlineTrackSearchResult[]> {
  const key = `${sourceCacheKeyOf(source)}\u0000${quality || ''}\u0000${query}`
  const hit = searchCache.get(key)
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) {
    // LRU 触达：重新插入即移到队尾
    searchCache.delete(key)
    searchCache.set(key, hit)
    return Promise.resolve(hit.value)
  }

  const running = searchInFlight.get(key)
  if (running) return running

  const exec = searchOneSource(source, query, quality)

  const task = exec
    .then((value: OnlineTrackSearchResult[]) => {
      searchCache.delete(key)
      searchCache.set(key, { at: Date.now(), value })
      while (searchCache.size > SEARCH_CACHE_MAX) {
        const oldest = searchCache.keys().next().value
        if (oldest === undefined) break
        searchCache.delete(oldest)
      }
      return value
    })
    .finally(() => {
      searchInFlight.delete(key)
    })
  searchInFlight.set(key, task)
  return task
}

/**
 * 聚合在线搜索：并发调用所有启用的源
 * - 单源失败不影响其他源；全部失败时抛错，前端展示直白的中文网络错误提示
 * - 请求音质非 128 时，另有 128 档用于可疑音源校正（见 correctSuspiciousAudioSources）
 *
 * 降低搜索耗时的三层手段（全部在客户端侧，源端无需配合）：
 * 1) 校正优先**就地取材**：主档结果若自带 qualityUrls['128']，直接用它替换可疑地址，
 *    完全省掉「再搜一次 128 档」那一整轮往返。实测源在 flac 请求下会回填 url_128，
 *    因此绝大多数情况都走这条零成本路径。
 * 2) 就地取材不成立（主档没回填 128 档：源不支持多音质）时，才补拉一次 128 基线档，
 *    且与主档**同轮并发**；旧实现是主档 await 完成后才发起的串行第二跳，白白多等一倍。
 * 3) 走 searchSourceCached：重复词命中内存，连一次往返都不出。
 */
export async function searchOnlineTracks(
  query: string,
  options?: OnlineSearchOptions
): Promise<OnlineTrackSearchResult[]> {
  const trimmed = (query || '').trim()
  const requested = (options?.sources || []).filter((s) => isSearchableSource(s))
  if (!trimmed || requested.length === 0) return []

  // lx 源需要宿主与脚本源码才能真正发起搜索；缺任一条件先摘掉并说明原因，
  // 否则「脚本源码不可得」会伪装成网络失败，把统一的中文报错推给用户。
  const sources: OnlineSourceConfig[] = []
  for (const s of requested) {
    if (s.kind !== 'lx') {
      sources.push(s)
      continue
    }
    if (!getLxHostDeps()) {
      console.warn(`[歌源] 跳过洛雪音源「${s.name}」：未初始化洛雪脚本宿主（缺少 lx.request 实现）`)
      continue
    }
    if (!(await resolveLxScript(s))) {
      console.warn(`[歌源] 跳过洛雪音源「${s.name}」：脚本源码不可得（配置未内联脚本且未注册脚本供应器）`)
      continue
    }
    sources.push(s)
  }
  if (sources.length === 0) return []

  const quality = options?.quality
  // 只有非 128 档才可能有「声称 flac」的可疑项；128 档自身永远不需要额外基线
  const qualityMatters = !!quality && quality !== '128'

  const mainSettled = await Promise.all(
    sources.map((s) =>
      searchSourceCached(s, trimmed, quality).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason) => ({ status: 'rejected' as const, reason })
      )
    )
  )
  const results: OnlineTrackSearchResult[] = []
  let allFailed = true
  for (let i = 0; i < mainSettled.length; i++) {
    const r = mainSettled[i]
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

  if (!qualityMatters) return results

  // 第一层：大多数源在主档响应里已回填 128 档地址，就地校正，零额外往返
  const inPlace = correctSuspiciousFromOwnBaseline(results)
  if (!hasSuspicious(inPlace)) return inPlace

  // 第二层：仍有就地校正不了的可疑项（主档没回填 128 档）→ 补拉 128 基线档。
  // 失败静默忽略，此时保留就地校正的结果即可（比串行版严格不差）
  // 洛雪源条目 audioUrl 为空串、不带音质声明，既不可能是可疑项，补拉基线对它也无意义，故排除在外。
  const auroraSources = sources.filter((s) => s.kind !== 'lx')
  if (auroraSources.length === 0) return inPlace
  const baselineSettled = await Promise.all(
    auroraSources.map((s) =>
      searchSourceCached(s, trimmed, '128').then(
        (value) => ({ status: 'fulfilled' as const, value }),
        () => ({ status: 'rejected' as const, value: [] as OnlineTrackSearchResult[] })
      )
    )
  )
  const baseline: OnlineTrackSearchResult[] = []
  for (const r of baselineSettled) if (r.status === 'fulfilled') baseline.push(...r.value)
  if (baseline.length === 0) return inPlace

  // 补拉到的基线档对「就地没修好的」那批继续兜底，最终口径与串行版一致
  return correctSuspiciousAudioSources(inPlace, baseline)
}
