import type { OnlineSourceConfig, PlaylistParseResult, ParsedSong } from './types'
import type { PluginContext } from './plugin/types'
import type { SourceEndpointInput } from './auroraPreset'
import { dropUnfilledParams, fillEndpointTemplate, playlistEndpointOf } from './auroraPreset'
import { firstSuccess } from './concurrency'
import { fetchWithTimeout, isTimeoutError } from './fetchWithTimeout'
import { auroraError, toErrorInfo } from './i18n/errors'

/**
 * 歌单解析协议执行器（与音乐源/歌词源同一架构）：
 * 应用不内置任何平台的歌单抓取逻辑，解析能力由用户自行配置的接口提供。
 *
 * 解析能力挂在**音源**上：一条音源既可搜索也可解析歌单。端点地址交给 auroraPreset 的
 * playlistEndpointOf 在执行时解析——服务地址形态由协议派生，接口模板形态取手填地址，
 * 本模块不关心它是怎么来的。
 */

/** 可承载歌单解析能力的源：只要求端点解析与请求所需的字段（OnlineSourceConfig 与之兼容） */
export type PlaylistCapableSource = SourceEndpointInput & {
  /** 源 id（插件门面要按它查启停表；调用方不传时补空串，`pluginIdOf` 会回落 aurora） */
  id?: string
  name?: string
  headers?: Record<string, string>
  enabled?: boolean
}

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
}

/** 单条歌单解析请求超时（大歌单服务端要分页取，给得比在线搜索宽） */
const PLAYLIST_TIMEOUT_MS = 15000

/**
 * 只在 import 路径上转出 `dropUnfilledParams`（实现在 auroraPreset）。
 *
 * 为什么留这个 re-export：它与 `fillEndpointTemplate` 是一对，早期两者都住在本模块，
 * 外部（与单测）按这条路径导入。实现搬去 auroraPreset 是为了让「先填后剔」共处一模块，
 * 而 auroraPreset 反过来 import 本模块会成环 —— 所以出口留在这里，调用方零改动。
 */
export { dropUnfilledParams } from './auroraPreset'

/** 歌单解析的可选参数 */
export interface ResolvePlaylistOptions {
  /**
   * 只取前 N 首（服务端 `?limit=`）：首屏先渲染一页，再按 `truncated` 决定是否补全量。
   * 不传即取源上限（老行为）。
   */
  limit?: number
}

/** 从粘贴文本中提取第一个 http/https 链接（分享文案通常夹带描述文字） */
export function extractShareUrl(text: string): string | null {
  const m = (text || '').match(/https?:\/\/[^\s，。！？;；'")）\]】]+/i)
  return m ? m[0] : null
}

/** 从响应 JSON 中容错提取歌曲条目数组（与音乐源相同的包裹兼容策略） */
function extractItems(json: any): any[] {
  if (Array.isArray(json)) return json
  if (json && typeof json === 'object') {
    if (Array.isArray(json.results)) return json.results
    if (Array.isArray(json.data)) return json.data
    if (Array.isArray(json.songs)) return json.songs
    if (Array.isArray(json.list)) return json.list
    if (json.data && typeof json.data === 'object' && Array.isArray(json.data.songs)) return json.data.songs
  }
  return []
}

/**
 * 单条目容错转 ParsedSong；无标题返回 null。
 *
 * 除 title/artist 外还认 album / duration / coverUrl / songmid：这四个是可选扩展，
 * 新版音源服务（QQ_Music 的 /aurora/playlist）会带上，歌单详情页据此显示时长与序号。
 * **有值才挂键**——老源只回两个字段时保持原样，凭空补空串会让调用方分不清
 * 「源没给」与「源给了空值」。
 */
function toSong(item: any): ParsedSong | null {
  if (!item || typeof item !== 'object') return null
  const title = item.title || item.name || item.songName
  if (!title || typeof title !== 'string') return null
  let artist: any = item.artist || item.singer || ''
  if (Array.isArray(artist)) artist = artist.map((a: any) => (typeof a === 'string' ? a : a?.name || '')).join('/')

  const song: ParsedSong = { title: String(title).trim(), artist: String(artist || '').trim() }

  // 专辑：酷我给字符串，QQ / 网易云给对象（album.name），个别源用 albumname / albumName
  const rawAlbum = item.album
  const album =
    typeof rawAlbum === 'string'
      ? rawAlbum
      : rawAlbum?.name || rawAlbum?.title || item.albumname || item.albumName
  if (album) song.album = String(album).trim()

  // 时长：协议口径一律**秒**（源的毫秒换算由源侧完成，客户端不做猜测性除算）
  const duration = Number(item.duration ?? item.interval)
  if (Number.isFinite(duration) && duration > 0) song.duration = Math.round(duration)

  const cover = item.coverUrl || item.cover || item.pic || (typeof rawAlbum === 'object' ? rawAlbum?.picUrl : '')
  if (cover) song.coverUrl = String(cover)

  const mid = item.songmid ?? item.mid ?? item.id
  if (mid !== undefined && mid !== null && mid !== '') song.songmid = String(mid)

  return song
}

/**
 * 用单个源解析歌单分享链接：
 * 解析地址里的 {url} 占位符替换为 URL 编码后的链接；响应宽松解析，
 * 可选 name 字段作为歌单标题。解析不出任何歌曲时抛错
 */
export async function resolvePlaylistUrl(
  source: PlaylistCapableSource,
  shareUrl: string,
  options?: ResolvePlaylistOptions
): Promise<PlaylistParseResult> {
  const endpoint = playlistEndpointOf(source)
  // 源没填名字时给空串：兜底名是界面文案，在数据层写死等于把它冻在一种语言上
  const label = source.name || ''
  if (!endpoint) {
    throw auroraError('core.error.playlistUrlMissing', { name: label, url: '{url}' })
  }
  const limit = Number(options?.limit)
  const values: Record<string, string | number> = { url: shareUrl }
  if (Number.isFinite(limit) && limit > 0) values.limit = Math.floor(limit)
  // 占位符统一由 fillEndpointTemplate 替换（url 走 URL 编码）；没传的占位参数整段清掉
  const url = dropUnfilledParams(fillEndpointTemplate(endpoint, values))
  let resp: Response
  try {
    resp = await fetchWithTimeout(
      url,
      { headers: { ...DEFAULT_HEADERS, ...(source.headers || {}) } },
      PLAYLIST_TIMEOUT_MS
    )
  } catch (err) {
    // 超时文案自解释（底层 AbortError 的英文 message 对用户毫无信息量）
    if (isTimeoutError(err)) {
      throw auroraError('core.error.playlistTimeout', { name: label, ms: PLAYLIST_TIMEOUT_MS })
    }
    // reason 取归一后的技术原文（嵌套结构化错误时 message 是编码串，不能进句子）
    const info = toErrorInfo(err)
    throw auroraError(
      'core.error.playlistRequestFailed',
      { name: label, reason: info.detail || info.code },
      String(err)
    )
  }
  if (!resp.ok) throw auroraError('core.error.playlistHttpStatus', { name: label, status: resp.status })
  // 读体同样纳入上面的错误映射：超时/非 JSON 若不在这里分流，用户看到的是
  // TimeoutError 的编码串（无源名、无「歌单解析」语境），而不是「音源「X」请求超时（15000ms）」
  let json: any
  try {
    json = (await resp.json()) as any
  } catch (err) {
    if (isTimeoutError(err)) {
      throw auroraError('core.error.playlistTimeout', { name: label, ms: PLAYLIST_TIMEOUT_MS })
    }
    throw auroraError('core.error.playlistNotJson', { name: label })
  }

  const songs: ParsedSong[] = []
  for (const item of extractItems(json)) {
    const song = toSong(item)
    if (song) songs.push(song)
  }
  if (songs.length === 0) {
    throw auroraError('core.error.playlistEmpty', { name: label })
  }
  const name =
    typeof json?.name === 'string' && json.name.trim()
      ? json.name.trim()
      : typeof json?.data?.name === 'string' && json.data.name.trim()
        ? json.data.name.trim()
        : ''
  // 「源明确说了这是截断」才挂键：老源不给该字段时保持原样，调用方据此不必多发一次全量请求
  return json?.truncated === true ? { name, songs, truncated: true } : { name, songs }
}

/**
 * 歌单解析的对冲延迟与同时在途上限。
 *
 * 串行版的失败耗时按源数累加：单源超时 15s（见 PLAYLIST_TIMEOUT_MS），
 * 用户配三个源而全不可用时，最坏要 45s 才报错——用户感知就是「点了导入卡死」。
 *
 * 1000ms 比歌词的窗口宽：歌单解析端点在大歌单上本来就要几百毫秒到数秒
 * （上游要分页取再聚合），窗口给窄了会把「第一档马上就好」的常见情形误判成
 * 「它不行」，白白多发请求去抢同一个歌单。
 */
const PLAYLIST_HEDGE_MS = 1000
const PLAYLIST_MAX_IN_FLIGHT = 3

/**
 * 聚合解析：按配置顺序尝试「具备歌单解析能力且已启用」的源，**首个成功即返回**；
 * 全部失败时抛**配置顺序上最后一个尝试过的源**的错误（前端展示直白的中文提示）。
 *
 * 并发策略是**延迟对冲**而非纯竞速（见 shared/concurrency.ts）：排在前面的源在
 * 其对冲窗口内成功时，后面的源根本不会被启动，因此「源配置顺序」仍是决定性的优先级
 * ——这对歌单尤其重要，不同源返回的字段厚度与服务端分页行为差别很大，
 * 不该让网络快慢替用户决定用哪一份。
 *
 * ## v15：判定权归插件注册表
 *
 * 改造前这里用 `playlistEndpointOf(s)` 过滤 —— 那是 **aurora 协议私有**的端点派生，
 * 等于说「只有协议源能解析歌单」。后果与歌词链路当初那处一模一样：装来的声明式插件
 * 即便在清单里写了 `playlistTracks`，也永远进不了这条链路，而 `playlistTracksViaPlugin`
 * 写好了却零调用方。
 *
 * 现在两条路径分开：
 * - **判定**（哪些源参与）：问插件注册表（`canParsePlaylist`）；
 * - **执行**：优先用插件自己的 `parsePlaylist`（`parsePlaylistViaPlugin`）。
 *
 * 为什么用**动态 import** 而不是顶层 import：`playlistResolver` 已被
 * `auroraPlugin` 静态引用，而 `plugin/executor` → `builtins` → `auroraPlugin`，
 * 再加一条静态边就会形成 evaluator 期闭不上的环（本仓已有多处踩过这个坑，
 * 见 `builtins.ts` 顶部）。动态 import 在**调用时**解析，求值期零风险。
 */
export async function parsePlaylistLink(
  sources: PlaylistCapableSource[],
  shareUrl: string,
  options?: ResolvePlaylistOptions
): Promise<PlaylistParseResult> {
  const { canParsePlaylistLink, parsePlaylistViaPlugin, hostContextOf } = await import(
    './plugin/executor'
  )

  // 能力判定：**两个条件同时成立**才算候选。
  //
  // 1. 插件声明了 `parsePlaylist`（`canParsePlaylistLink`）—— 决定"这类插件会不会做"；
  // 2. 这条**具体配置**里有可用的歌单端点（`playlistEndpointOf`）—— 决定"这一条能不能做"。
  //
  // 为什么必须两者都要：`aurora` 插件无条件实现了 `parsePlaylist`（它得覆盖所有
  // 协议源配置），但用户完全可能只填了搜索接口、或填了个不含 `{url}` 的模板。
  // 只看第 1 条会把这种源判成候选，然后必然失败并抛一句技术错误；
  // 用户该看到的是「你没有能解析歌单的源」，而不是「歌单解析地址缺少 {url}」。
  //
  // 反过来只看第 2 条就是改造前的缺陷（协议派生当判据），装来的声明式插件永远进不来。
  const enabled = (sources || []).filter(
    (s) => s && s.enabled && canParsePlaylistLink(toSourceConfig(s)) && Boolean(playlistEndpointOf(s))
  )
  if (enabled.length === 0) {
    throw auroraError('core.error.playlistNoSource')
  }

  // 失败原因**按源下标记位**，而不是 push 进一个数组。
  //
  // 为什么要这么做：并发后各源的失败是**完成顺序**回来的，push 出来的数组顺序随机，
  // 「取最后一项」会变成一个不确定的结果 —— 同一组源、同一次回退，用户这次看到
  // 「源B 解析失败」、下次看到「源A 解析失败」。按下标记位再按配置顺序取，
  // 得到的才是与旧串行版完全一致的那一条（配置顺序上最后被尝试的源）。
  // 抛错本身不能打断对冲调度，故先存起来、收场后再抛。
  const failures = new Array<unknown>(enabled.length).fill(null)
  const hit = await firstSuccess(
    enabled,
    async (source, index) => {
      try {
        return await parseOneSource(source, shareUrl, options, {
          canParsePlaylistLink,
          parsePlaylistViaPlugin,
          hostContextOf,
        })
      } catch (err) {
        failures[index] = err
        console.warn(`[歌单解析] 「${source.name || '未命名'}」解析失败:`, err)
        return null
      }
    },
    { hedgeMs: PLAYLIST_HEDGE_MS, maxInFlight: PLAYLIST_MAX_IN_FLIGHT }
  )
  if (hit) return hit.result

  // 从尾部往前找最后一个真正失败过的源（配置顺序上的「最后尝试过的」）
  let lastError: unknown = null
  for (let i = failures.length - 1; i >= 0; i--) {
    if (failures[i] !== null) {
      lastError = failures[i]
      break
    }
  }
  throw lastError instanceof Error ? lastError : auroraError('core.error.playlistFailed')
}

/** `parsePlaylistLink` 用到的插件门面（由调用处动态 import 后传入，避免模块环） */
interface PlaylistPluginFacade {
  canParsePlaylistLink: (source: OnlineSourceConfig) => boolean
  parsePlaylistViaPlugin: (
    source: OnlineSourceConfig,
    shareUrl: string,
    ctx: PluginContext,
    options?: { limit?: number }
  ) => Promise<PlaylistParseResult>
  hostContextOf: (source?: OnlineSourceConfig | null) => PluginContext
}

/**
 * 把宽松的 `PlaylistCapableSource` 收成插件门面要求的 `OnlineSourceConfig`。
 *
 * 为什么需要：`PlaylistCapableSource` 是**结构子集**，允许调用方只给端点字段
 * （既有单测与老调用方如此）。插件门面按 `OnlineSourceConfig` 取 `pluginId` /
 * `enabled` / `id` 等字段，缺了 `pluginId` 时 `pluginIdOf` 会回落到 `aurora` ——
 * 这正是老配置该有的行为，所以补上缺省字段即可，不需要调用方改形状。
 */
function toSourceConfig(source: PlaylistCapableSource): OnlineSourceConfig {
  return {
    id: String(source.id || ''),
    name: String(source.name || ''),
    sourceUrl: source.sourceUrl,
    ...(source.playlistUrl ? { playlistUrl: source.playlistUrl } : {}),
    ...(source.headers ? { headers: source.headers } : {}),
    ...(source.endpoints ? { endpoints: source.endpoints } : {}),
    ...(source.kind ? { kind: source.kind } : {}),
    ...(source.pluginId ? { pluginId: source.pluginId } : {}),
    enabled: source.enabled !== false,
  } as OnlineSourceConfig
}

/**
 * 解析**单个源**：插件优先，协议派生兜底。
 *
 * 两条路径的取舍：
 * 1. **插件实现优先**：只有它能覆盖「装来的声明式插件」「脚本插件」这些形态。
 *    判定用 `canParsePlaylist`（方法存在性），不用端点派生。
 * 2. **协议兜底**：`PlaylistCapableSource` 允许调用方只给端点字段（既有单测与
 *    老调用方如此），那种形状在注册表里查不到实现。此时用 `resolvePlaylistUrl`
 *    继续按协议解析 —— 否则一条「只填了 playlistUrl、没填 pluginId」的老源
 *    会突然解析不了，这属于纯粹的破坏性变更，不是本次要修的缺陷。
 *
 * 两条路径产出的形状相同（`ParsedSong[]` + 可选歌单名），所以这里统一转成
 * `PlaylistParseResult`，聚合层不必知道走的是哪条。
 */
async function parseOneSource(
  source: PlaylistCapableSource,
  shareUrl: string,
  options: ResolvePlaylistOptions | undefined,
  facade: PlaylistPluginFacade
): Promise<PlaylistParseResult> {
  const cfg = toSourceConfig(source)
  if (facade.canParsePlaylistLink(cfg)) {
    return facade.parsePlaylistViaPlugin(
      cfg,
      shareUrl,
      facade.hostContextOf(cfg),
      options?.limit ? { limit: options.limit } : undefined
    )
  }
  return resolvePlaylistUrl(source, shareUrl, options)
}
