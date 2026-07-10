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
  shuffleMode: 'off' as ShuffleMode,
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
      ...initialState,

      playTrack: (track) => {
        const state = get()
        const index = state.queue.findIndex((t) => t.id === track.id)
        if (index >= 0) {
          set({ currentIndex: index })
        } else {
          set({ queue: [...state.queue, track], currentIndex: state.queue.length })
        }
        audioPlayTrack(track)
      },

      playQueue: (tracks, startIndex = 0) => {
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
          nextIndex = Math.floor(Math.random() * state.queue.length)
        } else {
          nextIndex = state.currentIndex + 1
          if (nextIndex >= state.queue.length) {
            if (state.repeatMode === 'all') {
              nextIndex = 0
            } else {
              set({ isPlaying: false, progress: 0 })
              return
            }
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

        let prevIndex = state.currentIndex - 1
        if (prevIndex < 0) prevIndex = state.queue.length - 1

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
        const { shuffleMode } = get()
        set({ shuffleMode: shuffleMode === 'off' ? 'on' : 'off' })
      },

      cycleRepeat: () => {
        const { repeatMode } = get()
        const modes: RepeatMode[] = ['off', 'all', 'one']
        const nextIdx = (modes.indexOf(repeatMode) + 1) % modes.length
        set({ repeatMode: modes[nextIdx] })
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
