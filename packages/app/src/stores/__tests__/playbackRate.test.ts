/**
 * 播放速率：默认值、归一化、以及「桌面端真正应用到 Howler」的接线。
 *
 * 为什么这些断言值得单测：`playbackRate` 是个**跨层**字段——
 *   store（状态 + 持久化）→ audio.service 的模块级镜像 → 每个新建 Howl 的 rate。
 * 这条链上任何一环漏接，表现都是「切歌后悄悄变回 1×」这种**无声**的错，
 * 靠肉眼听不出来，只能靠断言钉住。
 *
 * 移动端的边界也在这里钉住：原生桥没有变速通道，所以 playerStore 在
 * useNative() 为真时**不得**调用 audio.service 的 setPlaybackRate
 * （audio.service 在移动端根本不存在播放实例，调用是空转）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  rates: [] as number[],
  audioTrackPlays: [] as string[],
}))

vi.mock('@/services/audio.service', async () => {
  const { audioEvents } = await import('@/services/audioEvents')
  return {
    playTrack: (track: any) => {
      h.audioTrackPlays.push(track.id)
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
    // store 唯一会调的变速入口：记录每次下发的速率
    setPlaybackRate: (rate: number) => {
      h.rates.push(rate)
    },
    getPlaybackRate: () => h.rates.at(-1) ?? 1,
  }
})

vi.mock('@/services/audioCache.service', () => ({
  resolveCachedAudioSrc: async () => null,
  configureAudioCache: () => {},
}))

/** 原生能力开关：默认关（= 桌面环境），需要时在用例里改写 */
const native = vi.hoisted(() => ({ available: false }))

vi.mock('@/services/mediaSession', () => ({
  isNativePlayerAvailable: () => native.available,
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
// ⚠️ 必须挂在 `window.localStorage` 上，不能只 stub 全局 `localStorage`：
// zustand v5 的 persist 默认存储是 `createJSONStorage(() => window.localStorage)`，
// 在 node 测试环境里 `window` 未定义会让 createJSONStorage 直接返回 undefined，
// persist 于是**静默跳过**所有写入（只打一条 warn），断言会永远拿不到快照
vi.stubGlobal('window', { localStorage: storage.impl })
vi.stubGlobal('localStorage', storage.impl)

const { normalizePlaybackRate, formatRateValue, PLAYBACK_RATE_PRESETS, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE } =
  await import('@/lib/playbackRate')
const { usePlayerStore, isPlaybackRateAvailable } = await import('@/stores/playerStore')

beforeEach(() => {
  storage.impl.clear()
  h.rates.length = 0
  h.audioTrackPlays.length = 0
  native.available = false
  // 只重置本任务新增的字段，避免把别的用例依赖的队列状态一起清掉
  usePlayerStore.setState({ playbackRate: 1 })
})

describe('播放速率：纯函数', () => {
  it('默认档位集合包含 1（原速）且升序', () => {
    expect(PLAYBACK_RATE_PRESETS).toContain(1)
    const sorted = [...PLAYBACK_RATE_PRESETS].sort((a, b) => a - b)
    expect([...PLAYBACK_RATE_PRESETS]).toEqual(sorted)
  })

  it('normalizePlaybackRate：非数/非正数回落 1，其余夹到 [MIN, MAX]', () => {
    expect(normalizePlaybackRate(1.5)).toBe(1.5)
    expect(normalizePlaybackRate(Number.NaN)).toBe(1)
    expect(normalizePlaybackRate(0)).toBe(1)
    expect(normalizePlaybackRate(-2)).toBe(1)
    expect(normalizePlaybackRate(Number.POSITIVE_INFINITY)).toBe(1)
    // 越界夹取而不是回落：用户设过 3× 时给他 2×（最接近的合法值）比悄悄回原速更合理
    expect(normalizePlaybackRate(9)).toBe(MAX_PLAYBACK_RATE)
    expect(normalizePlaybackRate(0.1)).toBe(MIN_PLAYBACK_RATE)
  })

  it('formatRateValue：整数不带小数，其余保留有效位', () => {
    expect(formatRateValue(1)).toBe('1')
    expect(formatRateValue(2)).toBe('2')
    expect(formatRateValue(0.75)).toBe('0.75')
    expect(formatRateValue(1.5)).toBe('1.5')
    expect(formatRateValue(1.25)).toBe('1.25')
  })
})

describe('播放速率：store 默认值与下发', () => {
  it('默认是 1（原速）', () => {
    expect(usePlayerStore.getState().playbackRate).toBe(1)
  })

  it('setPlaybackRate 更新状态并下发给音频层', () => {
    usePlayerStore.getState().setPlaybackRate(1.5)
    expect(usePlayerStore.getState().playbackRate).toBe(1.5)
    expect(h.rates).toEqual([1.5])
  })

  it('setPlaybackRate 归一化脏值后再下发（不会把 NaN 递给 Howler）', () => {
    usePlayerStore.getState().setPlaybackRate(Number.NaN)
    expect(usePlayerStore.getState().playbackRate).toBe(1)
    expect(h.rates).toEqual([1])
  })

  it('桌面端可用变速，移动端（原生引擎）不可用', () => {
    native.available = false
    expect(isPlaybackRateAvailable()).toBe(true)
    // 原生桥没有变速通道：入口必须隐藏，而不是给一个点了没反应的档位
    native.available = true
    expect(isPlaybackRateAvailable()).toBe(false)
  })

  it('移动端改速率只记状态，不下发给不存在的桌面播放器', () => {
    native.available = true
    usePlayerStore.getState().setPlaybackRate(1.25)
    expect(usePlayerStore.getState().playbackRate).toBe(1.25)
    // 原生侧没有 setPlaybackRate 通道，因此这一步不下发；
    // 状态仍被记住，迁到桌面端后由 startHowl 的 onload 应用
    expect(h.rates).toEqual([])
  })

  it('playbackRate 进入持久化快照（跨会话的收听偏好）', () => {
    usePlayerStore.getState().setPlaybackRate(0.75)
    const raw = storage.impl.getItem('aurora-player-state')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.state.playbackRate).toBe(0.75)
  })
})
