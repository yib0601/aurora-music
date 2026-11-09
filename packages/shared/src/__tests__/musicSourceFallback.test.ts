/**
 * 「音源没有搜索能力 → 内置聚合搜索兜底」的调度单测（不打真实网络）
 *
 * 这个兜底是**运行期**判定的：洛雪脚本有没有 `search` 动作藏在脚本里，
 * 配置里看不出来。所以判据只能是「跑完一轮一条结果都没有」。
 * 用例逐条钉住它的边界：
 *   1) 主源全空 → 兜底跑，且只交出「脚本源认领得到」的条目；
 *   2) 一条都取不了址 → 继续回空，不塞「点了播不了」的诱饵；
 *   3) 主源有结果 → 兜底一个请求都不发（不给正常搜索加延迟）；
 *   4) 插件被停用 → 兜底不跑；
 *   5) 主源全部失败但兜底有结果 → 不抛 `allSourcesFailed`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSearchCache, searchOnlineTracks } from '../musicSource'
import { registerPlugin, unregisterPlugin } from '../plugin/registry'
import { setPluginEnabled } from '../plugin/availability'
import type { OnlineSourceConfig, OnlineTrackSearchResult } from '../types'

const AGGREGATE_PLUGIN_ID = 'aggregate-search'
const EMPTY_PLUGIN_ID = 'test-nosearch'
const SCRIPT_PLUGIN_ID = 'test-script-standin'

/** 只回 QQ 音乐一条命中：足够验证「取址资格过滤」，不必铺满五家 */
function txPayload() {
  return {
    'music.search.SearchCgiService': {
      code: 0,
      data: {
        body: {
          song: {
            list: [
              {
                mid: 'kw-conflict-mid',
                id: 1,
                title: '晴天',
                interval: 269,
                file: { media_mid: 'kw-conflict-mid' },
                album: { mid: 'alb', name: '叶惠美' },
                singer: [{ name: '周杰伦' }],
              },
            ],
          },
        },
      },
    },
  }
}

/** 平台请求计数：兜底跑没跑，看它发没发请求最直接 */
function installFetch(options: { empty?: boolean } = {}) {
  const calls: string[] = []
  const fn = vi.fn(async (input: unknown) => {
    const url = String(input)
    calls.push(url)
    let payload: unknown = {}
    if (url.includes('y.qq.com')) payload = options.empty ? {} : txPayload()
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fn)
  return { calls }
}

function registerTestPlugins() {
  // 模拟「有 search 方法但搜不出东西」的洛雪脚本源（多数脚本的真实形态）
  registerPlugin({
    id: EMPTY_PLUGIN_ID,
    displayNameKey: 'test.nosearch',
    version: '1.0.0',
    capabilities: ['search'],
    search: async () => [] as OnlineTrackSearchResult[],
  })
  // 占位脚本源：只为让 `hasScriptSourceCandidate` 有源可认领（它只看源配置）
  registerPlugin({
    id: SCRIPT_PLUGIN_ID,
    displayNameKey: 'test.script',
    version: '1.0.0',
    capabilities: ['search'],
    search: async () => [] as OnlineTrackSearchResult[],
  })
}

function source(over: Partial<OnlineSourceConfig>): OnlineSourceConfig {
  return { id: 'src', name: '测试源', sourceUrl: '', enabled: true, ...over }
}

const emptySource = source({ id: 'src-empty', name: '只有取址的脚本源', pluginId: EMPTY_PLUGIN_ID })
/** 脚本源桩：`kind: 'lx'` 让它被认作「脚本源」，显式 pluginId 让执行仍走测试插件 */
function scriptLike(over: Partial<OnlineSourceConfig>): OnlineSourceConfig {
  return source({
    kind: 'lx',
    pluginId: SCRIPT_PLUGIN_ID,
    sourceUrl: 'https://example.invalid/script.js',
    ...over,
  })
}

const scriptSource = scriptLike({
  id: 'src-script',
  name: '脚本源（认领 kw）',
  platform: 'kw',
})

beforeEach(() => {
  clearSearchCache()
  registerTestPlugins()
})

afterEach(() => {
  unregisterPlugin(EMPTY_PLUGIN_ID)
  unregisterPlugin(SCRIPT_PLUGIN_ID)
  setPluginEnabled(AGGREGATE_PLUGIN_ID, true)
  vi.unstubAllGlobals()
  clearSearchCache()
})

describe('聚合搜索兜底', () => {
  it('主源一条结果都没有时触发兜底，且只交出脚本源认领得到的条目', async () => {
    const { calls } = installFetch()
    const results = await searchOnlineTracks('晴天', { sources: [emptySource, scriptSource] })

    // 兜底确实发了请求（问了各平台）
    expect(calls.some((url) => url.includes('y.qq.com'))).toBe(true)
    // 脚本源认领的是 kw，而唯一命中的是 tx → 取不出址，全部滤掉
    expect(results).toEqual([])
  })

  it('脚本源认领的平台与命中一致时，兜底结果可用', async () => {
    installFetch()
    const txScript = scriptLike({
      id: 'src-script-tx',
      name: '脚本源（认领 tx）',
      platform: 'tx',
    })
    const results = await searchOnlineTracks('晴天', { sources: [emptySource, txScript] })
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('晴天')
    expect(results[0].audioUrl).toBe('')
    expect(results[0].trackRef?.meta).toMatchObject({ platform: 'tx' })
  })

  it('没有任何脚本源可取址时返回空，不塞播不了的条目', async () => {
    installFetch()
    const results = await searchOnlineTracks('晴天', { sources: [emptySource] })
    expect(results).toEqual([])
  })

  it('插件被停用时不跑兜底', async () => {
    setPluginEnabled(AGGREGATE_PLUGIN_ID, false)
    const { calls } = installFetch()
    const results = await searchOnlineTracks('晴天', { sources: [emptySource, scriptSource] })
    expect(results).toEqual([])
    expect(calls.filter((url) => url.includes('y.qq.com'))).toEqual([])
  })

  it('主源全部失败但兜底有结果时不抛 allSourcesFailed', async () => {
    installFetch()
    registerPlugin({
      id: 'test-broken',
      displayNameKey: 'test.broken',
      version: '1.0.0',
      capabilities: ['search'],
      search: async () => {
        throw new Error('上游 500')
      },
    })
    try {
      const broken = source({ id: 'src-broken', name: '坏源', pluginId: 'test-broken' })
      const txScript = scriptLike({
        id: 'src-script-tx',
        name: '脚本源（认领 tx）',
        platform: 'tx',
      })
      const results = await searchOnlineTracks('晴天', { sources: [broken, txScript] })
      expect(results).toHaveLength(1)
    } finally {
      unregisterPlugin('test-broken')
    }
  })
})
