/**
 * aurora 协议源 → 插件适配器。
 *
 * **只做转发，不重写内部逻辑**：搜索 / 取址 / 歌单解析 / 探测的实现仍住在既有模块里
 * （`musicSource.ts` / `trackResolver.ts` / `auroraPreset.ts` / `playlistResolver.ts` /
 * `sourceProbe.ts`）。这里把它们包成插件契约的形状，让上层从此按能力调用，不再判断 `kind`。
 */

import type {
  DownloadQuality,
  OnlineSourceConfig,
  OnlineTrackSearchResult,
  SourceProbeResult,
  SourceTrackRef,
} from '../types'
import type { PluginCapability, PluginContext, ResolvedAudio, SourcePlugin } from './types'
import { searchMusicSource } from '../musicSource'
import { parseSourceInput, probeAuroraService } from '../auroraPreset'
import { auroraProbeToResult } from '../sourceProbe'
import {
  isTrackEndpointKnownMissing,
  resolveAuroraTrack,
  sourceSongIdOf,
} from '../trackResolver'
import { resolvePlaylistUrl } from '../playlistResolver'

/**
 * 从定位令牌里取「源内 id」。
 *
 * aurora 协议按**源内 id** 取址（`/aurora/track`），而脚本形态用不透明的 `trackRef`。
 * 这条分派收在插件内部：上层只交令牌，不需要知道它是哪种形态。
 */
function songIdOf(config: OnlineSourceConfig, ref: SourceTrackRef): string | undefined {
  const raw = ref?.meta?.songmid
  return sourceSongIdOf(config.id, typeof raw === 'string' ? raw : undefined)
}

export const auroraPlugin: SourcePlugin = {
  id: 'aurora',
  displayNameKey: 'core.platform.aurora',
  descriptionKey: 'sources.form.kindAuroraHint',
  version: '1.0.0',
  // playlistParse 由 getPlaylistTracks 承载；lyrics / auth 能力不在此插件内（歌词源是另一条线）
  // lyrics：歌词端点由协议派生（见 auroraPreset.lyricEndpointOf），属于本插件能力
  capabilities: ['probe', 'search', 'resolveTrack', 'playlistParse', 'lyrics'] as const,

  async probe(config: OnlineSourceConfig): Promise<SourceProbeResult> {
    // 探测直连：只取服务端自描述端点并验密钥，不写配置
    const parsed = parseSourceInput(config.sourceUrl)
    const result = await probeAuroraService(
      parsed?.baseUrl || config.sourceUrl,
      parsed?.apiKey
    )
    return auroraProbeToResult(result)
  },

  async search(
    config: OnlineSourceConfig,
    query: string,
    quality: DownloadQuality | undefined
  ): Promise<OnlineTrackSearchResult[]> {
    return searchMusicSource(config, query, quality)
  },

  async resolveTrack(
    config: OnlineSourceConfig,
    ref: SourceTrackRef,
    quality: DownloadQuality | undefined
  ): Promise<ResolvedAudio | null> {
    const songId = songIdOf(config, ref)
    if (!songId) return null
    // 老服务端没有这条端点：本进程已知道就直接回落，不再多打一次 404
    if (isTrackEndpointKnownMissing(config)) return null

    const resolved = await resolveAuroraTrack({ source: config, songId, quality })
    if (!resolved?.audioUrl) return null
    return {
      url: resolved.audioUrl,
      quality: resolved.quality,
      qualityUrls: resolved.qualityUrls,
      coverUrl: resolved.coverUrl,
    }
  },

  /**
   * 歌单解析：aurora 协议由 `{url}` 模板承载（服务地址形态由协议派生，接口模板形态手填）。
   *
   * `playlistRef` 传的是**歌单链接**（协议占位符 `{url}` 的语义），不是歌单 id——
   * 这条语义差异收在插件内，上层统一传「歌单定位串」即可。
   */
  async getPlaylistTracks(
    config: OnlineSourceConfig,
    playlistRef: string
  ): Promise<OnlineTrackSearchResult[]> {
    const parsed = await resolvePlaylistUrl(config, playlistRef)
    return parsed.songs.map((song, index) => ({
      // 协议源解析阶段只给元信息，没有稳定 id：用序号构造条目 id，
      // 真正的定位靠 songmid（源给出时），取址门面据此向源索取地址
      id: `${config.id}-${song.songmid || index}`,
      songmid: song.songmid,
      title: song.title,
      artist: song.artist,
      album: song.album || '',
      duration: song.duration || 0,
      coverUrl: song.coverUrl,
      audioUrl: '',
      source: config.id,
      sourceName: config.name,
    }))
  },
}

/** 导出一份能力清单常量，供注册表之外的静态展示使用（不改变既有导出） */
export const AURORA_PLUGIN_CAPABILITIES: readonly PluginCapability[] = auroraPlugin.capabilities
