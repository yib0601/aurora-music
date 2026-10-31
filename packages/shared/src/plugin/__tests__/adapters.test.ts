import { describe, it, expect } from 'vitest'
import { auroraPlugin } from '../auroraPlugin'
import { lxPlugin } from '../lxPlugin'
import type { OnlineSourceConfig } from '../../types'

/**
 * 两个既有形态的适配器：这里只验证「转发是否正确」与「能力边界是否表达清楚」，
 * 不重复测试底层实现（那些已有各自的单测）。
 */

const config = (extra?: Partial<OnlineSourceConfig>): OnlineSourceConfig => ({
  id: '00000000-0000-0000-0000-000000000000',
  name: 'Fake Source',
  sourceUrl: 'https://source.example.test/aurora',
  enabled: true,
  ...extra,
})

describe('aurora 适配器', () => {
  it('声明了协议源应有的能力', () => {
    expect(auroraPlugin.id).toBe('aurora')
    expect(auroraPlugin.capabilities).toEqual(
      expect.arrayContaining(['probe', 'search', 'resolveTrack', 'playlistParse'])
    )
  })

  it('提供了 search / resolveTrack / getPlaylistTracks 三个方法', () => {
    expect(typeof auroraPlugin.search).toBe('function')
    expect(typeof auroraPlugin.resolveTrack).toBe('function')
    expect(typeof auroraPlugin.getPlaylistTracks).toBe('function')
  })

  it('不声明 auth（协议源没有登录概念，凭证走 headers）', () => {
    expect(auroraPlugin.capabilities).not.toContain('auth')
    expect(auroraPlugin.login).toBeUndefined()
  })

  it('取址时令牌缺 songmid 就返回 null（不猜 id，猜错会取到别的歌）', async () => {
    const out = await auroraPlugin.resolveTrack!(
      config(),
      { sourceId: 'x', platform: 'aurora', meta: {} },
      undefined,
      {} as never
    )
    expect(out).toBeNull()
  })
})

describe('lx 适配器', () => {
  it('声明了「可搜索但无歌单解析」的能力边界', () => {
    expect(lxPlugin.id).toBe('lx')
    expect(lxPlugin.capabilities).toEqual(expect.arrayContaining(['probe', 'search', 'resolveTrack']))
    // 脚本协议里没有歌单解析入口，也没有标准歌词能力
    expect(lxPlugin.capabilities).not.toContain('playlistParse')
    expect(lxPlugin.capabilities).not.toContain('lyrics')
    // 因此这两个方法在契约上不存在，上层按能力探测会自动跳过
    expect(lxPlugin.getPlaylistTracks).toBeUndefined()
  })

  it('能力缺失用「方法不存在」表达，而不是 kind 判断', () => {
    expect(typeof lxPlugin.search).toBe('function')
    expect(typeof lxPlugin.resolveTrack).toBe('function')
  })
})

describe('插件能力的分工：同一份契约下形态差异不泄漏给上层', () => {
  it('aurora 与 lx 的差异只体现在能力与实现上，接口形状一致', () => {
    // 两者都能 probe / search / resolveTrack —— 上层用同一套调用代码
    for (const plugin of [auroraPlugin, lxPlugin]) {
      expect(typeof plugin.probe).toBe('function')
      expect(typeof plugin.search).toBe('function')
      expect(typeof plugin.resolveTrack).toBe('function')
      expect(typeof plugin.id).toBe('string')
      expect(typeof plugin.displayNameKey).toBe('string')
      expect(Array.isArray(plugin.capabilities)).toBe(true)
    }
  })
})
