import React, { useEffect, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
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
import { useThemeColor } from '@/hooks/useThemeColor'
import type { Track } from '@/types'

function AppLayout() {
  const { currentTrack, isPlaying, progress, duration, volume, muted, repeatMode, shuffleMode } =
    usePlayerStore(useShallow((s) => ({
      currentTrack: s.currentTrack,
      isPlaying: s.isPlaying,
      progress: s.progress,
      duration: s.duration,
      volume: s.volume,
      muted: s.muted,
      repeatMode: s.repeatMode,
      shuffleMode: s.shuffleMode,
    })))
  const theme = useLibraryStore((s) => s.theme)
  const glassMode = useLibraryStore((s) => s.glassMode)

  useThemeColor(currentTrack?.coverPath)

  useEffect(() => {
    initAudioAnalyser()
    const api = (window as any).electronAPI
    if (api?.getAllTracks) {
      api.getAllTracks().then((tracks: Track[]) => {
        useLibraryStore.getState().setTracks(tracks)
      })
    }
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
    const scanFolders = useLibraryStore.getState().scanFolders
    if (api?.scanFolder && scanFolders.length > 0) {
      scanFolders.forEach((folder) => api.scanFolder(folder))
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
    <div className="h-screen w-screen flex flex-col overflow-hidden relative" style={{ background: 'transparent' }}>
      {/* 桌面壁纸透射基底：更透明，让壁纸/背景色透出来 */}
      <div className="absolute inset-0 pointer-events-none dark:bg-[rgba(6,8,16,0.28)] bg-[rgba(250,251,254,0.32)]" />

      {/* 网格极光背景 */}
      <div className="mesh-bg" />

      {/* 流动光斑 */}
      <div className="aurora-bg">
        <div className="aurora-blob aurora-blob-1" />
        <div className="aurora-blob aurora-blob-2" />
        <div className="aurora-blob aurora-blob-3" />
      </div>

      {/* 封面主题光晕 */}
      <div className="absolute inset-0 pointer-events-none" style={{
        background: currentTrack?.coverPath
          ? 'radial-gradient(ellipse 80% 55% at 50% -20%, var(--accent-from-color, rgba(59,130,246,0.16)), transparent 72%)'
          : 'radial-gradient(ellipse_at_top,hsl(var(--primary)/0.06),transparent_55%)',
        transition: 'background 0.8s ease',
      }} />

      {/* 噪点纹理 */}
      <div className="noise-overlay" />

      <TitleBar />

      <div className="flex-1 flex overflow-hidden relative z-10 gap-2 p-2 pt-0">
        <aside className="w-56 flex-shrink-0 flex flex-col p-2 gap-2 glass-panel glass-sheen">
          <Sidebar />
        </aside>

        <main className="flex-1 flex flex-col min-w-0 overflow-hidden rounded-2xl glass glass-sheen">
          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 overflow-y-auto scrollbar-thin p-6">
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

            {currentTrack && (
              <div className="w-80 flex-shrink-0 p-5 hidden lg:flex flex-col gap-4 border-l border-border/30">
                <div className="rounded-2xl overflow-hidden glass-card aspect-square flex items-center justify-center shadow-lg shadow-black/5">
                  {currentTrack.coverPath ? (
                    <img
                      src={`file://${currentTrack.coverPath}`}
                      alt={currentTrack.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="text-4xl opacity-30">🎵</div>
                  )}
                </div>

                <div className="text-center px-1">
                  <p className="font-semibold truncate text-lg">{currentTrack.title}</p>
                  <p className="text-sm text-foreground/50 truncate">{currentTrack.artist}</p>
                </div>

                <div className="rounded-2xl glass-card h-28 p-3 overflow-hidden">
                  <Visualizer mode="bars" />
                </div>

                <div className="flex-1 overflow-hidden flex flex-col min-h-0 rounded-2xl glass-card">
                  <div className="px-4 pt-4 pb-2 text-xs font-medium text-foreground/40 uppercase tracking-wider">
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

          <div className="px-5 pb-4 pt-2">
            <PlayerBar
              currentTrack={currentTrack}
              isPlaying={isPlaying}
              progress={progress}
              duration={duration}
              volume={volume}
              muted={muted}
              repeatMode={repeatMode}
              shuffleMode={shuffleMode}
              onTogglePlay={handleTogglePlay}
              onNext={handleNext}
              onPrevious={handlePrevious}
              onSeek={handleSeek}
              onVolumeChange={handleVolumeChange}
              onToggleMute={handleToggleMute}
              onToggleShuffle={handleToggleShuffle}
              onCycleRepeat={handleCycleRepeat}
            />
          </div>
        </main>
      </div>
    </div>
  )
}

export default function App() {
  return <AppLayout />
}
