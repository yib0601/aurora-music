/**
 * 睡眠定时器：到点暂停、取消、以及「时间戳而非倒计时」这条设计约束。
 *
 * 语义基线（必须先对齐，否则测试会写成另一种产品）：
 *   - 到点执行的是 **`pause()`**，不是 `clearQueue()` / 退出应用：队列不丢，
 *     第二天点播放即可续上；
 *   - 状态只存**结束时间戳**，剩余量由「现在」推导。因此本文件的时钟断言
 *     一律用假定时器推进 `Date.now()`，而**不**去断言「内部计数走到了第几步」——
 *     后者会被后台节流打乱，前者对齐真实时钟。
 *
 * 运行：cd packages/app && npx vitest run src/stores/__tests__/sleepTimer.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  pauses: 0,
  toasts: [] as string[],
  resumes: 0,
}))

vi.mock('@/services/audio.service', async () => {
  const { audioEvents } = await import('@/services/audioEvents')
  /** 事件载荷里的曲目：与 store 当前曲目无关，本文件只关心「有没有广播」 */
  const anyTrack = { id: 't-1' } as any
  return {
    playTrack: (track: any) => {
      audioEvents.emit('trackChange', { track })
    },
    togglePlayPause: () => {},
    setVolume: () => {},
    seekTo: () => {},
    setMuted: () => {},
    stopPlayback: () => {},
    onCurrentTrackLoad: () => {},
    hasCurrentHowl: () => false,
    pausePlayback: () => {
      h.pauses += 1
      // 与真实 audio.service 一致：暂停后广播 pause 事件
      audioEvents.emit('pause', {})
    },
    resumePlayback: () => {
      h.resumes += 1
      audioEvents.emit('play', { track: anyTrack })
    },
    setPlaybackRate: () => {},
    getPlaybackRate: () => 1,
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
  toast: (message: string) => {
    h.toasts.push(message)
    return 1
  },
}))

// 与 playbackRate.test.ts 同一处理：persist 读的是 window.localStorage
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
vi.stubGlobal('window', {
  localStorage: storage.impl,
  addEventListener: () => {},
})
vi.stubGlobal('localStorage', storage.impl)
// 模块顶层会检查 document.addEventListener（可见性回调），给一个最小桩
vi.stubGlobal('document', {
  visibilityState: 'visible',
  addEventListener: () => {},
})

const { usePlayerStore } = await import('@/stores/playerStore')
const { sleepRemainingMs, formatSleepRemaining, isSleepTimerDue, SLEEP_TIMER_PRESETS, MINUTE_MS } =
  await import('@/lib/sleepTimer')

function seedPlaying() {
  const track = {
    id: 't-1',
    path: '/music/t-1.mp3',
    title: '曲目',
    artist: '歌手',
    album: '',
    duration: 200,
    addedAt: 0,
    playCount: 0,
    liked: false,
  } as any
  usePlayerStore.setState({
    queue: [track],
    currentIndex: 0,
    currentTrack: track,
    isPlaying: true,
    sleepEndsAt: null,
  })
  return track
}

beforeEach(() => {
  vi.useFakeTimers()
  h.pauses = 0
  h.resumes = 0
  h.toasts.length = 0
  storage.impl.clear()
  usePlayerStore.setState({ sleepEndsAt: null, isPlaying: false })
})

afterEach(() => {
  usePlayerStore.setState({ sleepEndsAt: null, isPlaying: false })
  vi.useRealTimers()
})

describe('睡眠定时器：时间计算（纯函数）', () => {
  it('结束时间戳 = 现在 + N 分钟', () => {
    expect(sleepRemainingMs(1000 + 15 * MINUTE_MS, 1000)).toBe(15 * MINUTE_MS)
    expect(sleepRemainingMs(1000 + 15 * MINUTE_MS, 1000 + MINUTE_MS)).toBe(14 * MINUTE_MS)
  })

  it('过点后剩余量夹到 0，不返回负数', () => {
    expect(sleepRemainingMs(1000, 5000)).toBe(0)
    expect(isSleepTimerDue(1000, 5000)).toBe(true)
    expect(isSleepTimerDue(9000, 5000)).toBe(false)
  })

  it('剩余时间向上取整：剩 0.6 秒显示 0:01 而不是 0:00', () => {
    // 截断会让「还没到点」显示成 0:00，用户会以为定时器坏了
    expect(formatSleepRemaining(600)).toBe('0:01')
    expect(formatSleepRemaining(0)).toBe('0:00')
    expect(formatSleepRemaining(65_000)).toBe('1:05')
    expect(formatSleepRemaining(15 * MINUTE_MS)).toBe('15:00')
  })

  it('档位是 15 / 30 / 60 分钟', () => {
    expect([...SLEEP_TIMER_PRESETS]).toEqual([15, 30, 60])
  })
})

describe('睡眠定时器：到点暂停', () => {
  it('设置 15 分钟后到点调用 pause()，队列与当前曲目保持不变', async () => {
    const track = seedPlaying()
    usePlayerStore.getState().setSleepTimer(15)

    const endsAt = usePlayerStore.getState().sleepEndsAt
    expect(endsAt).not.toBeNull()
    expect(endsAt! - Date.now()).toBe(15 * MINUTE_MS)

    // 推进到还差 1 毫秒：不应停
    await vi.advanceTimersByTimeAsync(15 * MINUTE_MS - 1)
    expect(h.pauses).toBe(0)

    // 推过结束点：暂停一次，并弹一次提示
    await vi.advanceTimersByTimeAsync(2)
    const st = usePlayerStore.getState()
    expect(h.pauses).toBe(1)
    expect(st.isPlaying).toBe(false)
    // 「暂停」语义：队列没被清、当前曲目还在，用户点播放即可续上
    expect(st.queue).toHaveLength(1)
    expect(st.currentTrack?.id).toBe(track.id)
    expect(h.toasts).toHaveLength(1)
    // 到点后时间戳清空，不会重复结算
    expect(st.sleepEndsAt).toBeNull()
  })

  it('到点只结算一次（定时器不会重复触发提示）', async () => {
    seedPlaying()
    usePlayerStore.getState().setSleepTimer(15)
    await vi.advanceTimersByTimeAsync(15 * MINUTE_MS + 10)
    expect(h.pauses).toBe(1)
    // 继续推进远超结束点的时间：仍然是 1 次
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS)
    expect(h.pauses).toBe(1)
    expect(h.toasts).toHaveLength(1)
  })

  it('已经停止播放时到点结算不重复 pause（播放器侧自己短路，提示仍给一次）', async () => {
    seedPlaying()
    // 用户中途手动暂停
    usePlayerStore.setState({ isPlaying: false })
    usePlayerStore.getState().setSleepTimer(15)
    await vi.advanceTimersByTimeAsync(15 * MINUTE_MS + 10)
    // pause() 内部 `if (get().isPlaying)` 短路，所以不会调用 audioPausePlayback
    expect(h.pauses).toBe(0)
    expect(usePlayerStore.getState().sleepEndsAt).toBeNull()
  })
})

describe('睡眠定时器：取消', () => {
  it('cancelSleepTimer 清时间戳且到点后不再暂停', async () => {
    seedPlaying()
    usePlayerStore.getState().setSleepTimer(15)
    expect(usePlayerStore.getState().sleepEndsAt).not.toBeNull()

    usePlayerStore.getState().cancelSleepTimer()
    expect(usePlayerStore.getState().sleepEndsAt).toBeNull()

    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS)
    expect(h.pauses).toBe(0)
    expect(h.toasts).toHaveLength(0)
  })

  it('setSleepTimer(null) 等价于取消', async () => {
    seedPlaying()
    usePlayerStore.getState().setSleepTimer(30)
    usePlayerStore.getState().setSleepTimer(null)
    expect(usePlayerStore.getState().sleepEndsAt).toBeNull()
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS)
    expect(h.pauses).toBe(0)
  })

  it('重复设置以最后一次为准（旧的定时器不会提前触发）', async () => {
    seedPlaying()
    usePlayerStore.getState().setSleepTimer(15)
    // 10 分钟后改成 60 分钟：此时应是「从现在起 60 分钟」
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS)
    usePlayerStore.getState().setSleepTimer(60)
    const endsAt = usePlayerStore.getState().sleepEndsAt!
    expect(endsAt - Date.now()).toBe(60 * MINUTE_MS)

    // 走到原定的 15 分钟处（现在只剩 5 分钟到原定时刻）：不应触发
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS + 10)
    expect(h.pauses).toBe(0)

    // 走满新的 60 分钟
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS)
    expect(h.pauses).toBe(1)
  })

  it('非正数分钟数视为取消，不排定已过点的定时器', () => {
    seedPlaying()
    usePlayerStore.getState().setSleepTimer(0)
    expect(usePlayerStore.getState().sleepEndsAt).toBeNull()
    usePlayerStore.getState().setSleepTimer(-5)
    expect(usePlayerStore.getState().sleepEndsAt).toBeNull()
    usePlayerStore.getState().setSleepTimer(Number.NaN)
    expect(usePlayerStore.getState().sleepEndsAt).toBeNull()
  })
})

describe('睡眠定时器：不持久化（重启即失效）', () => {
  it('persist 快照里没有 sleepEndsAt，但有 playbackRate', () => {
    seedPlaying()
    usePlayerStore.getState().setSleepTimer(15)
    usePlayerStore.getState().setPlaybackRate(1.25)

    const raw = storage.impl.getItem('aurora-player-state')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    // 「本次会话内 N 分钟后暂停」的意图不该跨重启打断用户，这是有意的决定
    expect(parsed.state).not.toHaveProperty('sleepEndsAt')
    // 变速是跨会话成立的收听偏好，反过来必须留下来
    expect(parsed.state.playbackRate).toBe(1.25)
  })

  it('reset() 把定时器一并清掉', () => {
    seedPlaying()
    usePlayerStore.getState().setSleepTimer(15)
    usePlayerStore.getState().reset()
    expect(usePlayerStore.getState().sleepEndsAt).toBeNull()
  })
})

describe('睡眠定时器：后台节流下仍以真实时钟结算', () => {
  it('跳过中间时刻（模拟渲染进程被冻结）直接推进到结束点之后，仍会结算', async () => {
    seedPlaying()
    usePlayerStore.getState().setSleepTimer(15)
    // advanceTimersByTimeAsync 会一次性推进时钟；即使假设期间回调没被调度
    // （真实环境的节流/丢弃），结束时点的判定依据仍是 Date.now()
    await vi.advanceTimersByTimeAsync(15 * MINUTE_MS + 1)
    expect(h.pauses).toBe(1)
    expect(usePlayerStore.getState().sleepEndsAt).toBeNull()
  })

  it('系统时钟被回拨导致定时器「早到」时，重新排定而不是提前暂停', async () => {
    seedPlaying()
    usePlayerStore.getState().setSleepTimer(15)
    // 手动把结束时间戳往后推（等价于系统时钟回拨了 10 分钟）
    const endsAt = usePlayerStore.getState().sleepEndsAt!
    usePlayerStore.setState({ sleepEndsAt: endsAt + 10 * MINUTE_MS })
    // ⚠️ 不用 `setTimeout(0)` 之类的 flush：本文件启用了假定时器，
    // 那样写出来的 promise 永远等不到 resolve，只会把用例拖成超时
    await vi.advanceTimersByTimeAsync(0)

    // 定时器在原来的 15 分钟处醒来，发现还没到点 → 重新排定，不暂停
    await vi.advanceTimersByTimeAsync(15 * MINUTE_MS + 1)
    expect(h.pauses).toBe(0)

    // 补足被推后的 10 分钟，此后才会结算
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS)
    expect(h.pauses).toBe(1)
  })
})
