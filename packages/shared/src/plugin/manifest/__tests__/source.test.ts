import { describe, expect, it } from 'vitest'
import { buildSourcePlugin, extractItems } from '../source'
import { validatePluginManifest } from '../validate'
import { PLUGIN_MANIFEST_FORMAT, type PluginManifest } from '../types'
import type { OnlineSourceConfig } from '../../../types'
import type { PluginContext } from '../../types'

/** 从合法清单直接构造（校验器已在别处覆盖，这里只当"输入工厂"用） */
function manifestOf(source: unknown, extra: Record<string, unknown> = {}): PluginManifest {
  const result = validatePluginManifest({
    format: PLUGIN_MANIFEST_FORMAT,
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    permissions: ['network'],
    hosts: ['api.example.com'],
    source,
    ...extra,
  })
  if (!result.ok) throw new Error(`manifest invalid: ${JSON.stringify(result.issues)}`)
  return result.manifest
}

const config: OnlineSourceConfig = {
  id: 'src-1',
  name: 'Demo Source',
  sourceUrl: 'https://api.example.com',
  enabled: true,
}

/** 记录请求的假 fetch，返回给定 JSON */
function ctxReturning(payload: unknown, recorded?: string[]): PluginContext {
  return {
    fetch: (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      recorded?.push(url)
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof globalThis.fetch,
  }
}

describe('extractItems：数组定位的容错链', () => {
  it('裸数组', () => {
    expect(extractItems([{ a: 1 }])).toEqual([{ a: 1 }])
  })

  it.each(['results', 'data', 'songs', 'list'])('顶层 %s', (key) => {
    expect(extractItems({ [key]: [{ a: 1 }] })).toEqual([{ a: 1 }])
  })

  it('一层嵌套（既有协议里存在 data.song.list 这类包裹）', () => {
    expect(extractItems({ data: { songs: [{ a: 1 }] } })).toEqual([{ a: 1 }])
    expect(extractItems({ data: { song: { list: [] } } })).toEqual([])
  })

  it('给了 items 路径时只按它取（不被容错链"救"成别的字段）', () => {
    const json = { results: [{ wrong: true }], data: { items: [{ right: true }] } }
    expect(extractItems(json, 'data.items')).toEqual([{ right: true }])
  })

  it('items 路径取不到 → 空数组，而不是回落容错链', () => {
    expect(extractItems({ results: [{ a: 1 }] }, 'data.items')).toEqual([])
  })

  it('取到的不是数组 → 空数组', () => {
    expect(extractItems({ data: { items: 'not-array' } }, 'data.items')).toEqual([])
  })

  it('null / 标量 / 空对象都安全返回空数组', () => {
    expect(extractItems(null)).toEqual([])
    expect(extractItems(42)).toEqual([])
    expect(extractItems({})).toEqual([])
  })
})

describe('buildSourcePlugin：能力由清单推导', () => {
  it('只声明 search → 只有 search 与 probe', () => {
    const plugin = buildSourcePlugin(
      manifestOf({
        search: { url: 'https://api.example.com/s?q={query}', map: { title: 't', audioUrl: 'u' } },
      })
    )
    expect(plugin).not.toBeNull()
    expect(typeof plugin!.search).toBe('function')
    expect(plugin!.resolveTrack).toBeUndefined()
    expect(plugin!.getPlaylistTracks).toBeUndefined()
    expect(plugin!.capabilities).toEqual(['search'])
  })

  it('声明 resolveTrack 与 playlistTracks 后能力齐全', () => {
    const plugin = buildSourcePlugin(
      manifestOf({
        search: { url: 'https://api.example.com/s?q={query}', map: { title: 't', audioUrl: 'u' } },
        resolveTrack: { url: 'https://api.example.com/t?id={id}', map: { audioUrl: 'u' } },
        playlistTracks: { url: 'https://api.example.com/p?id={playlistId}', map: { title: 't', audioUrl: 'u' } },
      })
    )
    expect(plugin!.capabilities.sort()).toEqual(['playlistParse', 'resolveTrack', 'search'].sort())
    expect(typeof plugin!.resolveTrack).toBe('function')
    expect(typeof plugin!.getPlaylistTracks).toBe('function')
  })

  it('纯歌词清单不产出音源插件（返回 null，调用方据此知道"它不进音源列表"）', () => {
    expect(buildSourcePlugin(manifestOf(undefined, { lyrics: { url: 'https://api.example.com/l?t={track}' }, source: undefined }))).toBeNull()
  })
})

describe('search：字段映射与占位符', () => {
  const manifest = manifestOf({
    search: {
      url: 'https://api.example.com/search?q={query}&quality={quality}',
      map: {
        id: 'song.id',
        title: 'song.name',
        artist: 'song.artists[0].name',
        album: 'song.album.name',
        duration: 'song.interval',
        coverUrl: 'song.pic',
        audioUrl: 'song.playUrl',
      },
    },
  })

  it('正常映射出曲目', async () => {
    const payload = {
      data: {
        list: [
          {
            song: {
              id: 'S1',
              name: '七里香',
              artists: [{ name: '周杰伦' }],
              album: { name: '七里香' },
              interval: 299,
              pic: 'https://img.example.com/a.jpg',
              playUrl: 'https://audio.example.com/a.mp3',
            },
          },
        ],
      },
    }
    const plugin = buildSourcePlugin(manifest)!
    const results = await plugin.search!(config, '七里香', undefined, ctxReturning(payload))

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      // id 前缀是源 id：执行器与取址门面都按这个约定识别"哪个源的条目"
      id: 'src-1-S1',
      songmid: 'S1',
      title: '七里香',
      artist: '周杰伦',
      album: '七里香',
      duration: 299,
      audioUrl: 'https://audio.example.com/a.mp3',
      source: 'src-1',
      sourceName: 'Demo Source',
    })
    // 有播放地址时不带 trackRef（惰性取址令牌只在需要时才存在）
    expect(results[0].trackRef).toBeUndefined()
  })

  it('占位符按 URL 编码替换（搜索词里的 & 不会拆出参数）', async () => {
    const recorded: string[] = []
    const plugin = buildSourcePlugin(manifest)!
    await plugin.search!(config, 'a&b=c', undefined, ctxReturning({ results: [] }, recorded))
    expect(recorded[0]).toContain('q=a%26b%3Dc')
  })

  it('音质缺省按 128 填（与既有执行器的缺省档一致）', async () => {
    const recorded: string[] = []
    const plugin = buildSourcePlugin(manifest)!
    await plugin.search!(config, 'x', undefined, ctxReturning({ results: [] }, recorded))
    expect(recorded[0]).toContain('quality=128')
  })

  it('指定音质时替换为该档', async () => {
    const recorded: string[] = []
    const plugin = buildSourcePlugin(manifest)!
    await plugin.search!(config, 'x', 'flac', ctxReturning({ results: [] }, recorded))
    expect(recorded[0]).toContain('quality=flac')
  })

  it('缺 title / artist 时用既有占位值（与内置执行器同一字面量）', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const results = await plugin.search!(
      config,
      'x',
      undefined,
      ctxReturning({ results: [{ song: { playUrl: 'https://a/1.mp3' } }] })
    )
    expect(results[0].title).toBe('未知歌曲')
    expect(results[0].artist).toBe('未知艺术家')
    expect(results[0].duration).toBe(0)
  })

  it('id 缺失时用列表序号兜底（此时 id 不稳定，但条目仍可用）', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const results = await plugin.search!(
      config,
      'x',
      undefined,
      ctxReturning({ results: [{ song: { name: 'A', playUrl: 'https://a/1.mp3' } }] })
    )
    expect(results[0].id).toBe('src-1-0')
    expect(results[0].songmid).toBeUndefined()
  })

  it('durationMs 声明时按 /1000 取整（上游给毫秒不该让应用显示错时长）', async () => {
    const msManifest = manifestOf({
      search: {
        url: 'https://api.example.com/s?q={query}',
        map: { title: 'n', durationMs: 'dur_ms', audioUrl: 'u' },
      },
    })
    const plugin = buildSourcePlugin(msManifest)!
    const results = await plugin.search!(
      config,
      'x',
      undefined,
      ctxReturning({ results: [{ n: 'A', dur_ms: 298999, u: 'https://a/1.mp3' }] })
    )
    expect(results[0].duration).toBe(299)
  })

  it('无 audioUrl 的搜索结果被跳过（没有播放地址的条目对播放器毫无意义）', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const results = await plugin.search!(
      config,
      'x',
      undefined,
      ctxReturning({
        results: [
          { song: { name: 'A' } },
          { song: { name: 'B', playUrl: 'https://a/2.mp3' } },
        ],
      })
    )
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('B')
  })

  it('`|` 分隔多路径按顺序取第一个有值的（上游字段名不统一）', async () => {
    const multi = manifestOf({
      search: {
        url: 'https://api.example.com/s?q={query}',
        map: { title: 'title|name|songName', artist: 'artist|singer', audioUrl: 'url|playUrl' },
      },
    })
    const plugin = buildSourcePlugin(multi)!
    const results = await plugin.search!(
      config,
      'x',
      undefined,
      ctxReturning({ results: [{ songName: 'C', singer: 'D', playUrl: 'https://a/3.mp3' }] })
    )
    expect(results[0]).toMatchObject({ title: 'C', artist: 'D', audioUrl: 'https://a/3.mp3' })
  })

  it('每条的 audioUrl 必须是字符串；数字/对象字段不隐式转换', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const results = await plugin.search!(
      config,
      'x',
      undefined,
      ctxReturning({ results: [{ song: { name: 'A', playUrl: { nested: true } } }] })
    )
    expect(results).toHaveLength(0)
  })
})

describe('search：HTTP 失败映射成既有错误码', () => {
  const manifest = manifestOf({
    search: { url: 'https://api.example.com/s?q={query}', map: { title: 't', audioUrl: 'u' } },
  })

  it('非 2xx 抛 sourceHttpStatus（带状态码）', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const ctx: PluginContext = {
      fetch: (async () => new Response('nope', { status: 503 })) as unknown as typeof globalThis.fetch,
    }
    await expect(plugin.search!(config, 'x', undefined, ctx)).rejects.toThrow(/503/)
  })

  it('非 JSON 抛 sourceNotJson', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const ctx: PluginContext = {
      fetch: (async () => new Response('<html>', { status: 200 })) as unknown as typeof globalThis.fetch,
    }
    await expect(plugin.search!(config, 'x', undefined, ctx)).rejects.toThrow()
  })

  it('网络异常抛 sourceRequestFailed（带源名，用户知道是哪条源坏了）', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const ctx: PluginContext = {
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof globalThis.fetch,
    }
    await expect(plugin.search!(config, 'x', undefined, ctx)).rejects.toThrow()
  })
})

describe('resolveTrack：失败返回 null（不打断播放）', () => {
  const manifest = manifestOf({
    source: undefined,
    search: { url: 'https://api.example.com/s?q={query}', map: { title: 't', audioUrl: 'u' } },
  } as never)
  const resolveManifest = manifestOf({
    search: { url: 'https://api.example.com/s?q={query}', map: { title: 't', audioUrl: 'u' } },
    resolveTrack: {
      url: 'https://api.example.com/track?id={id}&quality={quality}',
      map: {
        audioUrl: 'data.playUrl',
        quality: 'data.level',
        coverUrl: 'data.pic',
        expireAt: 'data.expire_at',
        isPreview: 'data.is_trial',
      },
    },
  })

  const ref = { sourceId: 'src-1', platform: 'demo', meta: { id: 'S1' } }

  it('成功映射出 ResolvedAudio（含过期时间与试听标记）', async () => {
    const plugin = buildSourcePlugin(resolveManifest)!
    const resolved = await plugin.resolveTrack!(
      config,
      ref,
      'flac',
      ctxReturning({
        data: { playUrl: 'https://a/1.flac', level: 'lossless', pic: 'https://i/a.jpg', expire_at: 1767225600000, is_trial: true },
      })
    )
    expect(resolved).toMatchObject({
      url: 'https://a/1.flac',
      quality: 'lossless',
      coverUrl: 'https://i/a.jpg',
      expireAt: 1767225600000,
      isPreview: true,
    })
  })

  it('isPreview=false 时不挂该字段（不留一个"明确不是试听"的冗余键）', async () => {
    const plugin = buildSourcePlugin(resolveManifest)!
    const resolved = await plugin.resolveTrack!(
      config,
      ref,
      undefined,
      ctxReturning({ data: { playUrl: 'https://a/1.mp3', is_trial: false } })
    )
    expect(resolved).not.toBeNull()
    expect(resolved!.isPreview).toBeUndefined()
  })

  it('令牌里没有源内 id → null（不猜、不拿别的源硬取）', async () => {
    const plugin = buildSourcePlugin(resolveManifest)!
    const noId = { sourceId: 'src-1', platform: 'demo', meta: {} }
    expect(await plugin.resolveTrack!(config, noId, undefined, ctxReturning({ data: { playUrl: 'x' } }))).toBeNull()
  })

  it.each([
    ['响应里没有 audioUrl', { data: { other: 'x' } }],
    ['audioUrl 非字符串', { data: { playUrl: 42 } }],
    ['响应是标量', 42],
    ['响应是 null', null],
  ])('%s → null', async (_label, payload) => {
    const plugin = buildSourcePlugin(resolveManifest)!
    expect(await plugin.resolveTrack!(config, ref, undefined, ctxReturning(payload))).toBeNull()
  })

  it('网络失败 → null 而不是抛错（上层据此回落按名搜索）', async () => {
    const plugin = buildSourcePlugin(resolveManifest)!
    const ctx: PluginContext = {
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof globalThis.fetch,
    }
    expect(await plugin.resolveTrack!(config, ref, undefined, ctx)).toBeNull()
  })

  it('取址响应包在 results[0] 里也能认（上游常用形态）', async () => {
    const plugin = buildSourcePlugin(resolveManifest)!
    const resolved = await plugin.resolveTrack!(
      config,
      ref,
      undefined,
      ctxReturning({ results: [{ data: { playUrl: 'https://a/2.mp3' } }] })
    )
    expect(resolved?.url).toBe('https://a/2.mp3')
  })

  it('裸对象响应（无 data 包裹）也能认', async () => {
    const bare = manifestOf({
      search: { url: 'https://api.example.com/s?q={query}', map: { title: 't', audioUrl: 'u' } },
      resolveTrack: { url: 'https://api.example.com/t?id={id}', map: { audioUrl: 'playUrl' } },
    })
    const plugin = buildSourcePlugin(bare)!
    const resolved = await plugin.resolveTrack!(
      config,
      ref,
      undefined,
      ctxReturning({ playUrl: 'https://a/3.mp3' })
    )
    expect(resolved?.url).toBe('https://a/3.mp3')
  })

  it('用 sourceId 而不是 config.id 之外的东西拼 id（取址永远按源内 id）', async () => {
    const recorded: string[] = []
    const plugin = buildSourcePlugin(resolveManifest)!
    await plugin.resolveTrack!(config, ref, undefined, ctxReturning({ data: {} }, recorded))
    expect(recorded[0]).toContain('id=S1')
  })
})

describe('playlistTracks：允许空 audioUrl（歌单常只给元信息）', () => {
  const manifest = manifestOf({
    playlistTracks: {
      url: 'https://api.example.com/playlist?id={playlistId}',
      map: { id: 'songmid', title: 'title', artist: 'singer', duration: 'duration' },
    },
  })

  it('无 audioUrl 的条目保留，并带惰性取址令牌（trackRef）', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const results = await plugin.getPlaylistTracks!(
      config,
      'PL1',
      ctxReturning({ songs: [{ songmid: 'M1', title: 'A', singer: 'B', duration: 200 }] })
    )
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      id: 'src-1-M1',
      songmid: 'M1',
      title: 'A',
      artist: 'B',
      duration: 200,
      audioUrl: '',
    })
    // 空 audioUrl + trackRef = 惰性取址：这是一等协议语义，不是补丁
    expect(results[0].trackRef).toEqual({ sourceId: 'src-1', platform: 'demo', meta: { id: 'M1' } })
  })

  it('占位符 {playlistId} 被替换', async () => {
    const recorded: string[] = []
    const plugin = buildSourcePlugin(manifest)!
    await plugin.getPlaylistTracks!(config, 'PL 1', ctxReturning({ songs: [] }, recorded))
    expect(recorded[0]).toContain('id=PL%201')
  })
})

describe('probe：只有搜索能力时可用搜索端点探活', () => {
  it('搜索端点通 → ok=true', async () => {
    const manifest = manifestOf({
      search: { url: 'https://api.example.com/s?q={query}', map: { title: 't', audioUrl: 'u' } },
    })
    const plugin = buildSourcePlugin(manifest)!
    const result = await plugin.probe!(config, ctxReturning({ results: [] }))
    expect(result.ok).toBe(true)
  })

  it('端点失败 → ok=false 且带错误信息（不抛给 UI）', async () => {
    const manifest = manifestOf({
      search: { url: 'https://api.example.com/s?q={query}', map: { title: 't', audioUrl: 'u' } },
    })
    const plugin = buildSourcePlugin(manifest)!
    const ctx: PluginContext = {
      fetch: (async () => new Response('x', { status: 500 })) as unknown as typeof globalThis.fetch,
    }
    const result = await plugin.probe!(config, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('只有取址能力时没有 probe（缺 id 的探活没有意义）', () => {
    const manifest = manifestOf({
      resolveTrack: { url: 'https://api.example.com/t?id={id}', map: { audioUrl: 'u' } },
    })
    const plugin = buildSourcePlugin(manifest)!
    expect(plugin.probe).toBeUndefined()
  })
})

describe('请求头合并：清单头覆盖默认、ctx.headers 覆盖清单头', () => {
  it('三层优先顺序', async () => {
    const manifest = manifestOf({
      search: {
        url: 'https://api.example.com/s?q={query}',
        headers: { 'X-From': 'manifest', 'X-Both': 'manifest' },
        map: { title: 't', audioUrl: 'u' },
      },
    })
    const plugin = buildSourcePlugin(manifest)!

    let seen: Record<string, string> = {}
    const ctx: PluginContext = {
      headers: { 'X-Both': 'config' },
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen = (init?.headers || {}) as Record<string, string>
        return new Response(JSON.stringify({ results: [] }), { status: 200 })
      }) as unknown as typeof globalThis.fetch,
    }
    await plugin.search!(config, 'x', undefined, ctx)

    expect(seen['X-From']).toBe('manifest')
    // 配置头优先级最高：用户在设置里填的头应当能盖掉插件自带的
    expect(seen['X-Both']).toBe('config')
    // 默认头仍在（UA 是部分上游的硬要求）
    expect(seen['User-Agent']).toBeTruthy()
  })
})

// ─── 数字型 id / songmid（同类缺陷的回归保护）──────────────
//
// 起因：`pickString` 只认字符串（`readString` 刻意不做隐式转换），
// 而第三方源用**数字 id** 是常态。丢掉数字 id 不会报错，只会静默：
//   - 搜索/歌单条目没有 songmid → 取址令牌里没有源内 id → 播放永远回落按名搜索
//     （同名不同版本会串录音，这是 trackResolver 存在的全部理由）
//   - 推荐歌单没有 id → 整条卡片消失
//   - 榜单曲目没有 songmid → 同样按名重搜
// 三处都必须"字符串或数字都收"，且都必须有测试钉住。

describe('数字型 id：字符串与数字都要收', () => {
  it('搜索结果的数字 id 不丢（否则取址令牌里没有源内 id）', async () => {
    const manifest = manifestOf({
      search: {
        url: 'https://api.example.com/s?q={query}',
        map: { id: 'song.id', title: 'song.name', audioUrl: 'song.url' },
      },
    })
    const plugin = buildSourcePlugin(manifest)!
    const results = await plugin.search!(
      config,
      'x',
      undefined,
      ctxReturning({ results: [{ song: { id: 123456, name: 'A', url: 'https://a/1.mp3' } }] })
    )
    expect(results).toHaveLength(1)
    // 数字被转成字符串，而不是变成 undefined
    expect(results[0].songmid).toBe('123456')
    expect(results[0].id).toBe('src-1-123456')
  })

  it('搜索结果的字符串 id 仍正常', async () => {
    const manifest = manifestOf({
      search: {
        url: 'https://api.example.com/s?q={query}',
        map: { id: 'song.id', title: 'song.name', audioUrl: 'song.url' },
      },
    })
    const plugin = buildSourcePlugin(manifest)!
    const results = await plugin.search!(
      config,
      'x',
      undefined,
      ctxReturning({ results: [{ song: { id: '002A97', name: 'A', url: 'https://a/1.mp3' } }] })
    )
    expect(results[0].songmid).toBe('002A97')
  })

  it('歌单曲目的数字 id 也带进 trackRef（惰性取址的前提）', async () => {
    const manifest = manifestOf({
      playlistTracks: {
        url: 'https://api.example.com/p?id={playlistId}',
        map: { id: 'songmid', title: 'title' },
      },
    })
    const plugin = buildSourcePlugin(manifest)!
    const results = await plugin.getPlaylistTracks!(
      config,
      'P1',
      ctxReturning({ songs: [{ songmid: 987654, title: 'A' }] })
    )
    expect(results[0].songmid).toBe('987654')
    expect(results[0].trackRef).toEqual({
      sourceId: 'src-1',
      platform: 'demo',
      meta: { id: '987654' },
    })
  })

  it('推荐歌单的数字 id 不丢（否则整条卡片消失）', async () => {
    const manifest = manifestOf({
      recommend: {
        url: 'https://api.example.com/r',
        items: 'list',
        map: { id: 'dissid', name: 'dissname' },
      },
    })
    const plugin = buildSourcePlugin(manifest)!
    const out = await plugin.recommendPlaylists!(
      config,
      {},
      ctxReturning({ list: [{ dissid: 9001, dissname: '华语流行' }] })
    )
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('9001')
  })

  it('榜单详情的数字 songmid 不丢（否则该曲目永远按名重搜）', async () => {
    const manifest = manifestOf({
      toplistDetail: {
        url: 'https://api.example.com/d?id={id}',
        map: { title: 'songname', artist: 'singer', songmid: 'mid' },
      },
    })
    const plugin = buildSourcePlugin(manifest)!
    const out = await plugin.toplistDetail!(
      config,
      { id: 4 },
      ctxReturning({ songs: [{ songname: 'A', singer: 'B', mid: 555666 }] })
    )
    expect(out.songs[0].songmid).toBe('555666')
  })

  it('数字 id 为 0 时保留（0 是合法 id，不能当"没有"）', async () => {
    const manifest = manifestOf({
      search: {
        url: 'https://api.example.com/s?q={query}',
        map: { id: 'id', title: 'title', audioUrl: 'url' },
      },
    })
    const plugin = buildSourcePlugin(manifest)!
    const results = await plugin.search!(
      config,
      'x',
      undefined,
      ctxReturning({ results: [{ id: 0, title: 'A', url: 'https://a/1.mp3' }] })
    )
    expect(results[0].songmid).toBe('0')
  })

  it('id 缺失时仍回落列表序号（不因修复而改变原有兜底）', async () => {
    const manifest = manifestOf({
      search: {
        url: 'https://api.example.com/s?q={query}',
        map: { id: 'id', title: 'title', audioUrl: 'url' },
      },
    })
    const plugin = buildSourcePlugin(manifest)!
    const results = await plugin.search!(
      config,
      'x',
      undefined,
      ctxReturning({ results: [{ title: 'A', url: 'https://a/1.mp3' }] })
    )
    expect(results[0].songmid).toBeUndefined()
    expect(results[0].id).toBe('src-1-0')
  })

  it('`|` 多路径里数字与字符串混合时按顺序取第一个有值的', async () => {
    const manifest = manifestOf({
      search: {
        url: 'https://api.example.com/s?q={query}',
        map: { id: 'songId|mid', title: 'title', audioUrl: 'url' },
      },
    })
    const plugin = buildSourcePlugin(manifest)!
    const results = await plugin.search!(
      config,
      'x',
      undefined,
      ctxReturning({ results: [{ mid: 777, title: 'A', url: 'https://a/1.mp3' }] })
    )
    expect(results[0].songmid).toBe('777')
  })
})
