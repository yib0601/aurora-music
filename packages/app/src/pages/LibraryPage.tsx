import { useState, useCallback, useMemo, useEffect, useRef, memo } from 'react'
import {
  FolderOpen, List, Grid3X3, Music as MusicIcon, Heart,
  Play, Plus, ListPlus, ListEnd, Disc3, RefreshCw,
  ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, Check, User, Search,
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
import { SearchOverlay } from '@/components/SearchOverlay'
import { platform } from '@/services/platform'
import { CoverImage } from '@/components/common/CoverImage'
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
  /** 代表曲目 id：分组封面缺失时，用它的内嵌封面按需补齐 */
  coverTrackId?: string
  tracks: Track[]
}

/** 未启用分组浏览时的空结果（保持引用稳定，避免无谓的重渲染） */
const EMPTY_GROUPS: TrackGroup[] = []

/**
 * 「添加到播放列表」子菜单内容。
 * 单独抽成组件订阅 playlistStore：播放列表增删只重渲染这个小组件，
 * 不会牵连整张歌曲表（数千行时一次全表重渲染就是几百毫秒的卡顿）。
 */
const PlaylistSubmenuItems = memo(function PlaylistSubmenuItems({
  trackId,
  onCreatePlaylist,
}: {
  trackId: string
  onCreatePlaylist: (trackId: string) => void
}) {
  const playlists = usePlaylistStore((s) => s.playlists)

  if (playlists.length === 0) {
    return (
      <ContextMenuItem onClick={() => onCreatePlaylist(trackId)}>
        <Plus className="h-4 w-4 mr-2" strokeWidth={1.5} />
        新建播放列表...
      </ContextMenuItem>
    )
  }

  return (
    <>
      {playlists.map((pl) => (
        <ContextMenuItem
          key={pl.id}
          onClick={() => usePlaylistStore.getState().addTracksToPlaylist(pl.id, [trackId])}
        >
          <ListPlus className="h-4 w-4 mr-2 opacity-50" strokeWidth={1.5} />
          {pl.name}
        </ContextMenuItem>
      ))}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onCreatePlaylist(trackId)}>
        <Plus className="h-4 w-4 mr-2" strokeWidth={1.5} />
        新建播放列表...
      </ContextMenuItem>
    </>
  )
})

/**
 * 音乐库歌曲行。
 * ⚠️ 必须定义在 LibraryPage 之外：若写在组件体内，每次父组件 render 都会生成
 * 新的组件类型，React 会把整张表的行全部卸载重建 —— 数千行时单次更新要数秒，
 * 且已打开的右键菜单（含「添加到播放列表」子菜单）会随之被销毁而"点不动"。
 * 只接收可比较的基本类型/稳定引用 props，其余动作直接走 store.getState()。
 */
const TrackRow = memo(function TrackRow({
  track,
  idx,
  liked,
  onPlay,
  onCreatePlaylist,
}: {
  track: Track
  idx: number
  liked: boolean
  onPlay: (idx: number) => void
  onCreatePlaylist: (trackId: string) => void
}) {
  const navigate = useNavigate()

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <tr
          className="row-hover cursor-pointer border-b border-white/5 last:border-0 hover:bg-mint/[0.075]"
          // 移动端无 hover/double-click 概念，改用单击触发播放；
          // 桌面端保留双击（避免误触，且单击只是 hover 显示播放图标）
          onClick={isDesktop() ? undefined : () => onPlay(idx)}
          onDoubleClick={isDesktop() ? () => onPlay(idx) : undefined}
        >
          <td className="py-2 px-1.5 md:py-2.5 md:px-3 max-w-xs">
            <div className="flex items-center gap-3 min-w-0">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  navigate(`/song/${track.id}`)
                }}
                title="查看歌曲详情"
                className="w-11 h-11 md:w-9 md:h-9 rounded-[8px] bg-white/[0.04] flex items-center justify-center overflow-hidden flex-shrink-0 transition-transform duration-200 ease-apple hover:scale-105"
              >
                <CoverImage
                  track={track}
                  className="w-full h-full object-cover product-shadow"
                  fallback={<Disc3 className="h-4 w-4 text-white/30" strokeWidth={1.5} />}
                />
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
                useLibraryStore.getState().toggleLike(track.id)
              }}
              // 移动端无 hover，收藏按钮需常显；桌面端保持 hover 显示
              className="btn-icon opacity-100 md:opacity-0 md:group-hover:opacity-100"
            >
              <Heart
                className={cn('h-4 w-4 md:h-3.5 md:w-3.5', liked ? 'text-coral fill-coral' : 'text-white/40')}
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
        <ContextMenuItem onClick={() => onPlay(idx)}>
          <Play className="h-4 w-4 mr-2" strokeWidth={1.5} />
          立即播放
        </ContextMenuItem>
        <ContextMenuItem onClick={() => usePlayerStore.getState().addToPlayNext(track)}>
          <ListEnd className="h-4 w-4 mr-2" strokeWidth={1.5} />
          下一首播放
        </ContextMenuItem>
        <ContextMenuItem onClick={() => usePlayerStore.getState().addToQueue(track)}>
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
            <PlaylistSubmenuItems trackId={track.id} onCreatePlaylist={onCreatePlaylist} />
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => useLibraryStore.getState().toggleLike(track.id)}>
          <Heart className={cn('h-4 w-4 mr-2', liked && 'fill-coral text-coral')} strokeWidth={1.5} />
          {liked ? '取消收藏' : '收藏'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

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
  const createPlaylist = usePlaylistStore((s) => s.createPlaylist)
  const addTracksToPlaylist = usePlaylistStore((s) => s.addTracksToPlaylist)
  const [showNewPlaylistDialog, setShowNewPlaylistDialog] = useState(false)
  const [newPlName, setNewPlName] = useState('')
  const [pendingTrackId, setPendingTrackId] = useState<string | null>(null)
  // 搜索浮层：由头部搜索图标或 ⌘/Ctrl+K 唤起，覆盖在音乐库之上，底层列表/标签栏保持不变
  const [searchOpen, setSearchOpen] = useState(false)
  // 专辑/艺术家分组详情：非 null 时内容区替换为该组的歌曲列表
  const [selectedGroup, setSelectedGroup] = useState<{ type: 'album' | 'artist'; key: string } | null>(null)

  // 全局快捷键 ⌘K / Ctrl+K 唤起搜索浮层
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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

  // 右键菜单里的「新建播放列表...」：记录待加入的曲目并打开弹窗
  const openCreatePlaylistDialog = useCallback((trackId: string) => {
    setPendingTrackId(trackId)
    setShowNewPlaylistDialog(true)
  }, [])

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

  // 分组只在对应标签页（或已进入某个分组详情）时才需要计算：
  // 歌曲页每批扫描数据都重算专辑+艺术家两套分组是纯浪费（歌曲多时是主要卡顿来源之一）
  const needAlbumGroups = libraryTab === 'albums' || selectedGroup?.type === 'album'
  const needArtistGroups = libraryTab === 'artists' || selectedGroup?.type === 'artist'

  // 按专辑分组（同名专辑按艺术家区分），组内按曲号排序
  const albumGroups = useMemo<TrackGroup[]>(() => {
    if (!needAlbumGroups) return EMPTY_GROUPS
    const map = new Map<string, { name: string; artist: string; tracks: Track[] }>()
    for (const t of tracks) {
      const name = t.album || '未知专辑'
      const artist = t.artist || '未知艺术家'
      // 用 \u0000 分隔的键代替 JSON.stringify/parse（每首歌一次序列化在数万首时很可观）
      const key = `${name}\u0000${artist}`
      const entry = map.get(key)
      if (entry) entry.tracks.push(t)
      else map.set(key, { name, artist, tracks: [t] })
    }
    const groups: TrackGroup[] = []
    for (const [key, entry] of map) {
      entry.tracks.sort((a, b) => (a.trackNumber ?? 99) - (b.trackNumber ?? 99) || collator.compare(a.title, b.title))
      // 代表曲目：优先取已有封面的，否则取首曲（同专辑内嵌封面通常一致）
      const coverTrack = entry.tracks.find((t) => t.coverPath) ?? entry.tracks[0]
      groups.push({
        key,
        name: entry.name,
        subtitle: entry.artist,
        coverPath: coverTrack?.coverPath,
        coverTrackId: coverTrack?.id,
        tracks: entry.tracks,
      })
    }
    return groups.sort((a, b) => collator.compare(a.name, b.name))
  }, [needAlbumGroups, tracks, collator])

  // 按艺术家分组，组内按 专辑 → 曲号 排序
  const artistGroups = useMemo<TrackGroup[]>(() => {
    if (!needArtistGroups) return EMPTY_GROUPS
    const map = new Map<string, Track[]>()
    for (const t of tracks) {
      const key = t.artist || '未知艺术家'
      const list = map.get(key)
      if (list) list.push(t)
      else map.set(key, [t])
    }
    const groups: TrackGroup[] = []
    for (const [key, ts] of map) {
      ts.sort((a, b) => collator.compare(a.album, b.album) || (a.trackNumber ?? 99) - (b.trackNumber ?? 99) || collator.compare(a.title, b.title))
      // 代表曲目：优先取已有封面的，否则取首曲
      const coverTrack = ts.find((t) => t.coverPath) ?? ts[0]
      groups.push({
        key,
        name: key,
        subtitle: '',
        coverPath: coverTrack?.coverPath,
        coverTrackId: coverTrack?.id,
        tracks: ts,
      })
    }
    return groups.sort((a, b) => collator.compare(a.name, b.name))
  }, [needArtistGroups, tracks, collator])

  // 当前选中的分组（tracks 变化后可能失效，找不到时回退到分组网格）
  const activeGroup = selectedGroup
    ? (selectedGroup.type === 'album' ? albumGroups : artistGroups).find((g) => g.key === selectedGroup.key) ?? null
    : null

  // 行内「立即播放/双击播放」使用的当前队列（分组详情页取该组歌曲，否则取排序后的全表）。
  // 用 ref 保存、点击时才读取：避免把 queue 数组当 prop 传给每一行——数据每次更新
  // 数组都会换引用，会让 memo 化的行全部重渲染。effect 里写入保证只记录已提交的渲染。
  const queueRef = useRef<Track[]>([])
  useEffect(() => {
    queueRef.current = activeGroup ? activeGroup.tracks : filteredTracks
  })
  const handlePlayRow = useCallback((index: number) => {
    const queue = queueRef.current
    if (index >= 0 && index < queue.length) {
      usePlayerStore.getState().playQueue(queue, index)
    }
  }, [])

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
            <div className="aspect-square rounded-[8px] bg-white/[0.04] mb-2.5 flex items-center justify-center overflow-hidden transition-transform duration-200 ease-apple group-hover:scale-[1.02]">
              <CoverImage
                track={g.coverTrackId ? { id: g.coverTrackId, coverPath: g.coverPath } : null}
                alt={g.name}
                className="w-full h-full object-cover product-shadow"
                fallback={
                  type === 'album' ? (
                    <Disc3 className="h-8 w-8 text-white/20" strokeWidth={1.5} />
                  ) : (
                    <User className="h-8 w-8 text-white/20" strokeWidth={1.5} />
                  )
                }
              />
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
              onClick={() => setSearchOpen(true)}
              title="搜索 (⌘K)"
              className="btn-icon"
            >
              <Search className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
            {tracks.length > 0 && libraryTab === 'songs' && (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      title="排序方式"
                      className="btn-icon w-auto px-2.5 gap-1.5"
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
                  className="btn-icon"
                >
                  {sortOrder === 'asc' ? (
                    <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.5} />
                  ) : (
                    <ArrowDown className="h-3.5 w-3.5" strokeWidth={1.5} />
                  )}
                </button>
              </>
            )}
            {tracks.length > 0 && scanFolders.length > 0 && (
              <button
                onClick={handleRescan}
                title="重新扫描，同步已删除的歌曲"
                className="btn-icon"
              >
                <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} />
              </button>
            )}
            {tracks.length > 0 && libraryTab === 'songs' && (
              <div className="segmented">
                <button
                  className={cn('segmented-item w-7 px-0', viewMode === 'list' && 'is-on')}
                  onClick={() => setViewMode('list')}
                >
                  <List className="h-3.5 w-3.5" strokeWidth={1.5} />
                </button>
                <button
                  className={cn('segmented-item w-7 px-0', viewMode === 'grid' && 'is-on')}
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
      {tracks.length === 0 ? (
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
            className="pill pill-lg pill-mint"
          >
            <FolderOpen className="h-4 w-4" strokeWidth={1.6} />
            导入音乐
          </button>
        </div>
      ) : (
        <>
          {/* 浏览标签：歌曲 / 专辑 / 艺术家 */}
          <div className="segmented mb-4 md:mb-5">
            {LIBRARY_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  setLibraryTab(tab.id)
                  setSelectedGroup(null)
                }}
                className={cn('segmented-item', libraryTab === tab.id && 'is-on')}
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
              className="btn-icon"
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
              className="pill pill-sm pill-mint flex-shrink-0"
            >
              <Play className="h-3.5 w-3.5" strokeWidth={1.6} />
              播放全部
            </button>
          </div>
          <table className="w-full font-text">
            <tbody>
              {activeGroup.tracks.map((track, idx) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  idx={idx}
                  liked={likedTracks.has(track.id)}
                  onPlay={handlePlayRow}
                  onCreatePlaylist={openCreatePlaylistDialog}
                />
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
                <TrackRow
                  key={track.id}
                  track={track}
                  idx={idx}
                  liked={likedTracks.has(track.id)}
                  onPlay={handlePlayRow}
                  onCreatePlaylist={openCreatePlaylistDialog}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {filteredTracks.map((track, idx) => (
              <ContextMenu key={track.id}>
                <ContextMenuTrigger asChild>
                  <div
                    className="group card-utility p-2.5 cursor-pointer"
                    // 移动端单击卡片即播放；桌面端保留双击，封面单击仍进详情
                    onClick={isDesktop() ? undefined : () => handlePlayRow(idx)}
                    onDoubleClick={() => handlePlayRow(idx)}
                  >
                    <div
                      onClick={(e) => {
                        e.stopPropagation()
                        navigate(`/song/${track.id}`)
                      }}
                      title="查看歌曲详情"
                      className="aspect-square rounded-[8px] bg-white/[0.04] mb-2.5 flex items-center justify-center overflow-hidden relative cursor-pointer transition-transform duration-200 ease-apple group-hover:scale-[1.02]"
                    >
                      <CoverImage
                        track={track}
                        alt={track.title}
                        className="w-full h-full object-cover product-shadow"
                        fallback={<MusicIcon className="h-8 w-8 text-white/20" strokeWidth={1.5} />}
                      />
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleLike(track.id)
                        }}
                        // 移动端无 hover：已收藏的红心常显，未收藏的保持隐藏避免遮挡封面
                        className={cn(
                          'absolute top-2 right-2 h-7 w-7 flex items-center justify-center rounded-full transition-opacity duration-200 ease-apple bg-black/40 hover:scale-105',
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
                  <ContextMenuItem onClick={() => handlePlayRow(idx)}>
                    <Play className="h-4 w-4 mr-2" strokeWidth={1.5} />
                    立即播放
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => usePlayerStore.getState().addToPlayNext(track)}>
                    <ListEnd className="h-4 w-4 mr-2" strokeWidth={1.5} />
                    下一首播放
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => usePlayerStore.getState().addToQueue(track)}>
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
                      <PlaylistSubmenuItems trackId={track.id} onCreatePlaylist={openCreatePlaylistDialog} />
                    </ContextMenuSubContent>
                  </ContextMenuSub>
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

      {/* 搜索浮层：覆盖在音乐库之上，不替换底层内容 */}
      {searchOpen && <SearchOverlay onClose={() => setSearchOpen(false)} />}

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
