import { useState, useCallback } from 'react'
import {
  FolderOpen, List, Grid3X3, Music as MusicIcon, Search as SearchIcon, Heart,
  Play, Plus, ListPlus, ListEnd,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import { playTrack as audioPlayTrack } from '@/services/audio.service'
import type { Track } from '@/types'

export function LibraryPage() {
  const { tracks, viewMode, setViewMode, isScanning, scanProgress, toggleLike, likedTracks } = useLibraryStore()
  const { playlists, createPlaylist, addTracksToPlaylist } = usePlaylistStore()
  const [localQuery, setLocalQuery] = useState('')
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

  const filteredTracks = localQuery
    ? tracks.filter(
        (t) =>
          t.title.toLowerCase().includes(localQuery.toLowerCase()) ||
          t.artist.toLowerCase().includes(localQuery.toLowerCase()) ||
          t.album.toLowerCase().includes(localQuery.toLowerCase())
      )
    : tracks

  const TrackRow = ({ track, idx, queue }: { track: Track; idx: number; queue: Track[] }) => (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <tr
          key={track.id}
          className="hover:bg-foreground/5 cursor-pointer transition-colors group"
          onDoubleClick={() => handlePlayTrack(track, tracks.findIndex((t) => t.id === track.id), queue)}
        >
          <td className="py-2.5 px-4 text-foreground/40 group-hover:text-foreground/80 w-10">
            <span className="group-hover:hidden">{idx + 1}</span>
            <Play className="h-3.5 w-3.5 hidden group-hover:block" />
          </td>
          <td className="py-2.5 px-4 font-medium truncate max-w-xs">{track.title}</td>
          <td className="py-2.5 px-4 text-foreground/60 truncate max-w-40">{track.artist}</td>
          <td className="py-2.5 px-4 text-foreground/60 truncate max-w-48 hidden md:table-cell">
            {track.album}
          </td>
          <td className="py-2.5 px-2 w-10">
            <button
              onClick={(e) => {
                e.stopPropagation()
                toggleLike(track.id)
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <Heart
                className={cn('h-4 w-4', likedTracks.has(track.id) ? 'text-red-500 fill-red-500' : 'text-foreground/40')}
              />
            </button>
          </td>
          <td className="py-2.5 px-4 text-right text-foreground/40 tabular-nums w-16">
            {formatTime(track.duration)}
          </td>
        </tr>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={() => handlePlayTrack(track, tracks.findIndex((t) => t.id === track.id), queue)}>
          <Play className="h-4 w-4 mr-2" />
          立即播放
        </ContextMenuItem>
        <ContextMenuItem onClick={() => handlePlayNext(track)}>
          <ListEnd className="h-4 w-4 mr-2" />
          下一首播放
        </ContextMenuItem>
        <ContextMenuItem onClick={() => handleAddToQueue(track)}>
          <Plus className="h-4 w-4 mr-2" />
          添加到队列
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <ListPlus className="h-4 w-4 mr-2" />
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
                <Plus className="h-4 w-4 mr-2" />
                新建播放列表...
              </ContextMenuItem>
            ) : (
              <>
                {playlists.map((pl) => (
                  <ContextMenuItem key={pl.id} onClick={() => handleAddToPlaylist(track.id, pl.id)}>
                    <ListPlus className="h-4 w-4 mr-2 opacity-50" />
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
                  <Plus className="h-4 w-4 mr-2" />
                  新建播放列表...
                </ContextMenuItem>
              </>
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => toggleLike(track.id)}>
          <Heart className={cn('h-4 w-4 mr-2', likedTracks.has(track.id) && 'fill-red-500 text-red-500')} />
          {likedTracks.has(track.id) ? '取消收藏' : '收藏'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-4 px-1">
        <h1 className="text-2xl font-bold">音乐库</h1>
        <div className="flex items-center gap-2">
          <div className="relative">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-foreground/40" />
            <input
              type="text"
              placeholder="搜索歌曲..."
              value={localQuery}
              onChange={(e) => setLocalQuery(e.target.value)}
              className="glass rounded-lg pl-9 pr-4 py-2 text-sm w-56 outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          {isDesktop() && (
            <Button variant="outline" size="sm" className="glass" onClick={handlePickFolder}>
              <FolderOpen className="h-4 w-4 mr-2" />
              导入音乐
            </Button>
          )}
          <div className="glass rounded-lg p-0.5 flex">
            <Button
              variant={viewMode === 'list' ? 'default' : 'ghost'}
              size="icon"
              className="h-8 w-8"
              onClick={() => setViewMode('list')}
            >
              <List className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === 'grid' ? 'default' : 'ghost'}
              size="icon"
              className="h-8 w-8"
              onClick={() => setViewMode('grid')}
            >
              <Grid3X3 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {isScanning && (
        <div className="glass rounded-lg p-3 mb-4">
          <p className="text-sm text-foreground/70 mb-2">
            正在扫描: {scanProgress.file}
          </p>
          <div className="w-full bg-muted rounded-full h-2">
            <div
              className="bg-primary h-2 rounded-full transition-all"
              style={{ width: `${scanProgress.total > 0 ? (scanProgress.current / scanProgress.total) * 100 : 0}%` }}
            />
          </div>
          <p className="text-xs text-foreground/50 mt-1">
            {scanProgress.current} / {scanProgress.total}
          </p>
        </div>
      )}

      {tracks.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-foreground/40">
          <MusicIcon className="h-16 w-16 mb-4 opacity-30" />
          <p className="text-lg font-medium mb-2">还没有音乐</p>
          <p className="text-sm mb-4">点击"导入音乐"添加你的音乐文件夹</p>
          {isDesktop() && (
            <Button onClick={handlePickFolder}>
              <FolderOpen className="h-4 w-4 mr-2" />
              导入音乐
            </Button>
          )}
        </div>
      ) : viewMode === 'list' ? (
        <div className="flex-1 overflow-y-auto scrollbar-thin pr-2">
          <div className="glass rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left py-3 px-4 font-medium text-foreground/50 w-10">#</th>
                  <th className="text-left py-3 px-4 font-medium text-foreground/50">标题</th>
                  <th className="text-left py-3 px-4 font-medium text-foreground/50">艺术家</th>
                  <th className="text-left py-3 px-4 font-medium text-foreground/50 hidden md:table-cell">专辑</th>
                  <th className="w-10"></th>
                  <th className="text-right py-3 px-4 font-medium text-foreground/50 w-16">时长</th>
                </tr>
              </thead>
              <tbody>
                {filteredTracks.map((track, idx) => (
                  <TrackRow key={track.id} track={track} idx={idx} queue={filteredTracks} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-thin pr-2">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {filteredTracks.map((track) => (
              <ContextMenu key={track.id}>
                <ContextMenuTrigger asChild>
                  <div
                    className="glass rounded-xl p-3 cursor-pointer hover:bg-foreground/5 transition-all hover:scale-[1.02] group"
                    onDoubleClick={() => handlePlayTrack(track, tracks.findIndex((t) => t.id === track.id), filteredTracks)}
                  >
                    <div className="aspect-square rounded-lg bg-gradient-to-br from-purple-500/20 to-pink-500/20 mb-3 flex items-center justify-center overflow-hidden relative">
                      {track.coverPath ? (
                        <img
                          src={`file://${track.coverPath}`}
                          alt={track.title}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <MusicIcon className="h-10 w-10 text-foreground/30" />
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleLike(track.id)
                        }}
                        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-black/40 rounded-full p-1.5"
                      >
                        <Heart
                          className={cn('h-4 w-4', likedTracks.has(track.id) ? 'text-red-400 fill-red-400' : 'text-white')}
                        />
                      </button>
                    </div>
                    <p className="text-sm font-medium truncate">{track.title}</p>
                    <p className="text-xs text-foreground/50 truncate">{track.artist}</p>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-52">
                  <ContextMenuItem onClick={() => handlePlayTrack(track, tracks.findIndex((t) => t.id === track.id), filteredTracks)}>
                    <Play className="h-4 w-4 mr-2" />
                    立即播放
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => handlePlayNext(track)}>
                    <ListEnd className="h-4 w-4 mr-2" />
                    下一首播放
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => handleAddToQueue(track)}>
                    <Plus className="h-4 w-4 mr-2" />
                    添加到队列
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => toggleLike(track.id)}>
                    <Heart className={cn('h-4 w-4 mr-2', likedTracks.has(track.id) && 'fill-red-500 text-red-500')} />
                    {likedTracks.has(track.id) ? '取消收藏' : '收藏'}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
