import type { LyricsSourceConfig, LyricsSearchOptions, LyricsSearchResult } from './types'
import { firstSuccess } from './concurrency'
import { dropUnfilledParams, fillEndpointTemplate } from './auroraPreset'
import { fetchWithTimeout, isTimeoutError } from './fetchWithTimeout'
import { auroraError, toErrorInfo } from './i18n/errors'

// 统一默认请求头，可被源配置的 headers 覆盖
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'Aurora-Music (https://github.com/yib0601/aurora-music)',
  Accept: 'application/json',
}

/**
 * 内置歌词源（LRCLIB，开放免费接口，返回 syncedLyrics / plainLyrics / duration 字段，
 * 与本协议解析规则天然兼容）。
 * 外部不可调整：不进入用户配置列表、不出现在设置页，仅作为所有用户源未命中时的兜底。
 *
 * 名称用**品牌名**而不是「内置歌词源」这类中文短语：本字段是配置数据（也会出现在
 * 「歌词源「X」请求失败」这类诊断文案里），在模块级写成中文文案会把语言冻结在
 * 模块加载那一刻；品牌名与语言无关，任何界面语言下都读得通。
 */
export const BUILTIN_LYRICS_SOURCE: LyricsSourceConfig = {
  id: 'builtin-lrclib',
  name: 'LRCLIB',
  sourceUrl: 'https://lrclib.net/api/search?track_name={track}&artist_name={artist}',
  enabled: true,
}

/**
 * 内置「精确取词」源：LRCLIB 的 /api/get 精确查找，排在模糊检索兜底之前。
 *
 * 为什么值得多一次请求：/api/search 是模糊检索，实测同一首歌响应 154KB、p50 3~7s
 * （8s 预算下会超时）；/api/get 命中时只有 7.7KB、p50 1~2s，体积与延迟都低一个量级。
 * 代价是**参数必须齐**：album 不匹配时它回 404，所以它只当「快路径」，
 * 失败由聚合层按落空推进到 search 兜底。
 *
 * id 必须与模糊检索源不同——两者都要参与执行，同 id 会在过滤时被去掉一个。
 * 名称仍是品牌名（理由同上：配置数据不该把语言冻在模块加载那一刻）。
 */
export const BUILTIN_LYRICS_GET_SOURCE: LyricsSourceConfig = {
  id: 'builtin-lrclib-get',
  name: 'LRCLIB',
  sourceUrl:
    'https://lrclib.net/api/get?track_name={track}&artist_name={artist}&album_name={album}&duration={duration}',
  enabled: true,
}

/**
 * 内置源一律不参与「用户源」这一档：用户配置里出现同 id 条目会让同一条上游被
 * 打两遍（且顺序不受本模块控制，等于把优先级交给配置数据的偶然性）。
 */
const BUILTIN_LYRICS_IDS = [BUILTIN_LYRICS_GET_SOURCE.id, BUILTIN_LYRICS_SOURCE.id]

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

/**
 * 取一个**真的有内容**的歌词字段值，纯空白视为没有（返回 null）。
 *
 * 为什么必须 trim 判定：上游会对部分曲目返回空壳记录（实测 LRCLIB 给
 * `{"syncedLyrics":"   \n  "}`）。只判 `!value` 会把它当命中 —— 返回空白串 →
 * 调用方解析出 0 行 → UI 空态，而聚合层认为「已命中」不再回落下一个源；
 * 更糟的是这份空白会被写成本地 .lrc，此后永远走本地缓存命中 → 永久空态。
 *
 * 只用于**判定**，不改写内容：正常歌词的首尾空行与缩进都是内容的一部分，
 * 返回值始终是调用方给的原文，绝不返回 trim 过的文本。
 */
function pickLyric(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function toCandidate(item: any, fallbackName: string, fallbackArtist: string): LyricsCandidate | null {
  if (!item || typeof item !== 'object') return null
  // 逐字段判「有没有内容」，空壳字段等同于该字段不存在，于是字段名兜底链会继续往后找
  const synced = pickLyric(item.syncedLyrics) ?? pickLyric(item.lrc) ?? pickLyric(item.lyric)
  const plain = pickLyric(item.plainLyrics) ?? pickLyric(item.lyrics)
  if (!synced && !plain) return null
  return {
    synced,
    plain,
    name: String(item.trackName || item.name || item.title || fallbackName),
    artist: String(item.artistName || item.artist || item.singer || fallbackArtist),
    duration: Number(item.duration) || 0,
  }
}

/** 单个歌词源请求超时：歌词是播放的附属信息，等太久不如先出无歌词界面 */
const LYRICS_TIMEOUT_MS = 8000

/**
 * 单个歌词源搜索（协议执行器核心）
 * - sourceUrl 占位符替换：{track}/{query} 歌曲名、{artist} 艺术家、{album} 专辑、{duration} 时长（秒）
 * - 取值为空的占位符**整段剔除**（不留 `artist_name=` 这种空参数），见 dropUnfilledParams
 * - 多条候选时优先带时间标签的歌词，同优先级中选时长最接近的
 */
export async function searchLyricsSource(
  source: LyricsSourceConfig,
  query: string,
  artist?: string,
  album?: string,
  duration?: number
): Promise<LyricsSearchResult | null> {
  if (!source.sourceUrl || !/\{(track|query)\}/.test(source.sourceUrl)) {
    throw auroraError('core.error.lyricsUrlNoPlaceholder', {
      name: source.name,
      track: '{track}',
      query: '{query}',
    })
  }

  // 本地曲目元信息缺项是常态（艺术家可能为空、时长可能为 0），而这些参数留成空值会被
  // 上游当成**错误**而非「没这个条件」——LRCLIB 实测 `artist_name=` 回 503 ServerOverloaded、
  // `duration=` 回 400 `cannot parse float from empty string`。所以空值一律不传该参数。
  const url = dropUnfilledParams(
    fillEndpointTemplate(source.sourceUrl, {
      track: query,
      query,
      artist: artist || '',
      album: album || '',
      duration: duration && duration > 0 ? Math.round(duration) : '',
    })
  )

  let resp: Response
  try {
    resp = await fetchWithTimeout(
      url,
      { headers: { ...DEFAULT_HEADERS, ...(source.headers || {}) } },
      LYRICS_TIMEOUT_MS
    )
  } catch (err) {
    if (isTimeoutError(err)) {
      throw auroraError('core.error.lyricsTimeout', { name: source.name, ms: LYRICS_TIMEOUT_MS })
    }
    // reason 取归一后的技术原文（嵌套结构化错误时 message 是编码串，不能进句子）
    const info = toErrorInfo(err)
    throw auroraError(
      'core.error.lyricsRequestFailed',
      { name: source.name, reason: info.detail || info.code },
      String(err)
    )
  }
  if (!resp.ok) throw auroraError('core.error.lyricsHttpStatus', { name: source.name, status: resp.status })

  // 读体同样纳入上面的错误映射：fetchWithTimeout 已给 body 读装了超时预算，
  // 但读体失败若在这里裸抛，用户看到的就是 TimeoutError 的编码串（无源名、无「歌词源」语境）
  let json: any
  try {
    json = (await resp.json()) as any
  } catch (err) {
    if (isTimeoutError(err)) {
      throw auroraError('core.error.lyricsTimeout', { name: source.name, ms: LYRICS_TIMEOUT_MS })
    }
    throw auroraError('core.error.lyricsNotJson', { name: source.name })
  }
  const candidates = extractItems(json)
    .map((item) => toCandidate(item, query, artist || ''))
    .filter((c): c is LyricsCandidate => c !== null)
  if (candidates.length === 0) return null

  // 选择策略：带真实同步歌词的候选加基础分；有参考时长时扣掉时长差，取总分最高者。
  // `!= null` 是刻意的：toCandidate 已保证这里的 synced 要么是有内容的字符串、要么是 null，
  // 于是「有同步歌词」这个判定与「字段有内容」完全等价——空壳 synced 拿不到那 1000 分，
  // 也就不会把带真歌词的候选（或同一条候选里的 plain）挤掉。
  const targetDur = duration && duration > 0 ? Math.round(duration) : 0
  let best = candidates[0]
  let bestScore = -Infinity
  for (const c of candidates) {
    let score = c.synced != null ? 1000 : 0
    if (targetDur > 0 && c.duration > 0) score -= Math.abs(c.duration - targetDur)
    if (score > bestScore) {
      best = c
      bestScore = score
    }
  }

  // 最终把关：选出来的这份也要真的能用，纯空白按落空返回 null，让聚合层继续推进下一档源。
  // 与 toCandidate 那道是两层意图——那道管「这条候选算不算有歌词」，这道管「选出来的能不能用」，
  // 后者兜住任何绕过前者的路径（字段名兜底链、将来新增的解析分支）。
  const lrc = pickLyric(best.synced) ?? pickLyric(best.plain)
  if (!lrc) return null
  return { lrc, name: best.name, artist: best.artist }
}

/**
 * 歌词源的对冲延迟与同时在途上限。
 *
 * 串行版的耗时会**按源数累加**：单源超时 8s（见 LYRICS_TIMEOUT_MS），用户配三个源
 * 加内置 LRCLIB 就是最坏 32s 才出「无歌词」——用户看到的只是一直没有歌词，
 * 根本不知道在等什么。对冲不改变「谁优先」，只把等待从「累加」改成「重叠」。
 *
 * 600ms 的取值依据：LRCLIB 这类公共接口的首字节实测在 200~400ms 量级，
 * 窗口低于它基本不会把「本该命中第一档」的常见情形误伤成多源并发。
 *
 * maxInFlight 给 3：每多一档在途就多一份上游请求，而歌词是播放的附属请求，
 * 不该为它把用户配的全部源一次铺开。
 */
const LYRICS_HEDGE_MS = 600
const LYRICS_MAX_IN_FLIGHT = 3

/**
 * 歌词聚合搜索：用户配置的源优先，**按配置顺序启动**，首个命中即返回；
 * 全部未命中（或未配置任何源）时回退到内置源兜底。
 * - 单源失败（网络错误/404/400/503）跳过并推进下一源
 * - 内置源固定排在末尾，外部不可调整；顺序是「精确取词 → 模糊检索」：
 *   /api/get 命中即返回（7.7KB / 1~2s），参数不匹配时它回 404，自动落到 /api/search
 *   这一档模糊检索（154KB / p50 3~7s）。宁可多一次 404，也不让常见情形先等那 154KB。
 *
 * 并发策略是**延迟对冲**而非纯竞速（见 shared/concurrency.ts）：排在前面的一档
 * 在其对冲窗口内出结果时，后面的档根本不会被启动——「用户把某个源配在第一位」
 * 这个意图因此仍是决定性的，不会被网络快慢颠倒。
 */
export async function searchLyrics(
  query: string,
  artist?: string,
  album?: string,
  duration?: number,
  options?: LyricsSearchOptions
): Promise<LyricsSearchResult | null> {
  const trimmed = (query || '').trim()
  if (!trimmed) return null
  const userSources = (options?.sources || []).filter(
    (s) => s && s.enabled && s.sourceUrl && !BUILTIN_LYRICS_IDS.includes(s.id)
  )
  // 用户源优先，末尾追加两个内置源。顺序即优先级：firstSuccess 按此顺序启动各档，
  // 落空（null）或抛错才会推进——「首个非空结果胜出」的语义与旧串行版完全一致。
  const sources: LyricsSourceConfig[] = [
    ...userSources,
    BUILTIN_LYRICS_GET_SOURCE,
    BUILTIN_LYRICS_SOURCE,
  ]

  const hit = await firstSuccess(
    sources,
    async (source) => {
      try {
        return await searchLyricsSource(source, trimmed, artist, album, duration)
      } catch (err) {
        // 单源失败只记录不中断（其它源可能仍有歌词），按落空交给对冲调度推进下一档
        console.warn(`[歌词源] 「${source.name}」搜索失败:`, err)
        return null
      }
    },
    { hedgeMs: LYRICS_HEDGE_MS, maxInFlight: LYRICS_MAX_IN_FLIGHT }
  )
  return hit?.result ?? null
}
