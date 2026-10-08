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
} from '@/services/playlistIO.service'
import { Button } from '@/components/ui/button'
import { useGoBack } from '@/lib/navigation'
import { HOME_ROUTE, LIBRARY_LABEL, LIBRARY_ROUTE } from '@/lib/routes'
import { SubPageTitle } from '@/components/PageHeading'
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
  // 返回兜底：历史栈底时 navigate(-1) 是 no-op，回主屏
  const goBack = useGoBack()
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
          <Button variant="link" onClick={() => navigate(LIBRARY_ROUTE)}>
            返回{LIBRARY_LABEL}
          </Button>
        </div>
      </div>
    )
  }

  const totalDuration = playlistTracks.reduce((sum, t) => sum + t.duration, 0)

  const handlePlayAll = () => {
    if (playlistTracks.length === 0) return
    // 整单播放：队列先落地再从第一首开始，取址由 playQueue 内部按需完成，
    // 不在页面上等所有在线曲目都取到地址（那会让「播放全部」卡住不响应）
    playQueue(playlistTracks, 0)
  }

  const handlePlayTrack = (track: typeof tracks[0], index: number) => {
    if (currentTrack?.id === track.id) {
      usePlayerStore.getState().togglePlay()
      return
    }
    // 不再在页面层预取址：取址是网络往返（可能几秒），会让「点了播放却什么都不显示」。
    // 队列与当前曲目立即落地，取址交给 playQueue 内部完成，失败时由 store 落错误提示
    playQueue(playlistTracks, index)
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
      toast(`没有匹配到${LIBRARY_LABEL}中的歌曲，请先扫描包含这些歌曲的目录`, { type: 'error' })
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
        {/* 返回按钮独占页头左侧：搜索入口已上移到应用顶栏（全局常驻），此处不再放置 */}
        {/* page-toolbar：手机端把 28px 的返回按钮提到 36px 触控尺寸 */}
        <div className="page-toolbar flex items-center mb-4">
          <button
            className="btn-icon"
            onClick={goBack}
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.7} />
          </button>
        </div>
        <div className="flex items-center gap-6 max-w-4xl">
          <div className="w-44 h-44 rounded-[24px] glass-regular border border-white/[0.08] flex items-center justify-center flex-shrink-0">
            <ListMusic className="h-20 w-20 text-mint" strokeWidth={1.3} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-text text-caption text-white/50 mb-2">播放列表</p>
            <SubPageTitle className="mb-3">{playlist.name}</SubPageTitle>
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
                  navigate(HOME_ROUTE)
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
              <div className="w-20 h-20 rounded-[16px] glass-regular border border-white/[0.08] flex items-center justify-center mb-5">
                <Music2 className="h-10 w-10 text-mint" strokeWidth={1.5} />
              </div>
              <p className="text-tagline text-white mb-1">播放列表为空</p>
              <p className="font-text text-caption text-white/50">从{LIBRARY_LABEL}中添加歌曲</p>
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
                // 与曲库一致：桌面端双击播放（单击仅 hover），移动端单击播放
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
                      'h-7 w-7 flex items-center justify-center rounded-[8px] hover:bg-white/[0.06] transition-colors duration-200 ease-apple',
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
                        className="h-7 w-7 flex items-center justify-center rounded-[8px] hover:bg-white/[0.06] text-white/50 transition-colors duration-200 ease-apple"
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
