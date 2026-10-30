/**
 * 移动端原生引擎「播到没有地址的在线曲目」的收口。
 *
 * 上报现象（乐源 qq-music-aurora，音乐馆歌单）：
 *   第一首正常出声；第二首只有进度与歌词、一声不响；接着疯狂切下一首，
 *   直到撞上一首本地曲目才停。
 *
 * 根因两条，都在「移动端是惰性取址、而原生引擎只认现成地址」这个错位上：
 *
 * 1) 队列里未取址的在线条目 path 为空串。原生 resolvePath("") 拼出
 *    /storage/emulated/0/（一个目录），setDataSource 必然抛错 → handleError →
 *    emitEvent("error")。JS 侧 error 分支用 isNetworkBackedTrack 判「本地文件损坏」，
 *    而该判据只看 onlineUrl/remoteUrl/http 前缀——未取址条目三者皆无，于是被判成
 *    坏文件移出队列。整条队列就这样被逐首吃掉，表现即「疯狂切歌」。
 * 2) 桌面端在 Howler onload 里拦「上源只给了几秒版权提示音」，移动端**完全没有**
 *    这道判定：一条 3 秒提示音被照播完，ended 触发自动下一首，队列以每首约 3 秒
 *    的节奏跳空——「有进度、没声音、疯狂切歌」。
 *
 * 本文件钉住三条不变量：
 *   - 带在线身份但没地址的条目，加载失败**不**得被移出队列（回归 1）
 *   - 引擎把「无地址」如实上报时，JS 取址后原位重播（新增回路）
 *   - 取址确实失败时停住并提示，既不静默跳曲也不吃队列（row 4/8 的真实情形）
 *   - 提示音闸门对原生路径同样生效（回归 2）
 *   - 在线曲目加载失败给**可读提示**（与桌面端 Howler 路径同源，回归 3）
 *
 * 运行：cd packages/app && npx vitest run src/stores/__tests__/nativeUnresolved.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Cb = (ev: any) => void

const h = vi.hoisted(() => ({
  events: [] as ((ev: any) => void)[],
  nativeQueue: [] as { items: any[]; index: number }[],
  pauses: 0,
  toasts: [] as any[],
  resolveCalls: [] as string[],
  /** 置空时 ensurePlayableTrack 解析失败（返回 null），模拟乐源 not-found / no-rights */
  resolveOk: true,
}))

vi.mock('@/services/audio.service', () => ({
  playTrack: () => {},
  togglePlayPause: () => {},
  setVolume: () => {},
  seekTo: () => {},
  setMuted: () => {},
  stopPlayback: () => {},
  onCurrentTrackLoad: () => {},
  hasCurrentHowl: () => false,
  pausePlayback: () => {},
  resumePlayback: () => {},
}))

vi.mock('@/services/audioCache.service', () => ({
  resolveCachedAudioSrc: async () => null,
  configureAudioCache: () => {},
}))

vi.mock('@/services/mediaSession', () => ({
  isNativePlayerAvailable: () => true,
  startNativeService: async () => true,
  stopNativeService: async () => {},
  // 与真实实现同语义：把 Track 的地址映射成下发路径（空地址条目就是空串）
  toQueueItems: (q: any[]) => q.map((t) => ({ path: t.onlineUrl || t.path, title: t.title })),
  nativePlayQueue: async (items: any[], index: number) => {
    h.nativeQueue.push({ items, index })
  },
  nativeSyncQueue: () => {},
  nativePause: () => {
    h.pauses++
  },
  nativeResume: () => {},
  nativeSeekTo: () => {},
  nativeSetVolume: () => {},
  nativeNext: () => {},
  nativePrevious: () => {},
  nativePlayAt: () => {},
  nativeStopEngine: () => {},
  nativeGetState: async () => ({ index: -1, position: 0, duration: 0 }),
  onPlaybackEvent: (cb: Cb) => {
    h.events.push(cb)
    return () => {}
  },
}))

vi.mock('@/components/common/Toast', () => ({
  toast: (msg: any, opts: any) => {
    h.toasts.push({ msg, opts })
    return 1
  },
}))

vi.mock('@/services/playlistIO.service', () => ({
  ensurePlayableTrack: async (t: any) => {
    h.resolveCalls.push(t.id)
    if (!h.resolveOk) return null
    return { ...t, onlineUrl: `http://x/${t.id}.mp3` }
  },
}))

const { usePlayerStore } = await import('@/stores/playerStore')

/** 未取址的在线占位条目：与 MusicHallDetailPage 的 baseTracks 同构（path 为空） */
const onlineRow = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `hall-pl-${i}`,
  path: '',
  title: `在线曲目 ${i}`,
  artist: '某歌手',
  album: '',
  duration: 179,
  addedAt: 0,
  playCount: 0,
  liked: false,
  onlineSource: 'src-1',
  onlineId: `mid-${i}`,
  ...extra,
})

/** 本地条目：path 有值、无在线身份 */
const localRow = (i: number) => ({
  id: `local-${i}`,
  path: `Music/local-${i}.flac`,
  title: `本地曲目 ${i}`,
  artist: '某歌手',
  album: '',
  duration: 200,
  addedAt: 0,
  playCount: 0,
  liked: false,
})

/** 触发原生事件：模块加载时已注册唯一回调 */
const emit = (ev: any) => {
  expect(h.events.length).toBeGreaterThan(0)
  h.events[0](ev)
}

beforeEach(() => {
  h.nativeQueue.length = 0
  h.pauses = 0
  h.toasts.length = 0
  h.resolveCalls.length = 0
  h.resolveOk = true
  usePlayerStore.setState({
    queue: [],
    currentIndex: -1,
    currentTrack: null,
    isPlaying: false,
    progress: 0,
    resolvingTrackId: null,
  })
})

describe('移动端原生引擎：无地址在线条目', () => {
  it('error 不得把「有在线身份但未取址」的条目移出队列（回归：疯狂切歌）', () => {
    const q = [localRow(0), onlineRow(1, { onlineUrl: undefined }), localRow(2)]
    usePlayerStore.setState({ queue: q, currentIndex: 1, currentTrack: q[1] })
    // 原生 resolvePath("") → /storage/emulated/0/ → MediaPlayer 失败上报
    emit({ type: 'error', index: 1, what: 1, extra: -2147483648 })
    const st = usePlayerStore.getState()
    expect(st.queue.length).toBe(3)
    expect(st.queue[1].id).toBe('hall-pl-1')
  })

  /**
   * 与桌面端 Howler 的 error 路径同源：在线曲目失败必须**可读**。
   *
   * 此前这里同样是静默 break（`if (isNetworkBackedTrack(track)) break`），
   * 于是移动端在线曲目播不出时用户看到的就是「点了没反应」。
   * 只改一条路径会让两端表现不一致，这条断言把原生路径钉住。
   */
  it('在线曲目加载失败：停住并给可读提示，不静默、不吃队列', () => {
    const q = [onlineRow(0, { onlineUrl: 'http://x/a.mp3' }), onlineRow(1)]
    usePlayerStore.setState({ queue: q, currentIndex: 0, currentTrack: q[0], isPlaying: true, progress: 42 })
    emit({ type: 'error', index: 0, what: 1, extra: -2147483648 })
    const st = usePlayerStore.getState()
    expect(h.toasts.length).toBe(1)
    expect(String(h.toasts[0].msg)).toContain('未提供这首歌的完整音频')
    expect(st.isPlaying).toBe(false)
    expect(st.progress).toBe(0)
    expect(st.queue.length).toBe(2)
  })

  it('纯本地条目加载失败仍按原语义移除（不因上面的放宽而回归）', () => {
    const q = [localRow(0), localRow(1)]
    usePlayerStore.setState({ queue: q, currentIndex: 0, currentTrack: q[0] })
    emit({ type: 'error', index: 0, what: 1, extra: -2147483648 })
    const st = usePlayerStore.getState()
    expect(st.queue.map((t) => t.id)).toEqual(['local-1'])
    // 本地文件损坏不发「音源」提示：那条文案对用户是误导
    expect(h.toasts.length).toBe(0)
  })

  it('unresolved 上报 → 取址并原位重播，队列带新地址下发（新增回路）', async () => {
    const q = [onlineRow(0), onlineRow(1)]
    usePlayerStore.setState({ queue: q, currentIndex: 1, currentTrack: q[1] })
    emit({ type: 'unresolved', index: 1 })
    await vi.waitFor(() => expect(h.nativeQueue.length).toBeGreaterThan(0))
    const last = h.nativeQueue.at(-1)!
    expect(last.index).toBe(1)
    expect(last.items[1].path).toBe('http://x/hall-pl-1.mp3')
    // 取址态必须收尾，否则播放键会被守卫永久早退
    expect(usePlayerStore.getState().resolvingTrackId).toBeNull()
  })

  it('取址失败：停住并提示，既不吃队列也不静默跳曲（row 4/8 的真实情形）', async () => {
    h.resolveOk = false
    const q = [onlineRow(0), onlineRow(1), localRow(2)]
    usePlayerStore.setState({ queue: q, currentIndex: 1, currentTrack: q[1] })
    emit({ type: 'unresolved', index: 1 })
    await vi.waitFor(() => expect(h.toasts.length).toBeGreaterThan(0))
    const st = usePlayerStore.getState()
    expect(st.queue.length).toBe(3)
    expect(st.currentIndex).toBe(1)
    expect(st.isPlaying).toBe(false)
    expect(st.resolvingTrackId).toBeNull()
    // 没有把空地址下发引擎（那会立刻变成一次 error → 被踢出队列）
    expect(h.nativeQueue.length).toBe(0)
  })

  it('同一位置重复上报只取址一次（避免取址风暴）', async () => {
    const q = [onlineRow(0)]
    usePlayerStore.setState({ queue: q, currentIndex: 0, currentTrack: q[0] })
    emit({ type: 'unresolved', index: 0 })
    emit({ type: 'unresolved', index: 0 })
    await vi.waitFor(() => expect(h.nativeQueue.length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 20))
    expect(h.resolveCalls.length).toBe(1)
  })
})

describe('移动端原生引擎：提示音闸门（回归 2）', () => {
  it('实际时长只有 3 秒而元数据是长曲 → 暂停 + 提示，不自动跳下一首', () => {
    const q = [onlineRow(0, { duration: 179 })]
    usePlayerStore.setState({ queue: q, currentIndex: 0, currentTrack: q[0], isPlaying: true })
    emit({ type: 'prepared', index: 0, duration: 3 })
    expect(h.pauses).toBe(1)
    expect(h.toasts.length).toBe(1)
    expect(usePlayerStore.getState().isPlaying).toBe(false)
    // 不踢队列：一条提示音不代表这首歌不能放，换个音源还能播
    expect(usePlayerStore.getState().queue.length).toBe(1)
  })

  it('实际时长与元数据相符 → 放行，不误伤正常长曲', () => {
    const q = [onlineRow(0, { duration: 179 })]
    usePlayerStore.setState({ queue: q, currentIndex: 0, currentTrack: q[0], isPlaying: true })
    emit({ type: 'prepared', index: 0, duration: 179.8 })
    expect(h.pauses).toBe(0)
    expect(h.toasts.length).toBe(0)
  })

  it('本地短素材（元数据本身就短）放行，不判异常', () => {
    const q = [localRow(0)]
    usePlayerStore.setState({ queue: q, currentIndex: 0, currentTrack: q[0], isPlaying: true })
    emit({ type: 'prepared', index: 0, duration: 6 })
    expect(h.pauses).toBe(0)
    expect(h.toasts.length).toBe(0)
  })
})
