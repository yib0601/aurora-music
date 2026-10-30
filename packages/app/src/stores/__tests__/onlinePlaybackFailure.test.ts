/**
 * 在线曲目播放失败必须**可读**（回归：静默 return）
 *
 * 上报现象：音乐馆/歌源里的在线曲目点了没反应，或只弹一句「没有资源」，
 * 用户完全不知道发生了什么。
 *
 * 根因：`audioEvents.on('error')` 里对网络来源曲目执行
 * `if (isNetworkBackedTrack(currentTrack)) return` —— **完全静默**。
 * 不把这类曲目踢出队列是对的（同源再取一次还是它，网络抖动也不该吃掉整条歌单），
 * 但静默是错的：地址是源给的，只是这条音频不可播放（实测：服务端把加密容器
 * `.mflac` / `.mgg` / `.mmp4` 与试听片段当完整直链返回，客户端必然播不出）。
 *
 * 本文件钉住四条不变量：
 *   - 在线曲目（已取到地址）加载失败 → 停住 + 可读提示（新文案键 incompleteAudio）
 *   - 出错的是已被切走的那一首 → 不提示、不动当前曲目（trackId 守卫不可丢）
 *   - 本地曲目加载失败 → 既有「移出队列 / 清空队列」语义与文案完全不变
 *   - 「源没给出地址」（取址失败）仍走 resolveFailed，与上面的情形区分开
 *
 * 运行：cd packages/app && npx vitest run src/stores/__tests__/onlinePlaybackFailure.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  audio: [] as any[],
  toasts: [] as any[],
  resolveCalls: [] as string[],
  /** 置 false 时 ensurePlayableTrack 返回 null（源没给出地址） */
  resolveOk: true,
}))

vi.mock('@/services/audio.service', () => ({
  playTrack: (track: any) => h.audio.push(track),
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

// 走渲染层 Howler 路径（web / 桌面），原生路径单独在 nativeUnresolved.test.ts 覆盖
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

// store 的提示走 Toast；这里截住，避免把 React 组件图拖进 node 测试
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
    return { ...t, onlineUrl: `https://example.invalid/${t.id}.mp3` }
  },
}))

/** zustand/persist 在 store 创建时就把 localStorage 引用缓存住了，必须建之前桩掉 */
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
vi.stubGlobal('localStorage', storage.impl)

const { usePlayerStore } = await import('@/stores/playerStore')
const { audioEvents } = await import('@/services/audioEvents')

/** 在线曲目：已有直链（播放中），加载失败即「源给的音频不可播放」 */
const onlineRow = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `on-${i}`,
  path: '',
  title: `在线曲目 ${i}`,
  artist: '某歌手',
  album: '',
  duration: 256,
  addedAt: 0,
  playCount: 0,
  liked: false,
  onlineSource: 'src-1',
  onlineId: `mid-${i}`,
  onlineUrl: 'https://example.invalid/audio.mp3',
  ...extra,
})

/** 本地曲目：path 有值、无在线身份 */
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

/** 未取址在线条目：无 path / onlineUrl / remoteUrl，走取址闸门 */
const unresolved = (i: number) => ({
  ...onlineRow(i),
  onlineUrl: undefined,
})

const toastText = (i = 0) => String(h.toasts[i].msg)

beforeEach(() => {
  storage.map.clear()
  h.audio.length = 0
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

describe('在线曲目播放失败：可读提示而非静默', () => {
  it('在线曲目（已取到地址）加载失败 → 停住 + 提示，且不踢出队列', () => {
    const q = [onlineRow(0), onlineRow(1)]
    usePlayerStore.setState({ queue: q, currentIndex: 1, currentTrack: q[1], isPlaying: true, progress: 12 })

    audioEvents.emit('error', { error: new Error('decode failed'), trackId: 'on-1' })

    const st = usePlayerStore.getState()
    // 静默 return 的回归点：必须有提示
    expect(h.toasts.length).toBe(1)
    expect(toastText()).toContain('未提供这首歌的完整音频')
    // 停住：不能继续装作在播
    expect(st.isPlaying).toBe(false)
    expect(st.progress).toBe(0)
    expect(st.resolvingTrackId).toBeNull()
    // 但不踢队列：同源再取一次还是它，换音源可能就能放
    expect(st.queue.map((t) => t.id)).toEqual(['on-0', 'on-1'])
    expect(st.currentIndex).toBe(1)
    expect(st.currentTrack?.id).toBe('on-1')
  })

  it('未取址的在线条目（只有在线身份）加载失败同样提示、同样不踢队列', () => {
    const q = [unresolved(0)]
    usePlayerStore.setState({ queue: q, currentIndex: 0, currentTrack: q[0], isPlaying: true })

    audioEvents.emit('error', { error: new Error('boom'), trackId: 'on-0' })

    expect(h.toasts.length).toBe(1)
    expect(toastText()).toContain('未提供这首歌的完整音频')
    expect(usePlayerStore.getState().queue.map((t) => t.id)).toEqual(['on-0'])
  })

  it('旧曲目的失败回调晚到：不提示、不动当前正在播的那一首', () => {
    const q = [onlineRow(0), onlineRow(1)]
    usePlayerStore.setState({ queue: q, currentIndex: 1, currentTrack: q[1], isPlaying: true, progress: 30 })

    // 用户已切到 1，曲目 0 的 Howl 此刻才报错
    audioEvents.emit('error', { error: new Error('late'), trackId: 'on-0' })

    expect(h.toasts.length).toBe(0)
    const st = usePlayerStore.getState()
    expect(st.isPlaying).toBe(true)
    expect(st.progress).toBe(30)
    expect(st.currentTrack?.id).toBe('on-1')
    expect(st.queue.length).toBe(2)
  })

  it('本地曲目加载失败：提示文案不变（无提示），既有移出队列语义不变', () => {
    const q = [localRow(0), localRow(1)]
    usePlayerStore.setState({ queue: q, currentIndex: 0, currentTrack: q[0], isPlaying: true })

    audioEvents.emit('error', { error: new Error('corrupt'), trackId: 'local-0' })

    expect(h.toasts.length).toBe(0)
    expect(usePlayerStore.getState().queue.map((t) => t.id)).toEqual(['local-1'])
  })

  it('队列只剩一条本地曲目且失败：清空队列，不弹「音源」提示', () => {
    const q = [localRow(0)]
    usePlayerStore.setState({ queue: q, currentIndex: 0, currentTrack: q[0], isPlaying: true })

    audioEvents.emit('error', { error: new Error('corrupt'), trackId: 'local-0' })

    expect(h.toasts.length).toBe(0)
    const st = usePlayerStore.getState()
    expect(st.queue.length).toBe(0)
    expect(st.currentTrack).toBeNull()
  })

  it('试听片段闸门（shortStream）语义不被新分支吞掉：仍用 abnormalAudio 且保留队列', () => {
    const q = [onlineRow(0)]
    usePlayerStore.setState({ queue: q, currentIndex: 0, currentTrack: q[0], isPlaying: true, progress: 5 })

    // audio.service 的时长闸门发出的标记：实际 48.5 秒 vs 元数据 256 秒
    audioEvents.emit('error', {
      error: { code: 'shortStream', actual: 48.5, expected: 256 },
      trackId: 'on-0',
    })

    expect(h.toasts.length).toBe(1)
    // 这条通路带实测秒数，仍是原文案（含秒数），不能被新文案顶掉
    expect(toastText()).toContain('49')
    expect(toastText()).not.toContain('未提供这首歌的完整音频')
    expect(usePlayerStore.getState().queue.length).toBe(1)
    expect(usePlayerStore.getState().isPlaying).toBe(false)
  })

  /**
   * 与「取址失败」的区分：源根本没给出地址时走 resolveFailed
   * （『未配置音源或搜索无结果』），而不是『未提供完整音频』。
   * 两种情形对用户是不同动作：前者要换/配音源，后者是这一首这个源拿不到完整版。
   */
  it('取址失败（源没给出地址）走 resolveFailed，与「音频不可播放」文案区分开', async () => {
    h.resolveOk = false
    const track = unresolved(7)

    await usePlayerStore.getState().playTrack(track)

    expect(h.toasts.length).toBe(1)
    expect(toastText()).toContain('无法播放该在线歌曲')
    expect(toastText()).not.toContain('未提供这首歌的完整音频')
    expect(h.audio.length).toBe(0) // 空地址不建播放器
    expect(usePlayerStore.getState().queue.map((t) => t.id)).toEqual(['on-7'])
  })
})
