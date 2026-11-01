/**
 * 平台层「源探测 / 惰性取址」转发独立验证（对抗性验证）
 *
 * 本文件**单独成文件**是刻意的：node 环境里 zustand/persist 首次创建时会缓存
 * `localStorage` 引用，而在同一模块图里既做「store 落盘断言」又做「真实 platform
 * 惰性加载 store」会让两边互相污染。这里用 vi.resetModules + 干净的全局桩，专测
 * 「渲染层 → 主进程」这一跳的参数契约（上层只认原生语义：定位令牌 + 取址门面）。
 *
 * 运行：cd packages/app && npx vitest run src/services/platform/__tests__/lxVerifierPlatform.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  ipcCalls: [] as any[],
  ipcResolve: null as null | ((ref: any, source: any, quality?: string) => Promise<any>),
  sources: [] as any[],
  quality: '320' as string,
}))

vi.mock('@/stores/libraryStore', () => ({
  useLibraryStore: {
    getState: () => ({ onlineSources: h.sources, downloadQuality: h.quality }),
    setState: () => {},
  },
}))

beforeEach(() => {
  h.ipcCalls.length = 0
  h.ipcResolve = async () => ({ url: 'http://real.test/a.mp3', quality: '320k' })
  h.sources = [{ id: 'lx-1', name: '洛雪', kind: 'lx', sourceUrl: 'http://s/x.js', enabled: true }]
  h.quality = '320'
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  })
  vi.stubGlobal('window', {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    electronAPI: {
      platform: 'desktop',
      // P3 起取址统一走插件门面；`lxSource.resolveUrl` 只剩历史 preload 兼容路径。
      // 这里同时提供两者，断言只盯新通道（`h.ipcCalls` 由 `plugins.resolveTrack` 记录）。
      plugins: {
        list: async () => [],
        probe: async () => ({}),
        search: async () => [],
        resolveTrack: async (pluginId: any, source: any, ref: any, quality?: string) => {
          h.ipcCalls.push({ pluginId, ref, source, quality })
          return await h.ipcResolve!(ref, source, quality)
        },
        userPlaylists: async () => [],
        playlistTracks: async () => [],
        login: async () => ({ ok: true }),
        authState: async () => ({}),
        logout: async () => ({ ok: true }),
      },
      lxSource: {
        fetchScript: async () => '',
        inspect: async () => ({}),
        search: async () => [],
        resolveUrl: async (ref: any, source: any, quality?: string) => {
          h.ipcCalls.push({ ref, source, quality })
          return await h.ipcResolve!(ref, source, quality)
        },
        clearCache: async () => {},
      },
    },
  })
})

const trackOf = (over: Record<string, unknown>) =>
  ({
    id: 't-1',
    title: '起风了',
    artist: '买辣椒也用券',
    album: '',
    duration: 325,
    path: '',
    addedAt: 0,
    playCount: 0,
    liked: false,
    ...over,
  }) as any

describe('平台层取址门面转发', () => {
  it('3a resolveTrackAudio 把令牌/源/音质完整交给主进程，只回填副本', async () => {
    const mod = await import('@/services/platform')
    const track = trackOf({
      id: 't9',
      onlineUrl: '',
      trackRef: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '91084746' } },
    })
    const out = await mod.platform.resolveTrackAudio(track)
    expect(h.ipcCalls.length).toBe(1)
    expect(h.ipcCalls[0].ref).toEqual({ sourceId: 'lx-1', platform: 'kw', meta: { songmid: '91084746' } })
    expect(h.ipcCalls[0].source.id).toBe('lx-1')
    expect(h.ipcCalls[0].quality).toBe('320')
    expect(out?.onlineUrl).toBe('http://real.test/a.mp3')
    expect(track.onlineUrl).toBe('') // 原对象不被就地修改
  })

  it('3b 缺令牌 / 源不存在 / 直链非 http：一律 null，且只在必要时触碰 IPC', async () => {
    const mod = await import('@/services/platform')
    expect(await mod.platform.resolveTrackAudio(trackOf({ id: 'x0', onlineUrl: '' }))).toBeNull()
    h.sources = []
    expect(
      await mod.platform.resolveTrackAudio(
        trackOf({ id: 'x1', onlineUrl: '', trackRef: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '1' } } })
      )
    ).toBeNull()
    // 源存在，但它的形态与令牌不匹配（这里用无 kind 的 aurora 形态源，令牌却是脚本源形态）。
    // 判定交给插件：真实 lx 插件会以「源不是脚本源」拒绝，故 null。
    h.sources = [{ id: 'lx-1', name: 'Aurora', sourceUrl: 'http://a', enabled: true }]
    h.ipcResolve = async () => null
    expect(
      await mod.platform.resolveTrackAudio(
        trackOf({ id: 'x2', onlineUrl: '', trackRef: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '1' } } })
      )
    ).toBeNull()
    h.sources = [{ id: 'lx-1', name: '洛雪', kind: 'lx', sourceUrl: 'http://s/x.js', enabled: true }]
    h.ipcResolve = async () => ({ url: 'not-a-url', quality: '128k' })
    expect(
      await mod.platform.resolveTrackAudio(
        trackOf({ id: 'x3', onlineUrl: '', trackRef: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '1' } } })
      )
    ).toBeNull()
    // 只有「源存在 + 交给插件后取不到 http 地址」这一条会触碰 IPC。
    //
    // 语义变化（P3）：改造前平台层会用 `kind === 'lx'` 预先拦掉"形态不符"的源，
    // 一次 IPC 都不发；现在形态判定交给插件自己（`ctx` + 令牌能力），平台层只
    // 负责"有源、有令牌就交给插件"。所以「源形态不符」那段会多一次 IPC ——
    // 这是刻意的：让插件回答"我能不能解析这个令牌"，而不是平台层猜。
    // 那段用的是无 kind 的源，插件侧同样会拒绝，最终结果仍是 null（见上一条断言）。
    expect(h.ipcCalls.length).toBe(2)
  })

  it('3c 主进程抛错（取址失败）时静默返回 null，并落一条 warn', async () => {
    const mod = await import('@/services/platform')
    h.ipcResolve = async () => {
      throw new Error('lx:resolveUrl 失败')
    }
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => void warns.push(a)
    try {
      const out = await mod.platform.resolveTrackAudio(
        trackOf({ id: 'x4', onlineUrl: '', trackRef: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '1' } } })
      )
      expect(out).toBeNull()
      expect(warns.some((w) => String(w[0]).includes('取址失败'))).toBe(true)
    } finally {
      console.warn = orig
    }
  })
})
