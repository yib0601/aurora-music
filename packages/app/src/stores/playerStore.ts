import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { RepeatMode, ShuffleMode, Track } from '@/types'
import {
  togglePlayPause as audioTogglePlayPause,
  playTrack as audioPlayTrack,
  setVolume as audioSetVolume,
  seekTo as audioSeekTo,
  setMuted as audioSetMuted,
  stopPlayback as audioStopPlayback,
  onCurrentTrackLoad,
  hasCurrentHowl,
  pausePlayback as audioPausePlayback,
  resumePlayback as audioResumePlayback,
} from '@/services/audio.service'
import { audioEvents } from '@/services/audioEvents'
import { resolveCachedAudioSrc } from '@/services/audioCache.service'
import { toast } from '@/components/common/Toast'
import { appTranslate } from '@/i18n'
import {
  isNativePlayerAvailable,
  startNativeService,
  stopNativeService,
  toQueueItems,
  nativePlayQueue,
  nativeSyncQueue,
  nativePause,
  nativeResume,
  nativeSeekTo,
  nativeSetVolume,
  nativeNext,
  nativePrevious,
  nativePlayAt,
  nativeStopEngine,
  nativeGetState,
  onPlaybackEvent,
} from '@/services/mediaSession'

interface PlayerState {
  currentTrack: Track | null
  isPlaying: boolean
  progress: number
  duration: number
  volume: number
  muted: boolean
  queue: Track[]
  currentIndex: number
  repeatMode: RepeatMode
  shuffleMode: ShuffleMode
  shuffleHistory: number[]

  /**
   * 正在取址的曲目 id：点播在线曲目后、拿到播放地址前的过渡态。
   * 此时 currentTrack 已经是这首歌，只是还没出声，播放条据此显示加载指示。
   */
  resolvingTrackId: string | null

  playTrack: (track: Track) => Promise<void>
  playQueue: (tracks: Track[], startIndex?: number) => Promise<void>
  addToQueue: (track: Track) => void
  addToPlayNext: (track: Track) => void
  removeFromQueue: (index: number) => void
  clearQueue: () => void
  togglePlay: () => void
  play: () => void
  pause: () => void
  next: () => void
  previous: () => void
  seekTo: (seconds: number) => void
  setVolume: (volume: number) => void
  toggleMute: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  cyclePlayMode: () => void
  setCurrentIndex: (index: number) => void
  setIsPlaying: (playing: boolean) => void
  setProgress: (progress: number) => void
  setDuration: (duration: number) => void
  reset: () => void
  restorePlayback: () => void
}

const initialState = {
  currentTrack: null,
  isPlaying: false,
  progress: 0,
  duration: 0,
  volume: 0.7,
  muted: false,
  queue: [],
  currentIndex: -1,
  repeatMode: 'off' as RepeatMode,
  shuffleMode: 'on' as ShuffleMode,
  shuffleHistory: [] as number[],
  resolvingTrackId: null as string | null,
}

/**
 * 持久化前剥离已过期的在线播放地址，保留曲目元信息。
 *
 * 只剥 onlineUrl：那是歌源返回的临时直链（有效期常只有几十分钟）。
 * remoteUrl（aurora-remote://<sourceId>/...）绝不能剥——它由来源配置推导，
 * 只要来源还在就一直有效，剥掉会让远端曲目重启后变成不可播放。
 */
function stripOnlineUrl(track: Track | null): Track | null {
  if (!track || !track.onlineUrl) return track
  // 源给的定位令牌与直链同命运：令牌依赖上游、重启后未必有效，
  // 交由播放时的按需取址重建，因此这里随 onlineUrl 一起剥离
  const { onlineUrl: _url, trackRef: _ref, ...rest } = track
  return rest as Track
}

/**
 * 是否为「网络来源」曲目：地址易失或依赖网络，加载失败不应把曲目踢出队列。
 * 本地文件出错意味着文件被删/损坏，跳过是对的；网络抖动只是暂时的，
 * 自动跳曲会让用户在 NAS 短暂不可达时整张歌单被逐首吃掉。
 */
function isNetworkBackedTrack(track: Track | null | undefined): boolean {
  if (!track) return false
  return !!track.onlineUrl || !!track.remoteUrl || /^https?:\/\//i.test(track.path)
}

/**
 * 播放意图号：点播那一刻自增。
 *
 * 取址（在线曲目按 id 向歌源/脚本换直链）是网络往返，可能几秒；期间用户完全可能
 * 再点另一首。异步回调回到 store 时必须先确认「这仍是最新一次点播」，否则旧曲目的
 * 结果会把新曲目的播放地址与显示信息一起覆盖掉。
 */
let playIntent = 0

/**
 * 点播落地：先把用户点的那首歌设为当前曲目，再谈取址。
 *
 * 这样做的意义是「点谁显示谁」——取址等待期间在线歌曲不再是一片空白：
 * 播放条/详情页立刻显示曲名、歌手、封面，只是进度条不动、主按钮转加载态。
 */
function markPlaying(track: Track, resolving: boolean): void {
  const prev = usePlayerStore.getState().currentTrack
  // 切到另一首歌：旧音频立即停掉。取址要网络往返，若还让上一首继续出声，
  // 就会出现「界面显示新歌、耳朵里是旧歌」的错位
  if (!useNative() && prev && prev.id !== track.id && hasCurrentHowl()) {
    audioStopPlayback()
  }
  usePlayerStore.setState({
    currentTrack: track,
    progress: 0,
    duration: track.duration || 0,
    resolvingTrackId: resolving ? track.id : null,
  })
}

/** 是否已有可直接播放的地址（无需走取址闸门） */
function hasPlayableSrc(track: Track): boolean {
  return !!(track.path || track.onlineUrl || track.remoteUrl)
}

/**
 * 取址失败的提示：与页面层同一句文案（此前散在四个页面各自 toast）。
 * store 没有渲染周期，译文在**每次调用时**取（appTranslate），不缓存成模块级常量。
 */
function notifyResolveFailed(track: Track): void {
  console.warn(`[播放] 取址失败，无法播放：${track.title} - ${track.artist}`)
  toast(appTranslate()('runtime.player.resolveFailed'), { type: 'error' })
}

/**
 * 取址收尾：地址仍未取到时给一次提示并停住，不把空地址交给播放器。
 *
 * 空地址会建出一个必然失败的 Howl，其 error 事件会被下面的自动跳曲逻辑
 * 当成本地文件损坏而把这首歌剔除出队列——那是「取址失败」不是「文件没了」，
 * 队列不该被吃掉。返回 false 表示这一轮不继续播放。
 */
function confirmResolved(ready: Track): boolean {
  if (hasPlayableSrc(ready)) {
    usePlayerStore.setState({ resolvingTrackId: null })
    return true
  }
  usePlayerStore.setState({ resolvingTrackId: null, isPlaying: false, progress: 0 })
  notifyResolveFailed(ready)
  return false
}

/**
 * 播放前的取址闸门：用户点播的曲目可能**还没有播放地址**。
 *
 * 典型场景就是惰性取址的源：搜索只给元信息（曲目带一份定位令牌 trackRef），
 * 地址要在播放时按令牌现取（见平台侧 resolveTrackAudio）；导入歌单 / 最近播放里的
 * 在线曲目在落盘时也剥离了地址。
 * 没有这道闸门，播放器会拿着空地址去加载，表现为「双击了但没声音」，且毫无提示。
 *
 * 判据只看**有没有可播放地址**：此前还额外要求曲目自带 trackRef / onlineSource /
 * onlineId 才放行，于是音乐库的歌单/榜单详情页构造出来的条目（只有歌名与歌手）
 * 被判成「无需取址」直接进播放器，加载必然失败——进度停在 0:00、一声不出，
 * 随后还会被 error 路径当成坏文件逐首踢出队列（见 confirmResolved 与 audioEvents 的
 * error 订阅）。带令牌的曲目由 ensurePlayableTrack 内部优先按令牌取址，
 * 无令牌的退化为「歌名 + 歌手」重新搜索，两条路都归它收口。
 *
 * 取址失败不阻断：返回原曲目，交给播放器按原有语义处理（无地址即不播放）。
 */
async function resolveBeforePlay(track: Track): Promise<Track> {
  if (hasPlayableSrc(track)) return track
  try {
    const { ensurePlayableTrack } = await import('@/services/playlistIO.service')
    return (await ensurePlayableTrack(track)) || track
  } catch (err) {
    console.warn('[播放] 按需取址失败:', err)
    return track
  }
}

/**
 * 「本次点播是否无需等待取址」的同步判据。
 *
 * ⚠️ 必须能同步判定：`await resolveBeforePlay(...)` 即便内部立刻返回，也至少要
 * 让出一个 microtask，于是同一 tick 内连点两首时，两边的后续代码都会排在**两个
 * 已解封的 await 回调**里按入队顺序执行 —— 第二首的 markPlaying 会落在第一首的
 * 回调之后，形成「点的是 B，最后显示 A」。有了这个同步分支，有地址的曲目走
 * 全同步路径，调用顺序严格等于用户点击顺序。
 *
 * 判据与 resolveBeforePlay 同一份：本地曲目（path 有值）与已取到地址的在线曲目
 * 都短路，零开销不变；**没有地址的一律视作有待取址**，不再要求自带定位令牌。
 */
function hasResolvableGap(track: Track): boolean {
  return !hasPlayableSrc(track)
}

/** 取址 → 播放（自动续播路径共用）：取址失败就按原样交给播放器，保持既有语义 */
async function playResolved(track: Track, volume: number, muted: boolean, autoplay = true): Promise<void> {
  const intent = ++playIntent
  // 同一道理：显示信息先切到这首歌，取址耗时期间界面不空窗
  markPlaying(track, hasResolvableGap(track))
  // 已有地址：全同步起播（同 playTrack 的同步分支）
  if (!hasResolvableGap(track)) {
    audioPlayTrack(track, volume, muted, autoplay)
    return
  }
  const ready = await resolveBeforePlay(track)
  // 取址期间用户已改点别的歌：本次结果作废
  if (intent !== playIntent) return
  if (ready !== track) {
    const state = usePlayerStore.getState()
    usePlayerStore.setState({ queue: state.queue.map((t) => (t.id === ready.id ? ready : t)) })
    if (state.currentTrack?.id === ready.id) usePlayerStore.setState({ currentTrack: ready })
  }
  // 自动续播（下一首/循环）取址失败同样停住：空地址交给播放器会被 error 路径
  // 误判成「本地文件损坏」而把这首歌踢出队列（见 confirmResolved）
  if (!confirmResolved(ready)) return
  audioPlayTrack(ready, volume, muted, autoplay)
}

async function restoreOnlineTrack(): Promise<void> {
  const track = usePlayerStore.getState().currentTrack
  if (!track) return
  // 冷启动恢复不占播放意图：在途的旧取址回调不应因为这次恢复而失效
  const intent = playIntent
  if (useNative()) {
    // 移动端：原生引擎可能仍持有有效流并续播中（START_STICKY），先对账；
    // 引擎活跃（snap.index >= 0）则无需重新取址，仅同步 UI
    await reconcileNativePlayback().catch(() => {})
    if (nativeBootstrapped) return
  }

  const st0 = usePlayerStore.getState()
  // 缓存命中（仅桌面端有缓存实现）：跳过搜索取址，直接用缓存协议地址加载
  const cachedSrc = await resolveCachedAudioSrc(track).catch(() => null)
  if (cachedSrc && usePlayerStore.getState().currentTrack?.id === track.id) {
    const playable: Track = { ...track, onlineUrl: cachedSrc }
    usePlayerStore.setState({
      currentTrack: playable,
      queue: st0.queue.map((t) => (t.id === track.id ? playable : t)),
    })
    audioPlayTrack(playable, st0.volume, st0.muted, false)
    const seekPos = st0.progress
    onCurrentTrackLoad(() => {
      audioSeekTo(seekPos)
    })
    return
  }

  // 动态导入：playlistIO → stores(library/playlist) 与 playerStore 静态互引会形成模块级循环依赖
  const { ensurePlayableTrack } = await import('@/services/playlistIO.service')
  const playable = await ensurePlayableTrack(track)
  if (!playable) return
  const st = usePlayerStore.getState()
  // 重新取址是异步的，期间用户可能已切歌或点了新歌：不覆盖用户的当前操作
  if (intent !== playIntent || st.currentTrack?.id !== track.id) return
  // 把取到新地址的曲目回填（队列里同 id 的条目一并更新，避免续播时仍拿旧快照）
  usePlayerStore.setState({
    currentTrack: playable,
    queue: st.queue.map((t) => (t.id === track.id ? playable : t)),
  })
  if (useNative()) {
    // 移动端：队列已带新地址下发，从持久化进度引导但不自动播放
    nativeBootstrapPlay(st.progress, false)
    return
  }
  audioPlayTrack(playable, st.volume, st.muted, false)
  const seekPos = st.progress
  onCurrentTrackLoad(() => {
    audioSeekTo(seekPos)
  })
}

// ─── 移动端原生播放引擎桥接 ──────────────────────────────────────
// 锁屏后系统会杀掉 WebView 渲染进程，WebView 内的 HTML5 Audio 会中断且
// 锁屏控件失效，因此移动端音频由原生 MediaPlayer 播放，JS 仅管理状态。
const useNative = () => isNativePlayerAvailable()

/** 原生引擎是否已完成队列引导（服务已启动且队列已下发） */
let nativeBootstrapped = false

/** 进度轮询：原生引擎不主动推 progress，播放中每 500ms 查询一次快照 */
let nativeTicker: ReturnType<typeof setInterval> | null = null
function startNativeTicker() {
  if (nativeTicker || !useNative()) return
  nativeTicker = setInterval(async () => {
    const st = usePlayerStore.getState()
    if (!st.isPlaying) return
    const snap = await nativeGetState()
    if (snap.index >= 0) {
      usePlayerStore.setState({ progress: snap.position, duration: snap.duration || st.duration })
    }
  }, 500)
}
function stopNativeTicker() {
  if (nativeTicker) {
    clearInterval(nativeTicker)
    nativeTicker = null
  }
}

/** 同步队列/循环/随机镜像到原生引擎（不打断当前播放） */
function syncNativeMirror() {
  if (!useNative()) return
  const s = usePlayerStore.getState()
  nativeSyncQueue(toQueueItems(s.queue), s.currentIndex, s.shuffleMode, s.repeatMode)
}

/** 启动原生服务并下发队列开始播放 */
function nativeBootstrapPlay(positionSec: number, autoplay = true) {
  const s = usePlayerStore.getState()
  if (s.queue.length === 0 || s.currentIndex < 0) return
  startNativeService().then((ok) => {
    if (!ok) return
    nativePlayQueue(
      toQueueItems(s.queue),
      s.currentIndex,
      autoplay,
      positionSec,
      s.muted ? 0 : s.volume,
      s.shuffleMode,
      s.repeatMode
    ).then(() => {
      nativeBootstrapped = true
      if (autoplay) startNativeTicker()
    })
  })
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
      ...initialState,

      playTrack: async (track) => {
        const intent = ++playIntent
        const state = get()
        let index = state.queue.findIndex((t) => t.id === track.id)
        let newQueue = state.queue
        if (index < 0) {
          newQueue = [...state.queue, track]
          index = newQueue.length - 1
        }
        const newHistory =
          state.shuffleMode === 'on'
            ? [...state.shuffleHistory, index]
            : state.shuffleHistory
        // 信息先行：先把这首歌设为当前曲目（此时可能还没有播放地址），
        // 再走取址——取址期间播放条显示的就是用户点的这首歌
        set({ queue: newQueue, currentIndex: index, shuffleHistory: newHistory })
        markPlaying(track, hasResolvableGap(track))
        // 已有地址：全同步路径，同一 tick 连点两首时不会互串（见 hasResolvableGap）
        if (!hasResolvableGap(track)) {
          if (useNative()) {
            set({ currentTrack: track, progress: 0 })
            nativeBootstrapPlay(0, true)
            return
          }
          audioPlayTrack(track, state.volume, state.muted)
          return
        }
        // 取址闸门：在线条目（尤其洛雪脚本源）多数没有现成地址
        const ready = await resolveBeforePlay(track)
        // 期间用户已点别的歌：本次结果作废，不得覆盖新曲目的信息与地址
        if (intent !== playIntent) return
        // 命中的旧条目可能还是无地址的快照：用取到地址的副本替换，避免续播时又空跑
        set({ queue: get().queue.map((t) => (t.id === ready.id ? ready : t)) })
        if (!confirmResolved(ready)) return
        if (useNative()) {
          set({ currentTrack: ready, progress: 0 })
          nativeBootstrapPlay(0, true)
          return
        }
        audioPlayTrack(ready, state.volume, state.muted)
      },

      playQueue: async (tracks, startIndex = 0) => {
        // 空队列或索引越界时直接返回，避免 audioPlayTrack(undefined) 崩溃
        if (!tracks || tracks.length === 0) return
        const idx = Math.max(0, Math.min(startIndex, tracks.length - 1))
        const intent = ++playIntent
        const start = tracks[idx]
        const newHistory = get().shuffleMode === 'on' && start ? [idx] : []
        // 队列与当前曲目先落地再取址：取址可能有网络往返，期间用户已能看到
        // 队列与「正在播放的是哪一首」（取址结果稍后回填地址）
        set({ queue: tracks, currentIndex: idx, shuffleHistory: newHistory })
        markPlaying(start, hasResolvableGap(start))
        // 已有地址：全同步起播（同 playTrack 的同步分支）
        if (!hasResolvableGap(start)) {
          if (useNative()) {
            set({ currentTrack: start, progress: 0 })
            nativeBootstrapPlay(0, true)
            return
          }
          audioPlayTrack(start, get().volume, get().muted)
          return
        }
        const ready = await resolveBeforePlay(start)
        if (intent !== playIntent) return
        if (ready !== start) {
          set({ queue: get().queue.map((t) => (t.id === ready.id ? ready : t)) })
        }
        if (!confirmResolved(ready)) return
        if (useNative()) {
          set({ currentTrack: ready, progress: 0 })
          nativeBootstrapPlay(0, true)
          return
        }
        audioPlayTrack(ready, get().volume, get().muted)
      },

      addToQueue: (track) => {
        const { queue } = get()
        if (queue.some((t) => t.id === track.id)) return
        set({ queue: [...queue, track] })
        syncNativeMirror()
        // 空闲时就先取址：切到它时才不会有「等了几秒才开始响」的顿感
        void resolveBeforePlay(track).then((ready) => {
          if (ready === track) return
          const st = get()
          set({ queue: st.queue.map((t) => (t.id === ready.id ? ready : t)) })
        })
      },

      addToPlayNext: (track) => {
        const { queue, currentIndex } = get()
        if (queue.some((t) => t.id === track.id)) return
        const insertAt = currentIndex < 0 ? 0 : currentIndex + 1
        set({ queue: [...queue.slice(0, insertAt), track, ...queue.slice(insertAt)] })
        syncNativeMirror()
        void resolveBeforePlay(track).then((ready) => {
          if (ready === track) return
          const st = get()
          set({ queue: st.queue.map((t) => (t.id === ready.id ? ready : t)) })
        })
      },

      removeFromQueue: (index) => {
        const { queue, currentIndex, resolvingTrackId } = get()
        if (index < 0 || index >= queue.length) return
        const cancelledResolve = queue[index].id === resolvingTrackId
        if (cancelledResolve) {
          // 正在取址的曲目被删：作废这次点播。否则取址回来会把这首歌重新
          // 填回 currentTrack/队列（用户已经明确删掉它了），或残留空地址条目
          playIntent++
        }
        const newQueue = queue.filter((_, i) => i !== index)
        let newCurrentIndex = currentIndex
        if (index < currentIndex) {
          newCurrentIndex = currentIndex - 1
        } else if (index === currentIndex) {
          // 删除当前播放的曲目，跳到下一首
          if (newQueue.length === 0) {
            newCurrentIndex = -1
          } else {
            newCurrentIndex = Math.min(currentIndex, newQueue.length - 1)
            if (useNative()) {
              // 队列变化较大（当前曲目被删），重新下发队列并从接续位置播放
              set({ queue: newQueue, currentIndex: newCurrentIndex, currentTrack: newQueue[newCurrentIndex], progress: 0 })
              nativeBootstrapPlay(0, true)
              return
            }
            const nextTrack = newQueue[newCurrentIndex]
            audioPlayTrack(nextTrack, get().volume, get().muted)
          }
        }
        set({
          queue: newQueue,
          currentIndex: newCurrentIndex,
          // 队列删空、或删的正是取址中那首：加载指示不能留在界面上
          ...(newCurrentIndex < 0 || cancelledResolve ? { resolvingTrackId: null } : {}),
        })
        syncNativeMirror()
      },

      clearQueue: () => {
        // 取消在途取址意图：清空后旧取址回调不得再落地任何播放状态
        playIntent++
        if (useNative()) {
          nativeStopEngine()
          stopNativeService()
          stopNativeTicker()
          nativeBootstrapped = false
          set({ queue: [], currentIndex: -1, currentTrack: null, isPlaying: false, progress: 0, resolvingTrackId: null })
          return
        }
        audioStopPlayback()
        set({ queue: [], currentIndex: -1, currentTrack: null, isPlaying: false, progress: 0, resolvingTrackId: null })
      },

      togglePlay: () => {
        const state = get()
        if (!state.currentTrack) return
        if (useNative()) {
          if (!nativeBootstrapped) {
            // 引擎未引导（如 app 冷启动恢复）：下发队列从当前进度续播
            set({ isPlaying: true })
            nativeBootstrapPlay(state.progress, true)
            return
          }
          // 取址在途时原生引擎仍在播上一首，暂停/续播要照常生效（不能早退）
          if (state.isPlaying) nativePause()
          else nativeResume()
          return
        }
        // 取址在途中用户点了播放键：此时没有 Howl 可操作，拿 currentTrack 去建
        // 播放器只会得到空地址的必然失败（连点还会把加载指示抖掉）。
        // 真取到地址后 playTrack 自己会起播，这里只需忽略这次点击
        if (state.resolvingTrackId) return
        // 如果 currentHowl 已被清理(如应用从后台恢复/StrictMode cleanup 后),
        // 重建 Howl 并从保存的进度续播,而不是静默失败
        if (!hasCurrentHowl()) {
          audioPlayTrack(state.currentTrack, state.volume, state.muted, false)
          const seekPos = state.progress
          onCurrentTrackLoad(() => audioSeekTo(seekPos))
          return
        }
        audioTogglePlayPause(state.isPlaying)
      },

      play: () => {
        const state = get()
        if (!state.currentTrack) return
        if (useNative()) {
          if (!nativeBootstrapped) {
            nativeBootstrapPlay(state.progress, true)
          } else {
            nativeResume()
          }
          return
        }
        // 同 togglePlay：取址在途时没有可播放的音频，忽略点击等取址结果
        if (state.resolvingTrackId) return
        if (!hasCurrentHowl()) {
          audioPlayTrack(state.currentTrack, state.volume, state.muted, false)
          const seekPos = state.progress
          onCurrentTrackLoad(() => audioSeekTo(seekPos))
          return
        }
        if (!state.isPlaying) audioResumePlayback()
      },

      pause: () => {
        if (useNative()) {
          if (get().isPlaying) nativePause()
          return
        }
        if (get().isPlaying) audioPausePlayback()
      },

      next: () => {
        const state = get()
        if (state.queue.length === 0) return
        if (useNative()) {
          syncNativeMirror()
          nativeNext()
          return
        }

        if (state.repeatMode === 'one') {
          audioSeekTo(0)
          void playResolved(state.currentTrack!, state.volume, state.muted)
          return
        }

        let nextIndex: number
        if (state.shuffleMode === 'on') {
          if (state.queue.length === 1) {
            nextIndex = state.currentIndex
          } else {
            const candidates = state.queue
              .map((_, i) => i)
              .filter((i) => i !== state.currentIndex)
            nextIndex = candidates[Math.floor(Math.random() * candidates.length)]
          }
          const newHistory = [...state.shuffleHistory, nextIndex].slice(-100)
          const nextTrack = state.queue[nextIndex]
          set({ currentIndex: nextIndex, shuffleHistory: newHistory })
          void playResolved(nextTrack, state.volume, state.muted)
          return
        }

        nextIndex = state.currentIndex + 1
        if (nextIndex >= state.queue.length) {
          if (state.repeatMode === 'all') {
            nextIndex = 0
          } else {
            set({ isPlaying: false, progress: 0 })
            return
          }
        }

        const nextTrack = state.queue[nextIndex]
        set({ currentIndex: nextIndex })
        void playResolved(nextTrack, state.volume, state.muted)
      },

      previous: () => {
        const state = get()
        if (state.queue.length === 0) return
        if (useNative()) {
          syncNativeMirror()
          nativePrevious()
          return
        }

        if (state.progress > 3) {
          audioSeekTo(0)
          return
        }

        let prevIndex: number
        if (state.shuffleMode === 'on') {
          const history = [...state.shuffleHistory]
          history.pop()
          const last = history[history.length - 1]
          if (last === undefined) {
            audioSeekTo(0)
            return
          }
          prevIndex = last
          set({ shuffleHistory: history })
        } else {
          prevIndex = state.currentIndex - 1
          if (prevIndex < 0) prevIndex = state.queue.length - 1
        }

        const prevTrack = state.queue[prevIndex]
        set({ currentIndex: prevIndex })
        void playResolved(prevTrack, state.volume, state.muted)
      },

      seekTo: (seconds) => {
        if (useNative()) {
          nativeSeekTo(seconds)
          set({ progress: seconds })
          return
        }
        audioSeekTo(seconds)
      },

      setVolume: (volume) => {
        const newMuted = volume === 0
        set({ volume, muted: newMuted })
        if (useNative()) {
          nativeSetVolume(newMuted ? 0 : volume)
          return
        }
        audioSetVolume(volume)
        if (newMuted) audioSetMuted(true, volume)
      },

      toggleMute: () => {
        const { muted, volume } = get()
        const newMuted = !muted
        set({ muted: newMuted })
        if (useNative()) {
          nativeSetVolume(newMuted ? 0 : volume)
          return
        }
        audioSetMuted(newMuted, volume)
        if (!newMuted) audioSetVolume(volume)
      },

      toggleShuffle: () => {
        const { shuffleMode, currentIndex } = get()
        const newMode: ShuffleMode = shuffleMode === 'off' ? 'on' : 'off'
        const newHistory =
          newMode === 'on' && currentIndex >= 0
            ? [currentIndex]
            : []
        set({ shuffleMode: newMode, shuffleHistory: newHistory })
        syncNativeMirror()
      },

      cycleRepeat: () => {
        const { repeatMode } = get()
        const modes: RepeatMode[] = ['off', 'all', 'one']
        const nextIdx = (modes.indexOf(repeatMode) + 1) % modes.length
        set({ repeatMode: modes[nextIdx] })
        syncNativeMirror()
      },

      cyclePlayMode: () => {
        const { shuffleMode, repeatMode, currentIndex } = get()
        // shuffle → repeat all → repeat one → shuffle
        if (shuffleMode === 'on') {
          set({ shuffleMode: 'off', shuffleHistory: [], repeatMode: 'all' })
        } else if (repeatMode === 'all') {
          set({ repeatMode: 'one' })
        } else {
          set({ repeatMode: 'off', shuffleMode: 'on', shuffleHistory: currentIndex >= 0 ? [currentIndex] : [] })
        }
        syncNativeMirror()
      },

      setCurrentIndex: (index) => {
        const { queue } = get()
        if (index >= 0 && index < queue.length) {
          set({ currentIndex: index, currentTrack: queue[index], progress: 0 })
          if (useNative()) {
            nativePlayAt(index)
          }
        }
      },

      setIsPlaying: (playing) => set({ isPlaying: playing }),
      setProgress: (progress) => set({ progress }),
      setDuration: (duration) => set({ duration }),

      reset: () => {
        set(initialState)
      },

      restorePlayback: () => {
        const state = get()
        if (!state.currentTrack || state.currentIndex < 0) return
        // 在线曲目的播放地址（onlineUrl）已在持久化时剥离（歌源直链会过期）；
        // 远端媒体库曲目的 remoteUrl 与本地曲目的 path 会被保留，可直接恢复。
        // 在线曲目需要按元信息重新搜索取址后才能恢复。
        const src = state.currentTrack.onlineUrl || state.currentTrack.remoteUrl || state.currentTrack.path
        if (!src) {
          void restoreOnlineTrack()
          return
        }
        if (useNative()) {
          // 移动端原生引擎：进程被杀后服务可能已由 START_STICKY 自动续播，
          // 先与原生快照对账（若引擎在播则直接同步 UI），否则仅恢复元数据，
          // 用户点播放时 togglePlay 检测到 nativeBootstrapped=false 会从持久化进度续播
          reconcileNativePlayback().catch(() => {})
          return
        }
        // 加载音频但不自动播放（需要用户交互才能播放）
        audioPlayTrack(state.currentTrack, state.volume, state.muted, false)
        // 等 Howl 的 onload 事件触发后再 seek,避免固定延迟导致 seek 失败
        const seekPos = state.progress
        onCurrentTrackLoad(() => {
          audioSeekTo(seekPos)
        })
      },
    }),
    {
      name: 'aurora-player-state',
      partialize: (state) => ({
        volume: state.volume,
        muted: state.muted,
        repeatMode: state.repeatMode,
        shuffleMode: state.shuffleMode,
        // 在线播放地址（onlineUrl）有效期通常只有几十分钟，持久化后恢复必然失效，
        // 故剥离；恢复时由 restoreOnlineTrack 按元信息重新搜索取址（见 restorePlayback）
        currentTrack: stripOnlineUrl(state.currentTrack),
        queue: state.queue.map(stripOnlineUrl),
        currentIndex: state.currentIndex,
        progress: state.progress,
        duration: state.duration,
        shuffleHistory: state.shuffleHistory,
      }),
    }
  )
)

// 订阅音频事件，更新播放状态 — 在模块加载时初始化
audioEvents.on('play', () => {
  usePlayerStore.setState({ isPlaying: true })
})

audioEvents.on('pause', () => {
  usePlayerStore.setState({ isPlaying: false })
})

audioEvents.on('stop', () => {
  usePlayerStore.setState({ isPlaying: false, progress: 0 })
})

audioEvents.on('end', () => {
  usePlayerStore.getState().next()
})

audioEvents.on('progress', ({ currentTime }) => {
  usePlayerStore.setState({ progress: currentTime })
})

audioEvents.on('duration', ({ duration }) => {
  usePlayerStore.setState({ duration })
})

audioEvents.on('trackChange', ({ track }) => {
  // 只在「播的就是当前点播的那首」时回填：取址期间用户可能已切歌，
  // 旧曲目的 Howl 建好后触发的事件不得把新曲目的显示信息顶掉
  const { currentTrack } = usePlayerStore.getState()
  if (currentTrack && currentTrack.id !== track.id) return
  usePlayerStore.setState({ currentTrack: track, duration: 0, progress: 0, resolvingTrackId: null })
})

// 本地文件加载失败（文件被删除/移动/损坏）时自动跳过，避免播放卡住；网络来源（在线流 / 远端媒体库）出错不自动跳
audioEvents.on('error', ({ trackId }) => {
  const state = usePlayerStore.getState()
  const { currentTrack, queue, currentIndex } = state
  if (!currentTrack) return
  // 出错的是已经被切走的那一首（Howl 的失败回调可能晚到）：什么都不做。
  // 否则会拿「当前曲目」去判定，把用户刚点的新歌当成坏文件删掉
  if (trackId && currentTrack.id !== trackId) return
  if (isNetworkBackedTrack(currentTrack)) return
  if (queue.length <= 1) {
    state.clearQueue()
    return
  }
  state.removeFromQueue(currentIndex)
})

// ─── 原生播放引擎事件回同步 ────────────────────────────────────
// 锁屏/后台期间锁屏控件由原生 MediaSession 直接操作引擎，JS 被冻结收不到
// 回调；解冻后通过 playbackevent 把状态差异同步回 UI（含补登播放统计）。
function emitPlayStats(track: Track) {
  audioEvents.emit('playStatsUpdate', {
    trackId: track.id,
    lastPlayedAt: Date.now(),
    playCount: (track.playCount || 0) + 1,
    track,
  })
}

let lastStatsEmittedAt = 0

/** 队列变更（addToQueue/removeFromQueue/toggleShuffle/cycleRepeat）后镜像到原生引擎 */
export function syncNativeQueueMirror() {
  syncNativeMirror()
}

/** 清空队列/停止播放后同步停掉原生引擎与前台服务 */
export function stopNativePlayback() {
  nativeStopEngine()
  void stopNativeService()
  stopNativeTicker()
  nativeBootstrapped = false
}

/**
 * 与原生引擎对账：锁屏/后台期间 WebView 被冻结（甚至进程被杀后 WebView 重建，
 * 此时模块级 nativeBootstrapped 已重置为 false），playbackevent 无法送达 JS。
 * 回到前台/启动恢复时主动查询原生快照，把曲目索引/进度/播放状态同步回 UI。
 * 不能用 nativeBootstrapped 做门控——WebView 重建后它必然为 false。
 */
export async function reconcileNativePlayback() {
  if (!isNativePlayerAvailable()) return
  const snap = await nativeGetState()
  if (snap.index < 0) return
  const st = usePlayerStore.getState()
  const updates: Partial<PlayerState> = { isPlaying: snap.isPlaying, progress: snap.position }
  if (snap.index !== st.currentIndex) {
    const track = st.queue[snap.index]
    if (track) {
      updates.currentIndex = snap.index
      updates.currentTrack = track
      updates.duration = 0
    }
  }
  if (snap.duration) updates.duration = snap.duration
  usePlayerStore.setState(updates)
  // 引擎活跃说明服务已在运行：补上引导标记，后续控制走原生路径
  nativeBootstrapped = true
  if (snap.isPlaying) startNativeTicker()
  else stopNativeTicker()
}

if (isNativePlayerAvailable()) {
  void onPlaybackEvent((ev) => {
    const state = usePlayerStore.getState()
    switch (ev.type) {
      case 'play': {
        // 补登播放统计（原生路径不经过 audio.service 的 onplay）；500ms 内去重
        const track = state.queue[state.currentIndex]
        const now = Date.now()
        if (track && now - lastStatsEmittedAt > 500) {
          lastStatsEmittedAt = now
          emitPlayStats(track)
        }
        usePlayerStore.setState({ isPlaying: true })
        startNativeTicker()
        break
      }
      case 'pause':
        usePlayerStore.setState({ isPlaying: false })
        if (typeof ev.position === 'number') {
          usePlayerStore.setState({ progress: ev.position })
        }
        break
      case 'prepared':
        if (typeof ev.duration === 'number') {
          usePlayerStore.setState({ duration: ev.duration })
        }
        break
      case 'indexChanged': {
        const idx = ev.index
        const track = typeof idx === 'number' ? state.queue[idx] : undefined
        if (track && idx !== state.currentIndex) {
          usePlayerStore.setState({
            currentIndex: idx!,
            currentTrack: track,
            progress: 0,
            duration: 0,
          })
        }
        break
      }
      case 'seeked':
        if (typeof ev.position === 'number') {
          usePlayerStore.setState({ progress: ev.position })
        }
        break
      case 'endedAll':
        stopNativeTicker()
        nativeBootstrapped = false
        usePlayerStore.setState({ isPlaying: false, progress: 0 })
        break
      case 'stopped':
        stopNativeTicker()
        usePlayerStore.setState({ isPlaying: false, progress: 0 })
        break
      case 'error': {
        // 与 Howler 错误路径一致：本地文件出错自动跳过；网络来源不自动跳
        const track = state.queue[state.currentIndex]
        if (!track) break
        if (isNetworkBackedTrack(track)) break
        if (state.queue.length <= 1) {
          state.clearQueue()
        } else {
          state.removeFromQueue(state.currentIndex)
        }
        break
      }
    }
  })
}
