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
import { playTrack as audioPlayTrack, playQueue } from '@/services/audio.service'
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

  const playlist = playlists.find((p) => p.id === id)

  const playlistTracks = useMemo(() => {
    if (!playlist) return []
    return playlist.trackIds
      .map((tid) => tracks.find((t) => t.id === tid))
      .filter(Boolean) as typeof tracks
  }, [playlist, tracks])

  if (!playlist) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-foreground/40">
        <ListMusic className="h-16 w-16 mb-4 opacity-20" />
        <p>播放列表不存在</p>
        <Button variant="link" onClick={() => navigate('/library')}>
          返回音乐库
        </Button>
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
      audioPlayTrack(track)
      return
    }
    playQueue(playlistTracks, index)
  }

  const isCurrentTrack = (trackId: string) => currentTrack?.id === trackId

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="p-1 pb-6">
        <Button
          variant="ghost"
          size="icon"
          className="mb-4 h-8 w-8 rounded-full hover:bg-foreground/10"
          onClick={() => navigate(-1)}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-end gap-6">
          <div className="w-44 h-44 rounded-2xl bg-gradient-to-br from-primary/25 to-primary/5 border border-border/30 flex items-center justify-center shadow-xl flex-shrink-0">
            <ListMusic className="h-20 w-20 text-foreground/30" />
          </div>
          <div className="flex-1 pb-2">
            <p className="text-xs font-medium uppercase tracking-wider text-foreground/45 mb-2">
              播放列表
            </p>
            <h1 className="text-4xl font-bold tracking-tight mb-3">{playlist.name}</h1>
            <div className="flex items-center gap-3 text-sm text-foreground/55">
              <span>{playlistTracks.length} 首歌曲</span>
              {totalDuration > 0 && (
                <>
                  <span>•</span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    {formatTime(totalDuration)}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-7">
          <Button
            size="lg"
            className="rounded-full w-12 h-12 p-0 bg-primary hover:bg-primary/90 shadow-lg shadow-primary/25"
            onClick={handlePlayAll}
            disabled={playlistTracks.length === 0}
          >
            {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-0.5" />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full hover:bg-foreground/10">
                <MoreHorizontal className="h-5 w-5" />
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
                <Trash2 className="h-4 w-4 mr-2" />
                删除播放列表
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
        {playlistTracks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-foreground/30">
            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-primary/25 to-primary/5 border border-border/30 flex items-center justify-center mb-5">
              <Music2 className="h-10 w-10 text-primary/70" />
            </div>
            <p className="text-sm text-foreground/45">播放列表为空</p>
            <p className="text-xs mt-1 text-foreground/35">从音乐库中添加歌曲</p>
          </div>
        ) : (
          <div className="rounded-2xl border border-border/30 overflow-hidden bg-foreground/[0.02]">
            <div className="grid grid-cols-[40px_1fr_auto_auto] gap-3 px-4 py-2.5 text-xs font-medium text-foreground/45 uppercase tracking-wider border-b border-border/30 bg-foreground/[0.02]">
              <span>#</span>
              <span>标题</span>
              <span>
                <Clock className="h-3.5 w-3.5" />
              </span>
              <span></span>
            </div>

            {playlistTracks.map((track, idx) => (
              <div
                key={track.id}
                onClick={() => handlePlayTrack(track, idx)}
                className={cn(
                  'grid grid-cols-[40px_1fr_auto_auto] gap-3 items-center px-4 py-2 cursor-pointer group transition-colors border-b border-border/20 last:border-0',
                  isCurrentTrack(track.id)
                    ? 'bg-primary/10'
                    : 'hover:bg-foreground/[0.04]'
                )}
              >
                <div className="text-sm text-foreground/50 w-6">
                  {isCurrentTrack(track.id) && isPlaying ? (
                    <div className="flex gap-0.5 items-end h-4">
                      <span className="w-1 bg-primary rounded-full animate-pulse" style={{ height: '60%' }} />
                      <span className="w-1 bg-primary rounded-full animate-pulse" style={{ height: '100%', animationDelay: '0.1s' }} />
                      <span className="w-1 bg-primary rounded-full animate-pulse" style={{ height: '40%', animationDelay: '0.2s' }} />
                    </div>
                  ) : isCurrentTrack(track.id) ? (
                    <Play className="h-3.5 w-3.5 text-primary" />
                  ) : (
                    <>
                      <span className="group-hover:hidden">{idx + 1}</span>
                      <Play className="h-3.5 w-3.5 hidden group-hover:block" />
                    </>
                  )}
                </div>
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary/15 to-primary/5 border border-border/30 flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {track.coverPath ? (
                      <img src={`file://${track.coverPath}`} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <Music2 className="h-4 w-4 opacity-35" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p
                      className={cn(
                        'text-sm truncate font-medium',
                        isCurrentTrack(track.id) ? 'text-primary' : ''
                      )}
                    >
                      {track.title}
                    </p>
                    <p className="text-xs text-foreground/45 truncate">{track.artist}</p>
                  </div>
                </div>
                <span className="text-xs text-foreground/45 tabular-nums w-12 text-right">
                  {formatTime(track.duration)}
                </span>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity w-16 justify-end">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleLike(track.id)
                    }}
                    className={cn(
                      'p-1.5 rounded-lg hover:bg-foreground/10',
                      likedTracks.has(track.id) ? 'text-red-500' : 'text-foreground/40'
                    )}
                  >
                    <Heart className="h-3.5 w-3.5" fill={likedTracks.has(track.id) ? 'currentColor' : 'none'} />
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        onClick={(e) => e.stopPropagation()}
                        className="p-1.5 rounded-lg hover:bg-foreground/10 text-foreground/40"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={(e) => {
                        e.stopPropagation()
                        addToQueue(track)
                      }}>
                        <Plus className="h-4 w-4 mr-2" />
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
                        <Trash2 className="h-4 w-4 mr-2" />
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
