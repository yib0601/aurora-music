import { useState, useMemo, useEffect, useRef, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Search as SearchIcon, Play, Plus, ListEnd, Music2, Heart, Loader2, Cloud, HardDrive, History, X, Download } from 'lucide-react'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { useNavigate } from 'react-router-dom'
import { platform } from '@/services/platform'
import { CoverImage } from '@/components/common/CoverImage'
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
import type { Track, OnlineTrackSearchResult, DownloadQuality } from '@/types'

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

interface SearchOverlayProps {
  /** 关闭浮层（Esc / 点击遮罩 / 选中结果后调用） */
  onClose: () => void
}

/**
 * Spotlight 风格搜索浮层（Liquid Glass）
 * - 以 portal 挂到 body，覆盖在音乐库之上，底层界面完全不改动
 * - 顶部玻璃面板：搜索框 + 本地/在线结果，Esc / 点击遮罩关闭
 * - 键盘：↑/↓ 移动高亮、Enter 播放高亮项（无高亮时记录搜索历史）
 * - 结果行用 row-hover + hairline 分隔；封面 rounded-xs + product-shadow
 * - 本地走内存过滤，在线按用户配置的歌源协议搜索
 */
export function SearchOverlay({ onClose }: SearchOverlayProps) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [tab, setTab] = useState<'local' | 'online'>('local')
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

  // 在线搜索：tab=online 且 query 非空时触发
  useEffect(() => {
    const q = debouncedQuery.trim()
    if (tab !== 'online' || !q) {
      setOnlineResults([])
      setOnlineError(null)
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
  }, [debouncedQuery, tab, onlineSources, downloadQuality])

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

  // 键盘可操作的结果列表（本地只展示前 30 条，需与渲染保持一致）
  const activeList = useMemo(
    () => (tab === 'local' ? localResults.slice(0, 30) : onlineLoading || onlineError ? [] : onlineTracks),
    [tab, localResults, onlineTracks, onlineLoading, onlineError]
  )

  // 查询/标签变化后旧的高亮已失效，重置
  useEffect(() => {
    setActiveIdx(-1)
  }, [debouncedQuery, tab])

  // 高亮移动时把对应行滚入可视区
  useEffect(() => {
    if (activeIdx < 0) return
    const track = activeList[activeIdx]
    if (track) rowRefs.current.get(track.id)?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, activeList])

  const handlePlayTrack = (track: Track, index: number, queue: Track[]) => {
    usePlayerStore.getState().playQueue(queue, index)
  }

  const handlePlayNext = (track: Track) => {
    usePlayerStore.getState().addToPlayNext(track)
  }

  const handleAddToQueue = (track: Track) => {
    usePlayerStore.getState().addToQueue(track)
  }

  // 下载在线歌曲：桌面端有默认下载目录则直存，否则弹保存对话框（可勾选后续记住）；
  // 移动端存到 Music/Aurora Music 目录
  const handleDownload = async (track: Track) => {
    if (!track.onlineUrl || downloadingIds.has(track.id)) return
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
        alert(`下载完成\n已保存到：${savedPath}`)
      } else {
        // 本次走了保存对话框：询问是否把所选目录设为默认下载目录
        const dir = savedPath.replace(/[\\/][^\\/]*$/, '')
        if (window.confirm(`下载完成\n已保存到：${savedPath}\n\n后续下载都保存到「${dir}」，不再询问吗？\n（可随时在「设置 → 下载」中修改）`)) {
          useLibraryStore.getState().setDownloadDir(dir)
        }
      }
    } catch (err: any) {
      // 用户在保存对话框点了取消，不算失败
      if (err?.message !== '已取消保存' && err?.message !== '缺少存储权限') {
        alert(err?.message || '下载失败，请稍后重试')
      }
    } finally {
      setDownloadingIds((prev) => {
        const next = new Set(prev)
        next.delete(track.id)
        return next
      })
    }
  }

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
        handlePlayTrack(track, activeIdx, activeList)
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

  // 行高亮态：鼠标悬停与键盘移动共用同一 activeIdx，保证两种输入方式视觉一致
  const rowActiveClass = (idx: number) => (idx >= 0 && idx === activeIdx ? 'bg-mint/[0.075]' : '')

  const setRowRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(id, el)
    else rowRefs.current.delete(id)
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
            <>
              {/* 本地/在线 tab 切换 */}
              <div className="flex items-center gap-1 mb-3 px-1">
                <button
                  onClick={() => setTab('local')}
                  className={cn(
                    'flex items-center gap-1.5 h-7 px-3.5 rounded-full text-[12px] font-semibold tracking-[-0.12px] transition-colors duration-200 ease-apple',
                    tab === 'local'
                      ? 'bg-mint/[0.12] text-mint'
                      : 'text-white/60 hover:text-white/90 hover:bg-white/[0.06]'
                  )}
                >
                  <HardDrive className="h-3 w-3" strokeWidth={1.8} />
                  本地 ({localResults.length})
                </button>
                <button
                  onClick={() => setTab('online')}
                  className={cn(
                    'flex items-center gap-1.5 h-7 px-3.5 rounded-full text-[12px] font-semibold tracking-[-0.12px] transition-colors duration-200 ease-apple',
                    tab === 'online'
                      ? 'bg-mint/[0.12] text-mint'
                      : 'text-white/60 hover:text-white/90 hover:bg-white/[0.06]'
                  )}
                >
                  <Cloud className="h-3 w-3" strokeWidth={1.8} />
                  在线
                </button>
              </div>

              {tab === 'local' ? (
                localResults.length === 0 ? (
                  <div className="flex flex-col items-center justify-center min-h-[280px]">
                    <div className="relative mb-5">
                      <div className="absolute -inset-10 bg-gradient-to-b from-coral/10 to-transparent rounded-full blur-3xl" />
                      <div className="relative w-[120px] h-[120px] rounded-[28px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                        <Music2 className="h-[52px] w-[52px] text-coral/60" strokeWidth={1} />
                      </div>
                    </div>
                    <p className="font-display text-[22px] font-semibold text-white/90 mb-2 tracking-[-0.3px]">未找到结果</p>
                    <p className="font-text text-[14px] text-white/40 tracking-[-0.15px]">没有匹配 "{query}" 的本地歌曲</p>
                  </div>
                ) : (
                  <div className="space-y-5">
                    <section>
                      {/* 结果计数收束：让单条/少量结果不再悬空 */}
                      <div className="flex items-center justify-between mb-3 px-1">
                        <h2 className="font-text text-[12px] font-semibold text-white/50 tracking-[-0.12px]">
                          共 {localResults.length} 条结果
                        </h2>
                        {localResults.length > 30 && (
                          <span className="font-text text-[12px] text-white/35 tracking-[-0.12px]">
                            仅显示前 30 条
                          </span>
                        )}
                      </div>
                      <div className="card-list overflow-hidden">
                        {localResults.slice(0, 30).map((track, idx) => (
                          <ContextMenu key={track.id}>
                            <ContextMenuTrigger asChild>
                              <div
                                ref={setRowRef(track.id)}
                                onMouseEnter={() => setActiveIdx(idx)}
                                className={cn(
                                  'row-hover flex items-center gap-3 px-4 py-2.5 cursor-pointer group border-b border-white/5 last:border-0 hover:bg-mint/[0.075]',
                                  rowActiveClass(idx)
                                )}
                                onDoubleClick={() => handlePlayTrack(track, idx, localResults)}
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
                                    navigate(`/song/${track.id}`)
                                    onClose()
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
                                    toggleLike(track.id)
                                  }}
                                  className="h-7 w-7 flex items-center justify-center rounded-[8px] opacity-0 group-hover:opacity-100 transition-opacity duration-200 ease-apple hover:bg-mint/[0.075]"
                                >
                                  <Heart
                                    className={cn('h-3.5 w-3.5', likedTracks.has(track.id) ? 'text-coral fill-coral' : 'text-white/40')}
                                    strokeWidth={1.7}
                                  />
                                </button>
                              </div>
                            </ContextMenuTrigger>
                            <ContextMenuContent className="w-52 z-[90]">
                              <ContextMenuItem onClick={() => handlePlayTrack(track, idx, localResults)}>
                                <Play className="h-4 w-4 mr-2" strokeWidth={1.5} />
                                立即播放
                              </ContextMenuItem>
                              <ContextMenuItem onClick={() => handlePlayNext(track)}>
                                <ListEnd className="h-4 w-4 mr-2" strokeWidth={1.5} />
                                下一首播放
                              </ContextMenuItem>
                              <ContextMenuItem onClick={() => handleAddToQueue(track)}>
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
                                      <ContextMenuItem key={pl.id} onClick={() => addTracksToPlaylist(pl.id, [track.id])}>
                                        {pl.name}
                                      </ContextMenuItem>
                                    ))
                                  )}
                                </ContextMenuSubContent>
                              </ContextMenuSub>
                            </ContextMenuContent>
                          </ContextMenu>
                        ))}
                      </div>
                    </section>
                  </div>
                )
              ) : enabledSourceCount === 0 ? (
                <div className="flex flex-col items-center justify-center min-h-[280px]">
                  <div className="relative mb-5">
                    <div className="absolute -inset-10 bg-gradient-to-b from-mint/10 to-transparent rounded-full blur-3xl" />
                    <div className="relative w-[120px] h-[120px] rounded-[28px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                      <Cloud className="h-[52px] w-[52px] text-mint/60" strokeWidth={1} />
                    </div>
                  </div>
                  <p className="font-display text-[22px] font-semibold text-white/90 mb-2 tracking-[-0.3px]">未配置音乐源</p>
                  <p className="font-text text-[14px] text-white/40 tracking-[-0.15px] mb-5 text-center max-w-xs">
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
              ) : onlineLoading ? (
                <div className="flex flex-col items-center justify-center min-h-[280px]">
                  <Loader2 className="h-10 w-10 text-mint/60 animate-spin mb-4" strokeWidth={1.5} />
                  <p className="font-text text-[14px] text-white/50 tracking-[-0.15px]">正在搜索在线音乐...</p>
                </div>
              ) : onlineError ? (
                <div className="flex flex-col items-center justify-center min-h-[280px]">
                  <div className="relative mb-5">
                    <div className="absolute -inset-10 bg-gradient-to-b from-coral/10 to-transparent rounded-full blur-3xl" />
                    <div className="relative w-[120px] h-[120px] rounded-[28px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                      <Music2 className="h-[52px] w-[52px] text-coral/60" strokeWidth={1} />
                    </div>
                  </div>
                  <p className="font-display text-[22px] font-semibold text-white/90 mb-2 tracking-[-0.3px]">搜索失败</p>
                  <p className="font-text text-[14px] text-white/40 tracking-[-0.15px]">{onlineError}</p>
                </div>
              ) : onlineTracks.length === 0 ? (
                <div className="flex flex-col items-center justify-center min-h-[280px]">
                  <div className="relative mb-5">
                    <div className="absolute -inset-10 bg-gradient-to-b from-coral/10 to-transparent rounded-full blur-3xl" />
                    <div className="relative w-[120px] h-[120px] rounded-[28px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                      <Music2 className="h-[52px] w-[52px] text-coral/60" strokeWidth={1} />
                    </div>
                  </div>
                  <p className="font-display text-[22px] font-semibold text-white/90 mb-2 tracking-[-0.3px]">未找到结果</p>
                  <p className="font-text text-[14px] text-white/40 tracking-[-0.15px]">没有匹配 "{query}" 的在线歌曲</p>
                </div>
              ) : (
                <div className="space-y-5">
                  {onlineGroups.map((group) => (
                    <section key={group.key}>
                      <h2 className="font-text text-[12px] font-semibold text-white/40 mb-3 px-1 tracking-[-0.12px]">
                        {group.label} ({group.tracks.length})
                      </h2>
                      <div className="card-list overflow-hidden">
                        {group.tracks.map((track, idx) => {
                          // 找到该曲目在 onlineResults 中的原始索引，用于取封面 URL
                          const resultIdx = onlineResults.findIndex((r) => r.id === track.id)
                          // 分组内的 idx 需换算成全局下标，才能与键盘高亮 activeIdx 对齐
                          const flatIdx = activeList.findIndex((t) => t.id === track.id)
                          return (
                            <ContextMenu key={track.id}>
                              <ContextMenuTrigger asChild>
                                <div
                                  ref={setRowRef(track.id)}
                                  onMouseEnter={() => setActiveIdx(flatIdx)}
                                  className={cn(
                                    'row-hover flex items-center gap-3 px-4 py-2.5 cursor-pointer group border-b border-white/5 last:border-0 hover:bg-mint/[0.075]',
                                    rowActiveClass(flatIdx)
                                  )}
                                  onDoubleClick={() => handlePlayTrack(track, idx, group.tracks)}
                                >
                                  {/* 序号/播放图标叠放在固定宽度容器内切换，避免 hover 时布局抖动 */}
                                  <span className="w-6 flex-shrink-0 flex items-center justify-center relative">
                                    <span className="font-text text-[12px] text-white/35 tabular-nums tracking-[-0.12px] transition-opacity duration-150 group-hover:opacity-0">
                                      {idx + 1}
                                    </span>
                                    <Play className="w-3 h-3 absolute text-mint opacity-0 transition-opacity duration-150 group-hover:opacity-100" strokeWidth={1.8} />
                                  </span>
                                  <div className="w-10 h-10 rounded-[8px] bg-white/[0.04] flex items-center justify-center flex-shrink-0 overflow-hidden">
                                    {onlineResults[resultIdx]?.coverUrl ? (
                                      <img src={onlineResults[resultIdx].coverUrl} alt="" className="w-full h-full object-cover product-shadow" referrerPolicy="no-referrer" />
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
                                      handleDownload(track)
                                    }}
                                    title="下载歌曲"
                                    disabled={downloadingIds.has(track.id)}
                                    className={cn(
                                      'h-7 w-7 flex items-center justify-center rounded-[8px] transition-opacity duration-200 ease-apple',
                                      downloadingIds.has(track.id)
                                        ? 'opacity-100 text-mint'
                                        : 'opacity-0 group-hover:opacity-100 hover:bg-mint/[0.075] text-white/40'
                                    )}
                                  >
                                    {downloadingIds.has(track.id) ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.7} />
                                    ) : (
                                      <Download className="h-3.5 w-3.5" strokeWidth={1.7} />
                                    )}
                                  </button>
                                </div>
                              </ContextMenuTrigger>
                              <ContextMenuContent className="w-52 z-[90]">
                                <ContextMenuItem onClick={() => handlePlayTrack(track, idx, group.tracks)}>
                                  <Play className="h-4 w-4 mr-2" strokeWidth={1.5} />
                                  立即播放
                                </ContextMenuItem>
                                <ContextMenuItem onClick={() => handlePlayNext(track)}>
                                  <ListEnd className="h-4 w-4 mr-2" strokeWidth={1.5} />
                                  下一首播放
                                </ContextMenuItem>
                                <ContextMenuItem onClick={() => handleAddToQueue(track)}>
                                  <Plus className="h-4 w-4 mr-2" strokeWidth={1.5} />
                                  添加到队列
                                </ContextMenuItem>
                                <ContextMenuSeparator />
                                <ContextMenuItem
                                  onClick={() => handleDownload(track)}
                                  disabled={downloadingIds.has(track.id)}
                                >
                                  {downloadingIds.has(track.id) ? (
                                    <Loader2 className="h-4 w-4 mr-2 animate-spin" strokeWidth={1.5} />
                                  ) : (
                                    <Download className="h-4 w-4 mr-2" strokeWidth={1.5} />
                                  )}
                                  下载歌曲
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>
                          )
                        })}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
