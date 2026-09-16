import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import {
  FolderOpen, List, Grid3X3, Music as MusicIcon, Play,
  RefreshCw, ArrowUp, ArrowDown, ChevronLeft, Check, User, Disc3,
} from 'lucide-react'
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { cn } from '@/lib/utils'
import { PageLayout } from '@/components/PageLayout'
import { SearchEntry } from '@/components/common/SearchEntry'
import { platform } from '@/services/platform'
import { CoverImage } from '@/components/common/CoverImage'
import { toast } from '@/components/common/Toast'
import { useDisplayTracks } from '@/hooks/useDisplayTracks'
import { DuplicateSummaryHover } from '@/components/common/DuplicateInfo'
import { VirtualTrackTable, VirtualTrackRow } from '@/components/VirtualTrackTable'
import { VirtualCardGrid } from '@/components/VirtualCardGrid'
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
 * 歌曲列表滚动位置缓存：滚动时随手记录，页面重挂载后恢复。
 * 详情页返回场景由 App 层的常驻挂载直接保住 DOM 与滚动位置；
 * 这里兜底其他会触发重挂载的路径（如去了「我喜欢的」再回来）。
 */
const savedScrollPositions: Record<string, number> = {}

/**
 * Apple 风格 LibraryPage
 * - 标题用 display-md 字号
 * - 表格无 glass，仅 hairline 分隔行
 * - 网格卡片用 card-utility（白底 + 1px hairline + 18px 圆角）
 * - 按钮统一 Apple 风格
 *
 * 性能：歌曲列表/网格均已虚拟化（@tanstack/react-virtual），
 * 只渲染可视区域内的行，数千首歌曲不再一次性创建全部节点。
 */
export function LibraryPage() {
  // 展示用曲库：同一首歌在多来源都有时只留优先副本（本机优先，否则第一次扫到的）。
  // hidden 用于在页面上明示隐藏了多少条，避免「歌莫名变少了」而用户无从察觉
  const { tracks, hidden: hiddenDuplicates, groups: duplicateGroups } = useDisplayTracks()
  const viewMode = useLibraryStore((s) => s.viewMode)
  const setViewMode = useLibraryStore((s) => s.setViewMode)
  const scanFolders = useLibraryStore((s) => s.scanFolders)
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
  // 专辑/艺术家分组详情：非 null 时内容区替换为该组的歌曲列表
  const [selectedGroup, setSelectedGroup] = useState<{ type: 'album' | 'artist'; key: string } | null>(null)

  // 歌曲列表滚动位置：滚动时记录，重挂载/视图切换后恢复
  const songsScrollRef = useRef<HTMLDivElement>(null)
  const viewModeRef = useRef(viewMode)
  useEffect(() => { viewModeRef.current = viewMode }, [viewMode])

  const handleSongsScroll = useCallback(() => {
    const el = songsScrollRef.current
    if (el) savedScrollPositions[viewModeRef.current] = el.scrollTop
  }, [])

  useEffect(() => {
    const el = songsScrollRef.current
    if (el) el.scrollTop = savedScrollPositions[viewMode] ?? 0
  }, [viewMode, libraryTab, selectedGroup])

  const handlePickFolder = async () => {
    // 不支持 File System Access API 的浏览器（Firefox/Safari）无法访问本地文件系统，
    // Noop 平台不提供 scanFolder，这里给出轻量提示而非静默无响应
    if (!platform.scanFolder) {
      toast('当前浏览器不支持访问本地文件，请使用 Chrome/Edge 或桌面版、安卓版', { type: 'error' })
      return
    }
    const folder = await platform.pickFolder()
    if (folder) {
      useLibraryStore.getState().addScanFolder(folder)
      // 扫描失败时平台会发送 scan:error 事件展示提示，这里吞掉 reject 即可
      await platform.scanFolder?.(folder).catch(() => {})
    }
  }

  // 重新扫描所有已配置目录，同步移除已删除文件对应的曲目记录
  const [rescanning, setRescanning] = useState(false)
  const handleRescan = async () => {
    if (!platform.scanFolder || scanFolders.length === 0 || rescanning) return
    setRescanning(true)
    let hasError = false
    for (const folder of scanFolders) {
      try {
        await platform.scanFolder(folder)
      } catch {
        hasError = true
      }
    }
    setRescanning(false)
    if (hasError) {
      toast('部分目录扫描失败，请检查目录是否存在且可访问', { type: 'error', duration: 5000 })
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

  // 胜出副本 id → 重复组：行内徽标据此标记「该展示副本另有被隐藏的副本」。
  // 分组详情等局部列表同样复用这张全局表（只标记，不影响行集合）。
  const duplicateMap = useMemo(() => {
    const map = new Map<string, (typeof duplicateGroups)[number]>()
    for (const g of duplicateGroups) map.set(g.kept.id, g)
    return map
  }, [duplicateGroups])

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

  // 专辑/艺术家分组网格卡片（分组数量远小于歌曲总数，保持平铺渲染）
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
              {/* 去重必须可见：否则用户只会发现「歌变少了」却找不到原因。
                  被隐藏的副本并未删库，歌单/收藏里对它的引用依然有效。
                  悬停提示逐组列出具体名单——只给条数不给名单，用户无从核对 */}
              {hiddenDuplicates > 0 && (
                <DuplicateSummaryHover hidden={hiddenDuplicates} groups={duplicateGroups} />
              )}
            </p>
          </div>
          {/* 工具栏：搜索入口常驻（本地无歌时也可用在线搜索）；重扫/视图切换仅列表态显示 */}
          <div className="flex items-center gap-2 flex-shrink-0 pb-1">
            <SearchEntry />
            {tracks.length > 0 && libraryTab === 'songs' && (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      title="排序方式"
                      className="btn-icon w-auto px-2.5 gap-1.5"
                    >
                      {sortOrder === 'asc' ? (
                        <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.5} />
                      ) : (
                        <ArrowDown className="h-3.5 w-3.5" strokeWidth={1.5} />
                      )}
                      {/* 固定 4 个字宽（最长「默认排序/添加时间」），避免切换排序时按钮宽度变化导致工具栏抖动 */}
                      <span className="font-text text-[12px] hidden sm:inline-block w-[4em] text-left">{SORT_LABELS[sortBy]}</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-36">
                    {/* preventDefault 阻止 Radix 选中后自动关闭，点击菜单外/再次点击按钮才关闭 */}
                    {(Object.keys(SORT_LABELS) as SortField[]).map((field) => (
                      <DropdownMenuItem key={field} onSelect={(e) => e.preventDefault()} onClick={() => setSortBy(field)}>
                        <span className="flex-1">{SORT_LABELS[field]}</span>
                        {sortBy === field && <Check className="h-3.5 w-3.5 text-mint" strokeWidth={2} />}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={(e) => e.preventDefault()} onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}>
                      <span className="flex-1">{sortOrder === 'asc' ? '升序' : '降序'}</span>
                      {sortOrder === 'asc' ? (
                        <ArrowUp className="h-3.5 w-3.5 text-mint" strokeWidth={2} />
                      ) : (
                        <ArrowDown className="h-3.5 w-3.5 text-mint" strokeWidth={2} />
                      )}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
            {tracks.length > 0 && scanFolders.length > 0 && (
              <button
                onClick={handleRescan}
                disabled={rescanning}
                title={rescanning ? '正在扫描…' : '重新扫描，同步已删除的歌曲'}
                className="btn-icon"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${rescanning ? 'animate-spin' : ''}`} strokeWidth={1.5} />
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
        // 分组详情：返回 + 组信息 + 播放全部 + 该组歌曲列表（单组歌曲量小，直接平铺）
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
          <div className="w-full font-text">
            {activeGroup.tracks.map((track, idx) => (
              <VirtualTrackRow
                key={track.id}
                track={track}
                idx={idx}
                liked={likedTracks.has(track.id)}
                onPlay={handlePlayRow}
                onCreatePlaylist={openCreatePlaylistDialog}
                duplicateGroup={duplicateMap.get(track.id)}
              />
            ))}
          </div>
        </div>
      ) : libraryTab === 'albums' ? (
        renderGroupGrid(albumGroups, 'album')
      ) : libraryTab === 'artists' ? (
        renderGroupGrid(artistGroups, 'artist')
      ) : viewMode === 'list' ? (
        <div
          ref={songsScrollRef}
          onScroll={handleSongsScroll}
          className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2"
        >
          <VirtualTrackTable
            tracks={filteredTracks}
            scrollRef={songsScrollRef}
            onPlayRow={handlePlayRow}
            onCreatePlaylist={openCreatePlaylistDialog}
            duplicateMap={duplicateMap}
          />
        </div>
      ) : (
        <div
          ref={songsScrollRef}
          onScroll={handleSongsScroll}
          className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2"
        >
          <VirtualCardGrid
            tracks={filteredTracks}
            scrollRef={songsScrollRef}
            onPlayRow={handlePlayRow}
            onCreatePlaylist={openCreatePlaylistDialog}
            duplicateMap={duplicateMap}
          />
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
