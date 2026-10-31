/**
 * 声明式清单 → 歌词解析器（运行时）。
 *
 * ## 为什么歌词单独一个文件、不复用 source.ts
 *
 * 歌词的响应形状与曲目列表**不是一类东西**：它没有"数组 + 字段映射"的通用结构，
 * 只有两种可能形态（JSON 候选对象 / 裸 LRC 文本），而 JSON 那一侧的字段容错
 * （`syncedLyrics` / `lrc` / `lyric` / `plainLyrics` / `lyrics`）已经在既有执行器
 * `lyricsSource.ts` 里经过实测打磨。让清单只声明"取哪个地址、返回哪种格式"，
 * 就能**直接复用**那份解析 —— 声明得越少，作者写错的可能越少。
 *
 * ## 与内置源的关系
 *
 * 已安装的歌词插件与内置 LRCLIB 走同一条聚合链（用户源优先、内置源兜底、
 * 延迟对冲并发，见 `lyricsSource.searchLyrics`）。所以这里只需要产出
 * 「一个 `LyricsSourceConfig` 形状的执行入口」，其余交给既有聚合。
 */

import type { LyricsSourceConfig } from '../../types'
import type { PluginManifest } from './types'
import { dropUnfilledParams, fillEndpointTemplate } from '../../auroraPreset'

/** 单次歌词请求预算：与内置源同口径（歌词是播放附属信息，等太久不如先出无歌词界面） */
const LYRICS_TIMEOUT_MS = 8000

/** 默认请求头：与 `lyricsSource.ts` 同口径 */
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'Aurora-Music (https://github.com/yib0601/aurora-music)',
  Accept: 'application/json',
}

/**
 * 填占位符 + 剔除空参数。
 *
 * **复用** `auroraPreset` 的那一对函数而不是在本层重写：它们的注释里写着几条实测结论
 * （空值参数会被上游当错误：LRCLIB 的 `artist_name=` 回 503、`duration=` 回 400；
 * 未替换的 `{limit}` 字面量会污染访问日志与缓存键）。重写一份等于放弃那些结论，
 * 而两份实现迟早会漂移。
 *
 * 为什么必须剔除：留成 `artist_name=` 会被上游当成**错误**而不是「没这个条件」。
 * 这条结论对声明式插件一模一样成立。
 */
export function fillLyricsUrl(template: string, values: Record<string, string>): string {
  return dropUnfilledParams(fillEndpointTemplate(template, values))
}

/** 歌词取词的结果（与 `LyricsSearchResult` 同形，但不引用它以避免层间倒挂） */
export interface DeclarativeLyricsHit {
  lrc: string
  name: string
  artist: string
}

/**
 * 从响应 JSON 里取候选数组。
 *
 * 与 `lyricsSource.extractItems` 同序：数组 → `results` → `data` → `songs` → `list` → 单对象。
 * 单对象视为"一条候选"（多数歌词 API 的 /get 形态就是单对象）。
 */
function extractCandidates(json: unknown): unknown[] {
  if (Array.isArray(json)) return json
  if (json && typeof json === 'object') {
    const record = json as Record<string, unknown>
    for (const key of ['results', 'data', 'songs', 'list']) {
      if (Array.isArray(record[key])) return record[key] as unknown[]
    }
    return [json]
  }
  return []
}

/** 取一个**真的有内容**的歌词字段值；纯空白视为没有（与 `lyricsSource.pickLyric` 同判据） */
function pickLyric(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/**
 * 把清单里的歌词声明包成「(query, artist, album, duration) → 歌词」的执行函数。
 *
 * `fetch` 由调用方注入：已安装插件的出网必须走**同一个**受白名单约束的实现
 * （见 `host.ts` 的 `createGuardedFetch`）。不给时用全局实现 —— 那只该出现在单测里，
 * 生产路径必须显式传。
 *
 * 失败语义：返回 `null`（不抛错）。与内置源的差别在此处是**刻意的**：内置源抛错后
 * 由聚合层 `firstSuccess` 的 `run` 捕获并转成落空；已安装插件在运行期没有一层
 * `try/catch` 包着它的抛错路径，让它自己把失败收敛成 `null` 更不容易漏。
 */
export function buildLyricsRunner(
  manifest: PluginManifest,
  fetchOverride?: typeof globalThis.fetch
): ((query: string, artist?: string, album?: string, duration?: number) => Promise<DeclarativeLyricsHit | null>) | null {
  const spec = manifest.lyrics
  if (!spec) return null

  return async (query, artist, album, duration) => {
    if (!query || !query.trim()) return null
    const url = fillLyricsUrl(spec.url, {
      track: query,
      query,
      artist: artist || '',
      album: album || '',
      duration: duration && duration > 0 ? String(Math.round(duration)) : '',
    })
    if (!url) return null

    // fetch 由调用方注入（主进程注入的已包主机白名单）；未注入时用全局实现
    const fetchImpl = (fetchOverride || globalThis.fetch) as typeof globalThis.fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LYRICS_TIMEOUT_MS)
    try {
      const resp = await fetchImpl(url, {
        headers: { ...DEFAULT_HEADERS, ...(spec.headers || {}) },
        signal: controller.signal,
      })
      if (!resp.ok) return null

      if (spec.format === 'lrc') {
        // 裸 LRC：响应体本身就是歌词文本。空壳（只有空白）按落空处理，
        // 否则会把一份渲染不出东西的文本当成命中，长期驻留在缓存里（见 lyrics.service
        // 的 isUsableLyrics：存量坏文件正是这么产生的）
        const text = await resp.text()
        if (!pickLyric(text)) return null
        return { lrc: text, name: query, artist: artist || '' }
      }

      let json: unknown
      try {
        json = await resp.json()
      } catch {
        return null
      }
      return pickCandidate(json, query, artist || '', duration)
    } catch {
      // 网络失败 / 超时一律按落空：聚合层继续推进下一档（与内置源一致）
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * 候选选择：优先带同步歌词的，同优先级里选时长最接近的。
 *
 * 与 `lyricsSource.searchLyricsSource` 的选择策略**逐条对齐**（同步词 +1000 分、
 * 再按 |Δduration| 扣分），因为这套权重是实测出来的：只按"有歌词"选会让
 * 同名的翻唱版本（时长差几十秒）挤掉原唱。
 */
function pickCandidate(
  json: unknown,
  fallbackName: string,
  fallbackArtist: string,
  duration: number | undefined
): DeclarativeLyricsHit | null {
  interface Candidate {
    synced: string | null
    plain: string | null
    name: string
    artist: string
    duration: number
  }

  const candidates: Candidate[] = []
  for (const item of extractCandidates(json)) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const synced =
      pickLyric(record.syncedLyrics) ?? pickLyric(record.lrc) ?? pickLyric(record.lyric)
    const plain = pickLyric(record.plainLyrics) ?? pickLyric(record.lyrics)
    if (!synced && !plain) continue
    candidates.push({
      synced,
      plain,
      name: String(record.trackName || record.name || record.title || fallbackName),
      artist: String(record.artistName || record.artist || record.singer || fallbackArtist),
      duration: Number(record.duration) || 0,
    })
  }
  if (candidates.length === 0) return null

  const targetDur = duration && duration > 0 ? Math.round(duration) : 0
  let best = candidates[0]
  let bestScore = -Infinity
  for (const candidate of candidates) {
    let score = candidate.synced != null ? 1000 : 0
    if (targetDur > 0 && candidate.duration > 0) score -= Math.abs(candidate.duration - targetDur)
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }

  const lrc = pickLyric(best.synced) ?? pickLyric(best.plain)
  if (!lrc) return null
  return { lrc, name: best.name, artist: best.artist }
}

/**
 * 已安装歌词插件 → `LyricsSourceConfig`（供既有聚合 `searchLyrics` 直接消费）。
 *
 * 为什么不改聚合层的入参类型：`LyricsSourceConfig` 已经是"一个有 url、能取词"的
 * 最小形状，声明式插件完全装得下它。把 `searchLyrics` 改成泛型或回调只会扩大
 * 改动面，而收益仅仅是"名字上更像插件"。
 *
 * `id` 用 `plugin:<manifestId>` 前缀：内置源的过滤与用户源的去重都按 id 判断
 * （见 `BUILTIN_LYRICS_IDS`），前缀保证外部插件的 id 永远不会撞上内置 id。
 */
export function lyricsConfigOf(manifest: PluginManifest): LyricsSourceConfig | null {
  if (!manifest.lyrics) return null
  return {
    // 注意：这里的 id 是"配置项 id"，不是插件 id —— 插件 id 保留在 `plugin_id`
    // 位置无法表达（LyricsSourceConfig 没有该字段），而访问限流/诊断都不需要它。
    id: `plugin:${manifest.id}`,
    name: manifest.id,
    sourceUrl: manifest.lyrics.url,
    ...(manifest.lyrics.headers ? { headers: manifest.lyrics.headers } : {}),
    enabled: true,
  }
}
