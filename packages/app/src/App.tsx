import React, { useEffect, useCallback } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { TitleBar } from '@/components/layout/TitleBar'
import { Sidebar } from '@/components/layout/Sidebar'
import { PlayerBar } from '@/components/player/PlayerBar'
import { QueueView } from '@/components/player/QueueView'
import { LibraryPage } from '@/pages/LibraryPage'
import { LikedPage } from '@/pages/LikedPage'
import { RecentPage } from '@/pages/RecentPage'
import { SearchPage } from '@/pages/SearchPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { PlaylistPage } from '@/pages/PlaylistPage'
import { LyricsView } from '@/components/lyrics/LyricsView'
import { Visualizer } from '@/components/visualizer/Visualizer'
import { usePlayerStore } from '@/stores/playerStore'
import { useLibraryStore } from '@/stores/libraryStore'
import {
  initAudioAnalyser,
  stopPlayback,
  seekTo as audioSeekTo,
} from '@/services/audio.service'
import type { Track } from '@/types'

function AppLayout() {
  const playerState = usePlayerStore()
  const { theme, glassMode } = useLibraryStore()

  useEffect(() => {
    initAudioAnalyser()
    const api = (window as any).electronAPI
    if (api?.onTracksScanned) {
      api.onTracksScanned((scannedTracks: Track[]) => {
        useLibraryStore.getState().setTracks(scannedTracks)
        useLibraryStore.getState().setIsScanning(false)
      })
      api.onScanProgress((progress: { current: number; total: number; file: string }) => {
        useLibraryStore.getState().setScanProgress(progress)
        useLibraryStore.getState().setIsScanning(true)
      })
    }

    return () => {
      stopPlayback()
    }
  }, [])

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark')
    } else if (theme === 'light') {
      document.documentElement.classList.remove('dark')
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      document.documentElement.classList.toggle('dark', prefersDark)
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = (e: MediaQueryListEvent) => {
        document.documentElement.classList.toggle('dark', e.matches)
      }
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
  }, [theme])

  useEffect(() => {
    if (glassMode === 'flat') {
      document.documentElement.classList.add('glass-flat')
    } else {
      document.documentElement.classList.remove('glass-flat')
    }
  }, [glassMode])

  const handleTogglePlay = useCallback(() => {
    usePlayerStore.getState().togglePlay()
  }, [])

  const handleNext = useCallback(() => {
    usePlayerStore.getState().next()
  }, [])

  const handlePrevious = useCallback(() => {
    usePlayerStore.getState().previous()
  }, [])

  const handleSeek = useCallback((seconds: number) => {
    audioSeekTo(seconds)
  }, [])

  const handleVolumeChange = useCallback((v: number) => {
    usePlayerStore.getState().setVolume(v)
  }, [])

  const handleToggleMute = useCallback(() => {
    usePlayerStore.getState().toggleMute()
  }, [])

  const handleToggleShuffle = useCallback(() => {
    usePlayerStore.getState().toggleShuffle()
  }, [])

  const handleCycleRepeat = useCallback(() => {
    usePlayerStore.getState().cycleRepeat()
  }, [])

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden relative">
      <div className="absolute inset-0 bg-gradient-to-br from-purple-900/20 via-background to-pink-900/20 animate-bg-shift pointer-events-none" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.08),transparent_60%)] pointer-events-none" />

      <TitleBar />

      <div className="flex-1 flex overflow-hidden relative z-10">
        <Sidebar />

        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 overflow-y-auto scrollbar-thin p-0">
              <Routes>
                <Route path="/" element={<Navigate to="/library" replace />} />
                <Route path="/library" element={<LibraryPage />} />
                <Route path="/liked" element={<LikedPage />} />
                <Route path="/recent" element={<RecentPage />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/playlist/:id" element={<PlaylistPage />} />
              </Routes>
            </div>

            {playerState.currentTrack && (
              <div className="w-80 flex-shrink-0 p-4 hidden lg:flex flex-col">
                <div className="glass rounded-xl p-4 mb-4">
                  <div className="aspect-square rounded-lg overflow-hidden bg-gradient-to-br from-purple-500/20 to-pink-500/20 mb-3 flex items-center justify-center">
                    {playerState.currentTrack.coverPath ? (
                      <img
                        src={`file://${playerState.currentTrack.coverPath}`}
                        alt={playerState.currentTrack.title}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="text-4xl opacity-30">🎵</div>
                    )}
                  </div>
                  <p className="font-semibold truncate">{playerState.currentTrack.title}</p>
                  <p className="text-sm text-foreground/50 truncate">{playerState.currentTrack.artist}</p>
                </div>

                <div className="glass rounded-xl p-4 h-32 mb-4">
                  <Visualizer mode="bars" />
                </div>

                <div className="glass rounded-xl flex-1 overflow-hidden flex flex-col min-h-0">
                  <div className="px-4 pt-4 pb-2 text-xs font-semibold text-foreground/40 uppercase tracking-wider">
                    歌词
                  </div>
                  <div className="flex-1 min-h-0">
                    <LyricsView />
                  </div>
                </div>
              </div>
            )}
          </div>

          <QueueView />

          <PlayerBar
            currentTrack={playerState.currentTrack}
            isPlaying={playerState.isPlaying}
            progress={playerState.progress}
            duration={playerState.duration}
            volume={playerState.volume}
            muted={playerState.muted}
            repeatMode={playerState.repeatMode}
            shuffleMode={playerState.shuffleMode}
            onTogglePlay={handleTogglePlay}
            onNext={handleNext}
            onPrevious={handlePrevious}
            onSeek={handleSeek}
            onVolumeChange={handleVolumeChange}
            onToggleMute={handleToggleMute}
            onToggleShuffle={handleToggleShuffle}
            onCycleRepeat={handleCycleRepeat}
          />
        </main>
      </div>
    </div>
  )
}

export default function App() {
  return <AppLayout />
}
