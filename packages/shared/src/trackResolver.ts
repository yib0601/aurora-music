import type { DownloadQuality, OnlineSourceConfig } from './types'
import { dropUnfilledParams, fillEndpointTemplate, trackEndpointOf } from './auroraPreset'
import type { SourceEndpointInput } from './auroraPreset'
import { fetchWithTimeout, isTimeoutError } from './fetchWithTimeout'
import { auroraError, toErrorInfo, type AuroraError } from './i18n/errors'

/**
 * 单曲取址执行器（自有服务协议，`kind='aurora'`）。
 *
 * 为什么必须有它：曲目一旦已定（曲库快照 / 音乐馆榜单与歌单条目 / 导入歌单），
 * 应用手里只有「歌名 + 歌手 + 源内 id」，而直链按约定不持久化（几十分钟就过期）。
 * 此前只能拿「歌名 + 歌手」重搜一遍取址 —— 同名不同版本（变速版 / 翻唱 / DJ 版 / Live）
 * 归一化后标题与目标**完全一致**，会合法地拿到与元数据同一档的分数，于是播出来的是
 * 别人的录音，而界面上的标题、时长、歌词全是原唱。
 *
 * 实测（2026-10-14，本模块的起因）：曲目《雨天》汪苏泷（`002A97IJ2D6KYA`，274s）被判给
 * 源端另一条同名条目「雨天 (变速版)」（`003Yt1Id3vzsYq`，115s，升调变速）——详情页显示
 * 时长 4:34、歌词是原唱的，播放条却显示解码后的 1:55。按 id 取址让曲目由 id 唯一确定，
 * 「同名」在客户端不再构成歧义。
 *
 * 与搜索执行器（`musicSource.ts`）共用同一套端点解析（`auroraPreset`）与错误映射
 * （`i18n/errors`），差异只有两点：参数是 `{id}` 而不是 `{query}`；失败**返回原因而不抛错**
 * —— 取址失败要能静默回落到按名搜索（老服务端没有该端点时就是这条路），
 * 不该把用户挡在播放之前。
 */

/** 统一默认请求头（与搜索执行器同口径，可被源配置的 headers 覆盖） */
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
}

/** 单曲取址超时：与搜索同一量级；源端在这一步可能要多打一次上游（查曲目元信息） */
export const TRACK_RESOLVE_TIMEOUT_MS = 10000

export interface TrackCapableSource extends SourceEndpointInput {
  id?: string
  name?: string
  headers?: Record<string, string>
  enabled?: boolean
}

export interface ResolveAuroraTrackInput {
  source: TrackCapableSource
  /** 源内曲目 id（曲目上的 `onlineId`；历史形态 `<sourceId>-<id>` 先过 sourceSongIdOf） */
  songId: string
  /** 目标音质；缺省不传该参数（由源决定默认档） */
  quality?: DownloadQuality
  timeoutMs?: number
}

/**
 * 取址结果：成功给直链与**实际取到的档位**；失败给 `null` 地址与原因（绝不抛错）。
 *
 * 失败原因与洛雪取址同一口径：`AuroraError` 的编码载荷（码 + 参数），
 * 显示端用 `renderErrorMessage` 按当前语言渲染。
 */
export type AuroraTrackResolve =
  | {
      audioUrl: string
      quality: string
      qualityUrls?: Partial<Record<DownloadQuality, string>>
      coverUrl?: string
      duration?: number
      title?: string
      artist?: string
    }
  | { audioUrl: null; reason: string }

/**
 * 从曲目上的 `onlineId` 取出**源内曲目 id**。
 *
 * 两种历史形态都要认：搜索结果条目把来源拼进了 id（`<sourceId>-<songmid>`），
 * 音乐馆榜单 / 歌单条目存的是纯源内 id。不认前缀，老数据（以及最近播放里的快照）
 * 就取不到址，会静默退回按名重搜 —— 那正是本模块要消除的行为。
 */
export function sourceSongIdOf(sourceId: string | undefined, onlineId: string | undefined): string {
  const id = String(onlineId || '').trim()
  if (!id) return ''
  const prefix = String(sourceId || '').trim()
  if (prefix && id.startsWith(`${prefix}-`)) return id.slice(prefix.length + 1).trim()
  return id
}

/**
 * 「该源的 `{id}` 端点不存在」的会话内记忆（键为解析后的端点地址）。
 *
 * 为什么需要：老服务端没有 `/aurora/track`，每次取址都要白打一次 404 再回落到按名搜索
 * ——「播放全部」场景下就是每首一次无效往返。源配置变动时由调用方
 * （libraryStore 的音源增删改）连同搜索缓存一起清掉，于是升级服务端后立刻恢复。
 */
const endpointMissing = new Set<string>()

/** 该源当前是否已知「没有单曲取址端点」（有则调用方可直接走按名搜索，不必白打一次） */
export function isTrackEndpointKnownMissing(source: TrackCapableSource | null | undefined): boolean {
  const endpoint = trackEndpointOf(source)
  return !!endpoint && endpointMissing.has(endpoint)
}

/** 清空「端点不存在」的记忆（音源配置变更时调用，与 clearSearchCache 同一时机） */
export function clearTrackEndpointCache(): void {
  endpointMissing.clear()
}

function fail(error: AuroraError): { audioUrl: null; reason: string } {
  return { audioUrl: null, reason: error.message }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 把端点返回的条目收敛成取址结果：只认 `results[0]` 的直链与档位，
 * 其余字段（封面 / 时长 / 歌名）缺失时不猜、保持 undefined。
 */
function toResolveResult(item: Record<string, unknown>): AuroraTrackResolve {
  const audioUrl = str(item.audioUrl)
  if (!audioUrl) return { audioUrl: null, reason: '' }
  const qualityUrls: Partial<Record<DownloadQuality, string>> = {}
  const rawUrls = item.qualityUrls
  if (rawUrls && typeof rawUrls === 'object') {
    for (const key of ['128', '320', 'flac'] as DownloadQuality[]) {
      const value = str((rawUrls as Record<string, unknown>)[key])
      if (value) qualityUrls[key] = value
    }
  }
  const duration = Number(item.duration)
  return {
    audioUrl,
    quality: str(item.quality),
    ...(Object.keys(qualityUrls).length > 0 ? { qualityUrls } : {}),
    ...(str(item.coverUrl) ? { coverUrl: str(item.coverUrl) } : {}),
    ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
    ...(str(item.title) ? { title: str(item.title) } : {}),
    ...(str(item.artist) ? { artist: str(item.artist) } : {}),
  }
}

/**
 * 按源内 id 向音源索取播放直链。
 *
 * 任何环节失败都返回 `{ audioUrl: null, reason }`，不抛错：调用方据此回落到
 * 按名搜索（旧行为），用户最多是回到「可能串版本」的老路径，而不是播不出来。
 */
export async function resolveAuroraTrack(
  input: ResolveAuroraTrackInput
): Promise<AuroraTrackResolve> {
  const source = input?.source
  const label = source?.name || ''
  const songId = String(input?.songId || '').trim()
  if (!songId) return fail(auroraError('core.error.trackIdMissing'))

  const endpoint = trackEndpointOf(source)
  if (!endpoint) {
    return fail(auroraError('core.error.trackEndpointMissing', { name: label, id: '{id}' }))
  }
  if (endpointMissing.has(endpoint)) {
    return fail(auroraError('core.error.trackEndpointMissing', { name: label, id: '{id}' }))
  }

  const timeoutMs = Number(input?.timeoutMs) > 0 ? Number(input.timeoutMs) : TRACK_RESOLVE_TIMEOUT_MS
  const url = dropUnfilledParams(
    fillEndpointTemplate(endpoint, { id: songId, quality: input?.quality || '' })
  )

  let resp: Response
  try {
    resp = await fetchWithTimeout(
      url,
      { headers: { ...DEFAULT_HEADERS, ...(source?.headers || {}) } },
      timeoutMs
    )
  } catch (err) {
    if (isTimeoutError(err)) {
      return fail(auroraError('core.error.sourceTimeout', { name: label, ms: timeoutMs }))
    }
    const info = toErrorInfo(err)
    return fail(
      auroraError(
        'core.error.sourceRequestFailed',
        { name: label, reason: info.detail || info.code },
        String(err)
      )
    )
  }

  // 老服务端没有这条端点：404/501 都按「不支持」处理并记住，
  // 后续取址不再白打一次（源配置变动时清掉，见 clearTrackEndpointCache）。
  if (resp.status === 404 || resp.status === 501) {
    endpointMissing.add(endpoint)
    return fail(auroraError('core.error.trackEndpointMissing', { name: label, id: '{id}' }))
  }
  if (!resp.ok) return fail(auroraError('core.error.sourceHttpStatus', { name: label, status: resp.status }))

  let json: any
  try {
    json = await resp.json()
  } catch {
    return fail(auroraError('core.error.sourceNotJson', { name: label }))
  }

  const results = Array.isArray(json?.results) ? json.results : []
  const first = results.find((item: unknown) => item && typeof item === 'object')
  if (!first) {
    // 源端已经说清了原因（found=false / 有曲目但取不到链），技术原文进 detail：
    // 句子是给人看的，机器原因不该混进句子
    const reason = str(json?.reason) || 'no results'
    return fail(auroraError('core.error.trackNoAudio', { name: label }, `${reason} songmid=${songId}`))
  }

  const resolved = toResolveResult(first as Record<string, unknown>)
  if (!resolved.audioUrl) {
    return fail(auroraError('core.error.trackNoAudio', { name: label }, `empty audioUrl songmid=${songId}`))
  }
  return resolved
}

/** 便捷封装：只要直链，失败返回 null（调用方判空即可） */
export async function resolveAuroraTrackUrl(
  input: ResolveAuroraTrackInput
): Promise<{ url: string; quality: string } | null> {
  const out = await resolveAuroraTrack(input)
  return out.audioUrl ? { url: out.audioUrl, quality: out.quality } : null
}

/** 供调用方做类型收窄：源是否可能是自有服务协议（脚本源不走这条路） */
export function isAuroraTrackSource(
  source: (TrackCapableSource & Pick<OnlineSourceConfig, 'enabled'>) | null | undefined
): boolean {
  return !!source && source.kind !== 'lx' && !!trackEndpointOf(source)
}
