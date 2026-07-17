import React, { useEffect, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Routes, Route, Navigate } from 'react-router-dom'
import { TitleBar } from '@/components/layout/TitleBar'
import { ResizeHandles } from '@/components/layout/ResizeHandle'
import { Sidebar } from '@/components/layout/Sidebar'
import { PlayerBar } from '@/components/player/PlayerBar'
import { QueueView } from '@/components/player/QueueView'
import { GlassSvgFilter } from '@/components/common/GlassSvgFilter'
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

/**
 * Apple Liquid Glass AppLayout
 * - 内容区保持纯净（白底/纸面/近黑瓷砖，靠颜色微差分隔）
 * - 浮层 chrome（TitleBar / Sidebar / PlayerBar / QueueView）使用 Liquid Glass 材质
 * - 根容器加 ambient-backdrop：渲染封面提取色的柔光斑，让玻璃有内容可折射
 * - 封面右侧栏作为产品展示瓷砖，封面图带唯一 product-shadow
 */
function AppLayout() {
  // ⚠️ 性能关键：只订阅低频变化字段，避免 progress 每 250ms 触发整树重渲染
  // progress / duration / isPlaying 等高频字段由 PlayerBar / LyricsView 自行订阅
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const volume = usePlayerStore((s) => s.volume)
  const muted = usePlayerStore((s) => s.muted)
  const repeatMode = usePlayerStore((s) => s.repeatMode)
  const shuffleMode = usePlayerStore((s) => s.shuffleMode)
  const theme = useLibraryStore((s) => s.theme)
  const glassMode = useLibraryStore((s) => s.glassMode)

  // 保留 themeColor hook 以维持封面色提取功能（用于 lyrics 渐变等非装饰场景）
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

  // glassMode 'flat' 在新设计下是默认行为；保留 'auto'/'forced' 兼容历史设置
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
    <div className="h-screen w-screen flex flex-col overflow-hidden relative bg-background text-foreground ambient-backdrop">
      {/* Mineradio SVG 色差玻璃滤镜定义（隐藏，仅注入 DOM 让 url(#...) 引用生效） */}
      <GlassSvgFilter />

      <TitleBar />

      <ResizeHandles />

      {/* 主区域：侧栏 + 内容 + 右侧封面瓷砖 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 侧栏 — Liquid Glass 材质，悬浮于 ambient-backdrop 之上 */}
        <aside className="w-56 flex-shrink-0 flex flex-col glass-regular border-r border-white/5">
          <Sidebar />
        </aside>

        {/* 主内容区 */}
        <main className="relative flex-1 flex flex-col min-w-0 overflow-hidden bg-transparent">
          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 overflow-y-auto scrollbar-thin">
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

            {/* 右侧 Now Playing 瓷砖 — Liquid Glass 材质 */}
            {currentTrack && (
              <div className="w-72 flex-shrink-0 hidden lg:flex flex-col glass-regular border-l border-white/5">
                <div className="p-6 flex flex-col gap-4">
                  {/* 封面图 — 唯一使用 product-shadow 的地方 */}
                  <div className="aspect-square rounded-[18px] bg-white/[0.04] flex items-center justify-center overflow-hidden">
                    {currentTrack.coverPath ? (
                      <img
                        src={`file://${currentTrack.coverPath}`}
                        alt={currentTrack.title}
                        className="w-full h-full object-cover product-shadow"
                      />
                    ) : (
                      <div className="text-4xl text-white/30">🎵</div>
                    )}
                  </div>

                  <div className="text-center">
                    <p className="font-display font-semibold truncate text-[17px] tracking-[-0.374px] text-white/96">
                      {currentTrack.title}
                    </p>
                    <p className="font-text text-[14px] text-white/50 truncate mt-1 tracking-[-0.224px]">
                      {currentTrack.artist}
                    </p>
                  </div>

                  <div className="bg-white/[0.04] rounded-[12px] h-20 p-2 overflow-hidden">
                    <Visualizer mode="bars" />
                  </div>
                </div>

                <div className="flex-1 overflow-hidden flex flex-col min-h-0 px-4 pb-4">
                  <div className="px-2 pt-2 pb-1.5">
                    <span className="font-text text-[11px] font-semibold text-white/40 uppercase tracking-wider">
                      歌词
                    </span>
                  </div>
                  <div className="flex-1 min-h-0">
                    <LyricsView />
                  </div>
                </div>
              </div>
            )}
          </div>

          <QueueView />

          {/* Mineradio 悬浮胶囊控制台 — 跟随主内容区宽度动态调整 */}
          {currentTrack && (
            <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 z-30 w-[clamp(360px,calc(100%-80px),640px)]">
              <PlayerBar
                currentTrack={currentTrack}
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
          )}
        </main>
      </div>
    </div>
  )
}

export default function App() {
  return <AppLayout />
}
