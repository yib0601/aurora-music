import { useState, useMemo, useEffect, useRef, useCallback, memo, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Search as SearchIcon, Play, Plus, ListEnd, Music2, Heart, Loader2, Cloud, HardDrive, History, X, Download } from 'lucide-react'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { useNavigate } from 'react-router-dom'
import { platform } from '@/services/platform'
import { CoverImage } from '@/components/common/CoverImage'
import { toast } from '@/components/common/Toast'
import { cn, formatTime } from '@/lib/utils'
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
import type { Track, OnlineTrackSearchResult, DownloadQuality, Playlist } from '@/types'

/** 音质回退链：设置的档位不可用时，依次尝试其余档位，最终回退到源默认地址 */
const QUALITY_FALLBACK: Record<DownloadQuality, DownloadQuality[]> = {
  '128': ['128', '320', 'flac'],
  '320': ['320', 'flac', '128'],
  flac: ['flac', '320', '128'],
}

/** 按下载音质设置挑选下载地址：源未提供多音质地址时直接用默认地址 */
function pickDownloadUrl(track: Track, preferred: DownloadQuality): string {
  const urls = track.onlineQualityUrls
  if (urls) {
    for (const q of QUALITY_FALLBACK[preferred]) {
      if (urls[q]) return urls[q]!
    }
  }
  return track.onlineUrl!
}

/** 行 DOM 注册：键盘高亮移动时把目标行滚动到可视区 */
type RegisterRow = (id: string, el: HTMLDivElement | null) => void

/** 行通用样式：content-visibility 让可视区外的行跳过渲染，百行级列表滚动不卡 */
const ROW_CLASS =
  'row-hover flex items-center gap-3 px-4 py-2.5 cursor-pointer group border-b border-white/5 last:border-0 hover:bg-mint/[0.075] [content-visibility:auto] [contain-intrinsic-size:auto_60px]'

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
          className={cn(ROW_CLASS, isActive && 'bg-mint/[0.075]')}
          onDoubleClick={() => onPlay(track, idx)}
        >
          {/* 序号/播放图标叠放在固定宽度容器内切换，避免 hover 时布局抖动 */}
          <span className="w-6 flex-shrink-0 flex items-center justify-center relative">
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
            className="w-10 h-10 rounded-[8px] bg-white/[0.04] flex items-center justify-center flex-shrink-0 overflow-hidden cursor-pointer transition-transform duration-200 ease-apple hover:scale-105"
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
          <span className="font-text text-[12px] text-white/35 tabular-nums w-10 text-right tracking-[-0.12px]">
            {formatTime(track.duration)}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onToggleLike(track.id)
            }}
            className="h-7 w-7 flex items-center justify-center rounded-[8px] opacity-0 group-hover:opacity-100 transition-opacity duration-200 ease-apple hover:bg-mint/[0.075]"
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
  /** 分组内下标：序号展示与播放定位 */
  idx: number
  /** 全局下标：与键盘高亮 activeIdx 对齐 */
  flatIdx: number
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
  idx,
  flatIdx,
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
          className={cn(ROW_CLASS, isActive && 'bg-mint/[0.075]')}
          onDoubleClick={() => onPlay(track, idx, queue)}
        >
          {/* 序号/播放图标叠放在固定宽度容器内切换，避免 hover 时布局抖动 */}
          <span className="w-6 flex-shrink-0 flex items-center justify-center relative">
            <span className="font-text text-[12px] text-white/35 tabular-nums tracking-[-0.12px] transition-opacity duration-150 group-hover:opacity-0">
              {idx + 1}
            </span>
            <Play className="w-3 h-3 absolute text-mint opacity-0 transition-opacity duration-150 group-hover:opacity-100" strokeWidth={1.8} />
          </span>
          <div className="w-10 h-10 rounded-[8px] bg-white/[0.04] flex items-center justify-center flex-shrink-0 overflow-hidden">
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
          <span className="font-text text-[12px] text-white/35 tabular-nums w-10 text-right tracking-[-0.12px]">
            {formatTime(track.duration)}
          </span>
          {/* 下载按钮：下载中显示加载态 */}
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDownload(track)
            }}
            title="下载歌曲"
            disabled={isDownloading}
            className={cn(
              'h-7 w-7 flex items-center justify-center rounded-[8px] transition-opacity duration-200 ease-apple',
              isDownloading
                ? 'opacity-100 text-mint'
                : 'opacity-0 group-hover:opacity-100 hover:bg-mint/[0.075] text-white/40'
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
        <ContextMenuItem onClick={() => onPlay(track, idx, queue)}>
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
  // 正在下载中的曲目 id 集合（同一首歌不重复触发，图标显示加载态）
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set())
  // 键盘高亮项下标（-1 = 无高亮）；随查询/标签切换重置
  const [activeIdx, setActiveIdx] = useState(-1)
  const tracks = useLibraryStore((s) => s.tracks)
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

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => setDebouncedQuery(query), 200)
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
      onlineId: r.id,
    }))
  }, [onlineResults])

  // 按来源分组：每个源一个分组，顺序跟随结果出现顺序（即用户配置的源顺序）
  const onlineGroups = useMemo(() => {
    type Group = { key: string; label: string; tracks: Track[] }
    const groupMap = new Map<string, Group>()
    for (const t of onlineTracks) {
      const name = t.onlineSourceName || '在线音乐'
      if (!groupMap.has(name)) {
        groupMap.set(name, { key: name, label: name, tracks: [] })
      }
      groupMap.get(name)!.tracks.push(t)
    }
    return Array.from(groupMap.values())
  }, [onlineTracks])

  // 本地只展示前 30 条（渲染与键盘导航共用同一份切片，保持一致）
  const localSlice = useMemo(() => localResults.slice(0, 30), [localResults])

  // 键盘可操作的结果列表：本地在上、在线在下，与渲染顺序一致
  const activeList = useMemo(
    () => [...localSlice, ...onlineTracks],
    [localSlice, onlineTracks]
  )

  // 行 id → 全局下标：分组渲染时 O(1) 换算键盘高亮位置，避免每行 findIndex 的 O(n²)
  const flatIdxById = useMemo(() => {
    const map = new Map<string, number>()
    activeList.forEach((t, i) => map.set(t.id, i))
    return map
  }, [activeList])

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
      navigate(`/song/${trackId}`)
      onClose()
    },
    [navigate, onClose]
  )

  const handleHoverRow = useCallback((idx: number) => setActiveIdx(idx), [])

  // 下载 guard 用 ref 镜像：开始/结束下载不重建回调，仅通过 isDownloading prop 更新对应行
  const downloadingIdsRef = useRef(downloadingIds)
  downloadingIdsRef.current = downloadingIds

  // 下载在线歌曲：桌面端有默认下载目录则直存，否则弹保存对话框（可勾选后续记住）；
  // 移动端存到 Music/Aurora Music 目录
  const handleDownload = useCallback(
    async (track: Track) => {
      if (!track.onlineUrl || downloadingIdsRef.current.has(track.id)) return
      setDownloadingIds((prev) => new Set(prev).add(track.id))
      try {
        // 取该曲来源配置的附加请求头（Referer/UA 等），保证下载与搜索请求一致
        const source = onlineSources.find((s) => s.id === track.onlineSource)
        const downloadDir = useLibraryStore.getState().downloadDir
        // 按设置的下载音质挑选地址（源未提供多音质地址时回退默认地址）
        const audioUrl = pickDownloadUrl(track, useLibraryStore.getState().downloadQuality)
        const { savedPath } = await platform.downloadOnlineTrack!(
          // 带上专辑与封面地址：下载完成后封面随文件嵌入（源直链的音频大多无内嵌封面）
          { audioUrl, title: track.title, artist: track.artist, album: track.album, coverUrl: track.coverUrl },
          source?.headers,
          downloadDir || undefined
        )
        if (downloadDir) {
          toast(`下载完成\n已保存到：${savedPath}`)
        } else {
          // 本次走了保存对话框：提供「设为默认下载目录」操作，点击后不再每次询问
          const dir = savedPath.replace(/[\\/][^\\/]*$/, '')
          toast(`下载完成\n已保存到：${savedPath}`, {
            action: {
              label: '设为默认下载目录',
              onClick: () => {
                useLibraryStore.getState().setDownloadDir(dir)
                toast(`后续下载将直接保存到「${dir}」，可在「设置 → 下载」中修改`)
              },
            },
          })
        }
      } catch (err: any) {
        // 用户在保存对话框点了取消，不算失败
        if (err?.message !== '已取消保存' && err?.message !== '缺少存储权限') {
          toast(err?.message || '下载失败，请稍后重试', { type: 'error' })
        }
      } finally {
        setDownloadingIds((prev) => {
          const next = new Set(prev)
          next.delete(track.id)
          return next
        })
      }
    },
    [onlineSources]
  )

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
      {/* 遮罩：点击关闭；轻模糊让底层音乐库退后但仍可辨识 */}
      <div
        className="absolute inset-0 bg-black/45 backdrop-blur-[3px] animate-in fade-in-0 duration-200"
        onClick={onClose}
      />

      {/* 浮层面板：顶部对齐的 Spotlight 面板，高度随结果自适应、最高 72vh */}
      <div className="relative mt-[7vh] w-[calc(100%-2rem)] max-w-2xl max-h-[72vh] flex flex-col glass-floating rounded-2xl overflow-hidden animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-200">
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
          <kbd className="hidden sm:flex items-center h-7 px-2 rounded-[8px] bg-white/[0.06] border border-white/[0.08] font-text text-[11px] text-white/40 flex-shrink-0">
            Esc
          </kbd>
        </div>

        {/* 结果区：内容超出时内部滚动，不撑破面板 */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-thin px-3 py-3">
          {!query.trim() ? (
            searchHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center min-h-[280px]">
                <div className="relative mb-5">
                  <div className="absolute -inset-10 bg-gradient-to-b from-mint/10 to-transparent rounded-full blur-3xl" />
                  <div className="relative w-[120px] h-[120px] rounded-[28px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                    <SearchIcon className="h-[52px] w-[52px] text-mint/60" strokeWidth={1} />
                  </div>
                </div>
                <p className="font-display text-[22px] font-semibold text-white/90 mb-2 tracking-[-0.3px]">开始搜索</p>
                <p className="font-text text-[13px] text-white/40 tracking-[-0.15px]">输入关键词搜索你的音乐库</p>
              </div>
            ) : (
              /* 历史搜索：有记录时空态展示，点击回搜，支持单条删除与一键清空 */
              <section>
                <div className="flex items-center justify-between mb-3 px-1">
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
            /* 本地/在线结果同屏：本地在上、在线在下 */
            <div className="space-y-5">
              {/* 本地结果 */}
              <section>
                <div className="flex items-center justify-between mb-3 px-1">
                  <h2 className="flex items-center gap-1.5 font-text text-[12px] font-semibold text-white/40 tracking-[-0.12px]">
                    <HardDrive className="h-3 w-3" strokeWidth={1.8} />
                    本地 ({localResults.length})
                  </h2>
                  {localResults.length > 30 && (
                    <span className="font-text text-[12px] text-white/35 tracking-[-0.12px]">
                      仅显示前 30 条
                    </span>
                  )}
                </div>
                {localResults.length === 0 ? (
                  <p className="px-1 py-4 text-center font-text text-[13px] text-white/35 tracking-[-0.15px]">
                    没有匹配 "{query}" 的本地歌曲
                  </p>
                ) : (
                  <div className="card-list overflow-hidden">
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
                  </div>
                )}
              </section>

              {/* 在线结果 */}
              <section>
                <h2 className="flex items-center gap-1.5 font-text text-[12px] font-semibold text-white/40 mb-3 px-1 tracking-[-0.12px]">
                  <Cloud className="h-3 w-3" strokeWidth={1.8} />
                  在线
                  {onlineLoading && (
                    <Loader2 className="h-3 w-3 text-mint/70 animate-spin" strokeWidth={1.8} />
                  )}
                </h2>
                {enabledSourceCount === 0 ? (
                  <div className="px-1 py-4 flex flex-col items-center gap-3">
                    <p className="font-text text-[13px] text-white/35 tracking-[-0.15px] text-center">
                      应用不内置任何音乐源，请先在设置中配置符合协议的搜索接口
                    </p>
                    <button
                      onClick={() => {
                        navigate('/settings')
                        onClose()
                      }}
                      className="pill pill-md bg-mint/[0.12] text-mint hover:bg-mint/20"
                    >
                      前往设置音乐源
                    </button>
                  </div>
                ) : onlineError ? (
                  <p className="px-1 py-4 text-center font-text text-[13px] text-coral/70 tracking-[-0.15px]">
                    {onlineError}
                  </p>
                ) : onlineLoading && onlineTracks.length === 0 ? (
                  <div className="px-1 py-4 flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 text-mint/60 animate-spin" strokeWidth={1.5} />
                    <span className="font-text text-[13px] text-white/40 tracking-[-0.15px]">正在搜索在线音乐...</span>
                  </div>
                ) : onlineTracks.length === 0 ? (
                  <p className="px-1 py-4 text-center font-text text-[13px] text-white/35 tracking-[-0.15px]">
                    没有匹配 "{query}" 的在线歌曲
                  </p>
                ) : (
                  <div className="space-y-5">
                    {onlineGroups.map((group) => (
                      <section key={group.key}>
                        <h2 className="font-text text-[12px] font-semibold text-white/40 mb-3 px-1 tracking-[-0.12px]">
                          {group.label} ({group.tracks.length})
                        </h2>
                        <div className="card-list overflow-hidden">
                          {group.tracks.map((track, idx) => (
                            <OnlineResultRow
                              key={track.id}
                              track={track}
                              idx={idx}
                              flatIdx={flatIdxById.get(track.id) ?? 0}
                              queue={group.tracks}
                              isActive={activeIdx >= 0 && flatIdxById.get(track.id) === activeIdx}
                              isDownloading={downloadingIds.has(track.id)}
                              onHover={handleHoverRow}
                              onPlay={handlePlayOnline}
                              onPlayNext={handlePlayNext}
                              onAddToQueue={handleAddToQueue}
                              onDownload={handleDownload}
                              registerRow={registerRow}
                            />
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
