/**
 * 单曲取址的统一编排（跨端共用）。
 *
 * ## 解决什么
 *
 * 改造前，桌面端（`app/src/services/platform/index.ts`）与移动端
 * （`app/src/services/platform/mobile/index.ts`）各自手写了一份取址分派，
 * 且都用 `source.kind !== 'lx'` / `source.kind === 'lx'` 判形态：
 *
 * - 有 `trackRef` → 只可能是脚本源 → 走 lx 通道
 * - 有 `onlineId` → 只可能是 aurora → 走按 id 取址
 *
 * 这意味着**装来的声明式插件永远走不到取址**：它既没有 lx 的 kind，也没有
 * aurora 专用的 `onlineId` 语义，于是被两条分支同时排除。
 *
 * ## 现在的判定
 *
 * 一律按**插件能力**：`typeof plugin.resolveTrack === 'function'`。凭据只是
 * 交给插件的一个不透明令牌 —— 插件自己知道该从哪个字段取值（aurora 读
 * `meta.songmid`，脚本读 `meta.platform`，声明式读 `meta.id`）。
 *
 * ## 保持的两条既有约定
 *
 * 1. **失败返回 `null`，不抛错**：上层据此回落按名搜索，取址失败绝不打断播放。
 * 2. **只回填副本**：直链会过期，返回值不落盘、不写库（持久化时 `onlineUrl` 本就剥离）。
 */

import type { DownloadQuality, OnlineSourceConfig, SourceTrackRef } from '../types'
import type { PluginContext } from './types'
import { canResolveTrack, resolveTrackViaPlugin } from './executor'
import { isTrackEndpointKnownMissing, sourceSongIdOf } from '../trackResolver'

/** 一次取址的结果：成功给地址与可选元信息，失败为 `null` */
export interface TrackResolution {
  url: string
  quality?: string
  qualityUrls?: Partial<Record<DownloadQuality, string>>
  coverUrl?: string
}

/** `resolveTrackAudio` 需要的最小输入（`Track` 与其结构兼容） */
export interface TrackResolutionInput {
  /** 源内 id（aurora 形态用它取址） */
  onlineId?: string
  /** 脚本源的定位令牌 */
  trackRef?: SourceTrackRef
  /** 曲目所属的源 id */
  onlineSource?: string
  /**
   * 展示用元信息（可选）。
   *
   * 跨源取址要把它映射成脚本认的字段名（`name` / `singer` / `albumName` / `interval`）：
   * 脚本多数只用 id 拼请求，但 mg 这类「只按歌名歌手」的平台没它就没法取址。
   */
  title?: string
  artist?: string
  album?: string
  duration?: number
  /**
   * 曲目已有的播放地址（可选）。
   *
   * 跨源脚本取址靠它**推断曲目属于哪个平台**（见 `inferPlatformFromUrl`），从而不必让
   * 用户为每条脚本源手工认领平台；识别不出来时才回落到认领设置。
   */
  onlineUrl?: string
}

/**
 * 为一条曲目构造「交给插件的定位令牌」。
 *
 * 为什么要统一构造：不同形态的插件从 `meta` 里取的字段不同 ——
 * - aurora 读 `meta.songmid`（源内 id）
 * - 洛雪脚本读 `meta.platform` + 原始条目字段（已在 `trackRef.meta` 里）
 * - 声明式清单读 `meta.id`
 *
 * 所以这里把**两种来源**的可用信息都放进 `meta`，让插件各取所需：
 * 曲目自带 `trackRef` 时原样使用（脚本源的字段最完整，不能丢），
 * 否则用 `onlineId` 补一个 `songmid`（aurora 的取法）。
 *
 * 返回 `null` 表示这条曲目没有任何可用的定位凭据 —— 取址不适用，
 * 调用方直接回落按名搜索，不必再问插件。
 */
export function trackRefFor(input: TrackResolutionInput): SourceTrackRef | null {
  const ref = input?.trackRef
  if (ref && ref.sourceId && ref.platform) return ref

  const sourceId = String(input?.onlineSource || '').trim()
  const songId = sourceSongIdOf(sourceId, input?.onlineId)
  if (!sourceId || !songId) return null
  return {
    sourceId,
    // 平台标识留空：aurora 与声明式插件都不看它，脚本源则在自带 `trackRef` 时
    // 走上面那条分支（这里构造出来的不会是脚本源）
    platform: '',
    meta: { songmid: songId, id: songId },
  }
}

/**
 * 统一取址入口。
 *
 * 返回 `null` 的每种情况对调用方含义一致（回落按名搜索）：
 * 1. 没有可用的定位凭据；
 * 2. 该源没启用 / 插件没实现 `resolveTrack`（能力缺失，正常降级）；
 * 3. 插件取不到地址（无权益 / id 不存在 / 老服务端没该端点）；
 * 4. 取到的地址不是 http(s)（防御性：绝不把非法地址交给播放器）。
 */
export async function resolveTrackAudioViaPlugin(
  source: OnlineSourceConfig | null | undefined,
  input: TrackResolutionInput,
  ctx: PluginContext,
  quality?: DownloadQuality
): Promise<TrackResolution | null> {
  if (!source) return null

  const ref = trackRefFor(input)
  if (!ref) return null

  // 能力缺失 = 正常降级（这个源不提供按 id 取址），不是错误
  if (!canResolveTrack(source)) return null

  // 老服务端没有 `{id}` 端点：本进程已知就直接跳过，不再白打一次 404。
  // 这条记忆是 aurora 协议特有的优化，但对其它插件无害（它们不会命中该缓存）。
  if (isTrackEndpointKnownMissing(source)) return null

  try {
    const resolved = await resolveTrackViaPlugin(source, ref, quality, ctx)
    if (!resolved?.url || !/^https?:\/\//i.test(resolved.url)) return null
    return {
      url: resolved.url,
      ...(resolved.quality ? { quality: resolved.quality } : {}),
      ...(resolved.qualityUrls ? { qualityUrls: resolved.qualityUrls } : {}),
      ...(resolved.coverUrl ? { coverUrl: resolved.coverUrl } : {}),
    }
  } catch (err) {
    // 取址失败一律回落按名搜索：不打断播放，也不给上层一个空地址
    ctx?.log?.(`取址失败: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

// ─── 跨源脚本取址（脚本源按平台认领） ────────────────────────────────

/**
 * 一段「脚本源认领某个平台」的候选取址任务。
 *
 * `ref` 是交给脚本的定位令牌：`sourceId` 必须是**脚本源自己**的 id（`resolveLxTrack`
 * 会拿它去 sources 里找脚本），`platform` 是源配置声明的平台，`meta` 是按该平台
 * 字段名归一化过的曲目元信息。
 */
export interface ScriptSourcePick {
  source: OnlineSourceConfig
  ref: SourceTrackRef
}

/** 跨源取址的输入：在 `TrackResolutionInput` 上补展示用元信息（`Track` 结构兼容） */
export type ScriptSourcePickInput = TrackResolutionInput

/** 一次成功的跨源取址 */
export interface ScriptSourceResolution {
  /** 命中的脚本源与令牌 */
  pick: ScriptSourcePick
  /** 脚本给出的直链与档位 */
  resolution: TrackResolution
}

/**
 * 失败记忆时长。
 *
 * 为什么要记：脚本源配错平台 / 上游挂了时，每次播放（含「下一首」连跳）都会白打一次
 * 取址并等待它失败，观感是「点一下卡一下」。60 秒足以覆盖一轮连跳，又让用户改完配置
 * 或上游恢复后很快能重试。
 */
const SCRIPT_FAIL_TTL_MS = 60_000
/** 失败记忆的条目上限（键含曲目 id，长时间浏览会无限增长，按上限整体清理） */
const SCRIPT_FAIL_MEMO_MAX = 200
const scriptFailures = new Map<string, number>()

/** 清空失败记忆（音源配置变动时可由调用方清；键里已含地址与平台，通常不必） */
export function clearScriptSourceMemo(): void {
  scriptFailures.clear()
}

/**
 * 从曲目输入里取「源内 id」。
 *
 * 优先按 `onlineSource` 剥前缀（aurora 形态的 `onlineId`），其次翻 `trackRef.meta`
 * 里的常见 id 字段（脚本源/声明式插件的原始条目）。都取不到就没有可交给脚本的定位 ——
 * 只有歌名歌手的曲目交给跨源取址没有意义（脚本的 musicUrl 基本都按 id 取）。
 */
function scriptIdOf(input: ScriptSourcePickInput): string {
  // 数据自带的 `meta.songmid` 最可信：它是**源自己**给的平台内定位，而 `onlineId`
  // 是应用侧的条目 id（内置聚合搜索的条目 id 带 `平台:` 前缀，拿去当 songmid 会让
  // 脚本按一个不存在的 mid 取址）。有它就先用它。
  const meta = (input?.trackRef?.meta || {}) as Record<string, unknown>
  const declared = meta.songmid
  if (typeof declared === 'string' && declared.trim()) return declared.trim()

  const fromOnline = sourceSongIdOf(
    String(input?.onlineSource || '').trim(),
    input?.onlineId
  )
  if (fromOnline) return fromOnline

  for (const field of ['id', 'hash', 'mid', 'rid']) {
    const value = meta[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

/**
 * 组装喂给脚本的元信息。
 *
 * 字段名同时给「脚本认的」与「通用」两套（`name`/`title`、`singer`/`artist`…）：
 * 映射层（`toLxMusicInfo`）两种都认，脚本自己读哪个都不会落空。
 * 故意**只给通用 id**（`songmid`/`id`）：让映射层按目标平台写进它自己的 id 字段，
 * 而不是在这里猜平台字段名。
 */
function scriptMetaFor(id: string, input: ScriptSourcePickInput): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  // 先整体带上曲目数据里已有的定位字段（`hash`、`albumId`、`copyrightId`…）：
  // 内置聚合搜索搜出来的曲目只有元信息、没有任何播放地址，脚本要的是**平台自己的**
  // 定位字段（酷狗认 `hash`、咪咕认 `copyrightId`），重新拼一份只会把它们丢掉。
  // 后面写通用字段时按需覆盖，所以顺序必须是「先带、后写」。
  const carried = (input?.trackRef?.meta || {}) as Record<string, unknown>
  for (const [key, value] of Object.entries(carried)) {
    if (value === undefined || value === null) continue
    meta[key] = value
  }
  if (id) {
    meta.songmid = id
    meta.id = id
  }
  const title = String(input?.title || '').trim()
  const artist = String(input?.artist || '').trim()
  const album = String(input?.album || '').trim()
  const duration = Number(input?.duration)
  if (title) {
    meta.name = title
    meta.title = title
  }
  if (artist) {
    meta.singer = artist
    meta.artist = artist
  }
  if (album) {
    meta.albumName = album
    meta.album = album
  }
  if (Number.isFinite(duration) && duration > 0) {
    meta.interval = duration
    meta.duration = duration
  }
  return meta
}

/**
 * 媒体域名 → 洛雪平台标识。
 *
 * 为什么要靠地址推断，而不是只让用户选：音源服务返回的播放地址本身就是平台直链
 * （QQ 的 `*.qqmusic.qq.com`、酷我的 `*.kuwo.cn`…），地址说了算就**不需要任何平台专属设置**
 * —— 换一家音源服务、换一个平台的曲库，同一个脚本源照样能对上号。
 * 表里只放「协议标识 → 域名后缀」，不写任何一家具体服务的假设。
 */
const PLATFORM_URL_HINTS: Array<[string, string[]]> = [
  ['tx', ['qq.com']],
  ['kw', ['kuwo.cn']],
  ['kg', ['kugou.com']],
  ['wy', ['163.com', '126.net']],
  ['mg', ['migu.cn']],
]

/**
 * 从播放地址推断洛雪平台标识（推断不出返回空串）。
 *
 * 只认主机名后缀，不认路径/查询串：`isure6.stream.qqmusic.qq.com` 与
 * `dl.stream.qqmusic.qq.com` 都是 tx，`sycdn.kuwo.cn` 是 kw。
 */
export function inferPlatformFromUrl(url?: string | null): string {
  const raw = String(url || '').trim()
  if (!raw) return ''
  let host = ''
  try {
    host = new URL(raw).hostname.toLowerCase()
  } catch {
    return ''
  }
  if (!host) return ''
  for (const [platform, suffixes] of PLATFORM_URL_HINTS) {
    if (suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return platform
  }
  return ''
}

/**
 * 曲目数据里**显式标注**的平台（`trackRef.meta.platform`）。
 *
 * 白名单照旧（只认洛雪那五个标识）：别的字符串说明数据有问题，
 * 拿去喂脚本只会换回一次必然失败的请求。
 */
function explicitPlatformOf(input: ScriptSourcePickInput): string {
  const meta = (input?.trackRef?.meta || {}) as Record<string, unknown>
  const raw = typeof meta.platform === 'string' ? meta.platform.trim() : ''
  if (!raw) return ''
  return PLATFORM_URL_HINTS.some(([platform]) => platform === raw) ? raw : ''
}

/**
 * 找出这条曲目可以交给哪些脚本源取址。
 *
 * 平台归属按三路来源确定，**优先用数据自带的说法**：
 * 0. 曲目数据显式标注的平台（`trackRef.meta.platform`，内置聚合搜索就是这条路：
 *    它搜出来的曲目没有任何播放地址，域名无从推断，但平台是它自己搜出来的）；
 * 1. 曲目已有播放地址 → 按域名推断（`inferPlatformFromUrl`），这也是「不用给脚本源
 *    手工选平台」的原因；
 * 2. 两路都拿不到 → 回落到脚本源自己的认领设置（`OnlineSourceConfig.platform`）。
 *
 * 匹配规则：脚本认领了平台就必须与曲目的平台一致（认领 kw 的脚本不该拿 QQ 的 id 去试）；
 * 脚本没认领则视为「通用脚本」，按推断出的平台取址。
 *
 * 不构成候选的情形：
 * - 曲目自带 `trackRef.platform`：它已经属于某条脚本源，走常规取址即可，
 *   再跨源去问第二家是错配（同一平台的另一脚本不该覆盖用户选中的源）；
 * - 取不到源内 id：没有可交给脚本的定位（见 `scriptIdOf`）；
 * - 曲目就来自该源 / 源停用 / 既推不出平台、源也没认领平台（猜不出平台就不能瞎喂 id）。
 */
export function scriptSourcesForTrack(
  sources: OnlineSourceConfig[] | null | undefined,
  input: ScriptSourcePickInput
): ScriptSourcePick[] {
  const own = input?.trackRef
  if (own && String(own.platform || '').trim()) return []

  const id = scriptIdOf(input)
  if (!id) return []

  const fromSourceId = String(input?.onlineSource || '').trim()
  const targetPlatform = explicitPlatformOf(input) || inferPlatformFromUrl(input?.onlineUrl)
  const meta = scriptMetaFor(id, input)
  const picks: ScriptSourcePick[] = []
  for (const source of sources || []) {
    if (!source || !source.enabled) continue
    const claimed = String(source.platform || '').trim()
    // 认领了别的平台 → 跳过（错配的 id 只会白打一次必然失败的取址）
    if (targetPlatform && claimed && claimed !== targetPlatform) continue
    const platform = targetPlatform || claimed
    if (!platform) continue
    if (source.id === fromSourceId) continue
    // 每条候选给独立 meta 副本：插件可能原地改写令牌（防御性，成本可忽略）
    picks.push({ source, ref: { sourceId: source.id, platform, meta: { ...meta } } })
  }
  return picks
}

/** 同步判据：这条曲目是否有脚本源愿意认领取址（用于播放前的同步闸门，必须不产生 I/O） */
export function hasScriptSourceCandidate(
  sources: OnlineSourceConfig[] | null | undefined,
  input: ScriptSourcePickInput
): boolean {
  return scriptSourcesForTrack(sources, input).length > 0
}

function scriptFailKey(pick: ScriptSourcePick, id: string): string {
  return `${pick.source.id}\u0001${String(pick.source.sourceUrl || '')}\u0001${pick.ref.platform}\u0001${id}`
}

function rememberScriptFailure(key: string, failedAt: number): void {
  if (scriptFailures.size >= SCRIPT_FAIL_MEMO_MAX) scriptFailures.clear()
  scriptFailures.set(key, failedAt)
}

/**
 * 跨源脚本取址：按候选顺序逐个尝试，第一个拿到 http(s) 直链的即命中。
 *
 * 两个端（桌面 / 移动）只在「怎么执行插件」上不同，候选筛选、失败记忆、地址校验
 * 这些策略必须同源 —— 所以循环放在这里，调用方只传一个 `resolve`：
 * 桌面端转发主进程（`api.plugins.resolveTrack`），移动端直接调
 * `resolveTrackAudioViaPlugin`。
 *
 * 失败不抛错、不打断：整轮失败返回 `null`，调用方回落到曲目原有地址 / 按名搜索。
 */
export async function resolveTrackAudioAcrossScriptSources(
  sources: OnlineSourceConfig[] | null | undefined,
  input: ScriptSourcePickInput,
  resolve: (pick: ScriptSourcePick) => Promise<TrackResolution | null>,
  log?: (message: string) => void
): Promise<ScriptSourceResolution | null> {
  const id = scriptIdOf(input)
  if (!id) return null

  for (const pick of scriptSourcesForTrack(sources, input)) {
    const key = scriptFailKey(pick, id)
    const failedAt = scriptFailures.get(key)
    if (failedAt !== undefined && Date.now() - failedAt < SCRIPT_FAIL_TTL_MS) continue

    let resolution: TrackResolution | null = null
    try {
      resolution = await resolve(pick)
    } catch (err) {
      // 插件执行异常与「取不到地址」对上层是同一件事：回落，不打断播放
      log?.(`脚本取址异常: ${err instanceof Error ? err.message : String(err)}`) // i18n-exempt: 开发者日志，不进界面
      resolution = null
    }

    if (resolution?.url && /^https?:\/\//i.test(resolution.url)) {
      scriptFailures.delete(key)
      return { pick, resolution }
    }
    rememberScriptFailure(key, Date.now())
  }
  return null
}
