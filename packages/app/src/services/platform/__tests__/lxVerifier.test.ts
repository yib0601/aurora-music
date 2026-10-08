/**
 * 洛雪链路 **app 侧**独立黑盒验收（对抗性验证，独立构造，不复用实现者的测试思路）
 *
 * 覆盖：
 *   1) 持久化白名单：落盘 JSON 里没有任何 script 字段，同时 aurora 源的既有字段不被吃掉；
 *   2) 播放前取址闸门：audioUrl==='' 且带 lx 的条目必须先取址再播放，且地址回填队列；
 *   3) 闸门零开销：已有 path / onlineUrl / remoteUrl 的曲目不得触发任何取址调用；
 *   4) ensurePlayableTrack 真实链路（playlistIO.service）：脚本优先、失败不伪造地址、已解析入库。
 *
 * 平台层 lxSource 转发在 lxVerifierPlatform.test.ts（单独文件：避免 persist 的 localStorage
 * 引用缓存与惰性 import 互相污染）。
 *
 * 运行：cd packages/app && npx vitest run src/services/platform/__tests__/lxVerifier.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── 打桩：音频服务与平台层（hoisted，供 vi.mock 工厂使用） ──────────
const h = vi.hoisted(() => ({
  audio: [] as { track: any; volume: number; muted: boolean; autoplay: boolean }[],
  resolveLxTrack: null as null | ((t: any) => Promise<any>),
  lxCalls: [] as any[],
}))

vi.mock('@/services/audio.service', async () => {
  const { audioEvents } = await import('@/services/audioEvents')
  return {
    playTrack: (track: any, volume: number, muted: boolean, autoplay: boolean) => {
      h.audio.push({ track, volume, muted, autoplay })
      // 与真实 audio.service 一致：建好 Howl 后广播 trackChange，playerStore 据此回填 currentTrack
      audioEvents.emit('trackChange', { track })
    },
    togglePlayPause: () => {},
    setVolume: () => {},
    seekTo: () => {},
    setMuted: () => {},
    stopPlayback: () => {},
    onCurrentTrackLoad: () => {},
    hasCurrentHowl: () => false,
    pausePlayback: () => {},
    resumePlayback: () => {},
  }
})

vi.mock('@/services/audioCache.service', () => ({
  resolveCachedAudioSrc: async () => null,
  configureAudioCache: () => {},
}))

vi.mock('@/services/mediaSession', () => ({
  isNativePlayerAvailable: () => false,
  startNativeService: async () => false,
  stopNativeService: async () => {},
  toQueueItems: (q: any[]) => q,
  nativePlayQueue: async () => {},
  nativeSyncQueue: () => {},
  nativePause: () => {},
  nativeResume: () => {},
  nativeSeekTo: () => {},
  nativeSetVolume: () => {},
  nativeNext: () => {},
  nativePrevious: () => {},
  nativePlayAt: () => {},
  nativeStopEngine: () => {},
  nativeGetState: async () => ({ index: -1, position: 0, duration: 0 }),
  onPlaybackEvent: () => () => {},
}))

vi.mock('@/services/platform', () => {
  const platform = {
    platform: 'desktop',
    resolveLxTrack: (t: any) => {
      h.lxCalls.push(t)
      return h.resolveLxTrack ? h.resolveLxTrack(t) : Promise.resolve(null)
    },
    searchOnlineTracks: async () => [],
  }
  return { platform, default: platform }
})

// ─── 存储桩 ───────────────────────────────────────────────────────
function makeStorageStub() {
  const map = new Map<string, string>()
  const impl = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size
    },
  }
  return { map, impl }
}

/**
 * 存储桩必须是**模块级单例**：zustand/persist 在 store 首次创建时就把 `localStorage`
 * 引用缓存住了（node 环境无真实 localStorage），每个测试重建桩会让后续写入落进已废弃的
 * 对象、读回来是空的 —— 那是测试自身的问题，不是产品行为。
 */
const storage = makeStorageStub()
const storageImpl = storage.impl

/** 同一模块图内复用 store 实例，避免 persist 在重新 import 时写坏状态 */
async function loadStores() {
  const lib = await import('@/stores/libraryStore')
  const player = await import('@/stores/playerStore')
  return { useLibraryStore: lib.useLibraryStore, usePlayerStore: player.usePlayerStore }
}

/**
 * 「真实 playlistIO 链路」的模块图：只桩掉 playlistIO 的外部依赖（平台、音频事件、缓存），
 * 以及把 @aurora/shared 的按名搜索能力收窄成「没有可用 aurora 源」——这样断言聚焦在
 * 「脚本取址这一跳」，不会被统一搜索取址的噪音掩盖。
 */
async function loadRealPlaylistIO() {
  vi.doMock('@/services/platform', () => {
    const platform = {
      platform: 'desktop',
      resolveLxTrack: (t: any) => {
        h.lxCalls.push(t)
        return h.resolveLxTrack ? h.resolveLxTrack(t) : Promise.resolve(null)
      },
      searchOnlineTracks: async () => [],
    }
    return { platform, default: platform }
  })
  vi.doMock('@/services/audioEvents', () => ({ audioEvents: { emit: () => {}, on: () => () => {} } }))
  vi.doMock('@/services/audioCache.service', () => ({
    resolveCachedAudioSrc: async () => null,
    configureAudioCache: () => {},
  }))
  vi.doMock('@aurora/shared', async (orig) => {
    const actual = await (orig as any)()
    return {
      ...actual,
      searchEndpointOf: () => '',
      scoreOnlineResult: () => 0,
      matchTracksByPaths: () => new Map(),
    }
  })
  return await import('@/services/playlistIO.service')
}

beforeEach(() => {
  storage.map.clear()
  h.audio.length = 0
  h.lxCalls.length = 0
  h.resolveLxTrack = null
  vi.stubGlobal('localStorage', storageImpl)
  vi.stubGlobal('window', {
    localStorage: storageImpl,
    addEventListener: () => {},
    removeEventListener: () => {},
    electronAPI: { platform: 'desktop' },
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

// ═══════════════════════════════════════════════════════════════════
// 1. 持久化白名单
// ═══════════════════════════════════════════════════════════════════

describe('1. 持久化白名单', () => {
  it('1a lx 源即使被注入 script 字段也不落盘；id/name/sourceUrl/kind/enabled/headers 保留', async () => {
    const { useLibraryStore } = await loadStores()
    storageImpl.setItem('aurora-library-state', JSON.stringify({ state: { onlineSources: [] }, version: 10 }))
    const huge = 'LX_SCRIPT_SOURCE_'.repeat(500)
    useLibraryStore.setState({
      onlineSources: [
        {
          id: 'lx-1',
          name: '洛雪源',
          kind: 'lx',
          sourceUrl: 'https://example.com/latest.js',
          enabled: true,
          headers: { 'X-Test': '1' },
          // 意外注入的运行期字段：必须被白名单挡住
          script: huge,
        } as any,
      ],
    })
    const raw = storage.map.get('aurora-library-state') || ''
    expect(raw.length).toBeGreaterThan(0)
    expect(raw).not.toContain('LX_SCRIPT_SOURCE_')
    expect(raw).not.toContain('"script"')
    const s = JSON.parse(raw).state.onlineSources[0]
    expect(s).toEqual({
      id: 'lx-1',
      name: '洛雪源',
      sourceUrl: 'https://example.com/latest.js',
      enabled: true,
      kind: 'lx',
      headers: { 'X-Test': '1' },
    })
  })

  it('1b 非 lx（aurora）源的 endpoints / playlistUrl 不被白名单吃掉', async () => {
    const { useLibraryStore } = await loadStores()
    storageImpl.setItem('aurora-library-state', JSON.stringify({ state: { onlineSources: [] }, version: 10 }))
    useLibraryStore.setState({
      onlineSources: [
        {
          id: 'au-1',
          name: 'Aurora 源',
          sourceUrl: 'http://127.0.0.1:19999',
          enabled: true,
          playlistUrl: 'http://x/pl?url={url}',
          endpoints: { search: '/aurora?query={query}&key=K', playlist: '/aurora/playlist?url={url}&key=K' },
          headers: { 'X-K': 'v' },
        } as any,
      ],
    })
    const raw = storage.map.get('aurora-library-state') || ''
    const s = JSON.parse(raw).state.onlineSources[0]
    expect(s.endpoints).toEqual({
      search: '/aurora?query={query}&key=K',
      playlist: '/aurora/playlist?url={url}&key=K',
    })
    expect(s.playlistUrl).toBe('http://x/pl?url={url}')
    expect(s.headers).toEqual({ 'X-K': 'v' })
    // 未设置 kind 的老配置不应被白名单补出一个 kind 字段
    expect('kind' in s).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════
// 2. 播放前取址闸门
// ═══════════════════════════════════════════════════════════════════

describe('2. 播放前取址闸门', () => {
  it('2a audioUrl 为空且带 lx 的条目：先取址再播放，地址回填队列与 currentTrack', async () => {
    const { usePlayerStore } = await loadStores()
    h.resolveLxTrack = async (t: any) =>
      t.lx
        ? { ...t, onlineUrl: 'http://real.test/from-script.mp3', onlineSource: 'lx-1', onlineQualityUrls: undefined }
        : null

    usePlayerStore.setState({ queue: [], currentIndex: -1, currentTrack: null })
    const track = trackOf({
      id: 'online-1',
      onlineUrl: '',
      lx: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '91084746' } },
    })
    await usePlayerStore.getState().playTrack(track)

    expect(h.lxCalls.length).toBe(1)
    expect(h.audio.length).toBe(1)
    expect(h.audio[0].track.onlineUrl).toBe('http://real.test/from-script.mp3')
    const st = usePlayerStore.getState()
    expect(st.queue.map((t) => t.onlineUrl)).toEqual(['http://real.test/from-script.mp3'])
    expect(st.currentTrack?.onlineUrl).toBe('http://real.test/from-script.mp3')
    // 队列里不得残留无地址的快照
    expect(st.queue[0].onlineUrl).not.toBe('')
  })

  it('2b 取址失败不阻断：曲目仍进队列且信息可见，但不拿空地址建播放器（队列不被吃）', async () => {
    const { usePlayerStore } = await loadStores()
    h.resolveLxTrack = async () => null
    usePlayerStore.setState({ queue: [], currentIndex: -1, currentTrack: null })
    const track = trackOf({ id: 'online-2', onlineUrl: '', lx: { sourceId: 'lx-1', platform: 'kw', meta: {} } })
    await expect(usePlayerStore.getState().playTrack(track)).resolves.toBeUndefined()
    // 收口点从「建 Howl」前移到「进队列」：空地址一旦交给播放器，其 loaderror 会被
    // 下面的 error 监听当成本地文件损坏，这首歌（队列长度 1 时是整个队列）就被吃掉。
    // 用户要的是「看到这首歌 + 知道取不到地址」，不是静默清空队列
    expect(h.audio.length).toBe(0)
    const st = usePlayerStore.getState()
    expect(st.queue.map((t) => t.id)).toEqual(['online-2'])
    expect(st.currentTrack?.id).toBe('online-2')
    expect(st.resolvingTrackId).toBeNull()
  })

  it('2c 零开销：有 path / onlineUrl / remoteUrl 的曲目不得触发任何取址调用', async () => {
    const { usePlayerStore } = await loadStores()
    h.resolveLxTrack = async () => {
      throw new Error('不应被调用')
    }
    for (const [id, over] of [
      ['local-1', { path: '/music/a.flac' }],
      ['online-3', { onlineUrl: 'http://x/a.mp3', onlineSource: 'lx-1' }],
      ['remote-1', { remoteUrl: 'aurora-remote://src/a.mp3' }],
      ['online-4', { onlineUrl: 'http://y/b.mp3', lx: { sourceId: 'lx-1', platform: 'kw', meta: {} } }],
    ] as const) {
      h.lxCalls.length = 0
      usePlayerStore.setState({ queue: [], currentIndex: -1, currentTrack: null })
      await usePlayerStore.getState().playTrack(trackOf({ id, ...(over as any) }))
      expect(h.lxCalls.length, `条目 ${id} 不应取址`).toBe(0)
    }
    // 无 lx / 无 onlineSource / 无 onlineId 的纯空曲目同样零开销
    h.lxCalls.length = 0
    await usePlayerStore.getState().playTrack(trackOf({ id: 'plain-1' }))
    expect(h.lxCalls.length).toBe(0)
  })

  it('2d addToQueue 入队后空闲预取址：地址回填队列', async () => {
    const { usePlayerStore } = await loadStores()
    h.resolveLxTrack = async (t: any) => ({ ...t, onlineUrl: 'http://real.test/prefetch.mp3' })
    usePlayerStore.setState({ queue: [], currentIndex: -1, currentTrack: null })
    usePlayerStore
      .getState()
      .addToQueue(trackOf({ id: 'online-5', onlineUrl: '', lx: { sourceId: 'lx-1', platform: 'kw', meta: {} } }))
    await new Promise((r) => setTimeout(r, 20))
    expect(h.lxCalls.length).toBe(1)
    expect(usePlayerStore.getState().queue[0].onlineUrl).toBe('http://real.test/prefetch.mp3')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 3. ensurePlayableTrack 真实链路（playlistIO.service，非打桩）
// ═══════════════════════════════════════════════════════════════════

describe('3. ensurePlayableTrack 真实链路', () => {
  it('3a 带 lx 的条目优先走脚本取址，地址与定位信息一并回填到当前曲目存储', async () => {
    const io = await loadRealPlaylistIO()
    h.resolveLxTrack = async (t: any) => ({
      ...t,
      onlineUrl: 'http://real.test/from-script.mp3',
      onlineSource: 'lx-1',
      onlineSourceName: '洛雪源',
    })
    const track = trackOf({
      id: 'io-1',
      onlineUrl: '',
      lx: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '91084746' } },
    })
    const out = await io.ensurePlayableTrack(track)
    expect(h.lxCalls.length).toBe(1)
    expect(out?.onlineUrl).toBe('http://real.test/from-script.mp3')
    // 已解析曲目必须进当前曲目存储，后续播放/下载才拿得到
    const { usePlaylistStore } = await import('@/stores/playlistStore')
    expect(usePlaylistStore.getState().importedTracks['io-1']?.onlineUrl).toBe('http://real.test/from-script.mp3')
  })

  it('3b 脚本取址失败且无可用 aurora 源：返回 null，不抛错、不伪造地址', async () => {
    const io = await loadRealPlaylistIO()
    h.resolveLxTrack = async () => null
    const out = await io.ensurePlayableTrack(
      trackOf({ id: 'io-2', onlineUrl: '', lx: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '1' } } })
    )
    expect(out).toBeNull()
  })

  it('3c 已有地址 / 本地路径的曲目直接返回原对象，零取址', async () => {
    const io = await loadRealPlaylistIO()
    h.resolveLxTrack = async () => {
      throw new Error('不应被调用')
    }
    const withUrl = trackOf({
      id: 'io-3',
      onlineUrl: 'http://x/a.mp3',
      lx: { sourceId: 'lx-1', platform: 'kw', meta: {} },
    })
    expect(await io.ensurePlayableTrack(withUrl)).toBe(withUrl)
    const local = trackOf({ id: 'io-4', path: '/music/a.flac' })
    expect(await io.ensurePlayableTrack(local)).toBe(local)
    expect(h.lxCalls.length).toBe(0)
  })

  it('3d 批量解析 resolvePlayableTracks：只处理缺地址的曲目，其余原样保留', async () => {
    const io = await loadRealPlaylistIO()
    h.resolveLxTrack = async (t: any) => ({ ...t, onlineUrl: 'http://real.test/' + t.id + '.mp3' })
    const tracks = [
      trackOf({ id: 'b-1', path: '/music/a.flac' }),
      trackOf({ id: 'b-2', onlineUrl: '', lx: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '1' } } }),
      trackOf({ id: 'b-3', onlineUrl: 'http://y/b.mp3' }),
      trackOf({ id: 'b-4', onlineUrl: '', lx: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '2' } } }),
    ]
    const out = await io.resolvePlayableTracks(tracks)
    expect(out.length).toBe(4)
    expect(out[0].path).toBe('/music/a.flac')
    expect(out[1].onlineUrl).toBe('http://real.test/b-2.mp3')
    expect(out[2].onlineUrl).toBe('http://y/b.mp3')
    expect(out[3].onlineUrl).toBe('http://real.test/b-4.mp3')
    expect(h.lxCalls.length).toBe(2)
  })
})