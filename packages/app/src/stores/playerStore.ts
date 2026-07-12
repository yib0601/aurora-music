import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { RepeatMode, ShuffleMode, Track } from '@/types'
import {
  togglePlayPause,
  playQueue as audioPlayQueue,
  playTrack as audioPlayTrack,
  addToQueue as audioAddToQueue,
  playNextAdd as audioPlayNextAdd,
  setVolume as audioSetVolume,
  seekTo as audioSeekTo,
  setMuted as audioSetMuted,
} from '@/services/audio.service'

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
  togglePlay: () => void
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
        audioPlayTrack(track)
      },

      playQueue: (tracks, startIndex = 0) => {
        const newHistory =
          get().shuffleMode === 'on' && tracks[startIndex] ? [startIndex] : []
        set({ queue: tracks, currentIndex: startIndex, shuffleHistory: newHistory })
        audioPlayQueue(tracks, startIndex)
      },

      addToQueue: (track) => {
        audioAddToQueue(track)
      },

      addToPlayNext: (track) => {
        audioPlayNextAdd(track)
      },

      togglePlay: () => {
        if (!get().currentTrack) return
        togglePlayPause()
      },

      next: () => {
        const state = get()
        if (state.queue.length === 0) return

        if (state.repeatMode === 'one') {
          audioSeekTo(0)
          audioPlayTrack(state.currentTrack!)
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
          const newHistory = [...state.shuffleHistory, nextIndex]
          const nextTrack = state.queue[nextIndex]
          set({ currentIndex: nextIndex, shuffleHistory: newHistory })
          audioPlayTrack(nextTrack)
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
        audioPlayTrack(nextTrack)
      },

      previous: () => {
        const state = get()
        if (state.queue.length === 0) return

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
        audioPlayTrack(prevTrack)
      },

      seekTo: (seconds) => {
        audioSeekTo(seconds)
      },

      setVolume: (volume) => {
        set({ volume, muted: volume === 0 })
        audioSetVolume(volume)
        if (get().muted) audioSetMuted(volume === 0)
      },

      toggleMute: () => {
        const { muted, volume } = get()
        const newMuted = !muted
        set({ muted: newMuted })
        audioSetMuted(newMuted)
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
      },

      cycleRepeat: () => {
        const { repeatMode } = get()
        const modes: RepeatMode[] = ['off', 'all', 'one']
        const nextIdx = (modes.indexOf(repeatMode) + 1) % modes.length
        set({ repeatMode: modes[nextIdx] })
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
      },

      setCurrentIndex: (index) => {
        const { queue } = get()
        if (index >= 0 && index < queue.length) {
          set({ currentIndex: index, currentTrack: queue[index], progress: 0 })
        }
      },

      setIsPlaying: (playing) => set({ isPlaying: playing }),
      setProgress: (progress) => set({ progress }),
      setDuration: (duration) => set({ duration }),

      reset: () => {
        set(initialState)
      },
    }),
    {
      name: 'aurora-player-state',
      partialize: (state) => ({
        volume: state.volume,
        muted: state.muted,
        repeatMode: state.repeatMode,
        shuffleMode: state.shuffleMode,
      }),
    }
  )
)
