import { describe, expect, it, beforeEach } from 'vitest'
import {
  canBrowseHall,
  recommendViaPlugin,
  toplistsViaPlugin,
  toplistDetailViaPlugin,
  hostContextOf,
} from '../executor'
import { registerPlugin, clearPluginsForTest } from '../registry'
import { resetBuiltinsRegistrationForTest, ensureBuiltinsRegistered } from '../builtins'
import type { SourcePlugin } from '../types'
import type { OnlineSourceConfig } from '../../types'

/** 一条最小可用的源配置 */
const CONFIG: OnlineSourceConfig = {
  id: 'src-1',
  name: 'Test Source',
  sourceUrl: 'https://api.example.com',
  enabled: true,
}

function reset(): void {
  clearPluginsForTest()
  resetBuiltinsRegistrationForTest()
}

/** 造一个只实现指定能力的插件 */
function pluginWith(id: string, methods: Partial<SourcePlugin>): SourcePlugin {
  return {
    id,
    displayNameKey: 'core.platform.aurora',
    version: '1.0.0',
    capabilities: [],
    ...methods,
  } as SourcePlugin
}

describe('canBrowseHall：判定按方法存在性', () => {
  beforeEach(reset)

  it('内置 aurora 插件声明了三个在线发现能力', () => {
    ensureBuiltinsRegistered()
    expect(canBrowseHall(CONFIG)).toBe(true)
  })

  it('只实现 top 列表不算不能浏览（有一个就够）', () => {
    registerPlugin(pluginWith('toplists-only', {
      toplists: async () => [],
    }))
    expect(canBrowseHall({ ...CONFIG, pluginId: 'toplists-only' })).toBe(true)
  })

  it('只实现推荐也算', () => {
    registerPlugin(pluginWith('rec-only', { recommendPlaylists: async () => [] }))
    expect(canBrowseHall({ ...CONFIG, pluginId: 'rec-only' })).toBe(true)
  })

  it('两者都没有 → false（UI 据此隐藏在线发现入口）', () => {
    registerPlugin(pluginWith('plain', { search: async () => [] }))
    expect(canBrowseHall({ ...CONFIG, pluginId: 'plain' })).toBe(false)
  })

  it('源被停用 → false（停用的源不该出现在候选里）', () => {
    registerPlugin(pluginWith('rec-only', { recommendPlaylists: async () => [] }))
    expect(canBrowseHall({ ...CONFIG, pluginId: 'rec-only', enabled: false })).toBe(false)
  })

  it('插件未注册 → false（配置错误按降级处理）', () => {
    expect(canBrowseHall({ ...CONFIG, pluginId: 'nope' })).toBe(false)
  })

  it('空配置 → false', () => {
    expect(canBrowseHall(null)).toBe(false)
    expect(canBrowseHall(undefined)).toBe(false)
  })
})

describe('recommendViaPlugin：能力缺失返回空数组（不是抛错）', () => {
  beforeEach(reset)

  it('能力缺失 → 空数组', async () => {
    registerPlugin(pluginWith('plain', { search: async () => [] }))
    const out = await recommendViaPlugin(
      { ...CONFIG, pluginId: 'plain' },
      {},
      hostContextOf(CONFIG)
    )
    expect(out).toEqual([])
  })

  it('插件未注册 → 空数组', async () => {
    expect(await recommendViaPlugin({ ...CONFIG, pluginId: 'nope' }, {}, hostContextOf(CONFIG))).toEqual([])
  })

  it('正常转发：入参与上下文原样交给插件', async () => {
    const seen: unknown[] = []
    registerPlugin(
      pluginWith('rec', {
        recommendPlaylists: async (config, options, ctx) => {
          seen.push(config.id, options.categoryId, typeof ctx.fetch)
          return [
            { id: 'p1', name: 'Playlist', source: config.id, sourceName: config.name },
          ]
        },
      })
    )
    const out = await recommendViaPlugin(
      { ...CONFIG, pluginId: 'rec' },
      { categoryId: '10000000' },
      hostContextOf(CONFIG)
    )
    expect(out).toHaveLength(1)
    expect(seen).toEqual(['src-1', '10000000', 'function'])
  })

  it('插件抛错时错误向上传播（由聚合层逐源捕获）', async () => {
    registerPlugin(
      pluginWith('boom', {
        recommendPlaylists: async () => {
          throw new Error('upstream 500')
        },
      })
    )
    await expect(
      recommendViaPlugin({ ...CONFIG, pluginId: 'boom' }, {}, hostContextOf(CONFIG))
    ).rejects.toThrow('upstream 500')
  })
})

describe('toplistsViaPlugin', () => {
  beforeEach(reset)

  it('能力缺失 → 空数组', async () => {
    expect(await toplistsViaPlugin({ ...CONFIG, pluginId: 'nope' }, {}, hostContextOf(CONFIG))).toEqual([])
  })

  it('正常转发', async () => {
    registerPlugin(
      pluginWith('tops', {
        toplists: async () => [{ groupName: 'G', toplists: [] }],
      })
    )
    const out = await toplistsViaPlugin({ ...CONFIG, pluginId: 'tops' }, { preview: 3 }, hostContextOf(CONFIG))
    expect(out).toEqual([{ groupName: 'G', toplists: [] }])
  })
})

describe('toplistDetailViaPlugin：能力缺失给"空详情"而不是 null', () => {
  beforeEach(reset)

  it('能力缺失 → 空详情（id 回填入参，便于调用方区分"哪个榜单空"）', async () => {
    const out = await toplistDetailViaPlugin(
      { ...CONFIG, pluginId: 'nope' },
      { id: 'top-1' },
      hostContextOf(CONFIG)
    )
    expect(out).toEqual({ id: 'top-1', name: '', total: 0, songs: [] })
  })

  it('正常转发', async () => {
    registerPlugin(
      pluginWith('detail', {
        toplistDetail: async (_config, options) => ({
          id: options.id ?? '',
          name: 'Hot',
          total: 1,
          songs: [{ rank: 1, title: 'A', artist: 'B', album: '', duration: 200 }],
        }),
      })
    )
    const out = await toplistDetailViaPlugin({ ...CONFIG, pluginId: 'detail' }, { id: 7 }, hostContextOf(CONFIG))
    expect(out.name).toBe('Hot')
    expect(out.songs).toHaveLength(1)
  })
})
