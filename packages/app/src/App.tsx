import React, { useEffect, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Routes, Route, Navigate } from 'react-router-dom'
import { TitleBar } from '@/components/layout/TitleBar'
import { ResizeHandles } from '@/components/layout/ResizeHandle'
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

  const handleCyclePlayMode = useCallback(() => {
    usePlayerStore.getState().cyclePlayMode()
  }, [])

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden relative" style={{ background: 'transparent' }}>
      {/* 背景层 - 深邃渐变 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `
            radial-gradient(ellipse 120% 100% at 0% 0%, rgba(30, 50, 110, 0.10), transparent 55%),
            radial-gradient(ellipse 100% 80% at 100% 100%, rgba(50, 35, 100, 0.08), transparent 55%),
            radial-gradient(ellipse 80% 60% at 50% 50%, rgba(20, 60, 120, 0.04), transparent 45%),
            linear-gradient(160deg, #0a0b10 0%, #0c0d14 30%, #0b0c12 60%, #090a0f 100%)
          `,
        }}
      />

      {/* 动态光晕层 - 封面主题色 */}
      <div className="absolute inset-0 pointer-events-none transition-opacity duration-1500 ease-out" style={{
        opacity: currentTrack?.coverPath ? 0.7 : 0,
        background: currentTrack?.coverPath
          ? 'radial-gradient(ellipse 70% 50% at 50% 25%, var(--accent-from-color, rgba(40,90,180,0.06)), transparent 65%)'
          : 'none',
      }} />

      {/* 微光效果层 - 顶部柔光 */}
      <div className="absolute inset-0 pointer-events-none" style={{
        background: 'radial-gradient(ellipse 80% 40% at 50% 0%, rgba(255,255,255,0.012), transparent 60%)',
      }} />

      {/* 噪点纹理层 */}
      <div className="absolute inset-0 pointer-events-none" style={{
        opacity: 0.012,
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        backgroundSize: '128px 128px',
      }} />

      <TitleBar />

      <ResizeHandles />

      <div className="flex-1 flex overflow-hidden relative z-10 gap-2.5 p-2.5 pt-0">
        <aside className="w-56 flex-shrink-0 flex flex-col p-2.5 gap-2.5 glass-panel">
          <Sidebar />
        </aside>

        <main className="flex-1 flex flex-col min-w-0 overflow-hidden rounded-[16px] glass">
          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 overflow-y-auto scrollbar-thin p-5">
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
              <div className="w-72 flex-shrink-0 p-4 hidden lg:flex flex-col gap-3.5 border-l border-border/10">
                <div className="rounded-[14px] overflow-hidden glass-card aspect-square flex items-center justify-center">
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
                  <p className="font-semibold truncate text-[15px]">{currentTrack.title}</p>
                  <p className="text-[12px] text-foreground/40 truncate mt-0.5">{currentTrack.artist}</p>
                </div>

                <div className="rounded-[14px] glass-card h-24 p-2.5 overflow-hidden">
                  <Visualizer mode="bars" />
                </div>

                <div className="flex-1 overflow-hidden flex flex-col min-h-0 rounded-[14px] glass-card">
                  <div className="px-3.5 pt-3 pb-1.5 text-[10px] font-medium text-foreground/35 uppercase tracking-wider">
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

          <div className="px-4 pb-3 pt-1.5">
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
              onCyclePlayMode={handleCyclePlayMode}
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
