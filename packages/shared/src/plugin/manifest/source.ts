/**
 * 声明式清单 → 可执行插件（运行时）。
 *
 * ## 这一层的唯一职责
 *
 * 把清单里「端点模板 + 字段映射」翻译成 `SourcePlugin` / 歌词解析器。**不做**任何
 * 领域判断：不判断该不该搜索、不决定音质、不猜测上游语义 —— 那些属于调用方与既有执行器。
 *
 * ## 三条实现约束
 *
 * 1. **不复制既有解析逻辑**。占位符填充与空参数剔除复用 `auroraPreset` 的
 *    `fillEndpointTemplate` / `dropUnfilledParams`（那对函数上有好几条实测结论：
 *    空参数会被上游当错误、未替换的 `{limit}` 字面量会污染日志与缓存键）。
 *    数组定位的容错顺序复用与 `musicSource.extractItems` 同口径的键链。
 * 2. **失败语义与内置插件一致**：搜索失败抛错（调用方聚合时逐源捕获）、
 *    取址失败返回 `null`（调用方回落按名搜索，绝不打断播放）、
 *    歌单取不到返回空数组（"这个歌单没有可导入的曲目"不是错误）。
 * 3. **网络只能走注入的 fetch**。`PluginContext.fetch` 对已安装插件已被主机白名单包过
 *    （见 `host.ts`），这里不再额外校验 —— 一个边界只在一处实现，才不会漂移。
 */

import type {
  DownloadQuality,
  MusicHallOptions,
  OnlineSourceConfig,
  OnlineTrackSearchResult,
  RecommendPlaylist,
  SourceProbeResult,
  SourceTrackRef,
  ToplistBrief,
  ToplistDetail,
  ToplistGroup,
  ToplistPreviewSong,
} from '../../types'
import type { PluginContext, SourcePlugin, ResolvedAudio } from '../types'
import type {
  DeclarativeRecommendEndpoint,
  DeclarativeResolveEndpoint,
  DeclarativeSearchEndpoint,
  DeclarativeToplistDetailEndpoint,
  DeclarativeToplistGroupFieldMap,
  DeclarativeToplistsEndpoint,
  DeclarativeTrackFieldMap,
  PluginManifest,
} from './types'
import { fillEndpointTemplate, dropUnfilledParams } from '../../auroraPreset'
import { fetchWithTimeout, isTimeoutError } from '../../fetchWithTimeout'
import { auroraError, toErrorInfo } from '../../i18n/errors'
import { readNumber, readString, valueAtPath } from './path'
import { resolveLocalized } from './localize'
import { buildScriptPlugin } from './script'
// 歌词源配置的构造（与 `lyrics.ts` 的运行时共用同一份投影，避免两处拼装漂移）
import { lyricsConfigOf } from './lyrics'
// 服务地址形态：从用户填的地址派生端点（取代清单里写死绝对 URL）
import { deriveService, type ServiceEndpointKey } from './service'

/** 声明式插件的单次请求预算：与内置协议执行器同一量级（搜索/取址 10s，歌单 15s） */
const SEARCH_TIMEOUT_MS = 10000
const RESOLVE_TIMEOUT_MS = 10000
const PLAYLIST_TIMEOUT_MS = 15000

/** 默认请求头：与既有执行器同口径（部分上游对 UA 敏感），可被清单里的 headers 覆盖 */
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
}

/**
 * 数组定位的容错键链。
 *
 * 与 `musicSource.extractItems` 逐字同序：声明式插件不该因为"作者没写 `items` 路径"
 * 就享有更差的兼容性 —— 这条键链是几年来对各种第三方实现的实际观测结果。
 */
const ITEM_KEYS = ['results', 'data', 'songs', 'list'] as const

/**
 * 从响应 JSON 里取候选数组。
 *
 * `itemsPath` 给了就**只**按它取（作者显式指定时不该被容错链"救"成别的字段：
 * 那会让"我明明写了 items，为什么取到空"变成无法排查的问题）。
 * 没给时依次尝试：数组本身 → 键链 → 键链里的一层嵌套（`data.song.list` 这类包裹）。
 */
export function extractItems(json: unknown, itemsPath?: string): unknown[] {
  if (itemsPath) {
    const value = valueAtPath(json, itemsPath)
    return Array.isArray(value) ? value : []
  }
  if (Array.isArray(json)) return json
  if (!json || typeof json !== 'object') return []
  const record = json as Record<string, unknown>
  for (const key of ITEM_KEYS) {
    if (Array.isArray(record[key])) return record[key] as unknown[]
  }
  // 一层嵌套：既有协议里存在 `{ data: { song: { list: [...] } } }` 这类包裹
  for (const key of ITEM_KEYS) {
    const nested = record[key]
    if (!nested || typeof nested !== 'object') continue
    for (const inner of ITEM_KEYS) {
      const value = (nested as Record<string, unknown>)[inner]
      if (Array.isArray(value)) return value
    }
  }
  return []
}

/** 单条原始条目 → 曲目字段（映射全部走清单，缺字段即 `undefined`，绝不抛错） */
interface MappedTrackFields {
  id?: string
  title: string
  artist: string
  album: string
  duration: number
  coverUrl?: string
  audioUrl?: string
}

/** 空值兜底：与 `musicSource` 同字面量（这是参与匹配的数据，不是界面文案，故不翻译） */
const UNKNOWN_TITLE = '未知歌曲'
const UNKNOWN_ARTIST = '未知艺术家'

/**
 * 按清单映射一个条目。
 *
 * 字段回落链的**顺序**取自 `musicSource`：标题与歌手各自有多个候选键名，
 * 而清单里一个字段只能写一条路径。所以约定：**一个字段名支持用 `|` 分隔多条路径**，
 * 按顺序取第一个有值的 —— 这让作者能表达"上游有时叫 artist 有时叫 singer"，
 * 而不必为混乱的上游写两个插件。
 */
function mapTrackFields(raw: unknown, map: DeclarativeTrackFieldMap): MappedTrackFields | null {
  if (!raw || typeof raw !== 'object') return null

  const pick = (path: string | undefined): unknown => {
    if (!path) return undefined
    for (const candidate of path.split('|')) {
      const value = valueAtPath(raw, candidate.trim())
      if (value !== undefined && value !== null && value !== '') return value
    }
    return undefined
  }

  const title = readString(pick(map.title)) || UNKNOWN_TITLE
  const artist = readString(pick(map.artist)) || UNKNOWN_ARTIST
  const album = readString(pick(map.album)) || ''
  // 时长：优先秒（duration），其次毫秒（durationMs → /1000 取整）。
  // 两条都声明是清单校验期就拦下的错误，这里只需各取其一。
  const durationSec = readNumber(pick(map.duration))
  const durationMs = readNumber(pick(map.durationMs))
  const duration =
    durationSec !== undefined
      ? Math.round(durationSec)
      : durationMs !== undefined
        ? Math.round(durationMs / 1000)
        : 0

  return {
    // id 必须是「字符串或数字」都收：上游用数字 id 是常态（QQ 的 songmid 是字符串，
    // 但第三方实现常给数字）。用 `readString` 会让数字 id 变成 undefined，
    // 结果是取址令牌里没有源内 id → 播放时永远回落按名搜索（静默串版本）。
    id: pickIdText(raw, map.id),
    title,
    artist,
    album,
    duration,
    coverUrl: readString(pick(map.coverUrl)),
    audioUrl: readString(pick(map.audioUrl)),
  }
}

/** 拼请求地址：填占位符 → 剔除空参数。这一对必须一起用（见 `dropUnfilledParams` 注释） */
function buildUrl(template: string, values: Record<string, string | number>): string {
  return dropUnfilledParams(fillEndpointTemplate(template, values))
}

/**
 * 取某个能力实际要用的 URL 模板。
 *
 * 优先级：**service 派生** > 清单静态 `spec.url`。
 *
 * 为什么派生优先：服务地址形态的清单里 `source.search.url` 之类通常是**缺席**的
 * （作者不可能写死自建主机的绝对地址），派生才是有值的那个。反过来，固定上游的
 * 插件没有 `service` 块，派生返回 null，自然落回静态模板 —— 两种形态共用一段执行代码。
 *
 * 派生不成立（用户没填地址 / 地址非法）时返回**空串**，让调用方明确跳过：
 * 发一个必然失败的请求只会把"没配置"伪装成"网络故障"。
 */
function endpointTemplateOf(
  manifest: PluginManifest,
  key: ServiceEndpointKey,
  staticTemplate: string | undefined,
  config: OnlineSourceConfig
): string {
  if (manifest.service) {
    const derived = deriveService(manifest.service, config)
    const fromService = derived?.endpoints?.[key]
    if (fromService) return fromService
    // 声明了 service 却没派生出来：说明用户地址缺失/非法，不该回落到静态模板
    // （静态模板在这种清单里本就是空或占位符），直接给空串让上层跳过
    if (!staticTemplate) return ''
  }
  return staticTemplate || ''
}

/**
 * 统一请求：注入头 + 超时（**含读体**） + 结构化错误。
 *
 * 错误码与既有执行器同一套（`core.error.source*`），用户看到的文案因此在
 * 「内置源」与「装来的源」之间没有差别 —— 文案不该暴露实现来源。
 *
 * ## 为什么不能直接用 `fetchWithTimeout`
 *
 * 那个函数走模块级 `customFetch`（移动端注入原生 HTTP 实现绕 CORS）。而插件契约明确
 * 「插件只依赖注入的 fetch」——同一份清单在桌面与移动必须行为相同，且已安装插件的
 * fetch 还被主机白名单包过（`host.ts`）；绕过它等于绕过白名单。
 *
 * ## 为什么超时必须覆盖读体
 *
 * 只给「建连接」设超时会漏掉最隐性的一类挂起：上游返回 200 与响应头后停住 body，
 * 连接一直开着直到 keep-alive 超时。既有执行器为此专门把读体纳入预算
 * （见 `fetchWithTimeout` 与 `bodyTimeoutCallers` 测试）。这里用同一个 AbortController
 * 覆盖 fetch 与 `resp.json()` 两段。
 */
async function requestJson(
  ctx: PluginContext,
  pluginName: string,
  url: string,
  headers: Record<string, string> | undefined,
  timeoutMs: number
): Promise<unknown> {
  const fetchImpl = ctx.fetch || globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const init: RequestInit = {
    // 三层合并，优先级从低到高：应用默认 → 清单声明（插件作者） → 用户配置（音源 headers）。
    // 用户必须能盖掉插件自带的头：那是他在设置页里表达的最后意图
    // （既有执行器 `musicSource` 也是「默认 ← 源配置」，口径一致）。
    headers: { ...DEFAULT_HEADERS, ...(headers || {}), ...(ctx.headers || {}) },
    signal: controller.signal,
  }

  try {
    let resp: Response
    try {
      resp = await fetchImpl(url, init)
    } catch (err) {
      if (isTimeoutError(err)) {
        throw auroraError('core.error.sourceTimeout', { name: pluginName, ms: timeoutMs })
      }
      const info = toErrorInfo(err)
      throw auroraError(
        'core.error.sourceRequestFailed',
        { name: pluginName, reason: info.detail || info.code },
        String(err)
      )
    }
    if (!resp.ok) {
      throw auroraError('core.error.sourceHttpStatus', { name: pluginName, status: resp.status })
    }
    try {
      return await resp.json()
    } catch (err) {
      if (isTimeoutError(err)) {
        throw auroraError('core.error.sourceTimeout', { name: pluginName, ms: timeoutMs })
      }
      throw auroraError('core.error.sourceNotJson', { name: pluginName })
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把清单里的一个列表型端点包成「取曲目数组」的函数。
 *
 * 三处复用（search / playlistTracks），差异只有占位符取值、超时，以及
 * **是否要求 audioUrl**（见 `requireAudioUrl` 的注释）。
 */
function listRunner(
  manifest: PluginManifest,
  spec: DeclarativeSearchEndpoint,
  timeoutMs: number,
  requireAudioUrl: boolean,
  /** 该端点在 service 派生映射里的键（`search` / `playlist`） */
  endpointKey: ServiceEndpointKey
) {
  return async (
    config: OnlineSourceConfig,
    values: Record<string, string | number>,
    ctx: PluginContext
  ): Promise<OnlineTrackSearchResult[]> => {
    const template = endpointTemplateOf(manifest, endpointKey, spec.url, config)
    if (!template) return []
    const url = buildUrl(template, values)
    const json = await requestJson(ctx, config.name || manifest.id, url, spec.headers, timeoutMs)
    const items = extractItems(json, spec.items)
    const results: OnlineTrackSearchResult[] = []
    for (const item of items) {
      const mapped = mapTrackFields(item, spec.map)
      if (!mapped) continue
      // 搜索结果**必须**有播放地址：没有地址的条目在界面上点不动，留着只会让
      // "这条源搜出来一堆但一首也播不了"变成无从解释的现象（既有执行器同样跳过）。
      // 歌单曲目则允许空地址：真实形态是"歌单只给元信息，取址另行触发"，
      // 那条路径由 resolveTrack 承担（空 audioUrl + trackRef 是一等协议语义）。
      if (requireAudioUrl && !mapped.audioUrl) continue
      const idStr = mapped.id ?? String(results.length)
      results.push({
        id: `${config.id}-${idStr}`,
        songmid: mapped.id,
        title: mapped.title,
        artist: mapped.artist,
        album: mapped.album,
        duration: mapped.duration,
        coverUrl: mapped.coverUrl,
        audioUrl: mapped.audioUrl || '',
        source: config.id,
        sourceName: config.name,
        // 惰性取址令牌：把源内 id 原样带回去，取址时不需要再查一次列表
        ...(mapped.audioUrl
          ? {}
          : {
              trackRef: {
                sourceId: config.id,
                platform: manifest.id,
                meta: { id: idStr },
              },
            }),
      })
    }
    return results
  }
}

/** 把清单映射成 `SourcePlugin`（注册进同一个音源注册表，上层无需知道它是清单还是代码） */
export function buildSourcePlugin(manifest: PluginManifest): SourcePlugin | null {
  const spec = manifest.source
  // 纯脚本插件（B 档，没有声明式端点）由 `script.ts` 构造：它的能力是脚本运行期自报的，
  // 与本函数的"清单声明什么就有什���"是两套来源，混在一处会让两边都读不清。
  if (!spec) {
    return manifest.script ? buildScriptPlugin(manifest) : null
  }

  const capabilities: string[] = []
  if (spec.search) capabilities.push('search')
  if (spec.resolveTrack) capabilities.push('resolveTrack')
  if (spec.playlistTracks) capabilities.push('playlistParse')
  if (manifest.lyrics) capabilities.push('lyrics')
  if (spec.recommend) capabilities.push('recommendPlaylists')
  if (spec.toplists) capabilities.push('toplists')
  if (spec.toplistDetail) capabilities.push('toplistDetail')
  // 空 `source: {}` 但有脚本块时不返回 null：B 档会在下面合并进来，
  // 此时"能力清单暂时为空"是正常的中间态。只有既无声明式端点又无脚本才真的什么也不做。
  if (capabilities.length === 0 && !manifest.script) return null

  const plugin: SourcePlugin = {
    id: manifest.id,
    // 外部插件的展示名是清单里的字面量，不是字典键。契约要求 `MessageKey`，
    // 这里放插件 id 作为**技术兜底**：渲染层取 `t(id)` 时会原样透出 id
    // （`core.ts` 的「查不到键就返回键本身」），而真正的展示名由
    // `PluginCatalogEntry.displayName` 提供（见 catalog.ts）—— 那条路径才是用户看到的。
    displayNameKey: manifest.id as SourcePlugin['displayNameKey'],
    version: manifest.version,
    // 注意：传的是 `capabilities` **数组本身**（同一引用）。下面 B 档合并会在
    // 合并成功后往同一个数组里 push，所以这里不必（也不能）二次赋值 ——
    // `capabilities` 在契约上是只读字段。
    capabilities: capabilities as SourcePlugin['capabilities'],
  }

  if (spec.search) {
    // requireAudioUrl = true：搜索结果是给用户点的，没有地址的条目在界面上点不动
    const run = listRunner(manifest, spec.search, SEARCH_TIMEOUT_MS, true, 'search')
    plugin.search = async (config, query, quality: DownloadQuality | undefined, ctx) =>
      run(config, { query, quality: quality || '128' }, ctx)
  }

  if (spec.playlistTracks) {
    // requireAudioUrl = false：歌单常只给元信息，地址在播放时按 id 现取
    const run = listRunner(manifest, spec.playlistTracks, PLAYLIST_TIMEOUT_MS, false, 'playlist')
    plugin.getPlaylistTracks = async (config, playlistId, ctx) =>
      run(config, { playlistId }, ctx)
  }

  if (spec.resolveTrack) {
    const resolve = spec.resolveTrack
    plugin.resolveTrack = async (config, ref: SourceTrackRef, quality, ctx) =>
      runResolve(manifest, resolve, config, ref, quality, ctx)
  }

  // ─── B 档脚本：与声明式端点**合并**（不是覆盖） ────────────────
  //
  // 一份清单同时带声明式端点与脚本块是合法且有用的组合，典型形态是
  // 「协议源负责搜索，脚本负责取址」（洛雪脚本绝大多数只实现 musicUrl）。
  // 合并规则：**脚本提供声明式没声明的能力**，声明式已有的优先 ——
  // 理由是同名能力下声明式更可预测（不执行代码），而脚本是补充手段。
  if (manifest.script) {
    const scriptPlugin = buildScriptPlugin(manifest)
    if (scriptPlugin) {
      if (typeof plugin.search !== 'function' && typeof scriptPlugin.search === 'function') {
        plugin.search = scriptPlugin.search
        capabilities.push('search')
      }
      if (
        typeof plugin.resolveTrack !== 'function' &&
        typeof scriptPlugin.resolveTrack === 'function'
      ) {
        plugin.resolveTrack = scriptPlugin.resolveTrack
        capabilities.push('resolveTrack')
      }
      // preflight / probe 只在声明式缺的时候补：两者语义不同（声明式探活是打一次搜索，
      // 脚本探活是把脚本跑一遍），混用会让"测试连接"的结论不可预测
      if (typeof plugin.preflight !== 'function' && scriptPlugin.preflight) {
        plugin.preflight = scriptPlugin.preflight
      }
      if (typeof plugin.probe !== 'function' && scriptPlugin.probe) {
        plugin.probe = scriptPlugin.probe
      }
    }
  }

  // ─── 在线发现（推荐歌单 / 榜单） ─────────────────────────────

  if (spec.recommend) {
    const browse = spec.recommend
    plugin.recommendPlaylists = async (config, options, ctx) =>
      runRecommend(manifest, browse, config, options, ctx)
  }

  if (spec.toplists) {
    const browse = spec.toplists
    plugin.toplists = async (config, options, ctx) =>
      runToplists(manifest, browse, config, options, ctx)
  }

  if (spec.toplistDetail) {
    const browse = spec.toplistDetail
    plugin.toplistDetail = async (config, options, ctx) =>
      runToplistDetail(manifest, browse, config, options, ctx)
  }

  // 探测：清单插件的"可用性"就是"端点能不能通"。只打一次最小的搜索请求
  // （`{query}` 用单字 `a`：这是探活，不是界面文案，也不该随语言漂移）。
  // 没有搜索能力的插件用取址端点探活是没意义的（需要真实 id），故直接给"未知"。
  if (spec.search) {
    plugin.probe = async (config, ctx): Promise<SourceProbeResult> => {
      try {
        await requestJson(
          ctx,
          config.name || manifest.id,
          buildUrl(spec.search!.url, { query: 'a', quality: '128' }),
          spec.search!.headers,
          SEARCH_TIMEOUT_MS
        )
        return { ok: true, kind: 'aurora', capabilities: [] }
      } catch (err) {
        return {
          ok: false,
          kind: 'aurora',
          capabilities: [],
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }
  }

  // ─── 歌词：把「本插件的歌词源」交给上层聚合器 ─────────────────
  //
  // 为什么不在这里取歌词：既有的 `searchLyrics` 做的是多源聚合（用户源优先 +
  // 内置 LRCLIB 兜底 + 延迟对冲），让每个插件各写一份取词等于把那套策略复写 N 遍。
  // 插件只回答"把哪条源交出去"，聚合仍归 `lyricsSource.ts`。
  //
  // 改造前 aurora 声明了 `lyrics` 能力却没有对应方法，能力只能靠协议私有的
  // `lyricEndpointOf()` 派生体现 —— 声明式插件因此在歌词链路上完全接不进来。
  if (manifest.lyrics) {
    // 服务地址形态：歌词端点从用户填的地址派生（`service.endpoints.lyric`），
    // 覆盖清单里那个通常是缺席的静态地址。
    plugin.lyricsSource = (config) => {
      const base = lyricsConfigOf(manifest)
      if (!base) return null
      if (!manifest.service) return base
      const derived = deriveService(manifest.service, config)
      const lyricUrl = derived?.endpoints?.lyric
      // 派生不出来（用户没填地址）= 此刻没有歌词源，明确返回 null 让上层跳过
      return lyricUrl ? { ...base, sourceUrl: lyricUrl } : null
    }
  }

  return plugin
}

/**
 * 取址：单对象响应 → 可播放地址。
 *
 * 失败返回 `null`（不是抛错）：与内置插件同一约定 —— 取址失败要能静默回落到按名搜索，
 * 不该把用户挡在播放之前。
 */
async function runResolve(
  manifest: PluginManifest,
  spec: DeclarativeResolveEndpoint,
  config: OnlineSourceConfig,
  ref: SourceTrackRef,
  quality: DownloadQuality | undefined,
  ctx: PluginContext
): Promise<ResolvedAudio | null> {
  // 源内 id：清单映射写 `id`；aurora 协议把同样的值放在 `songmid` 上。
  // 两者都认，才能让「服务地址形态」的清单复用 `trackRefFor` 构造的令牌
  // （那里同时填了 `songmid` 与 `id`，见 `plugin/trackAudio.ts`）。
  const songId =
    readString(ref?.meta?.id) || readString(ref?.meta?.songId) || readString(ref?.meta?.songmid)
  if (!songId) return null

  const template = endpointTemplateOf(manifest, 'track', spec.url, config)
  if (!template) return null

  let json: unknown
  try {
    json = await requestJson(
      ctx,
      config.name || manifest.id,
      buildUrl(template, { id: songId, quality: quality || '128' }),
      spec.headers,
      RESOLVE_TIMEOUT_MS
    )
  } catch {
    // 取址失败一律 null：上层回落按名搜索（既有编排约定，绝不打断播放）
    return null
  }

  const map = spec.map
  /*
   * `map` 里的路径**相对整个响应体**（作者看到的就是原始 JSON，不需要猜我们有没有
   * 偷偷脱一层壳）。但上游形态确实多变，所以这里按一个**固定顺序**依次尝试几个
   * 常见承载位置，取第一个能解析出 `audioUrl` 的：
   *
   *   1. 响应体本身          `{ playUrl: ... }` / `{ data: { playUrl: ... } }`
   *   2. `data`              `{ data: { ... } }` 配 `map.audioUrl = 'playUrl'`
   *   3. `results[0]`        `{ results: [{ ... }] }`
   *   4. `data.results[0]`
   *
   * 顺序固定 + 只认能解析出地址的那一个，不做"合并多层的字段"——那会让
   * "到底从哪一层取的"变得不可解释，出问题时作者无法复现。
   */
  const resolved = firstResolvableTarget(json, (target) => readString(valueAtPath(target, map.audioUrl)))
  if (!resolved) return null

  const { target, value: audioUrl } = resolved
  const out: ResolvedAudio = { url: audioUrl }
  const qualityLabel = readString(valueAtPath(target, map.quality))
  if (qualityLabel) out.quality = qualityLabel
  const cover = readString(valueAtPath(target, map.coverUrl))
  if (cover) out.coverUrl = cover
  const expireAt = readNumber(valueAtPath(target, map.expireAt))
  if (expireAt !== undefined) out.expireAt = expireAt
  // 只有显式的 `true` 才标记试听：缺失或 false 都不挂该字段
  const isPreview = valueAtPath(target, map.isPreview)
  if (isPreview === true) out.isPreview = true
  return out
}

/**
 * 在几个常见承载位置上依次找「能解析出真值」的那一层。
 *
 * 抽成通用小函数是因为它只依赖一个探针（`probe`），与"找什么字段"无关 ——
 * 将来曲目列表需要同样的定位逻辑时可以直接复用，不会写出第二套顺序。
 */
function firstResolvableTarget<T>(
  json: unknown,
  probe: (target: unknown) => T | undefined
): { target: unknown; value: T } | null {
  for (const candidate of responseCandidates(json)) {
    const value = probe(candidate)
    if (value !== undefined) return { target: candidate, value }
  }
  return null
}

/** 取址响应可能的承载位置（顺序即优先级，见 `runResolve` 注释） */
function responseCandidates(json: unknown): unknown[] {
  if (!json || typeof json !== 'object') return []
  const out: unknown[] = [json]
  const record = json as Record<string, unknown>
  const data = record.data
  const results = record.results
  if (Array.isArray(results)) out.push(results[0])
  if (data && typeof data === 'object') {
    out.push(data)
    const nested = (data as Record<string, unknown>).results
    if (Array.isArray(nested)) out.push(nested[0])
  }
  return out.filter((item) => item !== undefined && item !== null)
}

/** 已安装插件的展示名（供 catalog / UI 用；`id` 兜底保证永不为空） */
export function manifestDisplayName(manifest: PluginManifest, locale: string): string {
  return resolveLocalized(manifest.name, locale, manifest.id)
}

/** 已安装插件的说明（可缺省：没有说明时返回空串，UI 自行决定是否显示副标题） */
export function manifestDescription(manifest: PluginManifest, locale: string): string {
  return manifest.description ? resolveLocalized(manifest.description, locale, '') : ''
}

// ─── 在线发现的三个执行器 ──────────────────────────────────────
//
// 三个函数结构相同：填模板 → 请求 → 按清单映射 → 组装成应用形状。
// 与搜索执行器的差别只有一处：**空结果不是错误**。推荐/榜单是浏览型能力，
// 「该源这个分类下没有内容」与「该源不支持」在用户看来都不该变成错误页，
// 所以取不到条目时返回空数组/空详情，只有网络与解析失败才抛错。
//
// 复用 `mapTrackFields` 的 `pick` 语义（`|` 多路径）是刻意的：上游字段名不统一的
// 问题在在线发现里一样存在（QQ 的 dissid / dissname / imgurl 就是典型）。

/** 在线发现的可选占位符取值（页面/分类等参数是「建议」，插件实现不了就忽略） */
function hallValues(options: MusicHallOptions, extra: Record<string, string | number> = {}) {
  return {
    categoryId: options?.categoryId || '',
    sortId: options?.sortId || '',
    page: options?.page ?? '',
    limit: options?.limit ?? '',
    preview: options?.preview ?? '',
    ...extra,
  }
}

/** 按 `|` 分隔的多路径取第一个有值的字符串 */
function pickString(source: unknown, path: string | undefined): string | undefined {
  if (!path || !source || typeof source !== 'object') return undefined
  for (const candidate of path.split('|')) {
    const value = readString(valueAtPath(source, candidate.trim()))
    if (value !== undefined) return value
  }
  return undefined
}

/** 同上，但取数字（时长、播放量、排名这些上游可能给字符串） */
function pickNumber(source: unknown, path: string | undefined): number | undefined {
  if (!path || !source || typeof source !== 'object') return undefined
  for (const candidate of path.split('|')) {
    const value = readNumber(valueAtPath(source, candidate.trim()))
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * 取 id 文本：接受字符串或数字（把数字转成字符串）。
 *
 * 为什么单独一个函数而不是复用 `pickString`：`readString` 刻意不做隐式转换
 * （见 `path.ts` 的注释 —— 它靠"取不到"让调用方决定是否回落别的键），
 * 但 id 字段的语义是"标识符"，数字形态是**同一个标识**的另一种写法，
 * 不转换会让整条记录被丢弃。
 */
function pickIdText(source: unknown, path: string | undefined): string | undefined {
  if (!path || !source || typeof source !== 'object') return undefined
  for (const candidate of path.split('|')) {
    const value = valueAtPath(source, candidate.trim())
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

/**
 * 推荐歌单列表。
 *
 * 丢弃规则与既有 `musicHall.fetchRecommendPlaylists` 一致：**无 id 或无名丢弃**。
 * 这两条不是洁癖：没有 id 的卡片点开取不到曲目（用户点了没反应），
 * 没有名字的卡片是一块空白（用户以为界面坏了）。
 */
async function runRecommend(
  manifest: PluginManifest,
  spec: DeclarativeRecommendEndpoint,
  config: OnlineSourceConfig,
  options: MusicHallOptions,
  ctx: PluginContext
): Promise<RecommendPlaylist[]> {
  const url = buildUrl(spec.url, hallValues(options))
  const json = await requestJson(ctx, config.name || manifest.id, url, spec.headers, SEARCH_TIMEOUT_MS)
  // 推荐列表的包裹键与搜索不同（`list` / `playlists` 在前），单独给一条容错链
  const items = extractItems(json, spec.items) || []
  const pool = items.length > 0 ? items : extractArrayByKeys(json, ['list', 'playlists'])

  const out: RecommendPlaylist[] = []
  for (const item of pool) {
    if (!item || typeof item !== 'object') continue
    // 同上：歌单 id 上游常给数字（QQ 的 dissid 就是数字），只认字符串会把整条推荐丢掉
    const id = pickIdText(item, spec.map.id)
    const name = pickString(item, spec.map.name)
    if (!id || !name) continue
    out.push({
      id,
      name,
      coverUrl: pickString(item, spec.map.coverUrl),
      listenNum: pickNumber(item, spec.map.listenNum),
      creatorName: pickString(item, spec.map.creatorName),
      createTime: pickString(item, spec.map.createTime),
      source: config.id,
      sourceName: config.name,
    })
  }
  return out
}

/**
 * 榜单列表（分组 → 组内榜单 → 可选预览曲目）。
 *
 * 容错三处，每一处都对应真实的第三方实现形态：
 * 1. 响应是裸数组 → 视为**单组**（很多源只有一个"排行榜"分组）
 * 2. 组内榜单数组缺失 → 该组丢弃（空组在界面上是一行空标题）
 * 3. 预览曲目缺失 → 该榜单保留但 `songs: []`（预览是装饰，不是必需）
 */
async function runToplists(
  manifest: PluginManifest,
  spec: DeclarativeToplistsEndpoint,
  config: OnlineSourceConfig,
  options: MusicHallOptions,
  ctx: PluginContext
): Promise<ToplistGroup[]> {
  const url = buildUrl(spec.url, hallValues(options))
  const json = await requestJson(ctx, config.name || manifest.id, url, spec.headers, SEARCH_TIMEOUT_MS)

  // 分组数组：清单给了路径就只认它；没给时兼容 `groups` / `group` / `data`，裸数组＝单组
  let rawGroups: unknown[] = []
  if (spec.groups) {
    const value = valueAtPath(json, spec.groups)
    rawGroups = Array.isArray(value) ? value : []
  } else if (Array.isArray(json)) {
    rawGroups = json
  } else {
    rawGroups = extractArrayByKeys(json, ['groups', 'group', 'data'])
  }

  const out: ToplistGroup[] = []
  const map = spec.map
  for (const rawGroup of rawGroups) {
    if (!rawGroup || typeof rawGroup !== 'object') continue
    // 裸数组形态下"组对象"其实就是榜单本身：此时把 groupName 留空、组内列表视为 [该对象]。
    // 这个判定用「组内榜单路径取不到数组」来识别，比猜响应形态稳。
    let rawBriefs: unknown[] = []
    if (map.toplists) {
      const value = valueAtPath(rawGroup, map.toplists)
      if (Array.isArray(value)) rawBriefs = value
    } else {
      rawBriefs = extractArrayByKeys(rawGroup, ['toplists', 'toplist', 'list'])
    }

    const looksLikeGroup = rawBriefs.length > 0
    const briefs = looksLikeGroup
      ? rawBriefs.map((raw) => mapBrief(raw, spec.map)).filter((brief) => brief !== null)
      : // 不是分组容器：把它当成单个榜单本身
        [mapBrief(rawGroup, spec.map)].filter((brief) => brief !== null)

    if (briefs.length === 0) continue
    out.push({
      groupId: pickNumber(rawGroup, map.groupId),
      // 组名缺失时给空串：兜底展示名是界面文案，由渲染层按语言补
      // （给中文字面量等于把语言冻在数据层，英文界面下会冒出中文）
      groupName: looksLikeGroup ? pickString(rawGroup, map.groupName) || '' : '',
      toplists: briefs,
    })
  }
  return out
}

/** 单个榜单条目 → `ToplistBrief`；无 id 或无名返回 null（点不开、看不清） */
function mapBrief(raw: unknown, map: DeclarativeToplistGroupFieldMap): ToplistBrief | null {
  if (!raw || typeof raw !== 'object') return null
  const itemMap = map.item
  // 榜单 id 上游既可能给数字也可能给字符串（QQ 的 topId 是数字，第三方常给 slug），
  // 所以这里不能用 `pickString`（它只认字符串，数字会得到 undefined，
  // 整条榜单会被静默丢弃 —— 表现是"榜单列表永远空"）。改成「字符串或数字」都收。
  const idValue = pickIdText(raw, itemMap.id)
  const name = pickString(raw, itemMap.name)
  if (!idValue || !name) return null
  const idText = idValue

  const previews: ToplistPreviewSong[] = []
  if (itemMap.songs && itemMap.song) {
    const rawSongs = valueAtPath(raw, itemMap.songs)
    if (Array.isArray(rawSongs)) {
      rawSongs.forEach((rawSong, index) => {
        if (!rawSong || typeof rawSong !== 'object') return
        const title = pickString(rawSong, itemMap.song!.title)
        if (!title) return
        previews.push({
          // 排名缺失时按位置补：预览区要给"1 2 3"的序号，缺了就显示成 0 更糟
          rank: pickNumber(rawSong, itemMap.song!.rank) ?? index + 1,
          title,
          artist: pickString(rawSong, itemMap.song!.artist) || '',
          coverUrl: pickString(rawSong, itemMap.song!.coverUrl),
        })
      })
    }
  }

  return {
    // 榜单 id 在应用侧是 number：非数字 id（某些源用 slug）用 hashCode 转成稳定数字，
    // 否则详情���求拿不到原 id。转换规则写在这里而不是调用方 —— 详情端点由同一个插件提供。
    id: numericIdOf(idText),
    name,
    updateTime: pickString(raw, itemMap.updateTime),
    period: pickString(raw, itemMap.period),
    listenNum: pickNumber(raw, itemMap.listenNum),
    coverUrl: pickString(raw, itemMap.coverUrl),
    songs: previews,
  }
}

/**
 * 榜单 id 文本 → 应用侧的 number。
 *
 * 应用侧 `ToplistBrief.id` 是 `number`（历史形状，QQ 的 topId 都是数字）。第三方源的
 * 榜单 id 可能是 slug（`hot-100`）。两种都接受：数字原样，其它用稳定哈希 ——
 * 稳定是关键（不能每次刷新都变，否则详情缓存永远不命中）。
 *
 * 代价（如实记录）：哈希可能与另一个 slug 撞车。榜单数量是个位数到十几，
 * 撞车概率极低；真撞了表现为"点 A 榜单显示 B 的内容"，而用户至少能看出不对
 * （不是静默失效）。
 */
function numericIdOf(text: string): number {
  if (/^\d+$/.test(text)) return Number(text)
  // FNV-1a 32 位：短、稳定、无依赖
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/**
 * 榜单详情。
 *
 * 名称为空时**不抛错**：调用方会用它做页面标题，但"榜单名取不到"不该让整页失败
 * （曲目列表才是用户要看的东西）。这与 `musicHall.fetchToplistSongs` 的既有行为一致
 * （它也允许 name 为空串）。
 */
async function runToplistDetail(
  manifest: PluginManifest,
  spec: DeclarativeToplistDetailEndpoint,
  config: OnlineSourceConfig,
  options: MusicHallOptions,
  ctx: PluginContext
): Promise<ToplistDetail> {
  const id = options?.id ?? ''
  const url = buildUrl(spec.url, hallValues(options, { id: String(id) }))
  const json = await requestJson(ctx, config.name || manifest.id, url, spec.headers, SEARCH_TIMEOUT_MS)

  let rawSongs: unknown[] = []
  if (spec.items) {
    const value = valueAtPath(json, spec.items)
    rawSongs = Array.isArray(value) ? value : []
  } else {
    rawSongs = extractArrayByKeys(json, ['songs', 'songlist', 'list', 'data'])
  }

  const songs: ToplistDetail['songs'] = []
  rawSongs.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return
    const title = pickString(raw, spec.map.title)
    if (!title) return
    // 时长：秒优先，其次毫秒（与曲目映射同一套换算，避免两处各写一遍）
    const durationSec = pickNumber(raw, spec.map.duration)
    const durationMs = pickNumber(raw, spec.map.durationMs)
    const duration =
      durationSec !== undefined
        ? Math.round(durationSec)
        : durationMs !== undefined
          ? Math.round(durationMs / 1000)
          : 0
    songs.push({
      // 排名缺失按位置补：榜单详情左侧有"1 2 3"的序号列，缺了会全显示 0
      rank: pickNumber(raw, spec.map.rank) ?? index + 1,
      title,
      artist: pickString(raw, spec.map.artist) || '',
      album: pickString(raw, spec.map.album) || '',
      duration,
      coverUrl: pickString(raw, spec.map.coverUrl),
      // songmid 同理：它是"按 id 取址"的钥匙，数字形态丢掉就等于这条曲目永远按名重搜
      songmid: pickIdText(raw, spec.map.songmid),
    })
  })

  const meta = spec.meta || {}
  return {
    id,
    name: pickString(json, meta.name) || '',
    updateTime: pickString(json, meta.updateTime),
    total: pickNumber(json, meta.total) ?? songs.length,
    songs,
  }
}

/**
 * 按候选键链取数组（在线发现侧的包裹键与曲目列表不同）。
 *
 * 与 `extractItems` 分开是因为键链**顺序不同**：推荐用 `list` 在前（QQ 的推荐就是
 * `data.list`），而曲目搜索用 `results` 在前。共用一份会把两种响应形态混成一种。
 */
function extractArrayByKeys(root: unknown, keys: readonly string[]): unknown[] {
  if (!root || typeof root !== 'object') return []
  const record = root as Record<string, unknown>
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as unknown[]
  }
  // 一层嵌套（`data.list` 这类包裹）
  for (const key of keys) {
    const nested = record[key]
    if (!nested || typeof nested !== 'object') continue
    for (const inner of keys) {
      const value = (nested as Record<string, unknown>)[inner]
      if (Array.isArray(value)) return value
    }
  }
  return []
}
