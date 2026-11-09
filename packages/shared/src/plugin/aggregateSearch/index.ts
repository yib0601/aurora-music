/**
 * 内置「聚合搜索」插件：**音源没有搜索能力时，由软件自己把歌搜出来**。
 *
 * ## 为什么不放在每个音源里
 *
 * 洛雪自定义脚本的协议只有 `musicUrl` / `lyric` / `pic` 三种动作（见 LX 上游
 * `src/common/types/user_api.d.ts` 的 `UserApiSourceInfoActions`），**没有 search**。
 * 于是「只配了一条脚本」的用户在搜索框里永远搜不出东西，而且不会有任何报错 ——
 * 插件按设计返回空数组，界面只能得出「没找到」。
 *
 * 修法不是让脚本去搜（协议里没有这个能力），而是把搜索做成软件自己的一份能力：
 * 平台搜索接口内置在这里，搜到的曲目**只带元信息**（`audioUrl` 为空串 + `trackRef`），
 * 播放时仍交给用户配的脚本按平台换取直链（`shared/src/plugin/trackAudio.ts`）。
 *
 * 于是分工变成：**内置插件负责「找到歌」，用户的脚本负责「放出歌」**，
 * 这与 LX Music 自身的分工完全一致 —— 那边搜索永远走客户端内置的平台接口，
 * 自定义音源只接管取址。
 *
 * ## 兜底的触发条件
 *
 * 在 `shared/src/musicSource.ts` 的聚合搜索里：配置的源**一条结果都没给出**时
 * （典型就是「只有脚本、脚本没搜索」），再跑一次本插件。有可搜索音源且能搜到时
 * 完全不触发 —— 不增加任何常态延迟。另外还要求「至少有一条能取址的脚本源」，
 * 否则搜出来的曲目播不了，只会让用户点一次失败一次。
 *
 * ## 为什么不做内置取址
 *
 * 换平台直链要逐平台维护签名/加密（QQ 的 vkey、网易的 eapi、酷狗的 tracker），
 * 上游一改版就集体失效。本插件的边界由一句话划定：**只补搜索，不抢脚本的活**。
 */

import type { DownloadQuality, OnlineSourceConfig, OnlineTrackSearchResult } from '../../types'
import { translateDefault } from '../../i18n'
import type { PluginContext, SourcePlugin } from '../types'
import {
  AGGREGATE_PLATFORMS,
  PLATFORM_LABELS,
  PLATFORM_SEARCHERS,
  type AggregateHit,
} from './platforms'

/** 插件 id（注册表键、目录投影、兜底判据都用它） */
export const AGGREGATE_SEARCH_PLUGIN_ID = 'aggregate-search'

/**
 * 内置源的固定 id。
 *
 * 这条源**不进用户的音源配置**（用户既不能新增也不能删，只能在插件列表里启停整个插件），
 * 它只作为兜底时临时构造的一份 `OnlineSourceConfig` 交给插件门面执行 ——
 * 与内置歌词兜底（`lyricsSource.BUILTIN_LYRICS_SOURCE`）同一套路数。
 */
export const AGGREGATE_SEARCH_SOURCE_ID = 'builtin-aggregate-search'

/** 每平台取多少条（交错合并前） */
const PER_PLATFORM = 10

/** 合并后最多交给界面的条数：再多也只是让用户多滚两屏 */
const MAX_RESULTS = 50

/**
 * 构造内置兜底源。
 *
 * 名字取当前语言：它在结果里不作为 `sourceName` 出现（那里显示平台品牌名），
 * 但日志与调试面板会用到。
 */
export function builtinAggregateSource(): OnlineSourceConfig {
  return {
    id: AGGREGATE_SEARCH_SOURCE_ID,
    name: translateDefault('sources.plugins.aggregateSearchName'),
    pluginId: AGGREGATE_SEARCH_PLUGIN_ID,
    sourceUrl: '',
    enabled: true,
  }
}

/**
 * 交错合并：各平台的第 1 名、第 2 名……依次排列。
 *
 * 为什么不直接拼起来：拼接的结果会变成「QQ 音乐 10 条 → 酷我 10 条」，
 * 用户搜《晴天》看到的前十条全是同一家，会以为别的平台没搜到。
 * 交错之后第一屏天然覆盖五家，看起来才像「聚合」。
 */
function interleave(lists: AggregateHit[][]): AggregateHit[] {
  const merged: AggregateHit[] = []
  const seen = new Set<string>()
  const longest = lists.reduce((max, list) => Math.max(max, list.length), 0)
  for (let rank = 0; rank < longest; rank++) {
    for (const list of lists) {
      const hit = list[rank]
      if (!hit) continue
      const key = `${hit.platform}\u0001${hit.songmid}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(hit)
      if (merged.length >= MAX_RESULTS) return merged
    }
  }
  return merged
}

/**
 * 平台命中 → 搜索结果。
 *
 * 两个约定必须守住：
 * 1. `audioUrl` 留空串 = **惰性取址**，播放时才向用户配的脚本要地址；
 * 2. 平台标识写进 `trackRef.meta.platform`，**不写 `trackRef.platform`** ——
 *    后者非空表示「这条曲目已经属于某个脚本源」，会让跨源脚本取址直接放弃资格
 *    （见 `trackAudio.scriptSourcesForTrack` 的第一道早退）。
 */
function toSearchResult(config: OnlineSourceConfig, hit: AggregateHit): OnlineTrackSearchResult {
  return {
    id: `${hit.platform}:${hit.songmid}`,
    songmid: hit.songmid,
    title: hit.title,
    artist: hit.artist,
    album: hit.album,
    duration: hit.duration,
    ...(hit.coverUrl ? { coverUrl: hit.coverUrl } : {}),
    audioUrl: '',
    source: config.id,
    // 结果行显示平台品牌名：用户要的是「这是哪家的曲库」，而不是「这是聚合搜索给的」
    sourceName: PLATFORM_LABELS[hit.platform],
    trackRef: {
      sourceId: config.id,
      platform: '',
      meta: {
        ...(hit.extra || {}),
        platform: hit.platform,
        songmid: hit.songmid,
        id: hit.songmid,
      },
    },
  }
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export const aggregateSearchPlugin: SourcePlugin = {
  id: AGGREGATE_SEARCH_PLUGIN_ID,
  displayNameKey: 'sources.plugins.aggregateSearchName',
  descriptionKey: 'sources.plugins.aggregateSearchDesc',
  version: '1.0.0',
  capabilities: ['search'],
  // 自带内置源：不需要用户在设置里建源（也不会给它一个空的「音源」分区）
  builtinSource: true,
  requires: [
    { id: 'http.fetch', version: 1 },
    { id: 'log', version: 1, optional: true },
  ],

  /**
   * 并发问五家，谁先给谁的结果先上。
   *
   * 单家失败只记日志、不影响其它家：五个端点互相独立，一家改版不该让整个兜底失效。
   * 全部失败时同样返回空数组 —— 兜底是「搜不到时多试一次」，把网络故障升级成
   * 「所有音源搜索失败」的错误弹窗是本末倒置。
   *
   * `quality` 参数故意不用：档位由**取址时**的脚本决定（脚本按请求档位返回
   * 128k/320k/flac），搜索阶段多问一档只是多一次无效往返。
   */
  async search(
    config: OnlineSourceConfig,
    query: string,
    _quality: DownloadQuality | undefined,
    ctx: PluginContext
  ): Promise<OnlineTrackSearchResult[]> {
    const trimmed = (query || '').trim()
    if (!trimmed) return []

    const settled = await Promise.allSettled(
      AGGREGATE_PLATFORMS.map((platform) =>
        PLATFORM_SEARCHERS[platform](ctx, trimmed, PER_PLATFORM)
      )
    )
    const lists: AggregateHit[][] = []
    settled.forEach((result, index) => {
      const platform = AGGREGATE_PLATFORMS[index]
      if (result.status === 'fulfilled') {
        lists.push(result.value)
      } else {
        // 开发者日志，不进界面
        const note = `聚合搜索：${PLATFORM_LABELS[platform]} 搜索失败: ${messageOf(result.reason)}` // i18n-exempt: 开发者日志
        ctx.log?.(note)
      }
    })

    return interleave(lists).map((hit) => toSearchResult(config, hit))
  },
}
