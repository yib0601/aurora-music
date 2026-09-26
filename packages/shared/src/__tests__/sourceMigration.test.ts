import {
  mergeLegacyPlaylistSources,
  migrateLyricsSources,
  migrateOnlineSources,
} from '../sourceMigration'
import type { PlaylistResolverConfig } from '../types'

/** v9 之前的老音源形态：端点地址已拼好，另有服务地址 + 密钥两栏供设置页回显 */
const LEGACY_ONLINE = {
  id: 'src-1',
  name: '我的音源',
  apiUrl: 'https://music.example.com/aurora?query={query}&quality={quality}&key=K1',
  preset: 'aurora',
  baseUrl: 'https://music.example.com',
  apiKey: 'K1',
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
    const out = mergeLegacyPlaylistSources([LEGACY_ONLINE], [LEGACY])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('src-1')
    expect(out[0].name).toBe('我的音源')
    expect(out[0].apiUrl).toBe(LEGACY_ONLINE.apiUrl)
    expect(out[0].playlistUrl).toBe('https://music.example.com/aurora/playlist?url={url}')
  })

  it('找不到同主机音源时转为「只做歌单解析」的音源条目', () => {
    const other: PlaylistResolverConfig = {
      ...LEGACY,
      id: 'plr-2',
      name: '另个解析源',
      apiUrl: 'https://other.example.com/resolve?url={url}',
    }
    const out = mergeLegacyPlaylistSources([LEGACY_ONLINE], [other])
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
    const bad: PlaylistResolverConfig = {
      id: 'plr-x',
      name: '脏数据',
      apiUrl: 'https://a.example.com/search?q={query}',
      enabled: true,
    }
    expect(mergeLegacyPlaylistSources([LEGACY_ONLINE], [bad])).toHaveLength(1)
  })

  it('已有同主机条目且已带 playlistUrl 时不覆盖，另起一条', () => {
    const withPlaylist = {
      ...LEGACY_ONLINE,
      playlistUrl: 'https://music.example.com/playlist-old?url={url}',
    }
    const out = mergeLegacyPlaylistSources([withPlaylist], [LEGACY])
    expect(out).toHaveLength(2)
    expect(out[0].playlistUrl).toBe('https://music.example.com/playlist-old?url={url}')
    expect(out[1].playlistUrl).toBe(LEGACY.apiUrl)
  })

  it('不修改入参数组（纯函数）', () => {
    const online = [{ ...LEGACY_ONLINE }]
    const legacy = [LEGACY]
    mergeLegacyPlaylistSources(online, legacy)
    expect(online[0].playlistUrl).toBeUndefined()
    expect(legacy[0].apiUrl).toBe(LEGACY.apiUrl)
    expect(online).toHaveLength(1)
  })

  it('缺 id 时用注入的 id 工厂生成；入参为空安全', () => {
    const out = mergeLegacyPlaylistSources(
      [],
      [{ name: '无 id 源', apiUrl: 'https://b.example.com/r?url={url}', enabled: true }],
      () => 'src-fixed'
    )
    expect(out[0].id).toBe('src-fixed')
    expect(mergeLegacyPlaylistSources(null, null)).toEqual([])
    expect(mergeLegacyPlaylistSources(undefined, [])).toEqual([])
  })

  it('相对/非法地址不与任何音源合并，也不崩', () => {
    const weird: PlaylistResolverConfig = {
      id: 'plr-w',
      name: '相对地址',
      apiUrl: '/resolve?url={url}',
      enabled: true,
    }
    const out = mergeLegacyPlaylistSources([LEGACY_ONLINE], [weird])
    expect(out).toHaveLength(2)
    expect(out[1].playlistUrl).toBe('/resolve?url={url}')
  })
})

describe('migrateOnlineSources（v10 音源地址归一）', () => {
  it('服务地址形态：五个字段收口成一条 sourceUrl，端点不再落库', () => {
    const [s] = migrateOnlineSources([LEGACY_ONLINE])
    expect(s.sourceUrl).toBe('https://music.example.com?key=K1')
    expect(s.id).toBe('src-1')
    expect(s.name).toBe('我的音源')
    expect(s).not.toHaveProperty('apiUrl')
    expect(s).not.toHaveProperty('preset')
    expect(s).not.toHaveProperty('baseUrl')
    expect(s).not.toHaveProperty('apiKey')
    // 老端点与默认约定一致 → 无需缓存，执行时能重新推出来
    expect(s.endpoints).toBeUndefined()
  })

  it('老端点地址与默认约定不同（服务端自描述过）时转存 endpoints 缓存', () => {
    const [s] = migrateOnlineSources([
      {
        ...LEGACY_ONLINE,
        apiUrl: 'https://music.example.com/v2/search?q={query}&key=K1',
        playlistUrl: 'https://music.example.com/v2/playlist?u={url}&key=K1',
      },
    ])
    expect(s.sourceUrl).toBe('https://music.example.com?key=K1')
    expect(s.endpoints).toEqual({
      search: 'https://music.example.com/v2/search?q={query}&key=K1',
      playlist: 'https://music.example.com/v2/playlist?u={url}&key=K1',
    })
  })

  it('接口模板形态：地址原样留下，歌单地址单独保留', () => {
    const [s] = migrateOnlineSources([
      {
        id: 'src-2',
        name: '第三方',
        apiUrl: 'https://api.example.com/search?q={query}',
        playlistUrl: 'https://api.example.com/resolve?url={url}',
        enabled: true,
      },
    ])
    expect(s.sourceUrl).toBe('https://api.example.com/search?q={query}')
    expect(s.playlistUrl).toBe('https://api.example.com/resolve?url={url}')
    expect(s.endpoints).toBeUndefined()
  })

  it('只做歌单解析的音源：音源地址留空，歌单地址保留', () => {
    const [s] = migrateOnlineSources([
      {
        id: 'plr-9',
        name: '只解析',
        apiUrl: '',
        playlistUrl: 'https://a.example/r?url={url}',
        enabled: false,
      },
    ])
    expect(s.sourceUrl).toBe('')
    expect(s.playlistUrl).toBe('https://a.example/r?url={url}')
    expect(s.enabled).toBe(false)
  })

  it('已经是新形态时幂等（重复迁移不丢字段）', () => {
    const once = migrateOnlineSources([
      {
        ...LEGACY_ONLINE,
        apiUrl: 'https://music.example.com/v2/search?q={query}&key=K1',
      },
    ])
    expect(migrateOnlineSources(once)).toEqual(once)
  })

  it('缺 id / 缺名称时补默认值；非法入参安全', () => {
    const out = migrateOnlineSources([{ apiUrl: 'https://x.example/aurora?query={query}' }])
    expect(out[0].id).toMatch(/^src-/)
    expect(out[0].name).toBe('音源')
    expect(migrateOnlineSources(null)).toEqual([])
    expect(migrateOnlineSources([null, 42, 'x'])).toEqual([])
  })
})

describe('migrateLyricsSources（v10 字段统一）', () => {
  it('apiUrl 平移到 sourceUrl，其余字段保留', () => {
    const out = migrateLyricsSources([
      {
        id: 'lrc-1',
        name: 'LRCLIB',
        apiUrl: 'https://lrclib.net/api/search?track_name={track}',
        headers: { 'X-Test': 'b' },
        enabled: false,
      },
    ])
    expect(out).toEqual([
      {
        id: 'lrc-1',
        name: 'LRCLIB',
        sourceUrl: 'https://lrclib.net/api/search?track_name={track}',
        headers: { 'X-Test': 'b' },
        enabled: false,
      },
    ])
  })

  it('幂等且非法入参安全', () => {
    const list = [{ id: 'a', name: 'b', sourceUrl: 'https://x.example/y', enabled: true }]
    const once = migrateLyricsSources(list)
    expect(migrateLyricsSources(once)).toEqual(once)
    expect(migrateLyricsSources(undefined)).toEqual([])
  })
})
