import { useState, useMemo, useEffect, useRef, useCallback, memo, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Search as SearchIcon, Play, Plus, ListEnd, Music2, Heart, Loader2, Cloud, HardDrive, History, X, Download } from 'lucide-react'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { useNavigate } from 'react-router-dom'
import { platform } from '@/services/platform'
import { CoverImage } from '@/components/common/CoverImage'
import { cn, formatTime, isDesktop } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { useDownloadOnlineTrack } from '@/hooks/useDownloadOnlineTrack'
import { useDisplayTracks } from '@/hooks/useDisplayTracks'
import type { Track, OnlineTrackSearchResult, Playlist } from '@/types'

/** 行 DOM 注册：键盘高亮移动时把目标行滚动到可视区 */
type RegisterRow = (id: string, el: HTMLDivElement | null) => void

/** 行通用样式：content-visibility 让可视区外的行跳过渲染，百行级列表滚动不卡。
 * 水平内边距取 8px（而非卡片时代的 16px）：行直接铺在浮层玻璃上，
 * 8px（容器）+ 8px（行）= 16px 内容左缘，与搜索框图标严格对齐。
 * 间距窄屏收窄（8px）：390px 的手机屏上元素排得下才不至于把标题挤成省略号 */
const ROW_CLASS =
  'row-hover flex items-center gap-2 sm:gap-3 px-2 py-2 cursor-pointer group border-b border-white/[0.05] last:border-0 hover:bg-white/[0.04] [content-visibility:auto] [contain-intrinsic-size:auto_56px]'

/** 序号列：窄屏不显示（移动端惯例，给标题让出宽度），宽屏保留键盘位置感 */
const ROW_INDEX_CLASS = 'w-6 flex-shrink-0 hidden sm:flex items-center justify-center relative'

/** 来源徽章：本地与在线同栏混排，靠徽章区分来源；源名可长，内层 truncate */
const BADGE_CLASS =
  'flex items-center gap-1 flex-shrink-0 max-w-[140px] font-text text-[10px] border rounded-[8px] px-1.5 py-px tracking-[-0.1px]'
/** 本地来源徽章：mint 调，一眼认出「这首在我库里」 */
const BADGE_LOCAL_CLASS = cn(BADGE_CLASS, 'text-mint/70 border-mint/20 bg-mint/[0.05]')
/** 在线来源徽章：中性色，只承载源名 */
const BADGE_ONLINE_CLASS = cn(BADGE_CLASS, 'text-white/35 border-white/[0.08]')

interface LocalResultRowProps {
  track: Track
  idx: number
  isActive: boolean
  isLiked: boolean
  playlists: Playlist[]
  onHover: (idx: number) => void
  onPlay: (track: Track, idx: number) => void
  onPlayNext: (track: Track) => void
  onAddToQueue: (track: Track) => void
  onToggleLike: (trackId: string) => void
  onAddToPlaylist: (playlistId: string, trackId: string) => void
  onOpenDetail: (trackId: string) => void
  registerRow: RegisterRow
}

/**
 * 本地结果行。memo 隔离渲染：悬停/键盘高亮每次只变化两行，
 * 未受影响的行直接跳过重渲染（行内含 Radix ContextMenu，全量渲染成本高）。
 * 所有回调均由父组件 useCallback 保持稳定引用，否则 memo 失效。
 */
const LocalResultRow = memo(function LocalResultRow({
  track,
  idx,
  isActive,
  isLiked,
  playlists,
  onHover,
  onPlay,
  onPlayNext,
  onAddToQueue,
  onToggleLike,
  onAddToPlaylist,
  onOpenDetail,
  registerRow,
}: LocalResultRowProps) {
  const rowRef = useCallback((el: HTMLDivElement | null) => registerRow(track.id, el), [registerRow, track.id])
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={rowRef}
          onMouseEnter={() => onHover(idx)}
          className={cn(ROW_CLASS, isActive && 'bg-white/[0.06]')}
          onDoubleClick={() => onPlay(track, idx)}
        >
          {/* 序号/播放图标叠放在固定宽度容器内切换，避免 hover 时布局抖动 */}
          <span className={ROW_INDEX_CLASS}>
            <span className="font-text text-[12px] text-white/35 tabular-nums tracking-[-0.12px] transition-opacity duration-150 group-hover:opacity-0">
              {idx + 1}
            </span>
            <Play className="w-3 h-3 absolute text-mint opacity-0 transition-opacity duration-150 group-hover:opacity-100" strokeWidth={1.8} />
          </span>
          <div
            onClick={(e) => {
              e.stopPropagation()
              onOpenDetail(track.id)
            }}
            title="查看歌曲详情"
            className="w-10 h-10 rounded-[10px] bg-white/[0.04] flex items-center justify-center flex-shrink-0 overflow-hidden cursor-pointer transition-transform duration-200 ease-apple hover:scale-105"
          >
            <CoverImage
              track={track}
              className="w-full h-full object-cover product-shadow"
              fallback={<Music2 className="h-4 w-4 text-white/30" strokeWidth={1.6} />}
            />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-text text-[14px] font-semibold truncate text-white/92 tracking-[-0.224px]">{track.title}</p>
            <p className="font-text text-[12px] text-white/50 truncate tracking-[-0.12px]">{track.artist}</p>
          </div>
          <span className="font-text text-[12px] text-white/35 truncate max-w-32 hidden md:block tracking-[-0.12px]">
            {track.album}
          </span>
          {/* 来源徽章：与在线行同构，标出「本地」；窄屏只留图标省宽度 */}
          <span className={BADGE_LOCAL_CLASS}>
            <HardDrive className="h-2.5 w-2.5 flex-shrink-0" strokeWidth={1.8} />
            <span className="hidden sm:block">本地</span>
          </span>
          <span className="font-text text-[12px] text-white/35 tabular-nums w-10 text-right tracking-[-0.12px]">
            {formatTime(track.duration)}
          </span>
          {/* 收藏按钮：与在线行的下载按钮同规则常驻显示——
              触摸设备没有 hover，藏在 hover 里等于手机上永远点不到；
              且同一列表里两个操作按钮不该一个常显一个隐身 */}
          <button
            onClick={(e) => {
              e.stopPropagation()
              onToggleLike(track.id)
            }}
            title={isLiked ? '取消收藏' : '收藏'}
            className="h-7 w-7 flex items-center justify-center rounded-[10px] transition-colors duration-200 ease-apple hover:bg-mint/[0.075]"
          >
            <Heart
              className={cn('h-3.5 w-3.5', isLiked ? 'text-coral fill-coral' : 'text-white/40')}
              strokeWidth={1.7}
            />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52 z-[90]">
        <ContextMenuItem onClick={() => onPlay(track, idx)}>
          <Play className="h-4 w-4 mr-2" strokeWidth={1.5} />
          立即播放
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onPlayNext(track)}>
          <ListEnd className="h-4 w-4 mr-2" strokeWidth={1.5} />
          下一首播放
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onAddToQueue(track)}>
          <Plus className="h-4 w-4 mr-2" strokeWidth={1.5} />
          添加到队列
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Plus className="h-4 w-4 mr-2 opacity-50" strokeWidth={1.5} />
            添加到播放列表
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48 z-[90]">
            {playlists.length === 0 ? (
              <ContextMenuItem disabled>暂无播放列表</ContextMenuItem>
            ) : (
              playlists.map((pl) => (
                <ContextMenuItem key={pl.id} onClick={() => onAddToPlaylist(pl.id, track.id)}>
                  {pl.name}
                </ContextMenuItem>
              ))
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  )
})

interface OnlineResultRowProps {
  track: Track
  /** 全局下标：序号展示与键盘高亮（activeIdx）对齐，与本地行共用同一编号序列 */
  flatIdx: number
  /** 源内下标：双击播放时在 queue（同源结果）中的定位 */
  queueIdx: number
  queue: Track[]
  isActive: boolean
  isDownloading: boolean
  onHover: (idx: number) => void
  onPlay: (track: Track, idx: number, queue: Track[]) => void
  onPlayNext: (track: Track) => void
  onAddToQueue: (track: Track) => void
  onDownload: (track: Track) => void
  registerRow: RegisterRow
}

/** 在线结果行。memo 理由同 LocalResultRow；封面 img 懒加载 + 异步解码避免首屏解码风暴 */
const OnlineResultRow = memo(function OnlineResultRow({
  track,
  flatIdx,
  queueIdx,
  queue,
  isActive,
  isDownloading,
  onHover,
  onPlay,
  onPlayNext,
  onAddToQueue,
  onDownload,
  registerRow,
}: OnlineResultRowProps) {
  const rowRef = useCallback((el: HTMLDivElement | null) => registerRow(track.id, el), [registerRow, track.id])
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={rowRef}
          onMouseEnter={() => onHover(flatIdx)}
          className={cn(ROW_CLASS, isActive && 'bg-white/[0.06]')}
          onDoubleClick={() => onPlay(track, queueIdx, queue)}
        >
          {/* 序号/播放图标叠放在固定宽度容器内切换，避免 hover 时布局抖动 */}
          <span className={ROW_INDEX_CLASS}>
            <span className="font-text text-[12px] text-white/35 tabular-nums tracking-[-0.12px] transition-opacity duration-150 group-hover:opacity-0">
              {flatIdx + 1}
            </span>
            <Play className="w-3 h-3 absolute text-mint opacity-0 transition-opacity duration-150 group-hover:opacity-100" strokeWidth={1.8} />
          </span>
          <div className="w-10 h-10 rounded-[10px] bg-white/[0.04] flex items-center justify-center flex-shrink-0 overflow-hidden">
            {track.coverUrl ? (
              <img src={track.coverUrl} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover product-shadow" referrerPolicy="no-referrer" />
            ) : (
              <Music2 className="h-4 w-4 text-white/30" strokeWidth={1.6} />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-text text-[14px] font-semibold truncate text-white/92 tracking-[-0.224px]">{track.title}</p>
            <p className="font-text text-[12px] text-white/50 truncate tracking-[-0.12px]">{track.artist}</p>
          </div>
          <span className="font-text text-[12px] text-white/35 truncate max-w-32 hidden md:block tracking-[-0.12px]">
            {track.album}
          </span>
          {/* 来源徽章：同栏多源混排时靠它区分来源（与本地行「本地」徽章同构）；
              窄屏只留云图标省宽度，完整源名靠 title 提示 */}
          <span className={BADGE_ONLINE_CLASS} title={track.onlineSourceName || '在线音乐'}>
            <Cloud className="h-2.5 w-2.5 flex-shrink-0" strokeWidth={1.8} />
            <span className="hidden sm:block truncate">{track.onlineSourceName || '在线音乐'}</span>
          </span>
          {/* 音频实际来源后端标识（源提供 qualitySource 时展示，便于识别跨平台拼贴数据） */}
          {track.onlineAudioSource && (
            <span className="font-text text-[10px] text-white/30 border border-white/[0.08] rounded-[8px] px-1.5 py-px hidden lg:block flex-shrink-0">
              {track.onlineAudioSource}
            </span>
          )}
          <span className="font-text text-[12px] text-white/35 tabular-nums w-10 text-right tracking-[-0.12px]">
            {formatTime(track.duration)}
          </span>
          {/* 下载按钮：常驻显示（搜索场景下下载是主要动作，不藏在 hover 里）；
              下载中转为 mint 加载态并禁用 */}
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDownload(track)
            }}
            title="下载歌曲"
            disabled={isDownloading}
            className={cn(
              'h-7 w-7 flex items-center justify-center rounded-[10px] transition-colors duration-200 ease-apple',
              isDownloading
                ? 'text-mint cursor-default'
                : 'text-white/40 hover:text-mint hover:bg-mint/[0.075]'
            )}
          >
            {isDownloading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.7} />
            ) : (
              <Download className="h-3.5 w-3.5" strokeWidth={1.7} />
            )}
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52 z-[90]">
        <ContextMenuItem onClick={() => onPlay(track, queueIdx, queue)}>
          <Play className="h-4 w-4 mr-2" strokeWidth={1.5} />
          立即播放
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onPlayNext(track)}>
          <ListEnd className="h-4 w-4 mr-2" strokeWidth={1.5} />
          下一首播放
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onAddToQueue(track)}>
          <Plus className="h-4 w-4 mr-2" strokeWidth={1.5} />
          添加到队列
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onDownload(track)} disabled={isDownloading}>
          {isDownloading ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" strokeWidth={1.5} />
          ) : (
            <Download className="h-4 w-4 mr-2" strokeWidth={1.5} />
          )}
          下载歌曲
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

interface SearchOverlayProps {
  /** 关闭浮层（Esc / 点击遮罩 / 选中结果后调用） */
  onClose: () => void
}

/**
 * Spotlight 风格搜索浮层（Liquid Glass）
 * - 以 portal 挂到 body，覆盖在音乐库之上，底层界面完全不改动
 * - 顶部玻璃面板：搜索框 + 结果区（本地在上、在线在下同屏展示），Esc / 点击遮罩关闭
 * - 键盘：↑/↓ 移动高亮、Enter 播放高亮项（无高亮时记录搜索历史）
 * - 结果行用 row-hover + hairline 分隔；封面 rounded-xs + product-shadow
 * - 本地走内存过滤，在线按用户配置的歌源协议搜索
 *
 * 性能设计：结果行全部 memo 化。悬停/键盘高亮（activeIdx）与后台封面回写
 * （updateTrack 导致的 tracks 换引用）都会触发浮层重渲染，memo 把这些
 * 高频重渲染收敛到「真正变化的行」，避免整列表 + 每行 ContextMenu 重建。
 */
export function SearchOverlay({ onClose }: SearchOverlayProps) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [onlineResults, setOnlineResults] = useState<OnlineTrackSearchResult[]>([])
  const [onlineLoading, setOnlineLoading] = useState(false)
  const [onlineError, setOnlineError] = useState<string | null>(null)
  // 在线歌曲下载（共享 hook）：downloadingIds 驱动行内加载态
  const { downloadingIds, download: handleDownload } = useDownloadOnlineTrack()
  // 键盘高亮项下标（-1 = 无高亮）；随查询/标签切换重置
  const [activeIdx, setActiveIdx] = useState(-1)
  // 本地结果同样去重：命中重复副本时搜出两条一模一样的歌没有意义
  const { tracks } = useDisplayTracks()
  const toggleLike = useLibraryStore((s) => s.toggleLike)
  const likedTracks = useLibraryStore((s) => s.likedTracks)
  // 历史搜索记录（持久化在 libraryStore）
  const searchHistory = useLibraryStore((s) => s.searchHistory)
  const addSearchHistory = useLibraryStore((s) => s.addSearchHistory)
  const removeSearchHistory = useLibraryStore((s) => s.removeSearchHistory)
  const clearSearchHistory = useLibraryStore((s) => s.clearSearchHistory)
  const playlists = usePlaylistStore((s) => s.playlists)
  const addTracksToPlaylist = usePlaylistStore((s) => s.addTracksToPlaylist)
  // 歌源配置：应用不内置任何源，全部由用户按协议配置
  const onlineSources = useLibraryStore((s) => s.onlineSources)
  // 默认下载音质：搜索时替换源地址 {quality} 占位符，下载时挑选多音质地址
  const downloadQuality = useLibraryStore((s) => s.downloadQuality)
  // 已启用的源（空数组 = 用户尚未配置任何源，搜索页需给出引导）
  const enabledSourceCount = useMemo(
    () => onlineSources.filter((s) => s.enabled && s.apiUrl).length,
    [onlineSources]
  )
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>()
  // 并发取消：每次发起新搜索递增 seq，响应回来时校验是否仍是最新一次
  const searchSeqRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  // 行 DOM 引用：键盘高亮移动时把目标行滚动到可视区
  const rowRefs = useRef(new Map<string, HTMLDivElement>())

  // 关闭浮层（卸载）时把非空搜索词写入历史：
  // 覆盖「点结果播放后关闭 / 搜完 Esc 关闭」等此前不记录的场景，
  // addSearchHistory 内部去重置顶，重复记录无副作用
  const latestQueryRef = useRef('')
  latestQueryRef.current = query
  useEffect(() => {
    return () => {
      addSearchHistory(latestQueryRef.current)
    }
  }, [addSearchHistory])

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => setDebouncedQuery(query), 1000)
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current) }
  }, [query])

  // Esc 关闭浮层；浮层挂载即聚焦输入框
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    inputRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const localResults = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase()
    if (!q) return []
    return tracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.album.toLowerCase().includes(q)
    )
  }, [debouncedQuery, tracks])

  // 在线搜索：query 非空即触发（本地/在线结果同屏展示，无 tab 切换）；
  // 未配置源时跳过，避免无效 IPC
  useEffect(() => {
    const q = debouncedQuery.trim()
    if (!q || enabledSourceCount === 0) {
      setOnlineResults([])
      setOnlineError(null)
      setOnlineLoading(false)
      return
    }
    const seq = ++searchSeqRef.current
    setOnlineLoading(true)
    setOnlineError(null)
    platform
      .searchOnlineTracks(q, {
        sources: onlineSources,
        quality: downloadQuality,
      })
      .then((res) => {
        if (seq !== searchSeqRef.current) return
        setOnlineResults(res)
      })
      .catch((err) => {
        if (seq !== searchSeqRef.current) return
        // 展示主进程返回的直白中文错误（如"网络请求失败，请检查网络连接"）
        setOnlineError(err?.message || '搜索失败，请稍后重试')
        setOnlineResults([])
      })
      .finally(() => {
        if (seq !== searchSeqRef.current) return
        setOnlineLoading(false)
      })
  }, [debouncedQuery, onlineSources, downloadQuality, enabledSourceCount])

  // 在线结果转 Track（复用播放器逻辑）：path 置空，onlineUrl 携带播放地址
  const onlineTracks: Track[] = useMemo(() => {
    return onlineResults.map((r) => ({
      id: r.id,
      path: '',
      title: r.title,
      artist: r.artist,
      album: r.album,
      duration: r.duration,
      addedAt: Date.now(),
      playCount: 0,
      liked: false,
      onlineUrl: r.audioUrl,
      onlineQualityUrls: r.qualityUrls,
      coverUrl: r.coverUrl,
      onlineSource: r.source,
      onlineSourceName: r.sourceName,
      onlineAudioSource: r.audioSource,
      onlineId: r.id,
    }))
  }, [onlineResults])

  // 本地只展示前 30 条（渲染与键盘导航共用同一份切片，保持一致）
  const localSlice = useMemo(() => localResults.slice(0, 30), [localResults])

  /**
   * 在线行的渲染数据：本地与在线同栏混排（本地在前、在线在后），
   * 行序号与键盘高亮直接用全局下标；双击播放仍以「同源结果」为队列，
   * 所以额外切出 queue 与该行在源内的下标。
   */
  const onlineRows = useMemo(() => {
    type Row = { track: Track; flatIdx: number; queue: Track[]; queueIdx: number }
    const queueBySource = new Map<string, Track[]>()
    const rows: Row[] = []
    onlineTracks.forEach((t, i) => {
      const key = t.onlineSourceName || '在线音乐'
      let queue = queueBySource.get(key)
      if (!queue) {
        queue = []
        queueBySource.set(key, queue)
      }
      rows.push({ track: t, flatIdx: localSlice.length + i, queue, queueIdx: queue.length })
      queue.push(t)
    })
    return rows
  }, [onlineTracks, localSlice.length])

  // 键盘可操作的结果列表：本地在上、在线在下，与渲染顺序一致
  const activeList = useMemo(
    () => [...localSlice, ...onlineTracks],
    [localSlice, onlineTracks]
  )

  // 查询变化后旧的高亮已失效，重置
  useEffect(() => {
    setActiveIdx(-1)
  }, [debouncedQuery])

  // 高亮移动时把对应行滚入可视区
  useEffect(() => {
    if (activeIdx < 0) return
    const track = activeList[activeIdx]
    if (track) rowRefs.current.get(track.id)?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, activeList])

  // ---- 下行回调全部 useCallback 稳定化：memo 行的 props 引用不变才会跳过重渲染 ----

  const registerRow = useCallback<RegisterRow>((id, el) => {
    if (el) rowRefs.current.set(id, el)
    else rowRefs.current.delete(id)
  }, [])

  // 播放队列经 ref 取最新值：tracks 因后台封面回写换引用时回调保持稳定，行不重渲染
  const localResultsRef = useRef<Track[]>([])
  localResultsRef.current = localResults

  const handlePlayLocal = useCallback((track: Track, index: number) => {
    usePlayerStore.getState().playQueue(localResultsRef.current, index)
  }, [])

  const handlePlayOnline = useCallback((track: Track, index: number, queue: Track[]) => {
    usePlayerStore.getState().playQueue(queue, index)
  }, [])

  const handlePlayNext = useCallback((track: Track) => {
    usePlayerStore.getState().addToPlayNext(track)
  }, [])

  const handleAddToQueue = useCallback((track: Track) => {
    usePlayerStore.getState().addToQueue(track)
  }, [])

  const handleToggleLike = useCallback(
    (trackId: string) => toggleLike(trackId),
    [toggleLike]
  )

  const handleAddToPlaylist = useCallback(
    (playlistId: string, trackId: string) => addTracksToPlaylist(playlistId, [trackId]),
    [addTracksToPlaylist]
  )

  const handleOpenDetail = useCallback(
    (trackId: string) => {
      if (!isDesktop()) {
        // 移动端与点击播放条一致：播放该曲并打开全屏 Now Playing 浮层（不推进路由）
        const idx = localResultsRef.current.findIndex((t) => t.id === trackId)
        if (idx >= 0) {
          usePlayerStore.getState().playQueue(localResultsRef.current, idx)
          usePlaylistStore.getState().setMobileNowPlaying(true)
        }
        onClose()
        return
      }
      navigate(`/song/${trackId}`)
      onClose()
    },
    [navigate, onClose]
  )

  const handleHoverRow = useCallback((idx: number) => setActiveIdx(idx), [])

  // 输入框键盘：↑/↓ 移动高亮，Enter 播放高亮项或记录搜索历史
  const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 中文输入法回车是确认候选词，不算提交搜索
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, activeList.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, -1))
    } else if (e.key === 'Enter') {
      const track = activeIdx >= 0 ? activeList[activeIdx] : undefined
      if (track) {
        // activeList 本地在前、在线在后：按下标区分播放队列
        const localCount = localSlice.length
        if (activeIdx < localCount) {
          handlePlayLocal(track, activeIdx)
        } else {
          handlePlayOnline(track, activeIdx - localCount, onlineTracks)
        }
        onClose()
      } else {
        addSearchHistory(query)
      }
    }
  }

  const handleHistoryClick = (item: string) => {
    setQuery(item)
    addSearchHistory(item)
    inputRef.current?.focus()
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-start justify-center" role="dialog" aria-modal="true" aria-label="搜索">
      {/* 遮罩：点击关闭；轻模糊让底层音乐库退后但仍可辨识。
          不做淡入动画——backdrop-filter 不参与合成，软件渲染下
          模糊层淡入期间每帧重算全屏模糊会明显掉帧 */}
      <div
        className="absolute inset-0 bg-black/45 backdrop-blur-[3px]"
        onClick={onClose}
      />

      {/* 浮层面板：顶部对齐的 Spotlight 面板，高度随结果自适应、最高 72vh。
          入场仅保留淡入：缩放/位移动画会让玻璃模糊区域逐帧变化，
          软件渲染下每帧重算模糊（全屏时尤甚），故去掉 zoom/slide */}
      <div className="relative mt-[7vh] w-[calc(100%-2rem)] max-w-2xl max-h-[72vh] flex flex-col glass-liquid rounded-[16px] overflow-hidden animate-in fade-in-0 duration-200">
        {/* 搜索输入行 */}
        <div className="flex items-center gap-3 h-14 px-4 flex-shrink-0 border-b border-white/[0.08]">
          <SearchIcon className="h-[18px] w-[18px] text-mint/70 flex-shrink-0" strokeWidth={1.6} />
          <input
            ref={inputRef}
            type="text"
            placeholder="搜索歌曲、艺术家、专辑..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            className="flex-1 min-w-0 bg-transparent outline-none font-text text-[15px] text-white/92 placeholder:text-white/28 tracking-[-0.224px]"
          />
          {query && (
            <button
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
              title="清空"
              className="h-7 w-7 flex items-center justify-center rounded-full text-white/35 hover:text-white/80 hover:bg-white/[0.08] transition-colors duration-150 ease-apple flex-shrink-0"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          )}
          <kbd className="hidden sm:flex items-center h-7 px-2 rounded-[10px] bg-white/[0.06] border border-white/[0.08] font-text text-[11px] text-white/40 flex-shrink-0">
            Esc
          </kbd>
        </div>

        {/* 结果区：内容超出时内部滚动，不撑破面板。
            左右 8px + 行内 8px = 16px，与搜索框图标同一左缘 */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-thin px-2 py-3">
          {!query.trim() ? (
            searchHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center min-h-[280px]">
                <div className="relative mb-5">
                  <div className="absolute -inset-10 bg-gradient-to-b from-mint/10 to-transparent rounded-full blur-3xl" />
                  <div className="relative w-[120px] h-[120px] rounded-[24px] bg-white/[0.03] border border-white/[0.08] flex items-center justify-center">
                    <SearchIcon className="h-[52px] w-[52px] text-mint/60" strokeWidth={1} />
                  </div>
                </div>
                <p className="font-display text-[22px] font-semibold text-white/90 mb-2 tracking-[-0.3px]">开始搜索</p>
                <p className="font-text text-[13px] text-white/40 tracking-[-0.15px]">输入关键词，搜索本地音乐库与在线音源</p>
              </div>
            ) : (
              /* 历史搜索：有记录时空态展示，点击回搜，支持单条删除与一键清空 */
              <section className="px-2">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="flex items-center gap-1.5 font-text text-[12px] font-semibold text-white/40 tracking-[-0.12px]">
                    <History className="h-3.5 w-3.5" strokeWidth={1.8} />
                    历史搜索
                  </h2>
                  <button
                    onClick={clearSearchHistory}
                    className="font-text text-[12px] text-white/35 hover:text-white/70 transition-colors duration-200 ease-apple tracking-[-0.12px]"
                  >
                    清空
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {searchHistory.map((item) => (
                    <div
                      key={item}
                      className="group flex items-center gap-1 h-7 pl-3 pr-1 rounded-full bg-white/[0.06] border border-white/[0.08] hover:bg-white/[0.1] transition-colors duration-200 ease-apple cursor-pointer"
                      onClick={() => handleHistoryClick(item)}
                    >
                      <span className="font-text text-[13px] text-white/75 tracking-[-0.15px] max-w-48 truncate">{item}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          removeSearchHistory(item)
                        }}
                        title="删除该记录"
                        className="h-5 w-5 flex items-center justify-center rounded-full text-white/30 hover:text-white/80 hover:bg-white/[0.08] transition-colors duration-150 ease-apple"
                      >
                        <X className="h-3 w-3" strokeWidth={2} />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )
          ) : (
            /* 本地与在线同栏：本地在前、在线在后，行内来源徽章区分。
               刻意不再套 card-list —— 浮层本身已是 glass-liquid，
               再套一层卡片就是「框里有框」，行样式也被容器内边距带偏 */
            <div>
              <div className="overflow-hidden">
                {localSlice.map((track, idx) => (
                  <LocalResultRow
                    key={track.id}
                    track={track}
                    idx={idx}
                    isActive={idx === activeIdx}
                    isLiked={likedTracks.has(track.id)}
                    playlists={playlists}
                    onHover={handleHoverRow}
                    onPlay={handlePlayLocal}
                    onPlayNext={handlePlayNext}
                    onAddToQueue={handleAddToQueue}
                    onToggleLike={handleToggleLike}
                    onAddToPlaylist={handleAddToPlaylist}
                    onOpenDetail={handleOpenDetail}
                    registerRow={registerRow}
                  />
                ))}
                {onlineRows.map((row) => (
                  <OnlineResultRow
                    key={row.track.id}
                    track={row.track}
                    flatIdx={row.flatIdx}
                    queueIdx={row.queueIdx}
                    queue={row.queue}
                    isActive={activeIdx === row.flatIdx}
                    isDownloading={downloadingIds.has(row.track.id)}
                    onHover={handleHoverRow}
                    onPlay={handlePlayOnline}
                    onPlayNext={handlePlayNext}
                    onAddToQueue={handleAddToQueue}
                    onDownload={handleDownload}
                    registerRow={registerRow}
                  />
                ))}
              </div>

              {/* 底部状态行：整栏零命中 / 未配置源 / 在线报错 / 搜索中。
                  本地未命中时不渲染任何本地区块（既无标题也无空提示），
                  只有整栏零命中才给统一空态；本地已命中时在线空结果只留一行淡提示 */}
              <div className="px-2 pt-2 space-y-1">
                {localResults.length > localSlice.length && (
                  <p className="py-2 text-center font-text text-[12px] text-white/30 tracking-[-0.12px]">
                    本地结果较多，仅显示前 30 条
                  </p>
                )}
                {!onlineLoading && localResults.length === 0 && onlineTracks.length === 0 && (
                  <p className="py-3 text-center font-text text-[13px] text-white/35 tracking-[-0.15px]">
                    没有找到匹配 "{query}" 的歌曲
                  </p>
                )}
                {enabledSourceCount === 0 ? (
                  <div className="py-2 flex flex-col items-center gap-3">
                    <p className="font-text text-[13px] text-white/35 tracking-[-0.15px] text-center">
                      应用不内置任何音乐源，请先在设置中配置符合协议的搜索接口
                    </p>
                    <button
                      onClick={() => {
                        navigate('/settings')
                        onClose()
                      }}
                      className="pill pill-md pill-soft text-mint"
                    >
                      前往设置音乐源
                    </button>
                  </div>
                ) : onlineError ? (
                  <p className="py-3 text-center font-text text-[13px] text-coral/70 tracking-[-0.15px]">
                    {onlineError}
                  </p>
                ) : onlineLoading ? (
                  <div className="py-3 flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 text-mint/60 animate-spin" strokeWidth={1.5} />
                    <span className="font-text text-[13px] text-white/40 tracking-[-0.15px]">正在搜索在线音乐...</span>
                  </div>
                ) : onlineTracks.length === 0 ? (
                  /* 仅当本地已命中、只是在线没搜到时才提示，避免与上方空态重复 */
                  localResults.length > 0 && (
                    <p className="py-3 text-center font-text text-[12px] text-white/30 tracking-[-0.12px]">
                      在线源未找到匹配结果
                    </p>
                  )
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
