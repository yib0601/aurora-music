import { useState, useCallback, memo } from 'react'
import {
  FolderOpen, List, Grid3X3, Music as MusicIcon, Heart,
  Play, Plus, ListPlus, ListEnd,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
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
import type { Track } from '@/types'

/**
 * Apple 风格 LibraryPage
 * - 标题用 display-md 字号
 * - 表格无 glass，仅 hairline 分隔行
 * - 网格卡片用 card-utility（白底 + 1px hairline + 18px 圆角）
 * - 按钮统一 Apple 风格
 */
export function LibraryPage() {
  const tracks = useLibraryStore((s) => s.tracks)
  const viewMode = useLibraryStore((s) => s.viewMode)
  const setViewMode = useLibraryStore((s) => s.setViewMode)
  const isScanning = useLibraryStore((s) => s.isScanning)
  const scanProgress = useLibraryStore((s) => s.scanProgress)
  const toggleLike = useLibraryStore((s) => s.toggleLike)
  const likedTracks = useLibraryStore((s) => s.likedTracks)
  const playlists = usePlaylistStore((s) => s.playlists)
  const createPlaylist = usePlaylistStore((s) => s.createPlaylist)
  const addTracksToPlaylist = usePlaylistStore((s) => s.addTracksToPlaylist)
  const [showNewPlaylistDialog, setShowNewPlaylistDialog] = useState(false)
  const [newPlName, setNewPlName] = useState('')
  const [pendingTrackId, setPendingTrackId] = useState<string | null>(null)

  const api = (window as any).electronAPI

  const handlePickFolder = async () => {
    if (!api) return
    const folder = await api.pickFolder()
    if (folder) {
      useLibraryStore.getState().addScanFolder(folder)
      await api.scanFolder(folder)
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

  const filteredTracks = tracks

  // ⚠️ 性能：memo 化 TrackRow，避免每次父组件 render 都重建所有行
  const TrackRow = memo(({ track, idx, queue }: { track: Track; idx: number; queue: Track[] }) => (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <tr
          key={track.id}
          className="row-hover cursor-pointer border-b border-white/5 last:border-0 hover:bg-mint/[0.075]"
          onDoubleClick={() => handlePlayTrack(track, idx, queue)}
        >
          <td className="py-2.5 px-3 text-white/40 w-10 group-hover:text-white">
            <span className="group-hover:hidden font-text text-[13px] tabular-nums">{idx + 1}</span>
            <Play className="h-3 w-3 hidden group-hover:block text-mint" strokeWidth={1.8} />
          </td>
          <td className="py-2.5 px-3 font-text font-semibold text-[14px] truncate max-w-xs text-white tracking-[-0.224px]">
            {track.title}
          </td>
          <td className="py-2.5 px-3 font-text text-white/50 text-[14px] truncate max-w-40 tracking-[-0.224px]">
            {track.artist}
          </td>
          <td className="py-2.5 px-3 font-text text-white/40 text-[14px] truncate max-w-48 hidden md:table-cell tracking-[-0.224px]">
            {track.album}
          </td>
          <td className="py-2.5 px-2 w-10">
            <button
              onClick={(e) => {
                e.stopPropagation()
                toggleLike(track.id)
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 ease-apple p-1 hover:bg-mint/[0.075] rounded-xs"
            >
              <Heart
                className={cn('h-3.5 w-3.5', likedTracks.has(track.id) ? 'text-coral fill-coral' : 'text-white/40')}
                strokeWidth={1.5}
              />
            </button>
          </td>
          <td className="py-2.5 px-3 text-right font-text text-white/40 text-[13px] tabular-nums w-16 tracking-[-0.12px]">
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
    <PageLayout title="音乐库" subtitle={tracks.length === 0 ? '导入音乐，开始构建你的专属音乐库' : `${tracks.length} 首歌曲`}>
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
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-mint text-[#030608] font-semibold text-[14px] hover:brightness-110 transition-all duration-200 active:scale-95"
          >
            <FolderOpen className="h-4 w-4" strokeWidth={1.6} />
            导入音乐
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-end mb-8 -mt-12">
            <div className="flex items-center gap-2">
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
            </div>
          </div>

          {isScanning && (
            <div className="mb-4 card-utility p-4">
              <p className="font-text text-[14px] text-white/70 mb-2 truncate tracking-[-0.224px]">
                正在扫描: {scanProgress.file}
              </p>
              <div className="w-full bg-white/[0.06] rounded-pill h-1 overflow-hidden">
                <div
                  className="bg-mint h-full rounded-pill transition-all duration-300 ease-apple"
                  style={{ width: `${scanProgress.total > 0 ? (scanProgress.current / scanProgress.total) * 100 : 0}%` }}
                />
              </div>
              <p className="font-text text-[12px] text-white/40 mt-2 tabular-nums tracking-[-0.12px]">
                {scanProgress.current} / {scanProgress.total}
              </p>
            </div>
          )}

          {viewMode === 'list' ? (
        <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
          <table className="w-full font-text">
            <thead>
              <tr className="border-b border-white/10">
                <th className="text-left py-2.5 px-3 font-semibold text-white/40 w-10 text-[12px] tracking-[-0.12px]">#</th>
                <th className="text-left py-2.5 px-3 font-semibold text-white/40 text-[12px] tracking-[-0.12px]">标题</th>
                <th className="text-left py-2.5 px-3 font-semibold text-white/40 text-[12px] tracking-[-0.12px]">艺术家</th>
                <th className="text-left py-2.5 px-3 font-semibold text-white/40 text-[12px] tracking-[-0.12px] hidden md:table-cell">专辑</th>
                <th className="w-10"></th>
                <th className="text-right py-2.5 px-3 font-semibold text-white/40 text-[12px] w-16 tracking-[-0.12px]">时长</th>
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
                    onDoubleClick={() => handlePlayTrack(track, tracks.findIndex((t) => t.id === track.id), filteredTracks)}
                  >
                    <div className="aspect-square rounded-xs bg-white/[0.04] mb-2.5 flex items-center justify-center overflow-hidden relative">
                      {track.coverPath ? (
                        <img
                          src={`file://${track.coverPath}`}
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
                        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 ease-apple bg-black/40 rounded-pill p-1 hover:scale-105"
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
