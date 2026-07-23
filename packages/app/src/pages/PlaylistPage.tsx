import { useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Play,
  Pause,
  Heart,
  MoreHorizontal,
  ArrowLeft,
  ListMusic,
  Clock,
  Plus,
  Trash2,
  Music2,
} from 'lucide-react'
import { usePlaylistStore } from '@/stores/playlistStore'
import { usePlayerStore } from '@/stores/playerStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { cn, formatTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

export function PlaylistPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const playlists = usePlaylistStore((s) => s.playlists)
  const removeTrackFromPlaylist = usePlaylistStore((s) => s.removeTrackFromPlaylist)
  const deletePlaylist = usePlaylistStore((s) => s.deletePlaylist)
  const tracks = useLibraryStore((s) => s.tracks)
  const toggleLike = useLibraryStore((s) => s.toggleLike)
  const likedTracks = useLibraryStore((s) => s.likedTracks)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const playTrack = usePlayerStore((s) => s.playTrack)
  const addToQueue = usePlayerStore((s) => s.addToQueue)
  const playQueue = usePlayerStore((s) => s.playQueue)

  const playlist = playlists.find((p) => p.id === id)

  const playlistTracks = useMemo(() => {
    if (!playlist) return []
    return playlist.trackIds
      .map((tid) => tracks.find((t) => t.id === tid))
      .filter(Boolean) as typeof tracks
  }, [playlist, tracks])

  if (!playlist) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-white/50">
        <div className="card-utility p-lg flex flex-col items-center text-center max-w-sm">
          <ListMusic className="h-16 w-16 mb-4 text-mint" strokeWidth={1.5} />
          <p className="text-tagline text-white mb-3">播放列表不存在</p>
          <Button variant="link" onClick={() => navigate('/library')}>
            返回音乐库
          </Button>
        </div>
      </div>
    )
  }

  const totalDuration = playlistTracks.reduce((sum, t) => sum + t.duration, 0)

  const handlePlayAll = () => {
    if (playlistTracks.length === 0) return
    playQueue(playlistTracks, 0)
  }

  const handlePlayTrack = (track: typeof tracks[0], index: number) => {
    if (currentTrack?.id === track.id) {
      usePlayerStore.getState().togglePlay()
      return
    }
    playQueue(playlistTracks, index)
  }

  const isCurrentTrack = (trackId: string) => currentTrack?.id === trackId

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="p-8 pb-6">
        <Button
          variant="ghost"
          size="icon"
          className="mb-4 transition-all duration-200 ease-apple"
          onClick={() => navigate(-1)}
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.7} />
        </Button>
        <div className="flex items-end gap-6">
          <div className="w-44 h-44 rounded-lg glass-regular border border-white/10 flex items-center justify-center flex-shrink-0 shadow-[0_10px_30px_rgba(0,0,0,.18)]">
            <ListMusic className="h-20 w-20 text-mint" strokeWidth={1.3} />
          </div>
          <div className="flex-1 pb-2">
            <p className="font-text text-caption text-white/50 mb-2">播放列表</p>
            <h1 className="font-display text-[34px] font-semibold tracking-[-0.374px] text-white leading-tight mb-3">
              {playlist.name}
            </h1>
            <div className="flex items-center gap-3 font-text text-caption text-white/50">
              <span>{playlistTracks.length} 首歌曲</span>
              {totalDuration > 0 && (
                <>
                  <span>•</span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" strokeWidth={1.6} />
                    {formatTime(totalDuration)}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-7">
          <Button
            variant="primary"
            size="icon"
            className="w-12 h-12 rounded-full p-0"
            onClick={handlePlayAll}
            disabled={playlistTracks.length === 0}
          >
            {isPlaying ? <Pause className="h-5 w-5" strokeWidth={1.7} /> : <Play className="h-5 w-5 ml-0.5" strokeWidth={1.7} />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <MoreHorizontal className="h-5 w-5" strokeWidth={1.6} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => {
                  deletePlaylist(playlist.id)
                  navigate('/library')
                }}
              >
                <Trash2 className="h-4 w-4 mr-2" strokeWidth={1.6} />
                删除播放列表
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
        {playlistTracks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24">
            <div className="card-utility p-lg flex flex-col items-center text-center max-w-sm">
              <div className="w-20 h-20 rounded-lg glass-regular border border-white/10 flex items-center justify-center mb-5 shadow-[0_10px_30px_rgba(0,0,0,.18)]">
                <Music2 className="h-10 w-10 text-mint" strokeWidth={1.5} />
              </div>
              <p className="text-tagline text-white mb-1">播放列表为空</p>
              <p className="font-text text-caption text-white/50">从音乐库中添加歌曲</p>
            </div>
          </div>
        ) : (
          <div>
            <div className="grid grid-cols-[40px_1fr_auto_auto] gap-3 px-4 py-3 font-text text-caption text-white/50 border-b border-white/10">
              <span>#</span>
              <span>标题</span>
              <span>
                <Clock className="h-3.5 w-3.5" strokeWidth={1.6} />
              </span>
              <span></span>
            </div>

            {playlistTracks.map((track, idx) => (
              <div
                key={track.id}
                onClick={() => handlePlayTrack(track, idx)}
                className={cn(
                  'grid grid-cols-[40px_1fr_auto_auto] gap-3 items-center px-4 py-2.5 cursor-pointer group row-hover border-b border-white/5 last:border-0',
                  isCurrentTrack(track.id) && 'bg-mint/[0.06]'
                )}
              >
                <div className="text-caption text-white/50 w-6">
                  {isCurrentTrack(track.id) && isPlaying ? (
                    <div className="flex gap-0.5 items-end h-4">
                      <span className="w-1 bg-mint rounded-full animate-pulse" style={{ height: '60%' }} />
                      <span className="w-1 bg-mint rounded-full animate-pulse" style={{ height: '100%', animationDelay: '0.1s' }} />
                      <span className="w-1 bg-mint rounded-full animate-pulse" style={{ height: '40%', animationDelay: '0.2s' }} />
                    </div>
                  ) : isCurrentTrack(track.id) ? (
                    <Play className="h-3.5 w-3.5 text-mint" strokeWidth={1.8} />
                  ) : (
                    <>
                      <span className="group-hover:hidden">{idx + 1}</span>
                      <Play className="h-3.5 w-3.5 hidden group-hover:block text-mint" strokeWidth={1.8} />
                    </>
                  )}
                </div>
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xs bg-white/[0.04] flex items-center justify-center flex-shrink-0 overflow-hidden product-shadow">
                    {track.coverPath ? (
                      <img src={`file://${track.coverPath}`} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <Music2 className="h-4 w-4 text-white/40" strokeWidth={1.6} />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p
                      className={cn(
                        'font-text text-caption truncate font-semibold',
                        isCurrentTrack(track.id) ? 'text-mint' : 'text-white'
                      )}
                    >
                      {track.title}
                    </p>
                    <p className="font-text text-caption text-white/50 truncate">{track.artist}</p>
                  </div>
                </div>
                <span className="font-text text-caption text-white/50 tabular-nums w-12 text-right">
                  {formatTime(track.duration)}
                </span>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all duration-200 ease-apple w-16 justify-end">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleLike(track.id)
                    }}
                    className={cn(
                      'p-1.5 rounded-sm hover:bg-mint/[0.075] transition-all duration-200 ease-apple',
                      likedTracks.has(track.id) ? 'text-coral' : 'text-white/40'
                    )}
                  >
                    <Heart
                      className="h-3.5 w-3.5"
                      fill={likedTracks.has(track.id) ? 'currentColor' : 'none'}
                      strokeWidth={1.7}
                    />
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        onClick={(e) => e.stopPropagation()}
                        className="p-1.5 rounded-sm hover:bg-mint/[0.075] text-white/50 transition-all duration-200 ease-apple"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.7} />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={(e) => {
                        e.stopPropagation()
                        addToQueue(track)
                      }}>
                        <Plus className="h-4 w-4 mr-2" strokeWidth={1.6} />
                        添加到队列
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation()
                          removeTrackFromPlaylist(playlist.id, track.id)
                        }}
                      >
                        <Trash2 className="h-4 w-4 mr-2" strokeWidth={1.6} />
                        从播放列表移除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
