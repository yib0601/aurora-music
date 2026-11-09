/**
 * 搜索结果排序：**其它音源优先，自建协议源兜底**
 *
 * 用户自建协议源（地址模板由用户在源上手填）只负责「别家搜不到时才用」，所以结果
 * 顺序必须是「不用你填地址的源（脚本源 / 内置平台源）在前，协议源在后」。
 * 顺序即优先级：搜索面板的分组顺序、取址时「同分取先出现者」的判定、歌单导入与
 * 加密补档的择优都按这一个顺序走。
 *
 * 用例钉住三条：① 协议源天生排后（哪怕它在设置里排第一）；② 同档保持音源配置顺序；
 * ③ 源内排名不被重排（同一源的多条之间相对次序不变）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearSearchCache,
  orderBySourcePriority,
  searchOnlineTracks,
  sourcePriorityRank,
} from '../musicSource'
import { registerPlugin, unregisterPlugin } from '../plugin/registry'
import type { OnlineSourceConfig, OnlineTrackSearchResult } from '../types'

const SCRIPT_PLUGIN_ID = 'test-priority-script'

function hit(sourceId: string, sourceName: string, title: string, index: number): OnlineTrackSearchResult {
  return {
    id: `${sourceId}-${index}`,
    songmid: `${sourceId}-${index}`,
    title,
    artist: '周杰伦',
    album: '',
    duration: 269,
    audioUrl: '',
    source: sourceId,
    sourceName,
  }
}

function source(over: Partial<OnlineSourceConfig>): OnlineSourceConfig {
  return { id: 'src', name: '测试源', sourceUrl: '', enabled: true, ...over }
}

/** 自建协议源：服务地址 + 密钥形态，「接口模板」由客户端派生 → 协议源 */
const protocolSource = source({
  id: 'src-protocol',
  name: '我的乐源',
  sourceUrl: 'https://music.example.invalid/aurora?key=abc',
})

/** 脚本源：地址是脚本链接，插件不是协议源 → 优先档 */
const scriptSource = source({
  id: 'src-script',
  name: '脚本源',
  kind: 'lx',
  pluginId: SCRIPT_PLUGIN_ID,
  sourceUrl: 'https://example.invalid/script.js',
})

/** 协议源的搜索响应（只给执行排序所需的最小形状） */
function protocolPayload() {
  return {
    results: [
      {
        id: 'p1',
        songmid: 'p1',
        title: '晴天（乐源第 1 条）',
        artist: '周杰伦',
        album: '',
        duration: 269,
        audioUrl: 'https://isure6.stream.qqmusic.qq.com/p1.m4a',
      },
      {
        id: 'p2',
        songmid: 'p2',
        title: '晴天（乐源第 2 条）',
        artist: '周杰伦',
        album: '',
        duration: 269,
        audioUrl: 'https://isure6.stream.qqmusic.qq.com/p2.m4a',
      },
    ],
  }
}

beforeEach(() => {
  clearSearchCache()
  registerPlugin({
    id: SCRIPT_PLUGIN_ID,
    displayNameKey: 'test.priorityScript',
    version: '1.0.0',
    capabilities: ['search'],
    search: async () =>
      [
        hit('src-script', '脚本源', '晴天（脚本源第 1 条）', 1),
        hit('src-script', '脚本源', '晴天（脚本源第 2 条）', 2),
      ] satisfies OnlineTrackSearchResult[],
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(protocolPayload()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
  )
})

afterEach(() => {
  unregisterPlugin(SCRIPT_PLUGIN_ID)
  vi.unstubAllGlobals()
  clearSearchCache()
})

describe('音源优先级判定', () => {
  it('自填服务地址的协议源排在后面，脚本源排在前面', () => {
    expect(sourcePriorityRank(protocolSource)).toBe(1)
    expect(sourcePriorityRank(scriptSource)).toBe(0)
  })

  it('没有搜索端点的内置源／脚本源都在优先档', () => {
    const aggregate = source({ id: 'src-agg', name: '聚合搜索', pluginId: 'aggregate-search' })
    expect(sourcePriorityRank(aggregate)).toBe(0)
  })
})

describe('结果排序', () => {
  it('协议源在设置里排第一，结果里仍排在脚本源之后', async () => {
    const results = await searchOnlineTracks('晴天', {
      sources: [protocolSource, scriptSource],
    })
    expect(results.map((r) => r.source)).toEqual([
      'src-script',
      'src-script',
      'src-protocol',
      'src-protocol',
    ])
    // 源内相对次序不变（乐源自己的第 1 条仍在第 2 条之前）
    expect(results.slice(2).map((r) => r.title)).toEqual([
      '晴天（乐源第 1 条）',
      '晴天（乐源第 2 条）',
    ])
  })

  it('同为非协议源时保持音源配置顺序', () => {
    const a = source({ id: 'src-a', name: 'A', pluginId: SCRIPT_PLUGIN_ID })
    const b = source({ id: 'src-b', name: 'B', pluginId: SCRIPT_PLUGIN_ID })
    const ordered = orderBySourcePriority(
      [hit('src-b', 'B', 'b1', 1), hit('src-a', 'A', 'a1', 1), hit('src-b', 'B', 'b2', 2)],
      [b, a]
    )
    expect(ordered.map((r) => r.title)).toEqual(['b1', 'b2', 'a1'])
  })

  it('源内排名不被重排', () => {
    const ordered = orderBySourcePriority(
      [
        hit('src-protocol', '乐源', 'p1', 1),
        hit('src-script', '脚本源', 's1', 1),
        hit('src-script', '脚本源', 's2', 2),
        hit('src-protocol', '乐源', 'p2', 2),
      ],
      [protocolSource, scriptSource]
    )
    expect(ordered.map((r) => r.title)).toEqual(['s1', 's2', 'p1', 'p2'])
  })
})
