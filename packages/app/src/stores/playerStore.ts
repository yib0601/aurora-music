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

  playTrack: (track: Track) => void
  playQueue: (tracks: Track[], startIndex?: number) => void
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
}

/** 持久化前剥离已过期的在线播放地址，保留曲目元信息 */
function stripOnlineUrl(track: Track | null): Track | null {
  if (!track || !track.onlineUrl) return track
  const { onlineUrl: _url, ...rest } = track
  return rest as Track
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

      playTrack: (track) => {
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
        set({ queue: newQueue, currentIndex: index, shuffleHistory: newHistory })
        if (useNative()) {
          set({ currentTrack: track, progress: 0 })
          nativeBootstrapPlay(0, true)
          return
        }
        audioPlayTrack(track, state.volume, state.muted)
      },

      playQueue: (tracks, startIndex = 0) => {
        // 空队列或索引越界时直接返回，避免 audioPlayTrack(undefined) 崩溃
        if (!tracks || tracks.length === 0) return
        const idx = Math.max(0, Math.min(startIndex, tracks.length - 1))
        const newHistory =
          get().shuffleMode === 'on' && tracks[idx] ? [idx] : []
        set({ queue: tracks, currentIndex: idx, shuffleHistory: newHistory })
        if (useNative()) {
          set({ currentTrack: tracks[idx], progress: 0 })
          nativeBootstrapPlay(0, true)
          return
        }
        audioPlayTrack(tracks[idx], get().volume, get().muted)
      },

      addToQueue: (track) => {
        const newQueue = [...get().queue, track]
        set({ queue: newQueue })
        syncNativeMirror()
      },

      addToPlayNext: (track) => {
        const { queue, currentIndex } = get()
        const insertAt = currentIndex < 0 ? 0 : currentIndex + 1
        set({ queue: [...queue.slice(0, insertAt), track, ...queue.slice(insertAt)] })
        syncNativeMirror()
      },

      removeFromQueue: (index) => {
        const { queue, currentIndex } = get()
        if (index < 0 || index >= queue.length) return
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
        set({ queue: newQueue, currentIndex: newCurrentIndex })
        syncNativeMirror()
      },

      clearQueue: () => {
        if (useNative()) {
          nativeStopEngine()
          stopNativeService()
          stopNativeTicker()
          nativeBootstrapped = false
          set({ queue: [], currentIndex: -1, currentTrack: null, isPlaying: false, progress: 0 })
          return
        }
        audioStopPlayback()
        set({ queue: [], currentIndex: -1, currentTrack: null, isPlaying: false, progress: 0 })
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
          if (state.isPlaying) nativePause()
          else nativeResume()
          return
        }
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
          audioPlayTrack(state.currentTrack!, state.volume, state.muted)
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
          audioPlayTrack(nextTrack, state.volume, state.muted)
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
        audioPlayTrack(nextTrack, state.volume, state.muted)
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
        audioPlayTrack(prevTrack, state.volume, state.muted)
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
        // 在线曲目的播放地址已在持久化时剥离（地址会过期），无有效来源则跳过恢复，
        // 避免用空地址创建 Howl 导致加载报错
        const src = state.currentTrack.onlineUrl || state.currentTrack.path
        if (!src) return
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
        // 在线播放地址（onlineUrl）有效期通常只有几十分钟，持久化后恢复必然失效；
        // 剥离后恢复播放时由 audio.service 走错误跳过逻辑，避免用过期 URL 卡死
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
  usePlayerStore.setState({ currentTrack: track, duration: 0, progress: 0 })
})

// 本地文件加载失败（文件被删除/移动/损坏）时自动跳过，避免播放卡住；在线流网络错误不自动跳
audioEvents.on('error', () => {
  const state = usePlayerStore.getState()
  const { currentTrack, queue, currentIndex } = state
  if (!currentTrack) return
  if (currentTrack.onlineUrl || /^https?:\/\//i.test(currentTrack.path)) return
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
        // 与 Howler 错误路径一致：本地文件出错自动跳过；在线流不自动跳
        const track = state.queue[state.currentIndex]
        if (!track) break
        if (track.onlineUrl || /^https?:\/\//i.test(track.path)) break
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
