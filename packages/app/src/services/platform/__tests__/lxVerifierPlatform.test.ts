/**
 * 平台层 lxSource 转发独立验证（对抗性验证）
 *
 * 本文件**单独成文件**是刻意的：node 环境里 zustand/persist 首次创建时会缓存
 * `localStorage` 引用，而在同一模块图里既做「store 落盘断言」又做「真实 platform
 * 惰性加载 store」会让两边互相污染。这里用 vi.resetModules + 干净的全局桩，专测
 * 「渲染层 → 主进程」这一跳的参数契约。
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

describe('平台层 lxSource 转发', () => {
  it('3a resolveLxTrack 把 ref/source/quality 完整交给主进程，只回填副本', async () => {
    const mod = await import('@/services/platform')
    const track = trackOf({
      id: 't9',
      onlineUrl: '',
      lx: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '91084746' } },
    })
    const out = await mod.platform.resolveLxTrack(track)
    expect(h.ipcCalls.length).toBe(1)
    expect(h.ipcCalls[0].ref).toEqual({ sourceId: 'lx-1', platform: 'kw', meta: { songmid: '91084746' } })
    expect(h.ipcCalls[0].source.id).toBe('lx-1')
    expect(h.ipcCalls[0].quality).toBe('320')
    expect(out?.onlineUrl).toBe('http://real.test/a.mp3')
    expect(track.onlineUrl).toBe('') // 原对象不被就地修改
  })

  it('3b 缺 lx / 源不存在 / 源非 lx / 直链非 http：一律 null，且不惊动主进程', async () => {
    const mod = await import('@/services/platform')
    expect(await mod.platform.resolveLxTrack(trackOf({ id: 'x0', onlineUrl: '' }))).toBeNull()
    h.sources = []
    expect(
      await mod.platform.resolveLxTrack(
        trackOf({ id: 'x1', onlineUrl: '', lx: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '1' } } })
      )
    ).toBeNull()
    h.sources = [{ id: 'lx-1', name: 'Aurora', sourceUrl: 'http://a', enabled: true }]
    expect(
      await mod.platform.resolveLxTrack(
        trackOf({ id: 'x2', onlineUrl: '', lx: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '1' } } })
      )
    ).toBeNull()
    h.sources = [{ id: 'lx-1', name: '洛雪', kind: 'lx', sourceUrl: 'http://s/x.js', enabled: true }]
    h.ipcResolve = async () => ({ url: 'not-a-url', quality: '128k' })
    expect(
      await mod.platform.resolveLxTrack(
        trackOf({ id: 'x3', onlineUrl: '', lx: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '1' } } })
      )
    ).toBeNull()
    // 只允许「源存在 + 是 lx」这两条路径触碰 IPC
    expect(h.ipcCalls.length).toBe(1)
  })

  it('3c 主进程抛错（脚本取址失败）时静默返回 null，并落一条 warn', async () => {
    const mod = await import('@/services/platform')
    h.ipcResolve = async () => {
      throw new Error('lx:resolveUrl 失败')
    }
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => void warns.push(a)
    try {
      const out = await mod.platform.resolveLxTrack(
        trackOf({ id: 'x4', onlineUrl: '', lx: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '1' } } })
      )
      expect(out).toBeNull()
      expect(warns.some((w) => String(w[0]).includes('脚本取址失败'))).toBe(true)
    } finally {
      console.warn = orig
    }
  })
})