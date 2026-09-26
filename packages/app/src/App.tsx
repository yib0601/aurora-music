import React, { useEffect, useCallback, useState, useRef } from 'react'
import { Music, ShieldAlert } from 'lucide-react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { App as CapApp } from '@capacitor/app'
import { TitleBar, hasDesktopTitleBar } from '@/components/layout/TitleBar'
import { ResizeHandles } from '@/components/layout/ResizeHandle'
import { MobileNav } from '@/components/layout/MobileNav'
import { MobileNowPlaying } from '@/components/player/MobileNowPlaying'
import { Sidebar } from '@/components/layout/Sidebar'
import { PlayerBar } from '@/components/player/PlayerBar'
import { QueueView } from '@/components/player/QueueView'
import { GlassSvgFilter } from '@/components/common/GlassSvgFilter'
import { ToastHost, toast, dismissToast } from '@/components/common/Toast'
import { LibraryPage } from '@/pages/LibraryPage'
import { LikedPage } from '@/pages/LikedPage'
import { RecentPage } from '@/pages/RecentPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { PlaylistPage } from '@/pages/PlaylistPage'
import { SongDetailPage } from '@/pages/SongDetailPage'
import { LyricsView } from '@/components/lyrics/LyricsView'
import { usePlayerStore, reconcileNativePlayback } from '@/stores/playerStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { initAudioAnalyser, stopPlayback } from '@/services/audio.service'
import { isNativePlayerAvailable, nativeUpdateArtwork } from '@/services/mediaSession'
import {
  checkMediaPermissions,
  requestMediaPermissions,
  openAllFilesAccessSettings,
} from '@/services/permission'
import { useThemeColor } from '@/hooks/useThemeColor'
import { platform, setFolderPickerHandler } from '@/services/platform'
import { CoverImage } from '@/components/common/CoverImage'
import { MobileFolderPicker } from '@/components/MobileFolderPicker'
import { UpdateBanner } from '@/components/UpdateBanner'
import { SearchOverlay } from '@/components/SearchOverlay'
import { useUIStore } from '@/stores/uiStore'
import { UpdateDownloadDialog } from '@/components/UpdateDownloadDialog'
import {
  checkForUpdate,
  shouldShowStartupBanner,
  markStartupBannerShown,
  type UpdateInfo,
} from '@/services/update.service'
import { cn, isMobile, isDesktop } from '@/lib/utils'
import type { Track, FolderPickerOptions } from '@/types'

// 启动扫描守卫：StrictMode 开发模式下 effect 会双挂载，保证只触发一次扫描
let initialScanTriggered = false

// 扫描增量入库的批量阈值：攒满 SCAN_BATCH_SIZE 首、或距首次入队超过 SCAN_FLUSH_MS 毫秒，
// 才写一次 store。逐首写入意味着「N 首歌 = N 次整表重渲染」，是歌曲多时卡顿的主因。
const SCAN_BATCH_SIZE = 80
const SCAN_FLUSH_MS = 300
let pendingScanned: Track[] = []
let scanFlushTimer: ReturnType<typeof setTimeout> | null = null

/** 把攒下的扫描结果一次性写入音乐库（addTracks 按 id 去重，重复扫描无副作用） */
function flushScannedTracks() {
  if (scanFlushTimer) {
    clearTimeout(scanFlushTimer)
    scanFlushTimer = null
  }
  if (pendingScanned.length === 0) return
  const batch = pendingScanned
  pendingScanned = []
  useLibraryStore.getState().addTracks(batch)
}

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
  // 移动端全屏 Now Playing 视图：开关放全局 store，播放条与歌曲封面点击共用同一入口
  const nowPlayingOpen = usePlaylistStore((s) => s.mobileNowPlayingOpen)
  const setMobileNowPlaying = usePlaylistStore((s) => s.setMobileNowPlaying)
  const mobile = isMobile()
  const desktop = isDesktop()
  // 桌面外壳标题栏是否真的会渲染（与 TitleBar 内部判定同源）：
  // 内容列的 pt-11 留白必须跟着它走，否则没有标题栏时会凭空多出 44px 空白
  const hasTitleBar = hasDesktopTitleBar()
  // 歌曲详情页为沉浸式视图：隐藏左侧导航栏与右侧 Now Playing 瓷砖，避免与详情内容重叠
  const isSongDetail = location.pathname.startsWith('/song/')

  // 全局搜索浮层：入口按钮在各页头部工具栏原位置（标题右侧），App 层只负责
  // 统一渲染浮层与 ⌘/Ctrl+K 快捷键（设置页除外），保证任意页面唤起都可见
  const searchOpen = useUIStore((s) => s.searchOpen)
  const setSearchOpen = useUIStore((s) => s.setSearchOpen)
  const isSettings = location.pathname.startsWith('/settings')
  const isSettingsRef = useRef(isSettings)
  useEffect(() => { isSettingsRef.current = isSettings }, [isSettings])
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k') return
      if (isSettingsRef.current) return
      e.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSearchOpen])

  // 沉浸背景延迟挂载开关：进入详情页时先让侧栏/瓷砖折叠动画跑完（300ms）再渲染
  // 全屏模糊背景，避免软件渲染下动画期间每帧重算全屏模糊导致掉帧
  const [backdropReady, setBackdropReady] = useState(false)
  useEffect(() => {
    if (!isSongDetail) {
      setBackdropReady(false)
      return
    }
    const t = setTimeout(() => setBackdropReady(true), 320)
    return () => clearTimeout(t)
  }, [isSongDetail])

  // 进出详情页过渡期玻璃降级：侧栏/瓷砖宽度折叠动画（300ms）期间，
  // 玻璃模糊区域尺寸每帧变化，软件渲染下每帧重算模糊导致全屏进出场卡顿。
  // 过渡开始即挂 .glass-perf-lite 临时关闭所有玻璃 backdrop-filter，
  // 动画结束后恢复，静态视觉几乎无差异（背景色仍在，仅模糊消失 300ms）
  useEffect(() => {
    document.documentElement.classList.add('glass-perf-lite')
    const t = setTimeout(() => {
      document.documentElement.classList.remove('glass-perf-lite')
    }, 400)
    return () => {
      clearTimeout(t)
      document.documentElement.classList.remove('glass-perf-lite')
    }
  }, [isSongDetail])

  // 移动端文件夹选择器：在 App 层全局注册 handler，让 LibraryPage 与 SettingsPage
  // 的"导入音乐"/"选择下载目录"共用同一个 MobileFolderPicker（替代旧版每页各自注册的方案）
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  // 选择器文案随用途变化（扫描目录 / 下载目录），由调用方通过 pickFolder(options) 下传
  const [folderPickerText, setFolderPickerText] = useState<FolderPickerOptions | null>(null)
  const folderPickerResolve = React.useRef<((p: string | null) => void) | null>(null)

  React.useEffect(() => {
    if (!mobile) return
    setFolderPickerHandler(async (options) => {
      return new Promise<string | null>((resolve) => {
        folderPickerResolve.current = resolve
        setFolderPickerText(options ?? null)
        setFolderPickerOpen(true)
      })
    })
    return () => {
      setFolderPickerHandler(null)
      folderPickerResolve.current = null
    }
  }, [mobile])

  // 移动端存储权限引导：扫描本地音乐需要存储权限（运行时「音乐和音频」权限
  // 或「所有文件访问」特殊权限）。未授权时弹引导卡片，授权回 App 后自动重扫。
  const [needsStoragePermission, setNeedsStoragePermission] = useState(false)
  // ref 用于 resume 监听里拿到最新值，避免重复注册 listener
  const needsPermissionRef = useRef(false)
  useEffect(() => { needsPermissionRef.current = needsStoragePermission }, [needsStoragePermission])

  const triggerScanForConfiguredFolders = useCallback(() => {
    if (!platform.scanFolder) return
    const folders = useLibraryStore.getState().scanFolders
    for (const folder of folders) {
      platform.scanFolder(folder).catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (!mobile) return
    // 监听 app resume：用户从系统设置授权后回到 App，重新检测；
    // 已授权则关闭引导卡片并触发扫描（让用户立即看到歌曲）
    let listener: { remove: () => void } | undefined
    let cancelled = false
    CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return
      // 回到前台时与原生播放引擎对账：锁屏/后台期间 WebView 被冻结，
      // 锁屏控件触发的切歌/暂停等变化无法通过事件送达 JS，需主动拉取快照同步 UI
      reconcileNativePlayback().catch(() => {})
      checkMediaPermissions().then((granted) => {
        if (cancelled) return
        if (granted && needsPermissionRef.current) {
          setNeedsStoragePermission(false)
          triggerScanForConfiguredFolders()
        }
      }).catch(() => {})
    }).then((l) => { if (!cancelled) listener = l })
    return () => {
      cancelled = true
      listener?.remove()
    }
  }, [mobile, triggerScanForConfiguredFolders])

  // 系统返回键：分层消费——先关已打开的浮层（Now Playing / 文件夹选择器 /
  // 权限弹窗 / 导航抽屉 / 搜索浮层），再退回上一屏路由；已在主屏（音乐库）时
  // 提示再按一次退出，不直接杀进程。各浮层/抽屉开关经 ref 读取，保证监听只
  // 注册一次、回调内永远拿到最新状态。
  const searchOpenRef = useRef(searchOpen)
  useEffect(() => { searchOpenRef.current = searchOpen }, [searchOpen])
  const nowPlayingOpenRef = useRef(nowPlayingOpen)
  useEffect(() => { nowPlayingOpenRef.current = nowPlayingOpen }, [nowPlayingOpen])
  const folderPickerOpenRef = useRef(folderPickerOpen)
  useEffect(() => { folderPickerOpenRef.current = folderPickerOpen }, [folderPickerOpen])
  const locationRef = useRef(location)
  useEffect(() => { locationRef.current = location }, [location])
  const exitConfirmToastRef = useRef<number | null>(null)
  // 「再按一次退出」确认窗口计时器；提为 ref 以便路由切换时从外部撤销待确认状态
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!mobile) return
    let listener: { remove: () => void } | undefined
    let cancelled = false
    CapApp.addListener('backButton', () => {
      const setSearchOpen = useUIStore.getState().setSearchOpen
      const { mobileDrawerOpen, setMobileDrawerOpen } = useUIStore.getState()
      const playlistState = usePlaylistStore.getState()

      // ① 全屏 Now Playing 浮层：关闭即返回
      if (nowPlayingOpenRef.current) {
        playlistState.setMobileNowPlaying(false)
        return
      }
      // ①.5 播放队列浮层：收起浮层
      if (playlistState.showQueuePanel) {
        playlistState.setQueuePanel(false)
        return
      }
      // ② 文件夹选择器：视为取消选择（resolve(null)），调用方按取消处理
      if (folderPickerOpenRef.current) {
        setFolderPickerOpen(false)
        if (folderPickerResolve.current) {
          folderPickerResolve.current(null)
          folderPickerResolve.current = null
        }
        return
      }
      // ③ 存储权限引导弹窗：点返回等同「稍后再说」，不退出
      if (needsPermissionRef.current) {
        setNeedsStoragePermission(false)
        return
      }
      // ④ 导航抽屉：收起抽屉
      if (mobileDrawerOpen) {
        setMobileDrawerOpen(false)
        return
      }
      // ⑤ 全局搜索浮层
      if (searchOpenRef.current) {
        setSearchOpen(false)
        return
      }

      // ⑥ 路由返回：详情页/歌单页与屏内返回按钮行为一致（回上一页）；
      //    其他非主屏页回主屏；已在主屏（音乐库）则进入「再按一次退出」确认流程
      const path = locationRef.current.pathname
      if (path.startsWith('/song/') || path.startsWith('/playlist/')) {
        // 应用内无历史可退（如冷启动直达详情页）时兜底回主屏
        if (window.history.length > 1) navigate(-1)
        else navigate('/library')
        return
      }
      if (path !== '/library') {
        navigate('/library')
        return
      }
      // 主屏：二次确认退出，避免误触直接杀进程
      if (exitTimerRef.current) {
        // 待确认窗口内第二次按下：真正退出
        clearTimeout(exitTimerRef.current)
        exitTimerRef.current = null
        if (exitConfirmToastRef.current !== null) {
          dismissToast(exitConfirmToastRef.current)
          exitConfirmToastRef.current = null
        }
        CapApp.exitApp()
        return
      }
      exitConfirmToastRef.current = toast('再按一次返回键退出', { duration: 2000 })
      exitTimerRef.current = setTimeout(() => {
        exitTimerRef.current = null
        if (exitConfirmToastRef.current !== null) {
          dismissToast(exitConfirmToastRef.current)
          exitConfirmToastRef.current = null
        }
      }, 2000)
    }).then((l) => {
      if (cancelled) l.remove()
      else listener = l
    })
    return () => {
      cancelled = true
      listener?.remove()
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current)
        exitTimerRef.current = null
      }
      if (exitConfirmToastRef.current !== null) {
        dismissToast(exitConfirmToastRef.current)
        exitConfirmToastRef.current = null
      }
    }
  }, [mobile, navigate, setSearchOpen])

  // 授予权限：先尝试系统弹窗申请「音乐和音频」权限（一键）；
  // 若系统不再弹窗（永久拒绝）则跳转应用设置页，由用户手动开启
  const handleGrantStoragePermission = useCallback(() => {
    requestMediaPermissions().then((granted) => {
      if (granted) {
        setNeedsStoragePermission(false)
        triggerScanForConfiguredFolders()
      } else {
        openAllFilesAccessSettings().catch(() => {})
      }
    }).catch(() => {
      openAllFilesAccessSettings().catch(() => {})
    })
  }, [triggerScanForConfiguredFolders])

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

  // 路由切换时关闭移动端全屏 Now Playing（避免切到其他页时残留遮罩）；
  // 同时撤销「再按一次返回退出」的待确认状态，避免提示残留期间再次按返回时误退出
  useEffect(() => {
    usePlaylistStore.getState().setMobileNowPlaying(false)
    if (exitConfirmToastRef.current !== null) {
      dismissToast(exitConfirmToastRef.current)
      exitConfirmToastRef.current = null
    }
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current)
      exitTimerRef.current = null
    }
  }, [location.pathname])
  // ⚠️ 性能关键：只订阅低频变化字段，避免 progress 每 250ms 触发整树重渲染
  // progress / duration / isPlaying 等高频字段由 PlayerBar / LyricsView 自行订阅
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const volume = usePlayerStore((s) => s.volume)
  const muted = usePlayerStore((s) => s.muted)
  const repeatMode = usePlayerStore((s) => s.repeatMode)
  const shuffleMode = usePlayerStore((s) => s.shuffleMode)
  const theme = useLibraryStore((s) => s.theme)
  // 当前曲目的最新封面路径：playerStore.currentTrack 只是播放时的快照，
  // 封面可能在 UI 渲染时才异步提取/升级（CoverImage → libraryStore.updateTrack），
  // 取库中最新值才能把锁屏 artwork 补写给原生（见下方 mediaSession effect）
  const currentCoverPath = useLibraryStore((s) => {
    if (!currentTrack) return undefined
    const record = s.tracks.find((t) => t.id === currentTrack.id)
    return record?.coverPath || currentTrack.coverPath || currentTrack.coverUrl
  })

  // 保留 themeColor hook 以维持封面色提取功能（用于 lyrics 渐变等非装饰场景）
  // 在线曲目无本地 coverPath 时回退到远端 coverUrl
  useThemeColor(currentTrack?.coverPath || currentTrack?.coverUrl)

  // 启动时检查软件更新：有新版本且本次会话未提示过时展示横幅
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  useEffect(() => {
    if (!shouldShowStartupBanner()) return
    let cancelled = false
    checkForUpdate()
      .then((info) => {
        if (info && !cancelled) {
          setUpdateInfo(info)
          markStartupBannerShown()
        }
      })
      .catch(() => {
        // 网络不可用 / API 限流时静默跳过，不打扰用户
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    initAudioAnalyser()

    // 恢复上次播放状态（不自动播放，仅恢复曲目和进度）
    // 延迟 500ms 等待 audioContext 初始化和 tracks 加载
    let restoreTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      usePlayerStore.getState().restorePlayback()
    }, 500)

    // 订阅平台事件，收集取消函数以便 effect 清理时移除，避免监听器泄漏/重复注册
    const unsubscribers: Array<() => void> = []
    // 初始加载的版本号为 0：scan:complete 事件将递增版本号，
    // 如果 getAllTracks 延迟响应在 scan:complete 之后到达，版本号更小，会被跳过
    if (platform.getAllTracks) {
      platform.getAllTracks().then((tracks: Track[]) => {
        useLibraryStore.getState().setTracks(tracks, 0)
      })
    }
    // scan:complete 递增版本号，确保其数据优先级高于 getAllTracks
    let scanCompleteVersion = 1
    if (platform.onTracksScanned) {
      unsubscribers.push(
        platform.onTracksScanned((scannedTracks: Track[]) => {
          flushScannedTracks()
          useLibraryStore.getState().setTracks(scannedTracks, scanCompleteVersion++)
        })
      )
    }
    // 渐进式刷新：扫描期间每解析完一首平台都会推送一次。逐首写 store 会让每次
    // 都触发一次整表重渲染（上千首时直接卡死），因此在这里合并成批：
    // 攒满 SCAN_BATCH_SIZE 首或距首次入队超过 SCAN_FLUSH_MS 才写一次。
    if (platform.onTrackScanned) {
      unsubscribers.push(
        platform.onTrackScanned((track: Track) => {
          pendingScanned.push(track)
          if (pendingScanned.length >= SCAN_BATCH_SIZE) {
            flushScannedTracks()
          } else if (!scanFlushTimer) {
            scanFlushTimer = setTimeout(flushScannedTracks, SCAN_FLUSH_MS)
          }
        })
      )
      unsubscribers.push(() => {
        if (scanFlushTimer) clearTimeout(scanFlushTimer)
        scanFlushTimer = null
        pendingScanned = []
      })
    }
    // 扫描时发现目录已从磁盘删除：主进程已清理该目录的曲目并推送最新列表，
    // 这里同步移除目录配置，避免每次启动都重复扫描一个不存在的目录
    if (platform.onFolderMissing) {
      unsubscribers.push(
        platform.onFolderMissing(({ folder, removed }) => {
          console.warn(`[Scan] 目录已不存在，已从音乐库清理 ${removed} 首曲目并移除该扫描目录:`, folder)
          useLibraryStore.getState().removeScanFolder(folder)
        })
      )
    }
    // 扫描失败必须给用户明确提示：未授权时用户只会看到 0 首歌且无任何报错，
    // 极易误以为是软件本身的缺陷（而非缺少存储权限）
    if (platform.onScanError) {
      let lastErrorAt = 0
      unsubscribers.push(
        platform.onScanError((error: { folder: string; message: string }) => {
          console.warn('[Scan] 后台扫描失败:', error.message)
          if (isMobile()) {
            checkMediaPermissions().then((granted) => {
              if (!granted) {
                // 权限缺失：弹引导卡片（幂等，多个目录连续失败不会重复弹多个）
                setNeedsStoragePermission(true)
              } else {
                // 权限正常却仍失败（目录被删/损坏等）：5 秒去重，避免多目录连续弹窗
                const now = Date.now()
                if (now - lastErrorAt > 5000) {
                  lastErrorAt = now
                  alert(error.message)
                }
              }
            }).catch(() => {})
          } else {
            // 桌面端同样提示扫描失败（5 秒去重），否则用户只看到歌曲数目不变
            // 却完全不知道扫描失败了，极易误认为是软件本身的缺陷
            const now = Date.now()
            if (now - lastErrorAt > 5000) {
              lastErrorAt = now
              toast(error.message, { type: 'error', duration: 5000 })
            }
          }
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
      const doScan = () => {
        for (const folder of folders) {
          platform.scanFolder!(folder).catch(() => {})
        }
      }
      if (isMobile() && folders.length > 0) {
        // 移动端：先申请存储权限再扫描。未授权时 readdir 会静默失败，
        // 用户只会看到 0 首歌且无任何提示，会误以为是软件本身的缺陷
        requestMediaPermissions().then((granted) => {
          if (granted) {
            doScan()
          } else {
            setNeedsStoragePermission(true)
          }
        }).catch(doScan)
      } else if (folders.length > 0) {
        doScan()
      }
    }

    // 网络存储（WebDAV）来源同样在启动时后台静默重扫：远端可能新增/删除文件，
    // 用户改过来源配置（地址、根目录）后也需要重新对齐。仅扫描 enabled 的来源
    // （设置页的启用开关就是控制它）；主进程侧同样串行化，失败只记日志。
    // WebDAV 无法像本地目录那样挂 fs.watch，所以启动重扫是远端变更的主要同步入口。
    if (platform.scanLibrarySource) {
      const sources = useLibraryStore.getState().librarySources.filter((s) => s.enabled)
      for (const source of sources) {
        platform.scanLibrarySource(source.id).catch(() => {})
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
    // 同步 <html> 的 dark 类与 meta theme-color（移动端状态栏颜色随主题翻转）
    const apply = (isDark: boolean) => {
      document.documentElement.classList.toggle('dark', isDark)
      // 挂载 DS 风格层的作用域属性：`--ds-*` 系列 token 全部定义在
      // `[data-ds-theme]` / `.ds-scope` 之下（ds-tokens.css 刻意不使用 :root，
      // 以隔离命名空间、绝不覆盖 --fc-* 与 shadcn 变量）。
      // 若不挂这个属性，任何取值写成 var(--ds-*) 的 Tailwind class 都会解析为
      // 空值而**静默失效**（构建无报错、class 也在产物里，但计算值为 none/
      // 0px）——例如 shadow-ds-card、backdrop-blur-ds。因此这里必须与 dark 类
      // 同步挂载，且取值只能是 light/dark（ds-tokens.css 只认这两个值）。
      document.documentElement.setAttribute('data-ds-theme', isDark ? 'dark' : 'light')
      const meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', isDark ? '#0A0A0A' : '#F9F8F8')
    }
    if (theme === 'dark') {
      apply(true)
    } else if (theme === 'light') {
      apply(false)
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      apply(prefersDark)
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = (e: MediaQueryListEvent) => apply(e.matches)
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
  }, [theme])

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
  // 移动端原生播放引擎自带系统级 MediaSession（锁屏/通知栏控件直接操作原生引擎），
  // WebView 的 navigator.mediaSession 仅在桌面端/纯 Web 环境生效，避免两套控件冲突
  useEffect(() => {
    if (isNativePlayerAvailable()) return
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
  // 移动端：原生引擎自行维护 metadata/PlaybackState，但队列下发时封面可能尚未提取，
  // 这里在封面就绪/变化时补写一次，否则锁屏长期停在默认音符占位图
  useEffect(() => {
    if (isNativePlayerAvailable()) {
      nativeUpdateArtwork(currentCoverPath)
      return
    }
    if ('mediaSession' in navigator && currentTrack) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title,
        artist: currentTrack.artist,
        album: currentTrack.album || 'Aurora Music',
        // MediaImage 只接受 http/https/data/blob，本地文件协议不被支持，故不设 artwork
      })
    }
  }, [currentCoverPath, currentTrack])

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
      {/* 色场色斑层：四个独立元素，各自一段 radial-gradient。
          必须分开成独立元素——若把多段 radial-gradient 塞进同一个元素的 background，
          它们会先叠加成一张图，各色相互相中和成一片灰雾；
          独立分层后每层各自保持色相与边缘，玻璃才折射得出「一条条光带」。
          z-index:-1 + 根容器 isolation:isolate，保证始终沉在所有内容之下。

          ⚠️ 性能：色斑一律用 radial-gradient 做柔边，**不要加 filter: blur()**。
          模糊 + 无限漂移动画共存时，滤镜每帧失效重算，会让整个界面掉到个位数帧率；
          而 radial-gradient 是静态背景图，位移只走合成层，实测满帧。
          三层各自套 .ambient-blob__drift 承载漂移动画（详见 globals.css 对应注释）。 */}
      <div aria-hidden className="ambient-blob ambient-blob--depth" />
      <div aria-hidden className="ambient-blob ambient-blob--primary">
        <div className="ambient-blob__drift" />
      </div>
      <div aria-hidden className="ambient-blob ambient-blob--secondary">
        <div className="ambient-blob__drift" />
      </div>
      <div aria-hidden className="ambient-blob ambient-blob--glow">
        <div className="ambient-blob__drift" />
      </div>
      {/* 歌曲详情页沉浸背景：封面模糊背景提升到窗口级，覆盖顶部标题栏区域，消除顶部黑边 */}
      {/* 延迟 320ms 挂载：等侧栏/瓷砖折叠动画结束再渲染背景，
          否则动画期间每帧重算模糊，展开过程严重掉帧；
          详情页内切歌时 backdropReady 已为 true，背景立即随新封面更新 */}
      {isSongDetail && currentTrack && backdropReady && (
        <div
          aria-hidden
          className="absolute inset-0 overflow-hidden pointer-events-none animate-[backdrop-fade-in_.45s_ease]"
        >
          {/* 沉浸背景：封面全尺寸铺满（object-cover），不加 CSS blur、不做 scale 放大——
              旧方案的全屏 blur-[64px] 卡顿源于滤镜每帧全屏重算；无滤镜的静态图层
              只一次性光栅化缓存，逐帧仅合成，成本低于玻璃 backdrop-filter（实测不影响滚动）。
              封面原图约 600px，放大到窗口尺寸仅有轻微双线性柔化，轮廓清晰 */}
          <div className="absolute inset-0 opacity-55">
            <CoverImage track={currentTrack} alt="" className="w-full h-full object-cover" />
          </div>
          <div className="absolute inset-0 bg-gradient-to-b from-background/75 via-background/50 to-background/95" />
          <div
            className="absolute inset-0"
            style={{ background: 'radial-gradient(ellipse 60% 45% at 28% 18%, rgba(var(--fc-accent-rgb),.10), transparent 65%)' }}
          />
        </div>
      )}

      {/* Mineradio SVG 色差玻璃滤镜定义（隐藏，仅注入 DOM 让 url(#...) 引用生效） */}
      <GlassSvgFilter />

      {/* 软件内轻量提示挂载点：替代系统 alert/confirm 弹窗 */}
      <ToastHost />

      {/* 搜索浮层：portal 到 body 全屏覆盖，任意页面唤起均可见 */}
      {searchOpen && <SearchOverlay onClose={() => setSearchOpen(false)} />}

      {/* 内置软件更新：下载进度/安装对话框（全局唯一实例，横幅与设置页共用） */}
      <UpdateDownloadDialog />

      <TitleBar />

      {/* 桌面端窗口缩放手柄；移动端不需要（组件内部 isDesktop 判断返回 null） */}
      <ResizeHandles />

      {/* 移动端顶部导航：左上角汉堡菜单 + 左侧抽屉（替代底部 BottomTabBar） */}
      {mobile && <MobileNav />}

      {/* 主区域：侧栏 + 内容 + 右侧封面瓷砖 */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* 桌面端侧栏 — Liquid Glass 材质，悬浮于 ambient-backdrop 之上 */}
        {/* 移动端导航改为顶部汉堡菜单 + 左侧抽屉（MobileNav），不再用底部 Tab 或固定侧栏 */}
        {/* 详情页不卸载而是宽度折叠动画：直接卸载会让内容列宽度突变，
            居中的悬浮播放条瞬间横移（跳动）；折叠动画让播放条平滑过渡 */}
        {!mobile && (
          <aside
            className={cn(
              'flex-shrink-0 overflow-hidden transition-[width] duration-300 ease-apple',
              // 弱化分割线：去掉右侧 hairline 与玻璃顶边高亮，
              // 侧栏靠玻璃底色与内容区自然区分，不再用线条切割
              // （顶边高亮由 glass-flush-top 移除，否则裸露成窗口上沿白线）
              'glass-regular glass-flush-top shadow-none',
              isSongDetail ? 'w-0' : 'w-56',
            )}
          >
            {/* pt-11 补回标题栏高度：玻璃面板自身从窗口顶 y=0 起铺，其顶边高光因此
                贴着窗口上沿；内容仍从标题栏下方开始，位置与标题栏占位时逐像素一致 */}
            <div className={cn('w-56 h-full flex flex-col', hasTitleBar && 'pt-11')}>
              <Sidebar />
            </div>
          </aside>
        )}

        {/* 主内容区 */}
        {/* 歌曲详情页（桌面端）放开 overflow 裁切：详情滚动容器需上延到窗口顶，
            把裁切边移到窗口边界，否则内容阴影/光晕滚过标题栏底边时会形成横向断层线 */}
        {/* 详情页放开 overflow 时需用 min-h-0 抵消 flex 子项 min-height:auto，
            否则 main 会被内容撑到全文高度、滚动容器失去滚动能力 */}
        <main
          className={cn(
            'relative flex-1 flex flex-col min-w-0 bg-transparent',
            isSongDetail && !mobile ? 'overflow-visible min-h-0' : 'overflow-hidden',
          )}
        >
          <div className={cn('flex-1 flex min-h-0', isSongDetail && !mobile ? 'overflow-visible' : 'overflow-hidden')}>
            {/* 内容列：页面路由 + 悬浮播放条（播放条相对内容列居中，避免压到右侧歌词瓷砖） */}
            {/* pt-11 补回标题栏高度：标题栏已改为绝对定位浮层（不占文档流），主区域从窗口顶
                y=0 起算。padding 加在本列而非 main 上，才能让同处 main 内的右侧封面瓷砖
                也跟着铺到窗口顶（玻璃顶边高光因此落在窗口上沿，不再裸露在标题栏下方）；
                内容仍从标题栏下方 y=44 开始，与占位时逐像素一致，详情页滚动容器的
                -top-11 也仍相对本 padding 盒定位、上延到窗口顶的行为不变 */}
            <div className={cn('relative flex-1 flex flex-col min-w-0', hasTitleBar && 'pt-11', isSongDetail && !mobile && 'min-h-0')}>
              {/* 新版本提示横幅：启动检测到新版本时固定在内容区顶部 */}
              {updateInfo && (
                <div className="pt-3">
                  <UpdateBanner info={updateInfo} onClose={() => setUpdateInfo(null)} />
                </div>
              )}
              <div className="relative flex-1 min-h-0">
                {/*
                  音乐库常驻挂载：离开 /library（如进入歌曲详情）时不卸载，
                  用 visibility 隐藏而非 display —— 布局尺寸与滚动容器全程保留，
                  虚拟列表不会因容器失焦归零而停摆，返回时零重建、零空白、滚动位置原样恢复。
                */}
                <div
                  className={cn(
                    'h-full overflow-y-auto scrollbar-thin',
                    location.pathname !== '/library' && 'invisible',
                  )}
                >
                  <LibraryPage />
                </div>
                {/* 其他路由按需渲染，绝对定位铺满容器，与常驻的音乐库层共存互不影响 */}
                {/* 桌面端详情页：滚动容器上延 44px（标题栏高度）到窗口顶，裁切边移到窗口边界，
                    内容阴影/光晕滚过标题栏底边时不再形成横向断层线 */}
                {location.pathname !== '/library' && (
                  <div
                    className={cn(
                      'absolute left-0 right-0 bottom-0 overflow-y-auto scrollbar-thin',
                      isSongDetail && desktop ? '-top-11' : 'top-0',
                    )}
                  >
                    <Routes>
                      <Route path="/" element={<Navigate to="/library" replace />} />
                      <Route path="/liked" element={<LikedPage />} />
                      <Route path="/recent" element={<RecentPage />} />
                      <Route path="/settings" element={<SettingsPage />} />
                      <Route path="/playlist/:id" element={<PlaylistPage />} />
                      <Route path="/song/:id" element={<SongDetailPage />} />
                    </Routes>
                  </div>
                )}
              </div>

              {/* Mineradio 悬浮胶囊控制台 — 全局唯一实例，所有页面（含歌曲详情）常驻，
                  避免详情页内嵌另一份播放条导致切换页面时播放条位置/宽度跳变 */}
              {/* 移动端：贴屏幕底部（safe-area），宽度铺满屏宽 -16 */}
              <div
                className={cn(
                  'absolute left-1/2 -translate-x-1/2 z-30',
                  mobile
                    ? 'bottom-[calc(10px+env(safe-area-inset-bottom))] w-[calc(100%-16px)]'
                    : 'bottom-3 w-[clamp(360px,calc(100%-48px),640px)] min-[1500px]:w-[clamp(360px,calc(100%-48px),720px)]',
                )}
              >
                {/* 播放队列浮层：挂在播放条容器内（右缘对齐播放条、悬浮其上），
                    主页面/详情页/全屏下都跟随居中的播放条，不贴窗口右缘 */}
                <QueueView />
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
                  onOpenNowPlaying={() => setMobileNowPlaying(true)}
                />
              </div>
            </div>

            {/* 右侧 Now Playing 瓷砖 — Liquid Glass 材质 */}
            {/* 不随 currentTrack / 路由卸载，而是宽度折叠动画：选中歌曲或进入详情页时
                直接卸载会让内容列宽度突变，居中的悬浮播放条瞬间横移（跳动）；
                折叠动画让播放条随布局平滑过渡。无歌曲时展示空态占位保持瓷砖常驻 */}
            {!mobile && (
              <aside
                className={cn(
                  'flex-shrink-0 overflow-hidden transition-[width] duration-300 ease-apple',
                  // 与左侧栏一致：弱化分割线，靠玻璃底色区分区域
                  'glass-regular glass-flush-top shadow-none',
                  currentTrack && !isSongDetail ? 'w-72' : 'w-0',
                  'hidden lg:block',
                )}
              >
                {/* pt-11 与左侧栏同理：玻璃面板铺到窗口顶，内容仍从标题栏下方开始 */}
                <div className={cn('w-72 h-full flex flex-col', hasTitleBar && 'pt-11')}>
                  <div className="p-6 flex flex-col gap-4">
                    {/* 封面图 — 唯一使用 product-shadow 的地方，点击进入歌曲详情 */}
                    <button
                      onClick={() => currentTrack && navigate(`/song/${currentTrack.id}`)}
                      title="查看歌曲详情"
                      disabled={!currentTrack}
                      className="relative aspect-square rounded-ds-card bg-white/[0.04] flex items-center justify-center overflow-hidden w-full cursor-pointer transition-transform duration-200 ease-apple hover:scale-[1.02] disabled:hover:scale-100"
                    >
                      <CoverImage
                        track={currentTrack}
                        alt={currentTrack?.title}
                        className="w-full h-full object-cover product-shadow"
                        fallback={<div className="text-4xl text-white/30">🎵</div>}
                      />
                    </button>

                    <div className="text-center">
                      <p className="font-display font-semibold truncate text-[17px] tracking-[-0.374px] text-white/96">
                        {currentTrack?.title || '未在播放'}
                      </p>
                      <p className="font-text text-[14px] text-white/50 truncate mt-1 tracking-[-0.224px]">
                        {currentTrack?.artist || '选择一首歌曲开始'}
                      </p>
                    </div>

                  </div>

                  {/* 不再叠加 px-4：LyricsView 自带 px-4，两层缩进会让 288px 的瓷砖
                      净宽只剩 224px，中文歌词每行被压到 16 字、几乎句句折行 */}
                  <div className="flex-1 overflow-hidden flex flex-col min-h-0 pt-0 pb-6">
                    <div className="flex-1 min-h-0">
                      <LyricsView onLineClick={(time) => usePlayerStore.getState().seekTo(time)} />
                    </div>
                  </div>
                </div>
              </aside>
            )}
          </div>
        </main>
      </div>

      {/* 移动端全屏 Now Playing 视图 */}
      {mobile && (
        <MobileNowPlaying open={nowPlayingOpen} onClose={() => setMobileNowPlaying(false)} />
      )}

      {/* 移动端文件夹选择器：在 App 层全局渲染，LibraryPage 与 SettingsPage 共用 */}
      {mobile && (
        <MobileFolderPicker
          open={folderPickerOpen}
          onSelected={handleFolderSelected}
          onClose={handleFolderPickerClose}
          {...(folderPickerText ?? {})}
        />
      )}

      {/* 移动端存储权限引导：扫描需要「音乐和音频」权限（或「所有文件访问」）时显示 */}
      {mobile && needsStoragePermission && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm px-6">
          <div className="w-full max-w-[340px] rounded-ds-card bg-canvas-paper border border-white/10 p-6 flex flex-col items-center text-center shadow-ds-dropdown">
            <div className="w-14 h-14 rounded-full bg-mint/10 border border-mint/20 flex items-center justify-center mb-4">
              <ShieldAlert className="h-7 w-7 text-mint" strokeWidth={1.6} />
            </div>
            <h2 className="font-display text-[17px] font-bold text-white/96 tracking-[-0.3px]">
              需要存储权限
            </h2>
            <p className="font-text text-[13px] text-white/60 leading-relaxed mt-2 mb-6 tracking-[-0.15px]">
              未授予存储权限时无法读取本地音乐，因此扫描结果为空。请授予「音乐和音频」权限；若系统不再弹出授权窗口，可在设置中开启「所有文件访问」。授权后返回应用会自动开始扫描。
            </p>
            <button
              onClick={handleGrantStoragePermission}
              className="w-full h-11 rounded-full bg-mint text-mint-fg font-semibold text-[14px] active:scale-[0.98] transition"
            >
              授予权限
            </button>
            <button
              onClick={() => setNeedsStoragePermission(false)}
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
