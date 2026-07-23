import { useMemo, useState } from 'react'
import { Clock, Play, Plus, ListEnd, ListPlus, Heart, Music } from 'lucide-react'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { useNavigate } from 'react-router-dom'
import { formatTime, cn } from '@/lib/utils'
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

export function RecentPage() {
  const navigate = useNavigate()
  const allTracks = useLibraryStore((s) => s.tracks)
  const toggleLike = useLibraryStore((s) => s.toggleLike)
  const likedTracks = useLibraryStore((s) => s.likedTracks)
  const tracks = useMemo(
    () =>
      [...allTracks]
        .filter((t) => t.lastPlayedAt)
        .sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0)),
    [allTracks]
  )
  const playlists = usePlaylistStore((s) => s.playlists)
  const addTracksToPlaylist = usePlaylistStore((s) => s.addTracksToPlaylist)

  const handlePlay = (track: typeof tracks[0], idx: number) => {
    usePlayerStore.getState().playQueue(tracks, idx)
  }

  const handlePlayNext = (track: typeof tracks[0]) => {
    usePlayerStore.getState().addToPlayNext(track)
  }

  const handleAddToQueue = (track: typeof tracks[0]) => {
    usePlayerStore.getState().addToQueue(track)
  }

  const handleAddToPlaylist = (trackId: string, playlistId: string) => {
    addTracksToPlaylist(playlistId, [trackId])
  }

  return (
    <div className="flex flex-col h-full p-8">
      <div className="flex items-center gap-5 mb-8">
        <div className="w-20 h-20 rounded-lg glass-regular border border-white/10 flex items-center justify-center shadow-[0_10px_30px_rgba(0,0,0,.18)]">
          <Clock className="h-9 w-9 text-mint" strokeWidth={1.4} />
        </div>
        <div>
          <p className="font-text text-caption text-white/50 mb-1.5">列表</p>
          <h1 className="font-display text-[34px] font-semibold tracking-[-0.374px] text-white leading-tight">
            最近播放
          </h1>
          <p className="font-text text-[14px] text-white/50 tracking-[-0.224px] mt-1">
            {tracks.length} 首歌曲
          </p>
        </div>
      </div>

      {tracks.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="card-utility p-lg flex flex-col items-center text-center max-w-sm">
            <div className="w-20 h-20 rounded-lg glass-regular border border-white/10 flex items-center justify-center mb-5 shadow-[0_10px_30px_rgba(0,0,0,.18)]">
              <Clock className="h-10 w-10 text-mint" strokeWidth={1.5} />
            </div>
            <p className="text-tagline text-white mb-2">还没有播放记录</p>
            <p className="font-text text-caption text-white/50 mb-6">导入音乐后，你播放的歌曲会出现在这里</p>
            <button
              onClick={() => navigate('/library')}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-pill bg-mint text-[#030608] font-semibold text-[14px] shadow-[0_10px_30px_rgba(0,245,212,.18),inset_0_1px_0_rgba(255,255,255,.20)] hover:shadow-[0_10px_40px_rgba(0,245,212,.28)] transition-all duration-200 active:scale-95"
            >
              <Music className="h-4 w-4" strokeWidth={1.6} />
              去音乐库
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
          <table className="w-full font-text text-body">
            <thead>
              <tr className="border-b border-white/10">
                <th className="text-left py-3.5 px-4 font-semibold text-white/50 w-10 text-caption">#</th>
                <th className="text-left py-3.5 px-4 font-semibold text-white/50 text-caption">标题</th>
                <th className="text-left py-3.5 px-4 font-semibold text-white/50 text-caption">艺术家</th>
                <th className="text-left py-3.5 px-4 font-semibold text-white/50 text-caption hidden md:table-cell">专辑</th>
                <th className="text-right py-3.5 px-4 font-semibold text-white/50 text-caption w-16">时长</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((track, idx) => (
                <ContextMenu key={track.id}>
                  <ContextMenuTrigger asChild>
                    <tr
                      className="row-hover cursor-pointer border-b border-white/5 last:border-0 hover:bg-mint/[0.075]"
                      onClick={() => handlePlay(track, idx)}
                    >
                      <td className="py-3 px-4 text-white/50 text-caption">{idx + 1}</td>
                      <td className="py-3 px-4 font-semibold truncate max-w-xs text-white">{track.title}</td>
                      <td className="py-3 px-4 text-white/50 truncate max-w-40">{track.artist}</td>
                      <td className="py-3 px-4 text-white/50 truncate max-w-48 hidden md:table-cell">{track.album}</td>
                      <td className="py-3 px-4 text-right text-white/50 text-caption tabular-nums">{formatTime(track.duration)}</td>
                    </tr>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-52">
                    <ContextMenuItem onClick={() => handlePlay(track, idx)}>
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
                          <div className="px-2 py-1.5 text-sm text-white/50">暂无播放列表</div>
                        ) : (
                          playlists.map((pl) => (
                            <ContextMenuItem key={pl.id} onClick={() => handleAddToPlaylist(track.id, pl.id)}>
                              <ListPlus className="h-4 w-4 mr-2 opacity-50" strokeWidth={1.5} />
                              {pl.name}
                            </ContextMenuItem>
                          ))
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
