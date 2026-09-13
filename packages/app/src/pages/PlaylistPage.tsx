import { useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { CoverImage } from '@/components/common/CoverImage'
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
  Download,
  Upload,
  Link2,
  Search,
} from 'lucide-react'
import { usePlaylistStore } from '@/stores/playlistStore'
import { usePlayerStore } from '@/stores/playerStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { cn, formatTime, isDesktop } from '@/lib/utils'
import {
  downloadPlaylistAsM3U,
  parseM3U,
  matchTracksByPaths,
  pickM3UFile,
  ensurePlayableTrack,
  resolvePlayableTracks,
} from '@/services/playlistIO.service'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/stores/uiStore'
import { PlaylistImportDialog } from '@/components/PlaylistImportDialog'
import { toast } from '@/components/common/Toast'
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
  const createPlaylist = usePlaylistStore((s) => s.createPlaylist)
  const addTracksToPlaylist = usePlaylistStore((s) => s.addTracksToPlaylist)
  const tracks = useLibraryStore((s) => s.tracks)
  // 歌单导入的在线曲目（不在曲库里，反查兜底用）
  const importedTracks = usePlaylistStore((s) => s.importedTracks)
  const toggleLike = useLibraryStore((s) => s.toggleLike)
  const likedTracks = useLibraryStore((s) => s.likedTracks)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const playTrack = usePlayerStore((s) => s.playTrack)
  const addToQueue = usePlayerStore((s) => s.addToQueue)
  const playQueue = usePlayerStore((s) => s.playQueue)

  const [showImportDialog, setShowImportDialog] = useState(false)
  const setSearchOpen = useUIStore((s) => s.setSearchOpen)

  const playlist = playlists.find((p) => p.id === id)

  const playlistTracks = useMemo(() => {
    if (!playlist) return []
    return playlist.trackIds
      .map((tid) => tracks.find((t) => t.id === tid) || importedTracks[tid])
      .filter(Boolean) as typeof tracks
  }, [playlist, tracks, importedTracks])

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

  const handlePlayAll = async () => {
    if (playlistTracks.length === 0) return
    // 在线曲目可能没有可用地址（重启后过期被剥离），播放前按需取址
    const queue = await resolvePlayableTracks(playlistTracks)
    playQueue(queue, 0)
  }

  const handlePlayTrack = async (track: typeof tracks[0], index: number) => {
    if (currentTrack?.id === track.id) {
      usePlayerStore.getState().togglePlay()
      return
    }
    const playable = await ensurePlayableTrack(track)
    if (!playable) {
      toast('无法播放该在线歌曲：未配置音乐源或搜索无结果', { type: 'error' })
      return
    }
    const queue = playlistTracks.map((t) => (t.id === playable.id ? playable : t))
    playQueue(queue, index)
  }

  const isCurrentTrack = (trackId: string) => currentTrack?.id === trackId

  const handleExport = () => {
    downloadPlaylistAsM3U(playlist, tracks)
  }

  const handleImport = async () => {
    const content = await pickM3UFile()
    if (!content) return
    const paths = parseM3U(content)
    if (paths.length === 0) {
      toast('文件中没有找到有效的音乐路径', { type: 'error' })
      return
    }
    const matchedTracks = matchTracksByPaths(paths, tracks)
    if (matchedTracks.length === 0) {
      toast('没有匹配到音乐库中的歌曲，请先扫描包含这些歌曲的目录', { type: 'error' })
      return
    }
    // 从文件名推断播放列表名称
    const newPlaylist = createPlaylist('导入的播放列表')
    addTracksToPlaylist(newPlaylist.id, matchedTracks.map((t) => t.id))
    // 可选：导航到新播放列表
    navigate(`/playlist/${newPlaylist.id}`)
  }

  return (
    // 与其他页面共享 1200px 居中内容轴（PageLayout 同款），避免全屏拉伸
    <div className="flex flex-col h-full overflow-hidden mx-auto w-full max-w-[1200px]">
      <div className="px-4 pt-4 md:px-8 md:pt-8 pb-6">
        {/* 返回在左、搜索在右：搜索按钮与其他页面一样固定在头部右上角原位置 */}
        <div className="flex items-center justify-between mb-4">
          <button
            className="btn-icon"
            onClick={() => navigate(-1)}
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.7} />
          </button>
          <button
            onClick={() => setSearchOpen(true)}
            title="搜索 (⌘K)"
            className="btn-icon"
          >
            <Search className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        </div>
        <div className="flex items-center gap-6 max-w-4xl">
          <div className="w-44 h-44 rounded-lg glass-regular border border-white/10 flex items-center justify-center flex-shrink-0 shadow-[0_10px_30px_rgba(0,0,0,.18)]">
            <ListMusic className="h-20 w-20 text-mint" strokeWidth={1.3} />
          </div>
          <div className="flex-1 min-w-0">
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
            className="w-11 h-11 rounded-full p-0"
            onClick={handlePlayAll}
            disabled={playlistTracks.length === 0}
          >
            {isPlaying ? <Pause className="h-5 w-5" strokeWidth={1.7} /> : <Play className="h-5 w-5 ml-0.5" strokeWidth={1.7} />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="w-11 h-11">
                <MoreHorizontal className="h-5 w-5" strokeWidth={1.6} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={handleExport} disabled={playlistTracks.length === 0}>
                <Download className="h-4 w-4 mr-2" strokeWidth={1.6} />
                导出为 M3U
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleImport}>
                <Upload className="h-4 w-4 mr-2" strokeWidth={1.6} />
                导入 M3U 文件
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowImportDialog(true)}>
                <Link2 className="h-4 w-4 mr-2" strokeWidth={1.6} />
                导入歌单（链接/文本）
              </DropdownMenuItem>
              <DropdownMenuSeparator />
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

      {/* pb 为底部悬浮播放条让位，避免滚动到底时内容被遮挡 */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 md:px-8 pb-[calc(100px+env(safe-area-inset-bottom))] lg:pb-32">
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
            {/* 表头与数据行使用同一套列宽（3rem/4rem 固定尾列），保证对齐 */}
            <div className="grid grid-cols-[40px_1fr_3rem_4rem] gap-3 px-4 py-3 font-text text-caption text-white/50 border-b border-white/10">
              <span>#</span>
              <span>标题</span>
              <span className="text-right">
                <Clock className="h-3.5 w-3.5 inline-block" strokeWidth={1.6} />
              </span>
              <span></span>
            </div>

            {playlistTracks.map((track, idx) => (
              <div
                key={track.id}
                // 与音乐库一致：桌面端双击播放（单击仅 hover），移动端单击播放
                onClick={isDesktop() ? undefined : () => handlePlayTrack(track, idx)}
                onDoubleClick={isDesktop() ? () => handlePlayTrack(track, idx) : undefined}
                className={cn(
                  'grid grid-cols-[40px_1fr_3rem_4rem] gap-3 items-center px-4 py-2.5 cursor-pointer group row-hover border-b border-white/5 last:border-0',
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
                  <div className="w-10 h-10 rounded-[8px] bg-white/[0.04] flex items-center justify-center flex-shrink-0 overflow-hidden product-shadow">
                    <CoverImage
                      track={track}
                      className="w-full h-full object-cover"
                      fallback={<Music2 className="h-4 w-4 text-white/40" strokeWidth={1.6} />}
                    />
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
                      'h-7 w-7 flex items-center justify-center rounded-[8px] hover:bg-mint/[0.075] transition-all duration-200 ease-apple',
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
                        className="h-7 w-7 flex items-center justify-center rounded-[8px] hover:bg-mint/[0.075] text-white/50 transition-all duration-200 ease-apple"
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

      <PlaylistImportDialog open={showImportDialog} onOpenChange={setShowImportDialog} />
    </div>
  )
}
