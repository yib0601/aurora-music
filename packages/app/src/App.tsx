import React, { useEffect, useCallback, useState, useRef } from 'react'
import { Music, ShieldAlert } from 'lucide-react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { App as CapApp } from '@capacitor/app'
import { TitleBar } from '@/components/layout/TitleBar'
import { ResizeHandles } from '@/components/layout/ResizeHandle'
import { MobileNav } from '@/components/layout/MobileNav'
import { MobileNowPlaying } from '@/components/player/MobileNowPlaying'
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
import { SongDetailPage } from '@/pages/SongDetailPage'
import { LyricsView } from '@/components/lyrics/LyricsView'
import { usePlayerStore } from '@/stores/playerStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { initAudioAnalyser, stopPlayback } from '@/services/audio.service'
import { onMediaButtonEvent } from '@/services/mediaSession'
import { checkAllFilesAccess, openAllFilesAccessSettings } from '@/services/permission'
import { useThemeColor } from '@/hooks/useThemeColor'
import { platform, setFolderPickerHandler } from '@/services/platform'
import { MobileFolderPicker } from '@/components/MobileFolderPicker'
import { cn, isMobile } from '@/lib/utils'
import type { Track } from '@/types'

// 启动扫描守卫：StrictMode 开发模式下 effect 会双挂载，保证只触发一次扫描
let initialScanTriggered = false

/**
 * Apple Liquid Glass AppLayout
 * - 内容区保持纯净（白底/纸面/近黑瓷砖，靠颜色微差分隔）
 * - 浮层 chrome（TitleBar / Sidebar / PlayerBar / QueueView）使用 Liquid Glass 材质
 * - 根容器加 ambient-backdrop：渲染封面提取色的柔光斑，让玻璃有内容可折射
 * - 封面右侧栏作为产品展示瓷砖，封面图带唯一 product-shadow
 */
function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  // 移动端全屏 Now Playing 视图：由 PlayerBar 封面/标题点击触发
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false)
  const mobile = isMobile()
  // 歌曲详情页为沉浸式视图：隐藏左侧导航栏与右侧 Now Playing 瓷砖，避免与详情内容重叠
  const isSongDetail = location.pathname.startsWith('/song/')

  // 移动端文件夹选择器：在 App 层全局注册 handler，让 LibraryPage 与 SettingsPage
  // 的"导入音乐"按钮共用同一个 MobileFolderPicker（替代旧版每页各自注册的方案）
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const folderPickerResolve = React.useRef<((p: string | null) => void) | null>(null)

  React.useEffect(() => {
    if (!mobile) return
    setFolderPickerHandler(async () => {
      return new Promise<string | null>((resolve) => {
        folderPickerResolve.current = resolve
        setFolderPickerOpen(true)
      })
    })
    return () => {
      setFolderPickerHandler(null)
      folderPickerResolve.current = null
    }
  }, [mobile])

  // 移动端「所有文件访问」权限引导：Android 11+ 扫描 /sdcard 下音乐需要
  // MANAGE_EXTERNAL_STORAGE 特殊权限，必须由用户在系统设置中手动授予。
  // 已配置 scanFolders 但未授权时弹引导卡片，用户授权回 App 后自动重扫。
  const [needsAllFilesAccess, setNeedsAllFilesAccess] = useState(false)
  // ref 用于 resume 监听里拿到最新值，避免重复注册 listener
  const needsPermissionRef = useRef(false)
  useEffect(() => { needsPermissionRef.current = needsAllFilesAccess }, [needsAllFilesAccess])

  const triggerScanForConfiguredFolders = useCallback(() => {
    if (!platform.scanFolder) return
    const folders = useLibraryStore.getState().scanFolders
    for (const folder of folders) {
      platform.scanFolder(folder).catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (!mobile) return
    // 启动时检测：仅在已配置扫描目录但未授权时弹引导
    // （没配置目录的用户不需要打扰；已授权的也不打扰）
    checkAllFilesAccess().then((granted) => {
      if (!granted && useLibraryStore.getState().scanFolders.length > 0) {
        setNeedsAllFilesAccess(true)
      }
    }).catch(() => {})
  }, [mobile])

  useEffect(() => {
    if (!mobile) return
    // 监听 app resume：用户从系统设置授权后回到 App，重新检测；
    // 已授权则关闭引导卡片并触发扫描（让用户立即看到歌曲）
    let listener: { remove: () => void } | undefined
    let cancelled = false
    CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return
      checkAllFilesAccess().then((granted) => {
        if (cancelled) return
        if (granted && needsPermissionRef.current) {
          setNeedsAllFilesAccess(false)
          triggerScanForConfiguredFolders()
        }
      }).catch(() => {})
    }).then((l) => { if (!cancelled) listener = l })
    return () => {
      cancelled = true
      listener?.remove()
    }
  }, [mobile, triggerScanForConfiguredFolders])

  const handleOpenAllFilesAccessSettings = useCallback(() => {
    openAllFilesAccessSettings().catch(() => {})
  }, [])

  const handleFolderPickerClose = useCallback(() => {
    setFolderPickerOpen(false)
    if (folderPickerResolve.current) {
      folderPickerResolve.current(null)
      folderPickerResolve.current = null
    }
  }, [])

  const handleFolderSelected = useCallback((path: string) => {
    setFolderPickerOpen(false)
    if (folderPickerResolve.current) {
      folderPickerResolve.current(path)
      folderPickerResolve.current = null
    }
  }, [])

  // 路由切换时关闭移动端全屏 Now Playing（避免切到其他页时残留遮罩）
  useEffect(() => {
    setNowPlayingOpen(false)
  }, [location.pathname])
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

    // 恢复上次播放状态（不自动播放，仅恢复曲目和进度）
    // 延迟 500ms 等待 audioContext 初始化和 tracks 加载
    let restoreTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      usePlayerStore.getState().restorePlayback()
    }, 500)

    // 订阅平台事件，收集取消函数以便 effect 清理时移除，避免监听器泄漏/重复注册
    const unsubscribers: Array<() => void> = []
    if (platform.getAllTracks) {
      platform.getAllTracks().then((tracks: Track[]) => {
        useLibraryStore.getState().setTracks(tracks)
      })
    }
    if (platform.onTracksScanned) {
      unsubscribers.push(
        platform.onTracksScanned((scannedTracks: Track[]) => {
          useLibraryStore.getState().setTracks(scannedTracks)
        })
      )
    }
    // 渐进式刷新：每解析完一首立即追加到音乐库（addTracks 按 id 去重，重复扫描无副作用）
    if (platform.onTrackScanned) {
      unsubscribers.push(
        platform.onTrackScanned((track: Track) => {
          useLibraryStore.getState().addTracks([track])
        })
      )
    }
    // 扫描为静默后台任务：不订阅进度、不展示错误，失败仅记录日志
    if (platform.onScanError) {
      unsubscribers.push(
        platform.onScanError((error: { folder: string; message: string }) => {
          console.warn('[Scan] 后台扫描失败:', error.message)
        })
      )
    }

    // 监听系统媒体键（桌面端 globalShortcut/MPRIS，移动端 mediaSession）
    if (platform.onMediaControl) {
      unsubscribers.push(
        platform.onMediaControl((action: string) => {
          const playerState = usePlayerStore.getState()
          switch (action) {
            case 'toggle-play':
              playerState.togglePlay()
              break
            case 'next':
              playerState.next()
              break
            case 'previous':
              playerState.previous()
              break
            case 'stop':
              playerState.reset()
              break
          }
        })
      )
    }

    // 每次启动在后台静默重新扫描所有已配置的音乐目录
    // 用于同步移除已被删除的歌曲记录并纳入新增文件；扫描在后台执行不阻塞 UI、无任何提示，
    // 列表通过 onTracksScanned 事件自动刷新；平台已串行化扫描队列，失败仅记录日志
    if (platform.scanFolder && !initialScanTriggered) {
      initialScanTriggered = true
      const folders = useLibraryStore.getState().scanFolders
      for (const folder of folders) {
        platform.scanFolder(folder).catch(() => {})
      }
    }

    return () => {
      if (restoreTimer) {
        clearTimeout(restoreTimer)
        restoreTimer = null
      }
      for (const unsub of unsubscribers) unsub()
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

  // glassMode 兼容历史设置中的 'flat' 值
  useEffect(() => {
    document.documentElement.classList.remove('glass-flat')
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
    usePlayerStore.getState().seekTo(seconds)
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

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 忽略输入框中的按键
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      const playerState = usePlayerStore.getState()

      switch (e.code) {
        case 'Space':
          e.preventDefault()
          playerState.togglePlay()
          break
        case 'ArrowRight':
          if (e.shiftKey) {
            // Shift+→ 快进 10 秒
            e.preventDefault()
            playerState.seekTo(playerState.progress + 10)
          }
          break
        case 'ArrowLeft':
          if (e.shiftKey) {
            // Shift+← 快退 10 秒
            e.preventDefault()
            playerState.seekTo(Math.max(0, playerState.progress - 10))
          }
          break
        case 'ArrowUp':
          if (e.ctrlKey || e.metaKey) {
            // Ctrl/Cmd+↑ 音量 +
            e.preventDefault()
            playerState.setVolume(Math.min(1, playerState.volume + 0.1))
          }
          break
        case 'ArrowDown':
          if (e.ctrlKey || e.metaKey) {
            // Ctrl/Cmd+↓ 音量 -
            e.preventDefault()
            playerState.setVolume(Math.max(0, playerState.volume - 0.1))
          }
          break
        case 'KeyN':
          if (e.ctrlKey || e.metaKey) {
            // Ctrl/Cmd+N 下一首
            e.preventDefault()
            playerState.next()
          }
          break
        case 'KeyP':
          if (e.ctrlKey || e.metaKey) {
            // Ctrl/Cmd+P 上一首
            e.preventDefault()
            playerState.previous()
          }
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Media Session API - 让 OS 识别媒体键并显示播放信息
  useEffect(() => {
    if ('mediaSession' in navigator) {
      // 设置媒体操作处理器
      navigator.mediaSession.setActionHandler('play', () => {
        usePlayerStore.getState().play()
      })
      navigator.mediaSession.setActionHandler('pause', () => {
        usePlayerStore.getState().pause()
      })
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        usePlayerStore.getState().previous()
      })
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        usePlayerStore.getState().next()
      })
      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        const skipTime = details.seekOffset || 10
        const playerState = usePlayerStore.getState()
        playerState.seekTo(Math.max(0, playerState.progress - skipTime))
      })
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        const skipTime = details.seekOffset || 10
        const playerState = usePlayerStore.getState()
        playerState.seekTo(playerState.progress + skipTime)
      })
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined) {
          usePlayerStore.getState().seekTo(details.seekTime)
        }
      })
    }
  }, [])

  // 更新 Media Session 元数据（曲目信息）
  useEffect(() => {
    if ('mediaSession' in navigator && currentTrack) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title,
        artist: currentTrack.artist,
        album: currentTrack.album || 'Aurora Music',
        // MediaImage 只接受 http/https/data/blob，本地文件协议不被支持，故不设 artwork
      })
    }
  }, [currentTrack])

  // 移动端原生 MediaSession：监听通知栏/锁屏按钮事件
  // Honor/Huawei AudioHardening 要求 app 声明 foreground service 才会路由
  // STREAM_MUSIC 到扬声器；通知栏按钮事件通过 MediaSessionPlugin 转发到这里
  useEffect(() => {
    let unsub = () => {}
    onMediaButtonEvent((action) => {
      const player = usePlayerStore.getState()
      switch (action) {
        case 'play': player.play(); break
        case 'pause': player.pause(); break
        case 'next': player.next(); break
        case 'prev': player.previous(); break
        case 'stop': player.clearQueue(); break
        case 'seek': break // seek 需 position，已通过 navigator.mediaSession 处理
      }
    }).then((u) => { unsub = u })
    return () => unsub()
  }, [])

  // 更新 MPRIS 元数据（Linux 媒体键支持，桌面端专用）
  useEffect(() => {
    const api = (window as any).electronAPI
    if (api?.updateMprisMetadata) {
      const playerState = usePlayerStore.getState()
      api.updateMprisMetadata(currentTrack, playerState.isPlaying)
    }
  }, [currentTrack])

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden relative bg-background text-foreground ambient-backdrop">
      {/* Mineradio SVG 色差玻璃滤镜定义（隐藏，仅注入 DOM 让 url(#...) 引用生效） */}
      <GlassSvgFilter />

      <TitleBar />

      {/* 桌面端窗口缩放手柄；移动端不需要（组件内部 isDesktop 判断返回 null） */}
      <ResizeHandles />

      {/* 移动端顶部导航：左上角汉堡菜单 + 左侧抽屉（替代底部 BottomTabBar） */}
      {mobile && <MobileNav />}

      {/* 主区域：侧栏 + 内容 + 右侧封面瓷砖 */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* 桌面端侧栏 — Liquid Glass 材质，悬浮于 ambient-backdrop 之上；歌曲详情页隐藏 */}
        {/* 移动端导航改为顶部汉堡菜单 + 左侧抽屉（MobileNav），不再用底部 Tab 或固定侧栏 */}
        {!isSongDetail && !mobile && (
          <aside className="w-56 flex-shrink-0 flex flex-col glass-regular border-r border-white/5">
            <Sidebar />
          </aside>
        )}

        {/* 主内容区 */}
        <main className="relative flex-1 flex flex-col min-w-0 overflow-hidden bg-transparent">
          <div className="flex-1 flex overflow-hidden">
            {/* 内容列：页面路由 + 悬浮播放条（播放条相对内容列居中，避免压到右侧歌词瓷砖） */}
            <div className="relative flex-1 flex flex-col min-w-0">
              <div className="flex-1 overflow-y-auto scrollbar-thin">
                <Routes>
                  <Route path="/" element={<Navigate to="/library" replace />} />
                  <Route path="/library" element={<LibraryPage />} />
                  <Route path="/liked" element={<LikedPage />} />
                  <Route path="/recent" element={<RecentPage />} />
                  <Route path="/search" element={<SearchPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="/playlist/:id" element={<PlaylistPage />} />
                  <Route path="/song/:id" element={<SongDetailPage />} />
                </Routes>
              </div>

              {/* Mineradio 悬浮胶囊控制台 — 歌曲详情页已内嵌播放功能框，此处隐藏避免重复 */}
              {/* 移动端：贴屏幕底部（safe-area），宽度铺满屏宽 -16 */}
              {!isSongDetail && (
                <div
                  className={cn(
                    'absolute left-1/2 -translate-x-1/2 z-30',
                    mobile
                      ? 'bottom-[calc(10px+env(safe-area-inset-bottom))] w-[calc(100%-16px)]'
                      : 'bottom-3 w-[clamp(360px,calc(100%-48px),640px)]',
                  )}
                >
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
                    onOpenNowPlaying={() => setNowPlayingOpen(true)}
                  />
                </div>
              )}
            </div>

            {/* 右侧 Now Playing 瓷砖 — Liquid Glass 材质；歌曲详情页隐藏（详情页已含完整歌词与歌曲信息） */}
            {currentTrack && !isSongDetail && (
              <div className="w-72 flex-shrink-0 hidden lg:flex flex-col glass-regular border-l border-white/5">
                <div className="p-6 flex flex-col gap-4">
                  {/* 封面图 — 唯一使用 product-shadow 的地方，点击进入歌曲详情 */}
                  <button
                    onClick={() => navigate(`/song/${currentTrack.id}`)}
                    title="查看歌曲详情"
                    className="relative aspect-square rounded-[18px] bg-white/[0.04] flex items-center justify-center overflow-hidden w-full cursor-pointer transition-transform duration-200 ease-apple hover:scale-[1.02]"
                  >
                    {currentTrack.coverPath ? (
                      <img
                        src={platform.getCoverSrc(currentTrack.coverPath)}
                        alt={currentTrack.title}
                        className="w-full h-full object-cover product-shadow"
                      />
                    ) : (
                      <div className="text-4xl text-white/30">🎵</div>
                    )}
                  </button>

                  <div className="text-center">
                    <p className="font-display font-semibold truncate text-[17px] tracking-[-0.374px] text-white/96">
                      {currentTrack.title}
                    </p>
                    <p className="font-text text-[14px] text-white/50 truncate mt-1 tracking-[-0.224px]">
                      {currentTrack.artist}
                    </p>
                  </div>

                </div>

                <div className="flex-1 overflow-hidden flex flex-col min-h-0 px-4 pt-0 pb-6">
                  <div className="px-2 pt-2 pb-1.5">
                    <span className="font-text text-[11px] font-semibold text-white/40 uppercase tracking-wider">
                      歌词
                    </span>
                  </div>
                  <div className="flex-1 min-h-0">
                    <LyricsView onLineClick={(time) => usePlayerStore.getState().seekTo(time)} />
                  </div>
                </div>
              </div>
            )}
          </div>

          <QueueView />
        </main>
      </div>

      {/* 移动端全屏 Now Playing 视图 */}
      {mobile && (
        <MobileNowPlaying open={nowPlayingOpen} onClose={() => setNowPlayingOpen(false)} />
      )}

      {/* 移动端文件夹选择器：在 App 层全局渲染，LibraryPage 与 SettingsPage 共用 */}
      {mobile && (
        <MobileFolderPicker
          open={folderPickerOpen}
          onSelected={handleFolderSelected}
          onClose={handleFolderPickerClose}
        />
      )}

      {/* 移动端「所有文件访问」权限引导：已配置扫描目录但未授权时显示 */}
      {mobile && needsAllFilesAccess && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm px-6">
          <div className="w-full max-w-[340px] rounded-[20px] bg-[#0E1014] border border-white/10 p-6 flex flex-col items-center text-center shadow-[0_20px_60px_rgba(0,0,0,.5)]">
            <div className="w-14 h-14 rounded-full bg-mint/10 border border-mint/20 flex items-center justify-center mb-4">
              <ShieldAlert className="h-7 w-7 text-mint" strokeWidth={1.6} />
            </div>
            <h2 className="font-display text-[17px] font-bold text-white/96 tracking-[-0.3px]">
              需要文件访问权限
            </h2>
            <p className="font-text text-[13px] text-white/60 leading-relaxed mt-2 mb-6 tracking-[-0.15px]">
              为了扫描本地音乐文件，需要授予「所有文件访问」权限。点击下方按钮前往系统设置，授权后返回应用即可自动开始扫描。
            </p>
            <button
              onClick={handleOpenAllFilesAccessSettings}
              className="w-full h-11 rounded-full bg-mint text-[#030608] font-semibold text-[14px] active:scale-[0.98] transition"
            >
              前往设置
            </button>
            <button
              onClick={() => setNeedsAllFilesAccess(false)}
              className="w-full h-10 mt-2 text-white/50 text-[13px] hover:text-white/80 active:scale-[0.98] transition"
            >
              稍后再说
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function App() {
  return <AppLayout />
}
