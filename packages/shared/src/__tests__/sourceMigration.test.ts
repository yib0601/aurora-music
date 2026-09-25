import { mergeLegacyPlaylistSources } from '../sourceMigration'
import type { OnlineSourceConfig, PlaylistResolverConfig } from '../types'

const SEARCH: OnlineSourceConfig = {
  id: 'src-1',
  name: '我的音源',
  apiUrl: 'https://music.example.com/aurora?query={query}',
  enabled: true,
}

const LEGACY: PlaylistResolverConfig = {
  id: 'plr-1',
  name: '歌单解析',
  apiUrl: 'https://music.example.com/aurora/playlist?url={url}',
  enabled: true,
}

describe('mergeLegacyPlaylistSources（v9 音源合并迁移）', () => {
  it('同一服务的解析源挂到已有音源上，成为一条音源两种能力', () => {
    const out = mergeLegacyPlaylistSources([SEARCH], [LEGACY])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('src-1')
    expect(out[0].name).toBe('我的音源')
    expect(out[0].apiUrl).toBe('https://music.example.com/aurora?query={query}')
    expect(out[0].playlistUrl).toBe('https://music.example.com/aurora/playlist?url={url}')
  })

  it('找不到同主机音源时转为「只做歌单解析」的音源条目', () => {
    const other: PlaylistResolverConfig = { ...LEGACY, id: 'plr-2', name: '另个解析源', apiUrl: 'https://other.example.com/resolve?url={url}' }
    const out = mergeLegacyPlaylistSources([SEARCH], [other])
    expect(out).toHaveLength(2)
    const added = out[1]
    expect(added.name).toBe('另个解析源')
    expect(added.apiUrl).toBe('') // 不参与在线搜索
    expect(added.playlistUrl).toBe('https://other.example.com/resolve?url={url}')
    expect(added.enabled).toBe(true)
  })

  it('只做歌单解析的条目保留原 id、请求头与停用状态', () => {
    const legacy: PlaylistResolverConfig = {
      id: 'plr-9',
      name: '需要鉴权的解析源',
      apiUrl: 'https://a.example.com/resolve?url={url}',
      headers: { Authorization: 'Bearer t' },
      enabled: false,
    }
    const out = mergeLegacyPlaylistSources([], [legacy])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('plr-9')
    expect(out[0].headers).toEqual({ Authorization: 'Bearer t' })
    expect(out[0].enabled).toBe(false)
  })

  it('地址不含 {url} 的旧条目被丢弃', () => {
    const bad: PlaylistResolverConfig = { id: 'plr-x', name: '脏数据', apiUrl: 'https://a.example.com/search?q={query}', enabled: true }
    expect(mergeLegacyPlaylistSources([SEARCH], [bad])).toHaveLength(1)
  })

  it('已有同名同主机条目且已带 playlistUrl 时不覆盖，另起一条', () => {
    const withPlaylist: OnlineSourceConfig = { ...SEARCH, playlistUrl: 'https://music.example.com/playlist-old?url={url}' }
    const out = mergeLegacyPlaylistSources([withPlaylist], [LEGACY])
    expect(out).toHaveLength(2)
    expect(out[0].playlistUrl).toBe('https://music.example.com/playlist-old?url={url}')
    expect(out[1].playlistUrl).toBe(LEGACY.apiUrl)
  })

  it('不修改入参数组（纯函数）', () => {
    const online = [SEARCH]
    const legacy = [LEGACY]
    mergeLegacyPlaylistSources(online, legacy)
    expect(online[0].playlistUrl).toBeUndefined()
    expect(legacy[0].apiUrl).toBe(LEGACY.apiUrl)
    expect(online).toHaveLength(1)
  })

  it('缺 id 时用注入的 id 工厂生成；入参为空安全', () => {
    const out = mergeLegacyPlaylistSources([], [{ name: '无 id 源', apiUrl: 'https://b.example.com/r?url={url}', enabled: true }], () => 'src-fixed')
    expect(out[0].id).toBe('src-fixed')
    expect(mergeLegacyPlaylistSources(null, null)).toEqual([])
    expect(mergeLegacyPlaylistSources(undefined, [])).toEqual([])
  })

  it('相对/非法地址不与任何音源合并，也不崩', () => {
    const weird: PlaylistResolverConfig = { id: 'plr-w', name: '相对地址', apiUrl: '/resolve?url={url}', enabled: true }
    const out = mergeLegacyPlaylistSources([SEARCH], [weird])
    expect(out).toHaveLength(2)
    expect(out[1].playlistUrl).toBe('/resolve?url={url}')
  })
})
