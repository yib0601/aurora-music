/**
 * 播放信息跟随点播（app 侧行为单测）
 *
 * 覆盖三条易回归的行为：
 *   1) 点谁显示谁：点播无地址的在线曲目时，currentTrack 必须**同步**切到这首歌
 *      （取址是网络往返，此前要在页面层等取址完才显示，表现为「点了没反应」）；
 *   2) 旧取址不覆盖新点播：A 取址在途时用户点了 B，A 的结果回来不得顶掉 B 的信息与地址；
 *   3) 取址失败不装作在播：不建 Howl（避免空地址被 error 路径误判成本地文件损坏而
 *      把曲目踢出队列），清掉加载态并提示。
 *
 * 运行：cd packages/app && npx vitest run src/stores/__tests__/playInfoFollowsIntent.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── 打桩：音频服务 / 取址服务 / 平台层（hoisted，供 vi.mock 工厂使用） ──
const h = vi.hoisted(() => ({
  audio: [] as { track: any; volume: number; muted: boolean; autoplay: boolean }[],
  toasts: [] as any[][],
  /** 取址钩子：测试自行控制何时返回哪个结果 */
  resolve: null as null | ((t: any) => Promise<any>),
  resolveCalls: [] as string[],
}))

vi.mock('@/services/audio.service', async () => {
  const { audioEvents } = await import('@/services/audioEvents')
  return {
    playTrack: (track: any, volume: number, muted: boolean, autoplay: boolean) => {
      h.audio.push({ track, volume, muted, autoplay })
      // 与真实 audio.service 一致：建好 Howl 后广播 trackChange
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

// store 里失败提示走动态 import，这里截住，避免把 React 组件图拖进 node 测试
vi.mock('@/components/common/Toast', () => ({
  toast: (...args: any[]) => {
    h.toasts.push(args)
    return 1
  },
}))

// 取址闸门：动态 import 的 playlistIO.service 只用到 ensurePlayableTrack
vi.mock('@/services/playlistIO.service', () => ({
  ensurePlayableTrack: (t: any) => {
    h.resolveCalls.push(t.id)
    return h.resolve ? h.resolve(t) : Promise.resolve(t)
  },
}))

// ─── 存储桩：zustand/persist 在 store 创建时就把 localStorage 引用缓存住了 ──
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

/** 手动可解的 promise：控制取址返回时刻 */
function gate() {
  let release!: (v?: any) => void
  const promise = new Promise<any>((r) => (release = r))
  return { promise, release }
}

function trackOf(over: Partial<Record<string, any>> = {}) {
  return {
    id: 't-1',
    path: '',
    title: '曲目',
    artist: '歌手',
    album: '',
    duration: 200,
    addedAt: 0,
    playCount: 0,
    liked: false,
    ...over,
  } as any
}

/**
 * 无地址的在线条目：触发取址闸门的典型形态（无 path / onlineUrl / remoteUrl）。
 * 闸门判据只有「有没有可播放地址」，带不带定位令牌都会进水；令牌只决定
 * ensurePlayableTrack 内部走「按令牌取址」还是「按歌名 + 歌手重搜」。
 */
function unresolved(id: string) {
  return trackOf({ id, title: `歌-${id}`, onlineSource: 'src-1', onlineId: id })
}

beforeEach(() => {
  storage.map.clear()
  h.audio.length = 0
  h.toasts.length = 0
  h.resolveCalls.length = 0
  h.resolve = null
  vi.stubGlobal('localStorage', storage.impl)
})

async function loadStore() {
  const { usePlayerStore } = await import('@/stores/playerStore')
  return usePlayerStore
}

const flush = () => new Promise((r) => setTimeout(r, 0))

/**
 * 等到条件成立（上限 1s）。
 * ⚠️ 不能用固定的单次 setTimeout(0) 等取址启动：取址内部有一次动态 `import()`，
 * 两个并发调用的模块解析完成时刻不保证落在同一个 macrotask 里。
 */
async function waitFor(cond: () => boolean, ms = 1000) {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5))
}

describe('播放信息跟随点播', () => {
  it('1 点播无地址曲目：消息同步落地，取址期间显示的就是这首歌', async () => {
    const store = await loadStore()
    const g = gate()
    h.resolve = () => g.promise
    const track = unresolved('A')

    store.setState({ queue: [], currentIndex: -1, currentTrack: null, resolvingTrackId: null })
    const pending = store.getState().playTrack(track)

    // 同步段已生效：还没取到地址，但当前曲目已经是 A
    const st = store.getState()
    expect(st.currentTrack?.id).toBe('A')
    expect(st.currentTrack?.title).toBe('歌-A')
    expect(st.resolvingTrackId).toBe('A')
    expect(st.queue.map((t: any) => t.id)).toEqual(['A'])
    expect(h.audio.length).toBe(0) // 还没出声

    g.release({ ...track, onlineUrl: 'http://x/a.mp3' })
    await pending
    const done = store.getState()
    expect(done.resolvingTrackId).toBeNull()
    expect(done.currentTrack?.onlineUrl).toBe('http://x/a.mp3')
    expect(h.audio.length).toBe(1)
    expect(h.audio[0].track.onlineUrl).toBe('http://x/a.mp3')
  })

  it('2 取址在途时改点另一首：旧结果不得覆盖新点播的信息与地址', async () => {
    const store = await loadStore()
    const gA = gate()
    h.resolve = (t: any) => (t.id === 'A' ? gA.promise : Promise.resolve(t))
    const a = unresolved('A')
    const b = trackOf({ id: 'B', title: '歌-B', onlineUrl: 'http://x/b.mp3', onlineSource: 'src-1' })

    store.setState({ queue: [], currentIndex: -1, currentTrack: null, resolvingTrackId: null })
    const pendingA = store.getState().playTrack(a)
    expect(store.getState().currentTrack?.id).toBe('A')

    // 用户改点 B（B 自带地址，无需取址）
    await store.getState().playTrack(b)
    expect(store.getState().currentTrack?.id).toBe('B')
    expect(store.getState().resolvingTrackId).toBeNull()

    // A 的取址这时才回来 —— 不得把界面拉回 A
    gA.release({ ...a, onlineUrl: 'http://x/a.mp3' })
    await pendingA
    const st = store.getState()
    expect(st.currentTrack?.id).toBe('B')
    expect(st.currentTrack?.onlineUrl).toBe('http://x/b.mp3')
    expect(st.currentIndex).toBe(st.queue.findIndex((t: any) => t.id === 'B'))
    // 最后一次真正落地的播放是 B
    expect(h.audio[h.audio.length - 1].track.id).toBe('B')
  })

  /**
 * 校验「乱序返回的旧取址不得回填」。
 *
 * 形态说明：vitest 环境下同一模块的并发动态 `import()` 之间存在约 400ms 的解析延迟
 * （实测：首个 5ms 完成，后续 400ms 才完成），无法用「同一 tick 连点两首无地址曲目」
 * 构造稳定的竞态。因此这里直接给出「用户已经在听 B、A 的取址才返回」这一更普遍、
 * 也更危险的时序 —— 切歌时旧取址回来顶掉新曲目的信息与地址。
 */
it('2b 乱序回填：A 的取址在用户已切到 B 之后返回，不得覆盖 B 的信息与地址', async () => {
    const store = await loadStore()
    const gA = gate()
    h.resolve = (t: any) => (t.id === 'A' ? gA.promise : Promise.resolve(t))
    const a = unresolved('A')
    const b = trackOf({ id: 'B', title: '歌-B', onlineUrl: 'http://x/b.mp3', onlineSource: 'src-1' })

    store.setState({ queue: [], currentIndex: -1, currentTrack: null, resolvingTrackId: null })
    const pendingA = store.getState().playTrack(a)
    await waitFor(() => h.resolveCalls.length >= 1)
    expect(store.getState().currentTrack?.id).toBe('A')

    // 用户改点自带地址的 B：B 立即起播
    await store.getState().playTrack(b)
    expect(store.getState().currentTrack?.id).toBe('B')
    expect(store.getState().resolvingTrackId).toBeNull()
    const audioBefore = h.audio.length

    // A 的取址此刻才返回
    gA.release({ ...a, onlineUrl: 'http://x/a.mp3' })
    await pendingA
    const st = store.getState()
    expect(st.currentTrack?.id).toBe('B')
    expect(st.currentTrack?.onlineUrl).toBe('http://x/b.mp3')
    expect(st.currentIndex).toBe(st.queue.findIndex((t: any) => t.id === 'B'))
    // 旧结果不得再触发一次播放
    expect(h.audio.length).toBe(audioBefore)
    expect(h.audio[h.audio.length - 1].track.id).toBe('B')
    // A 的地址被丢弃：队列里 A 的条目仍是原始快照（没被写回过期地址）
    expect(st.queue.find((t: any) => t.id === 'A')?.onlineUrl).toBeUndefined()
  })

  it('3 取址失败：清加载态、给提示，且不拿空地址去建播放器（队列不被吃）', async () => {
    const store = await loadStore()
    h.resolve = () => Promise.resolve(null)
    const track = unresolved('C')

    store.setState({ queue: [], currentIndex: -1, currentTrack: null, resolvingTrackId: null })
    await store.getState().playTrack(track)
    await flush() // 让动态 import 的 toast 落地

    const st = store.getState()
    expect(st.resolvingTrackId).toBeNull()
    expect(st.currentTrack?.id).toBe('C') // 信息仍显示这首歌，只是没在播
    expect(st.isPlaying).toBe(false)
    expect(st.queue.map((t: any) => t.id)).toEqual(['C']) // 队列没被踢掉
    expect(h.audio.length).toBe(0) // 空地址不建 Howl
    expect(h.toasts.length).toBe(1)
    expect(String(h.toasts[0][0])).toContain('无法播放')
  })

  it('4 播队列：整队先落地，当前曲目立即指向起播那一首', async () => {
    const store = await loadStore()
    const g = gate()
    h.resolve = () => g.promise
    const queue = [trackOf({ id: 'X', title: 'X', onlineUrl: 'http://x/x.mp3' }), unresolved('Y')]

    store.setState({ queue: [], currentIndex: -1, currentTrack: null, resolvingTrackId: null })
    const pending = store.getState().playQueue(queue, 1)

    const st = store.getState()
    expect(st.queue.map((t: any) => t.id)).toEqual(['X', 'Y'])
    expect(st.currentIndex).toBe(1)
    expect(st.currentTrack?.id).toBe('Y') // 就是用户点的那一首
    expect(st.resolvingTrackId).toBe('Y')

    g.release({ ...queue[1], onlineUrl: 'http://x/y.mp3' })
    await pending
    const done = store.getState()
    expect(done.resolvingTrackId).toBeNull()
    expect(done.queue[1].onlineUrl).toBe('http://x/y.mp3')
    expect(h.audio.length).toBe(1)
  })

  it('5 切到无地址的下一首：信息立即切、旧音频先停、取址在途时同样只显示新歌', async () => {
    const store = await loadStore()
    const g = gate()
    h.resolve = () => g.promise
    const a = trackOf({ id: 'A', title: '歌-A', onlineUrl: 'http://x/a.mp3', onlineSource: 'src-1' })
    const b = unresolved('B')

    store.setState({
      queue: [a, b],
      currentIndex: 0,
      currentTrack: a,
      resolvingTrackId: null,
      shuffleMode: 'off',
      repeatMode: 'off',
    })
    store.getState().next()

    // next() 是同步推进索引 + playResolved 内部先 markPlaying
    const st = store.getState()
    expect(st.currentIndex).toBe(1)
    expect(st.currentTrack?.id).toBe('B')
    expect(st.resolvingTrackId).toBe('B')

    g.release({ ...b, onlineUrl: 'http://x/b.mp3' })
    await flush()
    const done = store.getState()
    expect(done.resolvingTrackId).toBeNull()
    expect(done.currentTrack?.onlineUrl).toBe('http://x/b.mp3')
    expect(done.queue[1].onlineUrl).toBe('http://x/b.mp3')
  })

  it('6 取址在途时点播放键：不拿空地址建播放器，等取址结果自己起播', async () => {
    const store = await loadStore()
    const g = gate()
    h.resolve = () => g.promise
    const track = unresolved('D')

    store.setState({ queue: [], currentIndex: -1, currentTrack: null, resolvingTrackId: null })
    const pending = store.getState().playTrack(track)
    expect(store.getState().resolvingTrackId).toBe('D')

    // 用户在取址期间反复点播放键
    store.getState().togglePlay()
    store.getState().play()
    expect(store.getState().resolvingTrackId).toBe('D') // 加载指示没被抖掉
    expect(h.audio.length).toBe(0) // 没有空地址 Howl

    g.release({ ...track, onlineUrl: 'http://x/d.mp3' })
    await pending
    expect(h.audio.length).toBe(1)
    expect(h.audio[0].track.onlineUrl).toBe('http://x/d.mp3')
  })

  it('7 取址在途时把这首从队列删掉：取址回来不得把它塞回去', async () => {
    const store = await loadStore()
    const g = gate()
    h.resolve = () => g.promise
    const a = unresolved('A')
    const b = trackOf({ id: 'B', title: '歌-B', onlineUrl: 'http://x/b.mp3' })

    store.setState({ queue: [], currentIndex: -1, currentTrack: null, resolvingTrackId: null })
    const pending = store.getState().playTrack(a)
    store.setState({ queue: [a, b], currentIndex: 1 })
    store.getState().removeFromQueue(0) // 删掉正在取址的 A

    g.release({ ...a, onlineUrl: 'http://x/a.mp3' })
    await pending
    const st = store.getState()
    expect(st.queue.map((t: any) => t.id)).toEqual(['B']) // A 没被塞回来
    expect(st.resolvingTrackId).toBeNull()
    expect(h.audio.length).toBe(0) // 也没有拿 A 去起播
  })

  it('8 删空队列：加载指示一并清掉，不留悬空菊花', async () => {
    const store = await loadStore()
    const g = gate()
    h.resolve = () => g.promise
    const a = unresolved('A')

    store.setState({ queue: [], currentIndex: -1, currentTrack: null, resolvingTrackId: null })
    const pending = store.getState().playTrack(a)
    expect(store.getState().resolvingTrackId).toBe('A')

    store.getState().removeFromQueue(0)
    expect(store.getState().resolvingTrackId).toBeNull()

    g.release(null)
    await pending
    expect(store.getState().queue).toEqual([])
  })

  it('9 延迟到达的加载错误：旧曲目 Howl 的失败回调不得把新点播的曲目踢出队列', async () => {
    const store = await loadStore()
    const { audioEvents } = await import('@/services/audioEvents')
    const a = trackOf({ id: 'A', title: '歌-A', path: '/music/a.flac' })
    const b = trackOf({ id: 'B', title: '歌-B', path: '/music/b.flac' })

    store.setState({ queue: [a, b], currentIndex: 1, currentTrack: b, isPlaying: true })
    // A 的 Howl 在用户切到 B 之后才报加载失败
    audioEvents.emit('error', { error: new Error('late'), trackId: 'A' })
    expect(store.getState().queue.map((t: any) => t.id)).toEqual(['A', 'B'])
    expect(store.getState().currentTrack?.id).toBe('B')

    // 出错的就是当前曲目时，既有自动跳过语义不变
    audioEvents.emit('error', { error: new Error('now'), trackId: 'B' })
    expect(store.getState().queue.map((t: any) => t.id)).toEqual(['A'])
  })

  /**
   * 音乐库的歌单/榜单详情页构造的条目只有歌名与歌手（来源 id、源内 id 都可能缺席）。
   * 闸门早先要求「自带 trackRef / onlineSource / onlineId」才放行，这类条目于是被判成
   * 「无需取址」直接拿空地址进播放器：加载必然失败，且 error 路径会把它们当坏文件
   * 逐首踢出队列——用户看到的就是「点了没声音、进度停在 0:00、队列自己变短」。
   */
  it('10 无定位令牌的曲目（歌单/榜单形态）同样走取址闸门并起播', async () => {
    const store = await loadStore()
    h.resolve = (t: any) =>
      Promise.resolve({ ...t, onlineUrl: 'http://x/hall.mp3', onlineSource: 'src-1', onlineId: 'songmid-1' })
    const hall = trackOf({ id: 'hall-70-0', title: '榜单曲目', artist: '歌手' })

    store.setState({ queue: [], currentIndex: -1, currentTrack: null, resolvingTrackId: null })
    await store.getState().playQueue([hall], 0)

    expect(h.resolveCalls).toEqual(['hall-70-0']) // 进了闸门
    expect(h.audio.length).toBe(1)
    expect(h.audio[0].track.onlineUrl).toBe('http://x/hall.mp3')
    expect(store.getState().currentTrack?.onlineUrl).toBe('http://x/hall.mp3')
  })

  it('11 有地址的曲目仍零开销：本地文件与已取址曲目都不触发取址', async () => {
    const store = await loadStore()
    const local = trackOf({ id: 'L1', title: '本地', path: '/music/a.flac' })
    const online = trackOf({ id: 'O1', title: '在线', onlineUrl: 'http://x/o.mp3', onlineSource: 'src-1' })

    store.setState({ queue: [], currentIndex: -1, currentTrack: null, resolvingTrackId: null })
    await store.getState().playQueue([local, online], 1)

    expect(h.resolveCalls).toEqual([])
    expect(h.audio.length).toBe(1)
    expect(h.audio[0].track.id).toBe('O1')
  })
})
