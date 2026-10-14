/**
 * 冷启动恢复取址：**移动端原生引擎未续播**这一分叉的取址态收尾。
 *
 * 单独成文件的原因：这一态取决于 playerStore 里的模块级 `nativeBootstrapped`，
 * 而同文件里只要先跑过任何一个会引导原生引擎的用例，它就被置位且不会回落。
 * 这里刻意只放这一个进程级前置态，保证「引擎未续播 → 需要重新取址」是真实进入的。
 *
 * 钉住的点：走到 nativeBootstrapPlay 这条出口时，resolvingTrackId 必须已被 finally
 * 清掉，且 JS 侧不建 Howl（队列已带新地址下发原生引擎）。
 *
 * 运行：cd packages/app && npx vitest run src/stores/__tests__/restoreOnlineTrackNative.test.ts
 */
import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({
  audio: [] as { track: any; autoplay: boolean }[],
  nativeQueue: [] as any[],
  resolveCalls: [] as string[],
}))

vi.mock('@/services/audio.service', () => ({
  playTrack: (track: any, _v: number, _m: boolean, autoplay: boolean) => {
    h.audio.push({ track, autoplay })
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
}))

vi.mock('@/services/audioCache.service', () => ({
  resolveCachedAudioSrc: async () => null,
  configureAudioCache: () => {},
}))

vi.mock('@/services/mediaSession', () => ({
  isNativePlayerAvailable: () => true,
  startNativeService: async () => true,
  stopNativeService: async () => {},
  toQueueItems: (q: any[]) => q,
  nativePlayQueue: async (items: any[]) => {
    h.nativeQueue.push(items)
  },
  nativeSyncQueue: () => {},
  nativePause: () => {},
  nativeResume: () => {},
  nativeSeekTo: () => {},
  nativeSetVolume: () => {},
  nativeNext: () => {},
  nativePrevious: () => {},
  nativePlayAt: () => {},
  nativeStopEngine: () => {},
  // index: -1 = 原生引擎没有在播（进程被杀后服务未续播）→ 需要重新取址
  nativeGetState: async () => ({ index: -1, position: 0, duration: 0 }),
  onPlaybackEvent: () => () => {},
}))

vi.mock('@/components/common/Toast', () => ({ toast: () => 1 }))

vi.mock('@/services/playlistIO.service', () => ({
  ensurePlayableTrack: (t: any) => {
    h.resolveCalls.push(t.id)
    return Promise.resolve({ ...t, onlineUrl: 'http://x/r1.mp3' })
  },
}))

const map = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => map.get(k) ?? null,
  setItem: (k: string, v: string) => void map.set(k, v),
  removeItem: (k: string) => void map.delete(k),
  clear: () => map.clear(),
  key: (i: number) => Array.from(map.keys())[i] ?? null,
  get length() {
    return map.size
  },
})

async function waitFor(cond: () => boolean, ms = 1000) {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5))
}

describe('冷启动恢复取址（原生分支：引擎未续播）', () => {
  it('重新取址后队列带新地址下发原生引擎，且不残留取址态、不建 Howl', async () => {
    const { usePlayerStore } = await import('@/stores/playerStore')
    const track: any = {
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
    }
    usePlayerStore.setState({
      queue: [track],
      currentIndex: 0,
      currentTrack: track,
      progress: 30,
      resolvingTrackId: null,
      isPlaying: false,
    })

    // 冷启动恢复取址是后台任务：restorePlayback 返回时它才刚起步，取址态已置位
    usePlayerStore.getState().restorePlayback()
    expect(usePlayerStore.getState().resolvingTrackId).toBe('R1')

    await waitFor(() => h.resolveCalls.length >= 1)
    await waitFor(() => usePlayerStore.getState().resolvingTrackId === null)

    const st = usePlayerStore.getState()
    expect(st.resolvingTrackId).toBeNull()
    // 队列带上新地址：原生引擎下一次下发才有地址可用
    expect(st.queue[0].onlineUrl).toBe('http://x/r1.mp3')
    expect(st.currentTrack?.onlineUrl).toBe('http://x/r1.mp3')
    // JS 侧不建 Howl（移动端音频由原生 MediaPlayer 播）
    expect(h.audio.length).toBe(0)
  })
})