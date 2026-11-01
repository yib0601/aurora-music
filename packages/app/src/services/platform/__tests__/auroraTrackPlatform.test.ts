/**
 * 自有服务协议「按源内 id 取址」的平台契约测试（渲染层这条链路，真机上只能靠肉眼）。
 *
 * 钉住的是本次加固的语义（起因：按「歌名 + 歌手」重搜把《雨天》原唱判给了 QQ 上
 * 同名的「雨天 (变速版)」，界面显示 4:34、播出来是 115s 的那条）：
 *  1) 曲目带源内 id（onlineId）时**先按 id 向源取址**，不再退回按名重搜；
 *  2) 历史形态的 onlineId（`<sourceId>-<id>`）先剥前缀再交给源 —— 不剥就取不到址，
 *     会静默退回按名重搜（正是要消除的行为）；
 *  3) 取址失败（无权益 / id 不存在 / 老服务端）一律返回 null 而不抛错：
 *     调用方据此回落按名搜索，用户最多回到旧路径，而不是播不出来；
 *  4) 取址成功返回**副本**，原 track 不被改写（直链会过期，落库就是写死地址）；
 *  5) 脚本源（kind='lx'）的 onlineId 不是源内 id，不按 id 取址。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '@/types'

const state = vi.hoisted(() => {
  /** IPC 回传的取址结果：成功（有直链）或失败（`audioUrl: null` + 原因），两条路径都要能覆盖 */
  type ResolveResult = {
    audioUrl: string | null
    quality?: string
    reason?: string
    qualityUrls?: Record<string, string>
    coverUrl?: string
    duration?: number
    title?: string
    artist?: string
  }
  return {
    onlineSources: [] as Array<Record<string, unknown>>,
    downloadQuality: 'flac' as string,
    // 新契约：桌面端取址走插件门面 `plugins.resolveTrack`（与搜索同一条路）。
    // 旧通道 `onlineTrack.resolveById` 只剩历史 preload 兼容，不再是主路径。
    pluginsResolveTrack: vi.fn(
      async (..._args: unknown[]): Promise<Record<string, unknown> | null> => ({
        url: 'http://cdn.example.com/M500002RXlW80X7JS7.mp3?vkey=x',
        quality: '128',
        qualityUrls: { '128': 'http://cdn.example.com/M500002RXlW80X7JS7.mp3?vkey=x' },
        coverUrl: 'https://y.qq.com/music/photo_new/T002R300x300M000001rvLZC39uADA.jpg',
      })
    ),
    resolveById: vi.fn(
      async (..._args: unknown[]): Promise<ResolveResult> => ({
        audioUrl: 'http://cdn.example.com/M500002RXlW80X7JS7.mp3?vkey=x',
        quality: '128',
        qualityUrls: { '128': 'http://cdn.example.com/M500002RXlW80X7JS7.mp3?vkey=x' },
        coverUrl: 'https://y.qq.com/music/photo_new/T002R300x300M000001rvLZC39uADA.jpg',
        duration: 274,
        title: '雨天',
        artist: '汪苏泷',
      })
    ),
  }
})

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
  CapacitorHttp: { request: async () => ({ status: 200, data: '' }) },
}))
vi.mock('@capacitor/filesystem', () => ({
  Directory: { ExternalStorage: 'EXTERNAL_STORAGE' },
  Filesystem: {},
}))

vi.mock('@/stores/libraryStore', () => ({
  useLibraryStore: {
    getState: () => ({
      onlineSources: state.onlineSources,
      downloadQuality: state.downloadQuality,
    }),
  },
}))

/** 音乐馆榜单 / 歌单条目构造出的曲目：有源内 id、没有直链（直链按约定不持久化） */
const hallTrack = (over: Partial<Track> = {}): Track =>
  ({
    id: 'hall-7798009869-33',
    path: '',
    title: '雨天',
    artist: '汪苏泷',
    album: '繁星四月 电视剧原声带',
    duration: 274,
    addedAt: 0,
    playCount: 0,
    liked: false,
    onlineSource: 'src-hall',
    onlineSourceName: 'Aurora 源',
    onlineId: '002A97IJ2D6KYA',
    ...over,
  }) as Track

const AURORA_SOURCE = {
  id: 'src-hall',
  name: 'Aurora 源',
  kind: 'aurora',
  sourceUrl: 'https://music.example.com?key=00000000-0000-0000-0000-000000000000',
  enabled: true,
}

afterEach(() => {
  // 打桩走 globalThis.fetch：用例里的 vi.resetModules() 会重新实例化 @aurora/shared，
  // 而 setCustomFetch 注入的是**那之前**的模块实例（两实例各有自己的注入点），
  // 全局 fetch 则与实例无关，任何一层调用都吃得到
  vi.unstubAllGlobals()
  state.resolveById.mockClear()
  state.pluginsResolveTrack.mockClear()
})

describe('桌面端：按源内 id 取址（IPC 走主进程）', () => {
  it('回填直链 / 多音质地址 / 封面，并返回副本（不改写原 track）', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      electronAPI: {
        onlineTrack: { resolveById: state.resolveById },
        plugins: {
          list: async () => [],
          probe: async () => ({}),
          search: async () => [],
          resolveTrack: state.pluginsResolveTrack,
          userPlaylists: async () => [],
          playlistTracks: async () => [],
          login: async () => ({ ok: true }),
          authState: async () => ({}),
          logout: async () => ({ ok: true }),
        },
      },
    }
    state.onlineSources = [AURORA_SOURCE]
    const { createDesktopPlatform } = await import('../index')
    const platform = createDesktopPlatform() as unknown as {
      resolveTrackAudio: (t: Track) => Promise<Track | null>
    }

    const origin = hallTrack()
    const out = await platform.resolveTrackAudio(origin)

    expect(out?.onlineUrl).toBe('http://cdn.example.com/M500002RXlW80X7JS7.mp3?vkey=x')
    expect(out?.onlineQualityUrls).toEqual({
      '128': 'http://cdn.example.com/M500002RXlW80X7JS7.mp3?vkey=x',
    })
    expect(out?.coverUrl).toBe('https://y.qq.com/music/photo_new/T002R300x300M000001rvLZC39uADA.jpg')
    // 副本语义：直链会过期，写回原 track 就是写进死地址
    expect(origin.onlineUrl).toBeUndefined()
    expect(out).not.toBe(origin)
    // 交给主进程的是「插件 id + 源配置 + 定位令牌 + 用户下载音质」。
    // P3 起桌面端取址统一走插件门面（`plugins.resolveTrack`），不再有
    // `onlineTrack.resolveById` 这条 aurora 专用通道 —— 后者正是让装来的
    // 声明式插件取不到址的原因（它被形态分支排除在外）。
    expect(state.resolveById).not.toHaveBeenCalled()
    expect(state.pluginsResolveTrack).toHaveBeenCalled()
    const [pluginId, cfgArg, tokenArg, qualityArg] = state.pluginsResolveTrack.mock.calls[0]
    expect(pluginId).toBe('aurora')
    expect((cfgArg as { id: string }).id).toBe('src-hall')
    // 令牌是不透明定位信息：aurora 读 meta.songmid，历史前缀已剥掉
    expect((tokenArg as { meta: { songmid: string } }).meta.songmid).toBe('002A97IJ2D6KYA')
    expect(qualityArg).toBe('flac')
  })

  it('历史形态的 onlineId（带 <sourceId>- 前缀）先剥前缀再接源', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      electronAPI: {
        onlineTrack: { resolveById: state.resolveById },
        plugins: {
          list: async () => [],
          probe: async () => ({}),
          search: async () => [],
          resolveTrack: state.pluginsResolveTrack,
          userPlaylists: async () => [],
          playlistTracks: async () => [],
          login: async () => ({ ok: true }),
          authState: async () => ({}),
          logout: async () => ({ ok: true }),
        },
      },
    }
    state.onlineSources = [AURORA_SOURCE]
    const { createDesktopPlatform } = await import('../index')
    const platform = createDesktopPlatform() as unknown as {
      resolveTrackAudio: (t: Track) => Promise<Track | null>
    }

    await platform.resolveTrackAudio(hallTrack({ onlineId: 'src-hall-002A97IJ2D6KYA' }))

    // 历史形态 `<sourceId>-<songmid>` 的剥前缀逻辑保留在 `trackRefFor` 里，
    // 断言落到令牌上（而不是某条通道的参数顺序）
    expect(state.pluginsResolveTrack).toHaveBeenCalled()
    const token = state.pluginsResolveTrack.mock.calls[0][2] as { meta: { songmid: string } }
    expect(token.meta.songmid).toBe('002A97IJ2D6KYA')
  })

  it('取址失败（无权益 / id 不存在 / 老服务端）返回 null，由调用方回落按名搜索', async () => {
    // 取址失败：插件返回 null（无权益 / id 不存在 / 老服务端都归一成这一种）
    state.pluginsResolveTrack.mockResolvedValueOnce(null)
    ;(globalThis as unknown as { window: unknown }).window = {
      electronAPI: {
        onlineTrack: { resolveById: state.resolveById },
        plugins: {
          list: async () => [],
          probe: async () => ({}),
          search: async () => [],
          resolveTrack: state.pluginsResolveTrack,
          userPlaylists: async () => [],
          playlistTracks: async () => [],
          login: async () => ({ ok: true }),
          authState: async () => ({}),
          logout: async () => ({ ok: true }),
        },
      },
    }
    state.onlineSources = [AURORA_SOURCE]
    const { createDesktopPlatform } = await import('../index')
    const platform = createDesktopPlatform() as unknown as {
      resolveTrackAudio: (t: Track) => Promise<Track | null>
    }

    expect(await platform.resolveTrackAudio(hallTrack())).toBeNull()
  })

  it('主进程抛错或直链非法时同样返回 null，不把异常穿透到 UI', async () => {
    const resolveTrack = vi
      .fn()
      .mockRejectedValueOnce(new Error('IPC 挂了'))
      .mockResolvedValueOnce({ url: 'not-a-url', quality: '128' })
    ;(globalThis as unknown as { window: unknown }).window = {
      electronAPI: {
        plugins: {
          list: async () => [],
          probe: async () => ({}),
          search: async () => [],
          resolveTrack,
          userPlaylists: async () => [],
          playlistTracks: async () => [],
          login: async () => ({ ok: true }),
          authState: async () => ({}),
          logout: async () => ({ ok: true }),
        },
      },
    }
    state.onlineSources = [AURORA_SOURCE]
    const { createDesktopPlatform } = await import('../index')
    const platform = createDesktopPlatform() as unknown as {
      resolveTrackAudio: (t: Track) => Promise<Track | null>
    }

    expect(await platform.resolveTrackAudio(hallTrack())).toBeNull()
    expect(await platform.resolveTrackAudio(hallTrack())).toBeNull()
  })

  it('脚本源的 onlineId 不是源内 id：不按 id 取址（没令牌就返回 null）', async () => {
    // 这条不变量的**判定位置**在 P3 从平台层移到了插件内：
    // 平台层不再按 `kind === 'lx'` 拦，而是把「无 platform 的令牌」交给 lx 插件，
    // 由 `lxResolver` 以 `core.error.lxTrackRefMissing` 拒绝（空 platform 无法定位平台）。
    // 所以这里让 mock 如实模拟插件契约：platform 为空 → 取不到址。
    const strictResolve = vi.fn(
      async (
        _id: unknown,
        _cfg: unknown,
        token?: { platform?: string }
      ): Promise<Record<string, unknown> | null> =>
        token?.platform ? { url: 'http://cdn.example.com/x.mp3' } : null
    )
    ;(globalThis as unknown as { window: unknown }).window = {
      electronAPI: {
        onlineTrack: { resolveById: state.resolveById },
        plugins: {
          list: async () => [],
          probe: async () => ({}),
          search: async () => [],
          resolveTrack: strictResolve,
          userPlaylists: async () => [],
          playlistTracks: async () => [],
          login: async () => ({ ok: true }),
          authState: async () => ({}),
          logout: async () => ({ ok: true }),
        },
      },
    }
    state.onlineSources = [
      { id: 'src-hall', name: 'Huibq 音源', kind: 'lx', sourceUrl: 'https://e.com/x.js', enabled: true },
    ]
    const { createDesktopPlatform } = await import('../index')
    const platform = createDesktopPlatform() as unknown as {
      resolveTrackAudio: (t: Track) => Promise<Track | null>
    }

    expect(await platform.resolveTrackAudio(hallTrack())).toBeNull()
    expect(state.resolveById).not.toHaveBeenCalled()
  })

  it('源已删除时返回 null（不猜、不拿别的源硬取）', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      electronAPI: {
        onlineTrack: { resolveById: state.resolveById },
        plugins: {
          list: async () => [],
          probe: async () => ({}),
          search: async () => [],
          resolveTrack: state.pluginsResolveTrack,
          userPlaylists: async () => [],
          playlistTracks: async () => [],
          login: async () => ({ ok: true }),
          authState: async () => ({}),
          logout: async () => ({ ok: true }),
        },
      },
    }
    state.onlineSources = []
    const { createDesktopPlatform } = await import('../index')
    const platform = createDesktopPlatform() as unknown as {
      resolveTrackAudio: (t: Track) => Promise<Track | null>
    }

    expect(await platform.resolveTrackAudio(hallTrack())).toBeNull()
    expect(state.resolveById).not.toHaveBeenCalled()
  })
})

describe('移动端：按源内 id 取址直调 shared 执行器', () => {
  it('原生容器下按 id 取址并回填直链（CapacitorHttp 不受 WebView CORS 限制）', async () => {
    vi.resetModules()
    ;(globalThis as unknown as { window: unknown }).window = {
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    }
    state.onlineSources = [AURORA_SOURCE]
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: unknown) => {
      calls.push(String(input))
      return new Response(
        JSON.stringify({
          songmid: '002A97IJ2D6KYA',
          found: true,
          reason: null,
          results: [
            {
              audioUrl: 'http://cdn.example.com/M500002RXlW80X7JS7.mp3?vkey=x',
              id: '002A97IJ2D6KYA',
              songmid: '002A97IJ2D6KYA',
              title: '雨天',
              duration: 274,
              quality: '128',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    const { createMobilePlatform } = await import('../mobile')
    const platform = createMobilePlatform() as unknown as {
      resolveTrackAudio: (t: Track) => Promise<Track | null>
    }
    const out = await platform.resolveTrackAudio(hallTrack())

    expect(out?.onlineUrl).toBe('http://cdn.example.com/M500002RXlW80X7JS7.mp3?vkey=x')
    // 请求发到源的 /aurora/track?id=<源内 id>：id 前缀已被剥掉、quality 取用户设置
    expect(calls[0]).toContain('/aurora/track?id=002A97IJ2D6KYA')
    expect(calls[0]).toContain('quality=flac')
  })

  it('无源内 id 且无令牌时短路返回 null（不读源配置、不发请求）', async () => {
    vi.resetModules()
    ;(globalThis as unknown as { window: unknown }).window = {
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    }
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: unknown) => {
      calls.push(String(input))
      return new Response('{}', { status: 200 })
    })

    const { createMobilePlatform } = await import('../mobile')
    const platform = createMobilePlatform() as unknown as {
      resolveTrackAudio: (t: Track) => Promise<Track | null>
    }
    expect(await platform.resolveTrackAudio(hallTrack({ onlineId: undefined }))).toBeNull()
    expect(calls).toEqual([])
  })
})
