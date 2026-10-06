/**
 * 洛雪脚本源的平台接口契约测试。
 *
 * 钉住的是「渲染层这条链路」的三条语义，它们在真机上只能靠肉眼，重构时极容易静默丢掉：
 *  1) 非脚本源（无 track.lx / 源 kind 不是 lx / 源已被删）一律返回 null，
 *     调用方才能安全回落到既有取址路径（这里抛错就会直接弹到播放失败的 UI 上）；
 *  2) 取址成功后返回的是**副本**，原 track 不被改写（直链会过期，落库会写进死地址）；
 *  3) 浏览器端与未知环境按「无该能力」处理（返回 null / 可读错误），不崩。
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

// ─── 浏览器环境（web 平台）：两个入口都无脚本能力 ───
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

const lxTrack = (over: Partial<Track> = {}): Track =>
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
    lx: { sourceId: 'src-lx', platform: 'kw', meta: { songmid: '91084746' } },
    ...over,
  }) as Track

describe('web 平台：洛雪能力空实现', () => {
  it('resolveLxTrack 恒返回 null，inspectLxSource 给可读错误而非抛错', async () => {
    const { createWebPlatform } = await import('../web')
    const platform = createWebPlatform() as unknown as {
      resolveLxTrack: (t: Track) => Promise<Track | null>
      inspectLxSource: (s: unknown) => Promise<{ ok: boolean; error?: string }>
    }
    expect(await platform.resolveLxTrack(lxTrack())).toBeNull()
    const inspection = await platform.inspectLxSource({ id: 'x', name: 'x', sourceUrl: '', enabled: true })
    expect(inspection.ok).toBe(false)
    expect(inspection.error).toContain('不支持')
  })
})

describe('桌面端：resolveLxTrack 取址语义', () => {
  it('回填 onlineUrl 并返回副本，不改写原 track', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      electronAPI: { lxSource: { resolveUrl: state.resolveUrl } },
    }
    state.onlineSources = [
      { id: 'src-lx', name: 'Huibq 音源', kind: 'lx', sourceUrl: 'https://example.com/huibq.js', enabled: true },
    ]
    const { createDesktopPlatform } = await import('../index')
    const platform = createDesktopPlatform() as unknown as { resolveLxTrack: (t: Track) => Promise<Track | null> }

    const origin = lxTrack()
    const out = await platform.resolveLxTrack(origin)
    expect(out?.onlineUrl).toBe('http://bd-lw.kuwo.cn/x/6ac51e74/resource/30106/trackmedia/M800.mp3')
    expect(origin.onlineUrl).toBeUndefined()
    expect(out).not.toBe(origin)
    // 质量档位取用户设置的下载音质（App 默认 flac）
    expect(state.resolveUrl).toHaveBeenCalledWith(origin.lx, state.onlineSources[0], 'flac')
  })

  it('无 lx 定位 / 源不是脚本源 / 源已删除时返回 null（不请求脚本）', async () => {
    state.resolveUrl.mockClear()
    ;(globalThis as unknown as { window: unknown }).window = {
      electronAPI: { lxSource: { resolveUrl: state.resolveUrl } },
    }
    const { createDesktopPlatform } = await import('../index')
    const platform = createDesktopPlatform() as unknown as { resolveLxTrack: (t: Track) => Promise<Track | null> }

    state.onlineSources = [
      { id: 'src-lx', name: 'Aurora 源', kind: 'aurora', sourceUrl: 'https://example.com/aurora', enabled: true },
    ]
    expect(await platform.resolveLxTrack(lxTrack())).toBeNull()

    state.onlineSources = []
    expect(await platform.resolveLxTrack(lxTrack())).toBeNull()

    expect(await platform.resolveLxTrack(lxTrack({ lx: undefined }))).toBeNull()
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
    const platform = createDesktopPlatform() as unknown as { resolveLxTrack: (t: Track) => Promise<Track | null> }

    expect(await platform.resolveLxTrack(lxTrack())).toBeNull()
    expect(await platform.resolveLxTrack(lxTrack())).toBeNull()
  })
})

describe('移动端：洛雪接口走 shared 直调', () => {
  it('原生容器下 createMobilePlatform 暴露三个洛雪方法', async () => {
    vi.resetModules()
    ;(globalThis as unknown as { window: unknown }).window = {
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    }
    const { createMobilePlatform } = await import('../mobile')
    const platform = createMobilePlatform() as unknown as Record<string, unknown>
    for (const name of ['fetchLxScript', 'inspectLxSource', 'resolveLxTrack']) {
      expect(typeof platform[name]).toBe('function')
    }
    // 非脚本源直接短路，不触碰 shared
    const resolve = platform.resolveLxTrack as (t: Track) => Promise<Track | null>
    expect(await resolve(lxTrack({ lx: undefined }))).toBeNull()
  })
})