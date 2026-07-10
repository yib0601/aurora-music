import { useState, useMemo } from 'react'
import { Search as SearchIcon, Play, Plus, ListEnd, Music2, Heart } from 'lucide-react'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
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
import type { Track } from '@/types'

export function SearchPage() {
  const [query, setQuery] = useState('')
  const tracks = useLibraryStore((s) => s.tracks)
  const toggleLike = useLibraryStore((s) => s.toggleLike)
  const likedTracks = useLibraryStore((s) => s.likedTracks)
  const playlists = usePlaylistStore((s) => s.playlists)
  const addTracksToPlaylist = usePlaylistStore((s) => s.addTracksToPlaylist)

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return tracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.album.toLowerCase().includes(q)
    )
  }, [query, tracks])

  const handlePlayTrack = (track: Track, index: number, queue: Track[]) => {
    usePlayerStore.getState().playQueue(queue, index)
  }

  const handlePlayNext = (track: Track) => {
    usePlayerStore.getState().addToPlayNext(track)
  }

  const handleAddToQueue = (track: Track) => {
    usePlayerStore.getState().addToQueue(track)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-4">搜索</h1>
        <div className="relative max-w-xl">
          <SearchIcon className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-foreground/40" />
          <input
            type="text"
            placeholder="搜索歌曲、艺术家、专辑..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="glass rounded-xl w-full pl-12 pr-4 py-3 text-base outline-none focus:ring-2 focus:ring-primary/50"
            autoFocus
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin pr-2">
        {!query.trim() ? (
          <div className="flex flex-col items-center justify-center py-20 text-foreground/30">
            <SearchIcon className="h-14 w-14 mb-3 opacity-20" />
            <p className="text-sm">输入关键词搜索你的音乐库</p>
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-foreground/30">
            <Music2 className="h-14 w-14 mb-3 opacity-20" />
            <p className="text-sm">未找到 "{query}" 的相关结果</p>
          </div>
        ) : (
          <div className="space-y-6">
            <section>
              <h2 className="text-sm font-semibold text-foreground/50 uppercase tracking-wider mb-2 px-1">
                歌曲 ({results.length})
              </h2>
              <div className="glass rounded-xl overflow-hidden">
                {results.slice(0, 30).map((track, idx) => (
                  <ContextMenu key={track.id}>
                    <ContextMenuTrigger asChild>
                      <div
                        className="flex items-center gap-3 px-4 py-2.5 hover:bg-foreground/5 cursor-pointer group transition-colors"
                        onDoubleClick={() => handlePlayTrack(track, idx, results)}
                      >
                        <span className="text-xs text-foreground/40 w-5 text-right group-hover:hidden">
                          {idx + 1}
                        </span>
                        <Play className="w-3.5 h-3.5 hidden group-hover:block text-foreground/60" />
                        <div className="w-10 h-10 rounded bg-gradient-to-br from-purple-500/20 to-pink-500/20 flex items-center justify-center flex-shrink-0 overflow-hidden">
                          {track.coverPath ? (
                            <img src={`file://${track.coverPath}`} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <Music2 className="h-4 w-4 opacity-40" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{track.title}</p>
                          <p className="text-xs text-foreground/50 truncate">{track.artist}</p>
                        </div>
                        <span className="text-xs text-foreground/40 truncate max-w-32 hidden md:block">
                          {track.album}
                        </span>
                        <span className="text-xs text-foreground/40 tabular-nums w-10 text-right">
                          {formatTime(track.duration)}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleLike(track.id)
                          }}
                          className="p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Heart className={cn('h-4 w-4', likedTracks.has(track.id) ? 'text-red-500 fill-red-500' : 'text-foreground/40')} />
                        </button>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-52">
                      <ContextMenuItem onClick={() => handlePlayTrack(track, idx, results)}>
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
                          <Plus className="h-4 w-4 mr-2 opacity-50" />
                          添加到播放列表
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent className="w-48">
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
        )}
      </div>
    </div>
  )
}
