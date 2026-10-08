/**
 * 源探测与惰性取址的平台契约测试（形态差异收在平台层，上层只认原生语义）。
 *
 * 钉住的是「渲染层这条链路」的语义，它们在真机上只能靠肉眼，重构时极容易静默丢掉：
 *  1) 非惰性取址的源（无 trackRef / 源 kind 不匹配 / 源已被删）一律返回 null，
 *     调用方才能安全回落到既有取址路径（这里抛错就会直接弹到播放失败的 UI 上）；
 *  2) 取址成功后返回的是**副本**，原 track 不被改写（直链会过期，落库会写进死地址）；
 *  3) 浏览器端与未知环境按「该形态不可用」处理（返回 null / 可读结论），不崩；
 *  4) 探测对服务形态的源不经过脚本宿主，直接取端点自描述。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Track } from '@/types'

const state = vi.hoisted(() => ({
  onlineSources: [] as Array<Record<string, unknown>>,
  downloadQuality: 'flac' as string,
  resolveUrl: vi.fn(async (..._args: unknown[]) => ({
    url: 'http://bd-lw.kuwo.cn/x/6ac51e74/resource/30106/trackmedia/M800.mp3',
    quality: '320k',
  })),
}))

// ─── 浏览器环境（web 平台）：脚本宿主无该能力 ───
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

const deferredTrack = (over: Partial<Track> = {}): Track =>
  ({
    id: 'k1',
    path: 'online:k1',
    title: '起风了',
    artist: '买辣椒也用券',
    album: '',
    duration: 325,
    addedAt: 0,
    playCount: 0,
    liked: false,
    onlineSource: 'src-lx',
    onlineSourceName: 'Huibq 音源',
    trackRef: { sourceId: 'src-lx', platform: 'kw', meta: { songmid: '91084746' } },
    ...over,
  }) as Track

describe('web 平台：脚本形态不可用', () => {
  it('取址恒返回 null；探测给可读结论而非抛错', async () => {
    const { createWebPlatform } = await import('../web')
    const platform = createWebPlatform() as unknown as {
      resolveTrackAudio: (t: Track) => Promise<Track | null>
      probeSource: (i: { kind?: string; sourceUrl: string }) => Promise<{
        ok: boolean
        error?: string
        capabilities: unknown[]
      }>
    }
    expect(await platform.resolveTrackAudio(deferredTrack())).toBeNull()
    const probe = await platform.probeSource({ kind: 'lx', sourceUrl: 'https://example.com/x.js' })
    expect(probe.ok).toBe(false)
    expect(probe.error).toContain('不支持')
    expect(probe.capabilities).toEqual([])
  })

  it('服务形态的探测不经脚本宿主，直接读端点自描述', async () => {
    const fetchStub = vi.fn(async () =>
      new Response(JSON.stringify({ endpoints: { search: '/aurora?query={query}' } }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchStub)
    const { createWebPlatform } = await import('../web')
    const platform = createWebPlatform() as unknown as {
      probeSource: (i: { kind?: string; sourceUrl: string }) => Promise<{
        ok: boolean
        capabilities: Array<{ key: string; searchable: boolean }>
      }>
    }
    const probe = await platform.probeSource({ kind: 'aurora', sourceUrl: 'https://music.example.com' })
    vi.unstubAllGlobals()
    expect(probe.ok).toBe(true)
    expect(probe.capabilities.map((c) => c.key)).toContain('search')
    expect(probe.capabilities.find((c) => c.key === 'search')?.searchable).toBe(true)
  })
})

describe('桌面端：惰性取址语义', () => {
  it('回填 onlineUrl 并返回副本，不改写原 track', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      electronAPI: { lxSource: { resolveUrl: state.resolveUrl } },
    }
    state.onlineSources = [
      { id: 'src-lx', name: 'Huibq 音源', kind: 'lx', sourceUrl: 'https://example.com/huibq.js', enabled: true },
    ]
    const { createDesktopPlatform } = await import('../index')
    const platform = createDesktopPlatform() as unknown as { resolveTrackAudio: (t: Track) => Promise<Track | null> }

    const origin = deferredTrack()
    const out = await platform.resolveTrackAudio(origin)
    expect(out?.onlineUrl).toBe('http://bd-lw.kuwo.cn/x/6ac51e74/resource/30106/trackmedia/M800.mp3')
    expect(origin.onlineUrl).toBeUndefined()
    expect(out).not.toBe(origin)
    // 质量档位取用户设置的下载音质（App 默认 flac）
    expect(state.resolveUrl).toHaveBeenCalledWith(origin.trackRef, state.onlineSources[0], 'flac')
  })

  it('无定位令牌 / 源形态不匹配 / 源已删除时返回 null（不请求源）', async () => {
    state.resolveUrl.mockClear()
    ;(globalThis as unknown as { window: unknown }).window = {
      electronAPI: { lxSource: { resolveUrl: state.resolveUrl } },
    }
    const { createDesktopPlatform } = await import('../index')
    const platform = createDesktopPlatform() as unknown as { resolveTrackAudio: (t: Track) => Promise<Track | null> }

    state.onlineSources = [
      { id: 'src-lx', name: 'Aurora 源', kind: 'aurora', sourceUrl: 'https://example.com/aurora', enabled: true },
    ]
    expect(await platform.resolveTrackAudio(deferredTrack())).toBeNull()

    state.onlineSources = []
    expect(await platform.resolveTrackAudio(deferredTrack())).toBeNull()

    expect(await platform.resolveTrackAudio(deferredTrack({ trackRef: undefined }))).toBeNull()
    expect(state.resolveUrl).not.toHaveBeenCalled()
  })

  it('主进程报错或地址非法时返回 null，不把异常穿透到 UI', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      electronAPI: {
        lxSource: {
          resolveUrl: vi
            .fn()
            .mockRejectedValueOnce(new Error('脚本「Huibq」不支持平台 kw'))
            .mockResolvedValueOnce({ url: 'not-a-url', quality: '128k' }),
        },
      },
    }
    state.onlineSources = [
      { id: 'src-lx', name: 'Huibq 音源', kind: 'lx', sourceUrl: 'https://example.com/huibq.js', enabled: true },
    ]
    const { createDesktopPlatform } = await import('../index')
    const platform = createDesktopPlatform() as unknown as { resolveTrackAudio: (t: Track) => Promise<Track | null> }

    expect(await platform.resolveTrackAudio(deferredTrack())).toBeNull()
    expect(await platform.resolveTrackAudio(deferredTrack())).toBeNull()
  })

  it('脚本形态探测：拉脚本 + 执行宿主 + 翻译成原生能力行', async () => {
    const electronAPI = {
      lxSource: {
        fetchScript: vi.fn(async () => 'var lx = globalThis.lx'),
        inspect: vi.fn(async () => ({
          ok: true,
          platforms: {
            kw: { name: '酷我', actions: ['musicUrl'], qualitys: ['128k', '320k'] },
            mg: { name: '咪咕', actions: ['musicUrl', 'search'], qualitys: ['128k'] },
          },
        })),
      },
    }
    ;(globalThis as unknown as { window: unknown }).window = { electronAPI }
    const { createDesktopPlatform } = await import('../index')
    const platform = createDesktopPlatform() as unknown as {
      probeSource: (i: { kind?: string; sourceUrl: string }) => Promise<{
        ok: boolean
        kind: string
        capabilities: Array<{ key: string; label: string; searchable: boolean; qualityCount?: number }>
      }>
    }

    const probe = await platform.probeSource({ kind: 'lx', sourceUrl: 'https://example.com/huibq.js' })
    expect(probe.ok).toBe(true)
    expect(probe.kind).toBe('lx')
    expect(electronAPI.lxSource.fetchScript).toHaveBeenCalledWith('https://example.com/huibq.js')
    const kw = probe.capabilities.find((c) => c.key === 'kw')
    expect(kw).toEqual({ key: 'kw', label: '酷我', searchable: false, qualityCount: 2 })
    // 自带 search 的平台在能力行里必须标成可检索，否则界面会把「搜索+取址」误报成「取址」
    expect(probe.capabilities.find((c) => c.key === 'mg')?.searchable).toBe(true)
  })
})

describe('移动端：能力走 shared 直调', () => {
  it('原生容器下暴露 probeSource 与 resolveTrackAudio，非惰性取址直接短路', async () => {
    vi.resetModules()
    ;(globalThis as unknown as { window: unknown }).window = {
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    }
    const { createMobilePlatform } = await import('../mobile')
    const platform = createMobilePlatform() as unknown as Record<string, unknown>
    for (const name of ['probeSource', 'resolveTrackAudio']) {
      expect(typeof platform[name]).toBe('function')
    }
    const resolve = platform.resolveTrackAudio as (t: Track) => Promise<Track | null>
    expect(await resolve(deferredTrack({ trackRef: undefined }))).toBeNull()
  })
})
