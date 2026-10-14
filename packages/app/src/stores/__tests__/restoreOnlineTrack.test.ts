/**
 * 冷启动恢复取址（playerStore.restoreOnlineTrack）的取址态回归。
 *
 * 上报现象：冷启动后点一次播放键，整条歌单以每首几秒的节奏连环跳空。
 *
 * 成因：restoreOnlineTrack 是冷启动时唯一一条会在用户点播放键**之前**主动取址的路径，
 * 但此前它全程不置 resolvingTrackId，于是 play / togglePlay 里
 * `if (state.resolvingTrackId) return` 的守卫形同虚设 —— 用户点一下播放键就落进
 * `!hasCurrentHowl()` 分支，拿还没取到地址的 currentTrack 去建 `new Howl({ src: [''] })`：
 * howler 必然 loaderror，而空 path / 空 onlineUrl 又让 isNetworkBackedTrack 判成
 * 「本地文件损坏」，把这首歌踢出队列并起播下一首，于是连锁。
 *
 * 因此本文件钉住两件事，缺一不可：
 *   1) 取址期间守卫真正生效：点播放键不建空地址播放器，取址态不被抖掉；
 *   2) **所有**出口（缓存命中 / 取址成功 / 取址失败 / 用户改点 / 原生分支）
 *      都必须清掉 resolvingTrackId —— 漏一处就是永久加载态，播放键彻底失效，
 *      比原 bug 更严重。
 *
 * 与原文件 playInfoFollowsIntent.test.ts 分开：那边测点播路径的信息跟随，
 * 这里专测冷启动这条「不占播放意图」的恢复路径，混在一起会互相遮挡。
 *
 * 运行：cd packages/app && npx vitest run src/stores/__tests__/restoreOnlineTrack.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  audio: [] as { track: any; volume: number; muted: boolean; autoplay: boolean }[],
  cacheSrc: null as string | null,
  /** 取址钩子：测试自行控制何时返回哪个结果 */
  resolve: null as null | ((t: any) => Promise<any>),
  resolveCalls: [] as string[],
  /** 原生引擎：默认不可用（桌面端语义），可按用例打开 */
  native: false,
  nativeBootstrappedFromReconcile: false,
}))

vi.mock('@/services/audio.service', async () => {
  const { audioEvents } = await import('@/services/audioEvents')
  return {
    playTrack: (track: any, volume: number, muted: boolean, autoplay: boolean) => {
      h.audio.push({ track, volume, muted, autoplay })
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
  resolveCachedAudioSrc: async () => h.cacheSrc,
  configureAudioCache: () => {},
}))

vi.mock('@/services/mediaSession', () => ({
  isNativePlayerAvailable: () => h.native,
  startNativeService: async () => true,
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
  // 原生快照：index >= 0 表示引擎仍在续播（reconcileNativePlayback 会把 bootstrapped 置回 true）
  nativeGetState: async () =>
    h.nativeBootstrappedFromReconcile ? { index: 0, position: 12, duration: 200 } : { index: -1, position: 0, duration: 0 },
  onPlaybackEvent: () => () => {},
}))

vi.mock('@/components/common/Toast', () => ({
  toast: () => 1,
}))

vi.mock('@/services/playlistIO.service', () => ({
  ensurePlayableTrack: (t: any) => {
    h.resolveCalls.push(t.id)
    return h.resolve ? h.resolve(t) : Promise.resolve(t)
  },
}))

function makeStorageStub() {
  const map = new Map<string, string>()
  return {
    map,
    impl: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      get length() {
        return map.size
      },
    },
  }
}

const storage = makeStorageStub()

function gate() {
  let release!: (v?: any) => void
  const promise = new Promise<any>((r) => (release = r))
  return { promise, release }
}

/** 冷启动后的持久化形态：path 为空、地址已被 stripOnlineUrl 剥掉的在线条目 */
function restoredTrack(over: Partial<Record<string, any>> = {}) {
  return {
    id: 'R1',
    path: '',
    title: '反方向的钟',
    artist: '周杰伦',
    album: '',
    duration: 0,
    addedAt: 0,
    playCount: 0,
    liked: false,
    onlineSource: 'src-1',
    onlineId: 'R1',
    ...over,
  } as any
}

beforeEach(() => {
  storage.map.clear()
  h.audio.length = 0
  h.cacheSrc = null
  h.resolve = null
  h.resolveCalls.length = 0
  h.native = false
  h.nativeBootstrappedFromReconcile = false
  vi.stubGlobal('localStorage', storage.impl)
})

async function loadStore() {
  const { usePlayerStore } = await import('@/stores/playerStore')
  return usePlayerStore
}

const flush = () => new Promise((r) => setTimeout(r, 0))

async function waitFor(cond: () => boolean, ms = 1000) {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5))
}

/** 冷启动场面：持久化里就一首无地址的在线曲目，restorePlayback 会在取址路径上 */
function seedRestored(store: any, track = restoredTrack()) {
  store.setState({
    queue: [track],
    currentIndex: 0,
    currentTrack: track,
    progress: 30,
    resolvingTrackId: null,
    isPlaying: false,
  })
  return track
}

describe('冷启动恢复取址：取址态与守卫', () => {
  it('1 恢复一开始就置 resolvingTrackId，此时点播放键不建空地址播放器', async () => {
    const store = await loadStore()
    const g = gate()
    h.resolve = () => g.promise
    seedRestored(store)

    store.getState().restorePlayback()
    // 同步段已置位：取址还没回来，界面就该显示加载态
    expect(store.getState().resolvingTrackId).toBe('R1')

    // 用户这时点播放键（正是上报的操作）
    store.getState().togglePlay()
    store.getState().play()
    await flush()

    expect(store.getState().resolvingTrackId).toBe('R1') // 加载指示没被抖掉
    expect(h.audio.length).toBe(0) // 没有 `new Howl({ src: [''] })`

    g.release({ ...restoredTrack(), onlineUrl: 'http://x/r1.mp3' })
    await waitFor(() => store.getState().resolvingTrackId === null)
    expect(store.getState().resolvingTrackId).toBeNull()
    expect(h.audio.length).toBe(1)
    expect(h.audio[0].track.onlineUrl).toBe('http://x/r1.mp3')
    expect(h.audio[0].autoplay).toBe(false) // 恢复不自动播放，等用户按播放键
  })

  it('2 取址成功：清取址态，地址回填 currentTrack 与队列', async () => {
    const store = await loadStore()
    h.resolve = (t: any) => Promise.resolve({ ...t, onlineUrl: 'http://x/r1.mp3' })
    seedRestored(store)

    store.getState().restorePlayback()
    await waitFor(() => store.getState().resolvingTrackId === null)

    const st = store.getState()
    expect(st.resolvingTrackId).toBeNull()
    expect(st.currentTrack?.onlineUrl).toBe('http://x/r1.mp3')
    expect(st.queue[0].onlineUrl).toBe('http://x/r1.mp3')
    expect(st.currentTrack?.id).toBe('R1')
  })

  it('3 取址失败（ensurePlayableTrack 返回 null）：同样清掉取址态，不留永久加载态', async () => {
    const store = await loadStore()
    h.resolve = () => Promise.resolve(null)
    seedRestored(store)

    store.getState().restorePlayback()
    expect(store.getState().resolvingTrackId).toBe('R1')
    await waitFor(() => store.getState().resolvingTrackId === null)

    const st = store.getState()
    // 漏清这里就是「播放键从此彻底失效」——比原 bug 更严重，必须钉死
    expect(st.resolvingTrackId).toBeNull()
    expect(st.currentTrack?.id).toBe('R1') // 信息仍显示这首歌，只是没地址
    expect(h.audio.length).toBe(0) // 空地址不建 Howl
    expect(st.queue.map((t: any) => t.id)).toEqual(['R1']) // 队列没被吃
  })

  it('4 缓存命中：不经搜索取址，仍要清掉取址态', async () => {
    const store = await loadStore()
    h.cacheSrc = 'aurora-cache://audio/r1.mp3'
    h.resolve = () => {
      throw new Error('缓存命中时不应再搜索取址')
    }
    seedRestored(store)

    store.getState().restorePlayback()
    await waitFor(() => store.getState().resolvingTrackId === null)

    const st = store.getState()
    expect(h.resolveCalls).toEqual([])
    expect(st.resolvingTrackId).toBeNull()
    expect(st.currentTrack?.onlineUrl).toBe('aurora-cache://audio/r1.mp3')
    expect(st.queue[0].onlineUrl).toBe('aurora-cache://audio/r1.mp3')
    expect(h.audio.length).toBe(1)
    expect(h.audio[0].autoplay).toBe(false)
  })

  it('5 恢复期间用户点了别的歌：本轮不得覆盖，也不得抖掉新点播的取址态', async () => {
    const store = await loadStore()
    const gR = gate()
    const gB = gate()
    h.resolve = (t: any) => (t.id === 'R1' ? gR.promise : gB.promise)
    seedRestored(store)

    store.getState().restorePlayback()
    expect(store.getState().resolvingTrackId).toBe('R1')

    // 用户点了另一首无地址的在线曲目（占播放意图，取址在途）
    const b = restoredTrack({ id: 'B', title: '晴天', onlineId: 'B' })
    const pendingB = store.getState().playTrack(b)
    expect(store.getState().currentTrack?.id).toBe('B')
    expect(store.getState().resolvingTrackId).toBe('B')

    // 冷启动那一路这时才回来：不得把界面拉回 R1，也不得清掉 B 的加载态
    gR.release({ ...restoredTrack(), onlineUrl: 'http://x/r1.mp3' })
    await flush()
    expect(store.getState().currentTrack?.id).toBe('B')
    expect(store.getState().resolvingTrackId).toBe('B')
    // R1 的地址被丢弃：队列里它的条目仍是原始快照
    expect(store.getState().queue.find((t: any) => t.id === 'R1')?.onlineUrl).toBeUndefined()

    gB.release({ ...b, onlineUrl: 'http://x/b.mp3' })
    await pendingB
    await waitFor(() => store.getState().resolvingTrackId === null)
    expect(store.getState().currentTrack?.onlineUrl).toBe('http://x/b.mp3')
  })

  it('6 恢复期间用户把这首从队列删掉：本轮不得把它塞回去，且取址态必须清掉', async () => {
    const store = await loadStore()
    const g = gate()
    h.resolve = () => g.promise
    seedRestored(store)
    store.setState({ queue: [restoredTrack(), restoredTrack({ id: 'B', onlineId: 'B' })], currentIndex: 0 })

    store.getState().restorePlayback()
    expect(store.getState().resolvingTrackId).toBe('R1')

    // 删掉正在取址的这条：removeFromQueue 会作废本轮意图、自己清掉加载指示，
    // 并按既有语义起播接续的下一首（与本次修复无关的另一条通路）
    store.getState().removeFromQueue(0)
    expect(store.getState().resolvingTrackId).toBeNull()

    g.release({ ...restoredTrack(), onlineUrl: 'http://x/r1.mp3' })
    await flush()

    const st = store.getState()
    expect(st.resolvingTrackId).toBeNull()
    expect(st.queue.map((t: any) => t.id)).toEqual(['B']) // R1 没被塞回来
    // 也没有拿 R1 去起播（接续起播的是 B，不是被删掉的 R1）
    expect(h.audio.every((a) => a.track.id === 'B')).toBe(true)
    expect(h.audio.some((a) => a.track.id === 'R1')).toBe(false)
  })

  it('7 冷启动时没有当前曲目 / 有可直接播放的地址：不进这条路径', async () => {
    const store = await loadStore()
    store.setState({ queue: [], currentIndex: -1, currentTrack: null, resolvingTrackId: null })
    store.getState().restorePlayback()
    await flush()
    expect(store.getState().resolvingTrackId).toBeNull()
    expect(h.resolveCalls).toEqual([])

    // 本地曲目（path 有值）走的是同步分支，同样不该置取址态
    const local = restoredTrack({ id: 'L1', path: '/music/l1.flac', onlineSource: undefined, onlineId: undefined })
    store.setState({ queue: [local], currentIndex: 0, currentTrack: local, resolvingTrackId: null })
    store.getState().restorePlayback()
    await flush()
    expect(store.getState().resolvingTrackId).toBeNull()
    expect(h.resolveCalls).toEqual([])
    expect(h.audio.length).toBe(1)
  })

  it('8 原生分支（引擎仍在续播）：对账后直接返回，取址态不得残留', async () => {
    const store = await loadStore()
    h.native = true
    h.nativeBootstrappedFromReconcile = true
    h.resolve = () => {
      throw new Error('引擎已续播时不应再搜索取址')
    }
    seedRestored(store)

    store.getState().restorePlayback()
    await waitFor(() => store.getState().resolvingTrackId === null)

    expect(h.resolveCalls).toEqual([])
    expect(store.getState().resolvingTrackId).toBeNull()
    expect(store.getState().progress).toBe(12) // 原生快照已同步回 UI
  })

  it('9 取址抛异常：finally 兜底清态，不留永久加载态，也不产生未处理拒绝', async () => {
    const store = await loadStore()
    h.resolve = () => Promise.reject(new Error('取址炸了'))
    seedRestored(store)

    store.getState().restorePlayback()
    await waitFor(() => store.getState().resolvingTrackId === null)

    const st = store.getState()
    expect(st.resolvingTrackId).toBeNull()
    expect(st.currentTrack?.id).toBe('R1')
    expect(h.audio.length).toBe(0)
    // 后台任务不得把异常漏成未处理拒绝：restorePlayback 里已 .catch 兜住并留日志
    await flush()
  })
})

/**
 * 取址**已结束且失败**之后点播放键（另一半敞着的洞）。
 *
 * 置 resolvingTrackId 只覆盖「取址在途」这个窗口；finally 清态之后，守卫不再生效，
 * 于是 `play` / `togglePlay` 落进 `!hasCurrentHowl()` 分支，拿**仍然没有地址**的
 * currentTrack 去建 `new Howl({ src: [''] })` —— 与冷启动那条完全同源。
 *
 * 真实触发场景：冷启动时乐源不可达 / 搜索无结果 → ensurePlayableTrack 返回 null →
 * 用户点播放键 → 空地址 loaderror → 被 isNetworkBackedTrack 当成「本地文件损坏」→
 * 逐首吃队列。所以这次修的判据必须独立钉住：**没有可播放地址时不得建播放器**。
 */
describe('取址失败后点播放键：不得用空地址建播放器', () => {
  it('10 取址失败 → 点 play() 应重新取址，而不是建空地址播放器', async () => {
    const store = await loadStore()
    h.resolve = () => Promise.resolve(null) // 取址失败（乐源不可达等）
    seedRestored(store)

    store.getState().restorePlayback()
    await waitFor(() => store.getState().resolvingTrackId === null)

    const before = h.resolveCalls.length
    h.audio.length = 0

    store.getState().play()
    await flush()

    // 核心断言：没有拿空地址去 audioPlayTrack（那会建出 src:'' 的 Howl 并连锁吃队列）
    expect(h.audio.filter((a) => !a.track.path && !a.track.onlineUrl)).toEqual([])
    // 且确实重新发起了取址（用户明确要求播放，不能静默吞掉）
    await waitFor(() => h.resolveCalls.length > before)
    expect(h.resolveCalls.length).toBeGreaterThan(before)
  })

  it('11 取址失败 → 点 togglePlay() 同样不得建空地址播放器', async () => {
    const store = await loadStore()
    h.resolve = () => Promise.resolve(null)
    seedRestored(store)

    store.getState().restorePlayback()
    await waitFor(() => store.getState().resolvingTrackId === null)

    h.audio.length = 0
    store.getState().togglePlay()
    await flush()

    expect(h.audio.filter((a) => !a.track.path && !a.track.onlineUrl)).toEqual([])
  })

  it('12 连点多次也不建空地址播放器（吃队列的根因）', async () => {
    const store = await loadStore()
    h.resolve = () => Promise.resolve(null)
    const q = [restoredTrack({ id: 'R1' }), restoredTrack({ id: 'R2' }), restoredTrack({ id: 'R3' })]
    store.setState({ queue: q, currentIndex: 0, currentTrack: q[0], progress: 0, resolvingTrackId: null })
    h.resolveCalls.length = 0
    h.audio.length = 0

    for (let i = 0; i < 4; i++) {
      store.getState().play()
      await flush()
    }

    // 断言根因而非结果：这里 mock 的 audio.service 不会真的抛 loaderror，
    // 所以「队列被吃空」不会在本用例里发生；能钉住的、也是必须钉住的是
    // —— 一次都没有把无地址曲目交给 audioPlayTrack（真实环境里那会建出
    // src:'' 的 Howl → loaderror → isNetworkBackedTrack 判「本地文件损坏」→ 吃队列）
    expect(h.audio.filter((a) => !a.track.path && !a.track.onlineUrl)).toEqual([])
    expect(store.getState().queue.length).toBe(3)
  })

  it('13 有地址的曲目不受影响：仍然走原重建分支', async () => {
    const store = await loadStore()
    const local = { ...restoredTrack({ id: 'L1' }), path: '/music/a.mp3' }
    store.setState({ queue: [local], currentIndex: 0, currentTrack: local, progress: 12, resolvingTrackId: null })
    h.audio.length = 0

    store.getState().play()
    await flush()

    expect(h.audio.length).toBe(1)
    expect(h.audio[0].track.path).toBe('/music/a.mp3')
    // 有地址时不走取址路径
    expect(h.resolveCalls).toEqual([])
  })
})