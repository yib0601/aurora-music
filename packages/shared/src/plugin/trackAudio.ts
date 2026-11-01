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
