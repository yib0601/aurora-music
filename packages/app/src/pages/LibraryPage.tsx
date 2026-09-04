import { useState, useCallback, useMemo, memo } from 'react'
import {
  FolderOpen, List, Grid3X3, Music as MusicIcon, Heart,
  Play, Plus, ListPlus, ListEnd, Disc3, RefreshCw,
  ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, Check, User, Search, X,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
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
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { isDesktop, formatTime, cn } from '@/lib/utils'
import { PageLayout } from '@/components/PageLayout'
import { SearchView } from '@/components/SearchView'
import { platform } from '@/services/platform'
import type { Track, SortField, LibraryTab } from '@/types'

/** 排序字段展示名 */
const SORT_LABELS: Record<SortField, string> = {
  default: '默认排序',
  title: '标题',
  artist: '艺术家',
  album: '专辑',
  duration: '时长',
  addedAt: '添加时间',
}

/** 音乐库浏览标签 */
const LIBRARY_TABS: { id: LibraryTab; label: string }[] = [
  { id: 'songs', label: '歌曲' },
  { id: 'albums', label: '专辑' },
  { id: 'artists', label: '艺术家' },
]

/** 专辑/艺术家分组 */
interface TrackGroup {
  key: string
  name: string
  subtitle: string
  coverPath?: string
  tracks: Track[]
}

/**
 * Apple 风格 LibraryPage
 * - 标题用 display-md 字号
 * - 表格无 glass，仅 hairline 分隔行
 * - 网格卡片用 card-utility（白底 + 1px hairline + 18px 圆角）
 * - 按钮统一 Apple 风格
 */
export function LibraryPage() {
  const navigate = useNavigate()
  const tracks = useLibraryStore((s) => s.tracks)
  const viewMode = useLibraryStore((s) => s.viewMode)
  const setViewMode = useLibraryStore((s) => s.setViewMode)
  const scanFolders = useLibraryStore((s) => s.scanFolders)
  const toggleLike = useLibraryStore((s) => s.toggleLike)
  const likedTracks = useLibraryStore((s) => s.likedTracks)
  const libraryTab = useLibraryStore((s) => s.libraryTab)
  const setLibraryTab = useLibraryStore((s) => s.setLibraryTab)
  const sortBy = useLibraryStore((s) => s.sortBy)
  const setSortBy = useLibraryStore((s) => s.setSortBy)
  const sortOrder = useLibraryStore((s) => s.sortOrder)
  const setSortOrder = useLibraryStore((s) => s.setSortOrder)
  const playlists = usePlaylistStore((s) => s.playlists)
  const createPlaylist = usePlaylistStore((s) => s.createPlaylist)
  const addTracksToPlaylist = usePlaylistStore((s) => s.addTracksToPlaylist)
  const [showNewPlaylistDialog, setShowNewPlaylistDialog] = useState(false)
  const [newPlName, setNewPlName] = useState('')
  const [pendingTrackId, setPendingTrackId] = useState<string | null>(null)
  // 搜索模式：由头部搜索图标切换，开启后内容区替换为 SearchView（本地过滤 + 在线搜索）
  const [searchOpen, setSearchOpen] = useState(false)
  // 专辑/艺术家分组详情：非 null 时内容区替换为该组的歌曲列表
  const [selectedGroup, setSelectedGroup] = useState<{ type: 'album' | 'artist'; key: string } | null>(null)

  const handlePickFolder = async () => {
    const folder = await platform.pickFolder()
    if (folder) {
      useLibraryStore.getState().addScanFolder(folder)
      // 扫描失败时平台会发送 scan:error 事件展示提示，这里吞掉 reject 即可
      await platform.scanFolder?.(folder).catch(() => {})
    }
  }

  // 重新扫描所有已配置目录，同步移除已删除文件对应的曲目记录
  const handleRescan = async () => {
    if (!platform.scanFolder || scanFolders.length === 0) return
    for (const folder of scanFolders) {
      await platform.scanFolder(folder).catch(() => {})
    }
  }

  const handlePlayTrack = useCallback((track: Track, index: number, queue: Track[]) => {
    usePlayerStore.getState().playQueue(queue, index)
  }, [])

  const handlePlayNext = (track: Track) => {
    usePlayerStore.getState().addToPlayNext(track)
  }

  const handleAddToQueue = (track: Track) => {
    usePlayerStore.getState().addToQueue(track)
  }

  const handleAddToPlaylist = (trackId: string, playlistId: string) => {
    addTracksToPlaylist(playlistId, [trackId])
  }

  const handleCreateAndAdd = () => {
    if (newPlName.trim() && pendingTrackId) {
      const pl = createPlaylist(newPlName.trim())
      addTracksToPlaylist(pl.id, [pendingTrackId])
      setNewPlName('')
      setPendingTrackId(null)
      setShowNewPlaylistDialog(false)
    }
  }

  // 中文排序：numeric 让 "歌2" 排在 "歌10" 前，sensitivity base 忽略大小写/音调
  const collator = useMemo(() => new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' }), [])

  // 歌曲排序：default 保持数据库顺序（艺术家 → 专辑 → 曲号 → 标题），desc 为整体反转
  const sortedTracks = useMemo(() => {
    if (sortBy === 'default' && sortOrder === 'asc') return tracks
    const arr = [...tracks]
    if (sortBy !== 'default') {
      arr.sort((a, b) => {
        switch (sortBy) {
          case 'title':
            return collator.compare(a.title, b.title)
          case 'artist':
            return collator.compare(a.artist, b.artist) || collator.compare(a.album, b.album) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0)
          case 'album':
            return collator.compare(a.album, b.album) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0)
          case 'duration':
            return a.duration - b.duration
          case 'addedAt':
            return a.addedAt - b.addedAt
          default:
            return 0
        }
      })
    }
    if (sortOrder === 'desc') arr.reverse()
    return arr
  }, [tracks, sortBy, sortOrder, collator])

  const filteredTracks = sortedTracks

  // 按专辑分组（同名专辑按艺术家区分），组内按曲号排序
  const albumGroups = useMemo<TrackGroup[]>(() => {
    const map = new Map<string, Track[]>()
    for (const t of tracks) {
      const key = JSON.stringify([t.album || '未知专辑', t.artist || '未知艺术家'])
      const list = map.get(key)
      if (list) list.push(t)
      else map.set(key, [t])
    }
    return [...map.entries()]
      .map(([key, ts]) => {
        const [name, artist] = JSON.parse(key) as [string, string]
        const sorted = [...ts].sort((a, b) => (a.trackNumber ?? 99) - (b.trackNumber ?? 99) || collator.compare(a.title, b.title))
        return { key, name, subtitle: artist, coverPath: ts.find((t) => t.coverPath)?.coverPath, tracks: sorted }
      })
      .sort((a, b) => collator.compare(a.name, b.name))
  }, [tracks, collator])

  // 按艺术家分组，组内按 专辑 → 曲号 排序
  const artistGroups = useMemo<TrackGroup[]>(() => {
    const map = new Map<string, Track[]>()
    for (const t of tracks) {
      const key = t.artist || '未知艺术家'
      const list = map.get(key)
      if (list) list.push(t)
      else map.set(key, [t])
    }
    return [...map.entries()]
      .map(([key, ts]) => {
        const sorted = [...ts].sort((a, b) => collator.compare(a.album, b.album) || (a.trackNumber ?? 99) - (b.trackNumber ?? 99) || collator.compare(a.title, b.title))
        return { key, name: key, subtitle: '', coverPath: ts.find((t) => t.coverPath)?.coverPath, tracks: sorted }
      })
      .sort((a, b) => collator.compare(a.name, b.name))
  }, [tracks, collator])

  // 当前选中的分组（tracks 变化后可能失效，找不到时回退到分组网格）
  const activeGroup = selectedGroup
    ? (selectedGroup.type === 'album' ? albumGroups : artistGroups).find((g) => g.key === selectedGroup.key) ?? null
    : null

  // 专辑/艺术家分组网格卡片
  const renderGroupGrid = (groups: TrackGroup[], type: 'album' | 'artist') => (
    <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {groups.map((g) => (
          <div
            key={g.key}
            className="group card-utility p-2.5 cursor-pointer"
            onClick={() => setSelectedGroup({ type, key: g.key })}
          >
            <div className="aspect-square rounded-xs bg-white/[0.04] mb-2.5 flex items-center justify-center overflow-hidden transition-transform duration-200 ease-apple group-hover:scale-[1.02]">
              {g.coverPath ? (
                <img src={platform.getCoverSrc(g.coverPath)} alt={g.name} className="w-full h-full object-cover product-shadow" />
              ) : type === 'album' ? (
                <Disc3 className="h-8 w-8 text-white/20" strokeWidth={1.5} />
              ) : (
                <User className="h-8 w-8 text-white/20" strokeWidth={1.5} />
              )}
            </div>
            <p className="font-text text-[14px] font-semibold truncate text-white tracking-[-0.224px]">
              {g.name}
            </p>
            <p className="font-text text-[12px] text-white/50 truncate mt-0.5 tracking-[-0.12px]">
              {g.subtitle ? `${g.subtitle} · ` : ''}{g.tracks.length} 首歌曲
            </p>
          </div>
        ))}
      </div>
    </div>
  )

  // ⚠️ 性能：memo 化 TrackRow，避免每次父组件 render 都重建所有行
  const TrackRow = memo(({ track, idx, queue }: { track: Track; idx: number; queue: Track[] }) => (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <tr
          key={track.id}
          className="row-hover cursor-pointer border-b border-white/5 last:border-0 hover:bg-mint/[0.075]"
          // 移动端无 hover/double-click 概念，改用单击触发播放；
          // 桌面端保留双击（避免误触，且单击只是 hover 显示播放图标）
          onClick={isDesktop() ? undefined : () => handlePlayTrack(track, idx, queue)}
          onDoubleClick={isDesktop() ? () => handlePlayTrack(track, idx, queue) : undefined}
        >
          <td className="py-2 px-1.5 md:py-2.5 md:px-3 max-w-xs">
            <div className="flex items-center gap-3 min-w-0">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  navigate(`/song/${track.id}`)
                }}
                title="查看歌曲详情"
                className="w-11 h-11 md:w-9 md:h-9 rounded-lg md:rounded-[6px] bg-white/[0.04] flex items-center justify-center overflow-hidden flex-shrink-0 transition-transform duration-200 ease-apple hover:scale-105"
              >
                {track.coverPath ? (
                  <img src={platform.getCoverSrc(track.coverPath)} alt="" className="w-full h-full object-cover product-shadow" />
                ) : (
                  <Disc3 className="h-4 w-4 text-white/30" strokeWidth={1.5} />
                )}
              </button>
              <div className="min-w-0">
                <span className="block font-text font-semibold text-[14px] truncate text-white tracking-[-0.224px]">
                  {track.title}
                </span>
                {/* 移动端隐藏艺术家列，改为标题下方第二行展示 */}
                <span className="block md:hidden font-text text-[12px] text-white/40 truncate mt-0.5 tracking-[-0.12px]">
                  {track.artist}
                </span>
              </div>
            </div>
          </td>
          <td className="py-2.5 px-3 font-text text-white/50 text-[14px] truncate max-w-40 tracking-[-0.224px] hidden md:table-cell">
            {track.artist}
          </td>
          <td className="py-2.5 px-3 font-text text-white/45 text-[14px] truncate max-w-48 hidden md:table-cell tracking-[-0.224px]">
            {track.album}
          </td>
          <td className="py-2 px-1 md:py-2.5 md:px-2 w-10">
            <button
              onClick={(e) => {
                e.stopPropagation()
                toggleLike(track.id)
              }}
              // 移动端无 hover，收藏按钮需常显；桌面端保持 hover 显示
              className="opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-200 ease-apple p-1.5 md:p-1 hover:bg-mint/[0.075] rounded-xs"
            >
              <Heart
                className={cn('h-4 w-4 md:h-3.5 md:w-3.5', likedTracks.has(track.id) ? 'text-coral fill-coral' : 'text-white/40')}
                strokeWidth={1.5}
              />
            </button>
          </td>
          <td className="py-2 pr-1.5 pl-1 md:py-2.5 md:px-3 text-right font-text text-white/45 text-[12px] md:text-[13px] tabular-nums w-12 md:w-16 tracking-[-0.12px]">
            {formatTime(track.duration)}
          </td>
        </tr>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={() => handlePlayTrack(track, idx, queue)}>
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
            <ListPlus className="h-4 w-4 mr-2" strokeWidth={1.5} />
            添加到播放列表
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48">
            {playlists.length === 0 ? (
              <ContextMenuItem
                onClick={() => {
                  setPendingTrackId(track.id)
                  setShowNewPlaylistDialog(true)
                }}
              >
                <Plus className="h-4 w-4 mr-2" strokeWidth={1.5} />
                新建播放列表...
              </ContextMenuItem>
            ) : (
              <>
                {playlists.map((pl) => (
                  <ContextMenuItem key={pl.id} onClick={() => handleAddToPlaylist(track.id, pl.id)}>
                    <ListPlus className="h-4 w-4 mr-2 opacity-50" strokeWidth={1.5} />
                    {pl.name}
                  </ContextMenuItem>
                ))}
                <ContextMenuSeparator />
                <ContextMenuItem
                  onClick={() => {
                    setPendingTrackId(track.id)
                    setShowNewPlaylistDialog(true)
                  }}
                >
                  <Plus className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  新建播放列表...
                </ContextMenuItem>
              </>
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => toggleLike(track.id)}>
          <Heart className={cn('h-4 w-4 mr-2', likedTracks.has(track.id) && 'fill-coral text-coral')} strokeWidth={1.5} />
          {likedTracks.has(track.id) ? '取消收藏' : '收藏'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  ))
  TrackRow.displayName = 'TrackRow'

  return (
    <PageLayout
      header={
        // 标题与工具栏同行：工具栏右对齐到内容列边缘，与标题共享同一视觉轴，
        // 替代旧版负 margin 悬浮方案（标题/工具栏错位且间距脆弱）
        <div className="flex items-end justify-between gap-4 mb-6 md:mb-8">
          <div className="min-w-0">
            <h1 className="font-display text-[24px] md:text-[32px] font-semibold tracking-[-0.374px] text-white/98 leading-tight">
              音乐库
            </h1>
            <p className="font-text text-[13px] text-white/50 mt-1 tracking-[-0.2px]">
              {tracks.length === 0 ? '导入音乐，开始构建你的专属音乐库' : `${tracks.length} 首歌曲`}
            </p>
          </div>
          {/* 工具栏：搜索图标常驻（本地无歌时也可用在线搜索）；重扫/视图切换仅列表态显示 */}
          <div className="flex items-center gap-2 flex-shrink-0 pb-1">
            <button
              onClick={() => setSearchOpen((v) => !v)}
              title={searchOpen ? '关闭搜索' : '搜索'}
              className={cn(
                'h-7 w-7 flex items-center justify-center rounded-[10px] transition-all duration-200 ease-apple',
                searchOpen ? 'text-mint bg-mint/[0.12]' : 'text-white/60 hover:text-white hover:bg-white/[0.05]'
              )}
            >
              {searchOpen ? (
                <X className="h-3.5 w-3.5" strokeWidth={1.5} />
              ) : (
                <Search className="h-3.5 w-3.5" strokeWidth={1.5} />
              )}
            </button>
            {!searchOpen && tracks.length > 0 && libraryTab === 'songs' && (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      title="排序方式"
                      className="h-7 px-2 flex items-center gap-1.5 rounded-[10px] text-white/60 hover:text-white hover:bg-white/[0.05] transition-all duration-200 ease-apple"
                    >
                      <ArrowUpDown className="h-3.5 w-3.5" strokeWidth={1.5} />
                      <span className="font-text text-[12px] hidden sm:inline">{SORT_LABELS[sortBy]}</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-36">
                    {(Object.keys(SORT_LABELS) as SortField[]).map((field) => (
                      <DropdownMenuItem key={field} onClick={() => setSortBy(field)}>
                        <span className="flex-1">{SORT_LABELS[field]}</span>
                        {sortBy === field && <Check className="h-3.5 w-3.5 text-mint" strokeWidth={2} />}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <button
                  onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                  title={sortOrder === 'asc' ? '当前升序，点击切换为降序' : '当前降序，点击切换为升序'}
                  className="h-7 w-7 flex items-center justify-center rounded-[10px] text-white/60 hover:text-white hover:bg-white/[0.05] transition-all duration-200 ease-apple"
                >
                  {sortOrder === 'asc' ? (
                    <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.5} />
                  ) : (
                    <ArrowDown className="h-3.5 w-3.5" strokeWidth={1.5} />
                  )}
                </button>
              </>
            )}
            {!searchOpen && tracks.length > 0 && scanFolders.length > 0 && (
              <button
                onClick={handleRescan}
                title="重新扫描，同步已删除的歌曲"
                className="h-7 w-7 flex items-center justify-center rounded-[10px] text-white/60 hover:text-white hover:bg-white/[0.05] transition-all duration-200 ease-apple"
              >
                <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} />
              </button>
            )}
            {!searchOpen && tracks.length > 0 && libraryTab === 'songs' && (
              <div className="flex rounded-[10px] overflow-hidden border border-white/5 bg-white/[0.04] p-0.5">
                <button
                  className={cn(
                    'h-7 w-7 flex items-center justify-center rounded-[8px] transition-all duration-200 ease-apple',
                    viewMode === 'list' ? 'bg-mint text-black' : 'text-white/60 hover:text-white hover:bg-white/[0.05]'
                  )}
                  onClick={() => setViewMode('list')}
                >
                  <List className="h-3.5 w-3.5" strokeWidth={1.5} />
                </button>
                <button
                  className={cn(
                    'h-7 w-7 flex items-center justify-center rounded-[8px] transition-all duration-200 ease-apple',
                    viewMode === 'grid' ? 'bg-mint text-black' : 'text-white/60 hover:text-white hover:bg-white/[0.05]'
                  )}
                  onClick={() => setViewMode('grid')}
                >
                  <Grid3X3 className="h-3.5 w-3.5" strokeWidth={1.5} />
                </button>
              </div>
            )}
          </div>
        </div>
      }
    >
      {searchOpen ? (
        <SearchView />
      ) : tracks.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center">
          <div className="relative mb-6">
            <div className="absolute -inset-16 bg-gradient-to-b from-mint/8 to-transparent rounded-full blur-3xl" />
            <div className="relative w-[120px] h-[120px] rounded-[28px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
              <MusicIcon className="h-[52px] w-[52px] text-mint/60" strokeWidth={1} />
            </div>
          </div>
          <h2 className="font-display text-[22px] font-semibold text-white/90 mb-2 tracking-[-0.3px]">
            还没有音乐
          </h2>
          <p className="font-text text-[14px] text-white/40 mb-6 tracking-[-0.15px]">
            导入你的音乐文件夹，开始构建你的专属音乐库
          </p>
          <button
            onClick={handlePickFolder}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-mint text-mint-fg font-semibold text-[14px] hover:brightness-110 transition-all duration-200 active:scale-95"
          >
            <FolderOpen className="h-4 w-4" strokeWidth={1.6} />
            导入音乐
          </button>
        </div>
      ) : (
        <>
          {/* 浏览标签：歌曲 / 专辑 / 艺术家 */}
          <div className="flex items-center gap-1 mb-4 md:mb-5 w-fit rounded-[10px] border border-white/5 bg-white/[0.04] p-0.5">
            {LIBRARY_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  setLibraryTab(tab.id)
                  setSelectedGroup(null)
                }}
                className={cn(
                  'h-7 px-3.5 rounded-[8px] font-text text-[13px] transition-all duration-200 ease-apple',
                  libraryTab === tab.id ? 'bg-mint text-black font-semibold' : 'text-white/60 hover:text-white hover:bg-white/[0.05]'
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeGroup ? (
        // 分组详情：返回 + 组信息 + 播放全部 + 该组歌曲列表
        <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
          <div className="flex items-center gap-3 mb-4 md:mb-5">
            <button
              onClick={() => setSelectedGroup(null)}
              title="返回"
              className="h-8 w-8 flex-shrink-0 flex items-center justify-center rounded-[10px] text-white/60 hover:text-white hover:bg-white/[0.05] transition-all duration-200 ease-apple"
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
            </button>
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-[18px] md:text-[20px] font-semibold text-white truncate tracking-[-0.3px]">
                {activeGroup.name}
              </h2>
              <p className="font-text text-[12px] text-white/50 truncate mt-0.5">
                {activeGroup.subtitle ? `${activeGroup.subtitle} · ` : ''}{activeGroup.tracks.length} 首歌曲
              </p>
            </div>
            <button
              onClick={() => handlePlayTrack(activeGroup.tracks[0], 0, activeGroup.tracks)}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-mint text-mint-fg font-semibold text-[12px] hover:brightness-110 transition-all duration-200 active:scale-95 flex-shrink-0"
            >
              <Play className="h-3.5 w-3.5" strokeWidth={1.6} />
              播放全部
            </button>
          </div>
          <table className="w-full font-text">
            <tbody>
              {activeGroup.tracks.map((track, idx) => (
                <TrackRow key={track.id} track={track} idx={idx} queue={activeGroup.tracks} />
              ))}
            </tbody>
          </table>
        </div>
      ) : libraryTab === 'albums' ? (
        renderGroupGrid(albumGroups, 'album')
      ) : libraryTab === 'artists' ? (
        renderGroupGrid(artistGroups, 'artist')
      ) : viewMode === 'list' ? (
        <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
          <table className="w-full font-text">
            {/* 移动端空间宝贵，隐藏表头（列表语义已由双行布局表达） */}
            <thead className="hidden md:table-header-group">
              <tr className="border-b border-white/10">
                <th className="text-left py-2.5 px-3 font-semibold text-white/50 text-[12px] tracking-[-0.12px]">标题</th>
                <th className="text-left py-2.5 px-3 font-semibold text-white/50 text-[12px] tracking-[-0.12px]">艺术家</th>
                <th className="text-left py-2.5 px-3 font-semibold text-white/50 text-[12px] tracking-[-0.12px]">专辑</th>
                <th className="w-10"></th>
                <th className="text-right py-2.5 px-3 font-semibold text-white/50 text-[12px] w-16 tracking-[-0.12px]">时长</th>
              </tr>
            </thead>
            <tbody>
              {filteredTracks.map((track, idx) => (
                <TrackRow key={track.id} track={track} idx={idx} queue={filteredTracks} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {filteredTracks.map((track) => (
              <ContextMenu key={track.id}>
                <ContextMenuTrigger asChild>
                  <div
                    className="group card-utility p-2.5 cursor-pointer"
                    // 移动端单击卡片即播放；桌面端保留双击，封面单击仍进详情
                    onClick={isDesktop() ? undefined : () => handlePlayTrack(track, tracks.findIndex((t) => t.id === track.id), filteredTracks)}
                    onDoubleClick={() => handlePlayTrack(track, tracks.findIndex((t) => t.id === track.id), filteredTracks)}
                  >
                    <div
                      onClick={(e) => {
                        e.stopPropagation()
                        navigate(`/song/${track.id}`)
                      }}
                      title="查看歌曲详情"
                      className="aspect-square rounded-xs bg-white/[0.04] mb-2.5 flex items-center justify-center overflow-hidden relative cursor-pointer transition-transform duration-200 ease-apple group-hover:scale-[1.02]"
                    >
                      {track.coverPath ? (
                        <img
                          src={platform.getCoverSrc(track.coverPath)}
                          alt={track.title}
                          className="w-full h-full object-cover product-shadow"
                        />
                      ) : (
                        <MusicIcon className="h-8 w-8 text-white/20" strokeWidth={1.5} />
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleLike(track.id)
                        }}
                        // 移动端无 hover：已收藏的红心常显，未收藏的保持隐藏避免遮挡封面
                        className={cn(
                          'absolute top-2 right-2 transition-opacity duration-200 ease-apple bg-black/40 rounded-pill p-1 hover:scale-105',
                          likedTracks.has(track.id) ? 'opacity-100 md:opacity-0 md:group-hover:opacity-100' : 'opacity-0 group-hover:opacity-100'
                        )}
                      >
                        <Heart
                          className={cn('h-3.5 w-3.5', likedTracks.has(track.id) ? 'text-coral fill-coral' : 'text-white')}
                          strokeWidth={1.5}
                        />
                      </button>
                    </div>
                    <p className="font-text text-[14px] font-semibold truncate text-white tracking-[-0.224px]">
                      {track.title}
                    </p>
                    <p className="font-text text-[12px] text-white/50 truncate mt-0.5 tracking-[-0.12px]">
                      {track.artist}
                    </p>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-52">
                  <ContextMenuItem onClick={() => handlePlayTrack(track, tracks.findIndex((t) => t.id === track.id), filteredTracks)}>
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
                  <ContextMenuItem onClick={() => toggleLike(track.id)}>
                    <Heart className={cn('h-4 w-4 mr-2', likedTracks.has(track.id) && 'fill-coral text-coral')} strokeWidth={1.5} />
                    {likedTracks.has(track.id) ? '取消收藏' : '收藏'}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        </div>
      )}
      </>
    )}

      <Dialog open={showNewPlaylistDialog} onOpenChange={setShowNewPlaylistDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>新建播放列表</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="播放列表名称"
            value={newPlName}
            onChange={(e) => setNewPlName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateAndAdd()
            }}
          />
          <DialogFooter>
            <Button variant="secondary" onClick={() => setShowNewPlaylistDialog(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={handleCreateAndAdd}>创建并添加</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageLayout>
  )
}
