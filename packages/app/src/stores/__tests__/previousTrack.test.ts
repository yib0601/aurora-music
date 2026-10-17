/**
 * 「上一曲」在随机模式下的回退语义。
 *
 * 上报现象（在线歌单 / 音乐馆推荐歌单，默认随机播放）：
 *   点歌单里第 N 首起播，按「上一曲」停在原地 —— 桌面端只是 seek 回 0:00，
 *   移动端原生引擎把当前曲从头重放，用户看到的就是「按了没反应 / 无法播放上一曲」。
 *
 * 根因：两条路径在「随机历史里没有更早一条」时都把命令吃掉，而不是回退：
 *   - JS  `previous()`：`shuffleHistory` 只有一条 → `audioSeekTo(0)` 后 return；
 *   - Kotlin `computePrevIndex()`：`shuffleHistory.size < 2` → 返回 currentIndex。
 * 而「历史只有一条」正是**点某一首起播**的常态：`playQueue(tracks, i)` 把历史
 * 初始化成 `[i]` 后就不再有更早的记录（用户机器上的持久化状态实测为
 * `shuffleMode:"on" / currentIndex:3 / shuffleHistory:[3]`）。
 *
 * 本文件钉住四条不变量：
 *   1) 没有更早的随机记录 → 退回顺序上一首（不原地重播、不静默吃掉命令）；
 *   2) 有更早的随机记录 → 仍回退到上一条随机记录（原有语义不回归）；
 *   3) 顺序模式越界回队尾、进度超过 3 秒时回到开头（既有语义不回归）；
 *   4) 随机历史末项与当前曲目不一致时（setCurrentIndex / 原生 playAt 之后）
 *      不得跳到那条陈旧记录指向的曲目。
 *
 * 运行：cd packages/app && npx vitest run src/stores/__tests__/previousTrack.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  audio: [] as { track: any; volume: number; muted: boolean; autoplay: boolean }[],
  seeks: [] as number[],
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
    seekTo: (seconds: number) => {
      h.seeks.push(seconds)
      audioEvents.emit('progress', { currentTime: seconds })
    },
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

vi.mock('@/components/common/Toast', () => ({
  toast: () => 1,
}))

vi.mock('@/services/playlistIO.service', () => ({
  ensurePlayableTrack: async (t: any) => {
    h.resolveCalls.push(t.id)
    return { ...t, onlineUrl: `http://x/${t.id}.mp3` }
  },
}))

/** 存储桩：zustand/persist 在 store 创建时就把 localStorage 引用缓存住了 */
function makeStorageStub() {
  const map = new Map<string, string>()
  return {
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
vi.stubGlobal('localStorage', storage.impl)

const { usePlayerStore } = await import('@/stores/playerStore')

/** 未取址的在线占位条目：与 MusicHallDetailPage 的 baseTracks 同构（path 为空） */
function hallTrack(i: number) {
  return {
    id: `hall-pl-${i}`,
    path: '',
    title: `在线曲目 ${i}`,
    artist: '某歌手',
    album: '',
    duration: 180,
    addedAt: 0,
    playCount: 0,
    liked: false,
    onlineSource: 'src-1',
    onlineId: `mid-${i}`,
  } as any
}

/** 五首的歌单：点第 4 行（index 3）起播，即上报时用户机器上的真实状态 */
const list = () => [0, 1, 2, 3, 4].map(hallTrack)

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  storage.impl.clear()
  h.audio.length = 0
  h.seeks.length = 0
  h.resolveCalls.length = 0
})

describe('上一曲：随机模式下历史不足时的回退', () => {
  it('1 点第 4 首起播（历史只有一条）→ 回退到第 3 首，而不是原地重播', async () => {
    const queue = list()
    usePlayerStore.setState({
      queue,
      currentIndex: 3,
      currentTrack: queue[3],
      // 用户机器上的实测状态：随机开、历史只有当前这一条
      shuffleMode: 'on',
      repeatMode: 'off',
      shuffleHistory: [3],
      progress: 0,
      resolvingTrackId: null,
    })

    usePlayerStore.getState().previous()

    const st = usePlayerStore.getState()
    expect(st.currentIndex).toBe(2)
    expect(st.currentTrack?.id).toBe('hall-pl-2')
    // 取址落在新曲目上，且沿用「点播即显示」语义：显示信息上屏后仍带取址态
    expect(st.resolvingTrackId).toBe('hall-pl-2')
    // 没有把当前曲从头重放
    expect(h.seeks).toEqual([])

    await flush() // 取址是动态 import，落到下一个 macrotask
    expect(h.resolveCalls).toEqual(['hall-pl-2'])
    expect(h.audio.at(-1)?.track.id).toBe('hall-pl-2')
  })

  it('1b 历史只有一条且位于队首 → 回退到队尾（顺序语义的越界规则）', () => {
    const queue = list()
    usePlayerStore.setState({
      queue,
      currentIndex: 0,
      currentTrack: queue[0],
      shuffleMode: 'on',
      repeatMode: 'off',
      shuffleHistory: [0],
      progress: 0,
      resolvingTrackId: null,
    })

    usePlayerStore.getState().previous()
    expect(usePlayerStore.getState().currentIndex).toBe(4)
  })

  it('1c 回退后再次按上一曲：继续往前走（历史被改写为新位置）', () => {
    const queue = list()
    usePlayerStore.setState({
      queue,
      currentIndex: 3,
      currentTrack: queue[3],
      shuffleMode: 'on',
      repeatMode: 'off',
      shuffleHistory: [3],
      progress: 0,
      resolvingTrackId: null,
    })

    usePlayerStore.getState().previous()
    expect(usePlayerStore.getState().shuffleHistory).toEqual([2])
    usePlayerStore.getState().previous()
    expect(usePlayerStore.getState().currentIndex).toBe(1)
    expect(usePlayerStore.getState().shuffleHistory).toEqual([1])
  })

  it('2 历史充足 → 仍回退到上一条随机记录（原有语义不回归）', async () => {
    const queue = list()
    usePlayerStore.setState({
      queue,
      currentIndex: 4,
      currentTrack: queue[4],
      shuffleMode: 'on',
      repeatMode: 'off',
      // 上一首随机放的是 1，再上一首是 0；当前 4
      shuffleHistory: [0, 1, 4],
      progress: 0,
      resolvingTrackId: null,
    })

    usePlayerStore.getState().previous()

    const st = usePlayerStore.getState()
    expect(st.currentIndex).toBe(1)
    expect(st.currentTrack?.id).toBe('hall-pl-1')
    expect(st.shuffleHistory).toEqual([0, 1])
    await flush()
    expect(h.audio.at(-1)?.track.id).toBe('hall-pl-1')
  })

  it('4 历史末项与当前曲目不一致（setCurrentIndex / 原生 playAt 之后）→ 顺序回退，不跳陈旧记录', () => {
    const queue = list()
    usePlayerStore.setState({
      queue,
      currentIndex: 4,
      currentTrack: queue[4],
      shuffleMode: 'on',
      repeatMode: 'off',
      // 末项 1 ≠ 当前 4：历史是陈旧的（如 setCurrentIndex 未同步历史）
      shuffleHistory: [0, 1],
      progress: 0,
      resolvingTrackId: null,
    })

    usePlayerStore.getState().previous()
    expect(usePlayerStore.getState().currentIndex).toBe(3)
    expect(usePlayerStore.getState().shuffleHistory).toEqual([3])
  })
})

describe('上一曲：顺序模式与「回到开头」的既有语义', () => {
  it('3 顺序模式回退到上一首', () => {
    const queue = list()
    usePlayerStore.setState({
      queue,
      currentIndex: 2,
      currentTrack: queue[2],
      shuffleMode: 'off',
      repeatMode: 'off',
      shuffleHistory: [],
      progress: 0,
      resolvingTrackId: null,
    })

    usePlayerStore.getState().previous()
    expect(usePlayerStore.getState().currentIndex).toBe(1)
  })

  it('3b 顺序模式队首 → 回队尾', () => {
    const queue = list()
    usePlayerStore.setState({
      queue,
      currentIndex: 0,
      currentTrack: queue[0],
      shuffleMode: 'off',
      repeatMode: 'off',
      shuffleHistory: [],
      progress: 0,
      resolvingTrackId: null,
    })

    usePlayerStore.getState().previous()
    expect(usePlayerStore.getState().currentIndex).toBe(4)
  })

  it('3c 播放超过 3 秒 → 回到开头，不切歌（两种模式一致）', () => {
    for (const shuffleMode of ['on', 'off'] as const) {
      h.seeks.length = 0
      const queue = list()
      usePlayerStore.setState({
        queue,
        currentIndex: 3,
        currentTrack: queue[3],
        shuffleMode,
        repeatMode: 'off',
        shuffleHistory: [3],
        progress: 42,
        resolvingTrackId: null,
      })

      usePlayerStore.getState().previous()
      const st = usePlayerStore.getState()
      expect(h.seeks).toEqual([0])
      expect(st.currentIndex).toBe(3)
      expect(h.resolveCalls).toEqual([])
    }
  })
})
