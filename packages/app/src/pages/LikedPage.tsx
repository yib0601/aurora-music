import { useMemo } from 'react'
import { Heart, Play, Plus, ListEnd, ListPlus, Music } from 'lucide-react'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { useNavigate } from 'react-router-dom'
import { formatTime, cn } from '@/lib/utils'
import { PageLayout } from '@/components/PageLayout'
import { platform } from '@/services/platform'
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

export function LikedPage() {
  const navigate = useNavigate()
  const allTracks = useLibraryStore((s) => s.tracks)
  const toggleLiked = useLibraryStore((s) => s.toggleLiked)
  const tracks = useMemo(() => allTracks.filter((t) => t.liked), [allTracks])
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
    <PageLayout title="我喜欢的音乐" subtitle={tracks.length === 0 ? '收藏你喜欢的歌曲' : `${tracks.length} 首歌曲`}>
      {tracks.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center">
          <div className="relative mb-6">
            <div className="absolute -inset-16 bg-gradient-to-b from-coral/8 to-transparent rounded-full blur-3xl" />
            <div className="relative w-[120px] h-[120px] rounded-[28px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
              <Heart className="h-[52px] w-[52px] text-coral/60" strokeWidth={1} />
            </div>
          </div>
          <h2 className="font-display text-[22px] font-semibold text-white/90 mb-2 tracking-[-0.3px]">
            还没有收藏的歌曲
          </h2>
          <p className="font-text text-[14px] text-white/50 mb-6 tracking-[-0.15px]">
            在歌曲上点击爱心，它们会出现在这里
          </p>
          <button
            onClick={() => navigate('/library')}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-mint text-mint-fg font-semibold text-[14px] hover:brightness-110 transition-all duration-200 active:scale-95"
          >
            <Music className="h-4 w-4" strokeWidth={1.6} />
            去音乐库
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
          <table className="w-full font-text text-body">
            {/* 移动端空间宝贵，隐藏表头（列表语义已由双行布局表达） */}
            <thead className="hidden md:table-header-group">
              <tr className="border-b border-white/10">
                <th className="text-left py-2.5 px-3 font-semibold text-white/50 text-caption">标题</th>
                <th className="text-left py-2.5 px-3 font-semibold text-white/50 text-caption">艺术家</th>
                <th className="text-left py-2.5 px-3 font-semibold text-white/50 text-caption">专辑</th>
                <th className="w-10"></th>
                <th className="text-right py-2.5 px-3 font-semibold text-white/50 text-caption w-16">时长</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((track, idx) => (
                <ContextMenu key={track.id}>
                  <ContextMenuTrigger asChild>
                    <tr
                      className="row-hover cursor-pointer group border-b border-white/5 last:border-0 hover:bg-mint/[0.075]"
                      onClick={() => handlePlay(track, idx)}
                    >
                      <td className="py-2 px-1.5 md:py-2.5 md:px-3 max-w-xs">
                        <div className="flex items-center gap-3 min-w-0">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              navigate(`/song/${track.id}`)
                            }}
                            title="查看歌曲详情"
                            className="w-11 h-11 md:w-9 md:h-9 rounded-lg md:rounded-[6px] bg-white/[0.04] flex items-center justify-center overflow-hidden flex-shrink-0 transition-transform duration-200 ease-apple hover:scale-105"
                          >
                            {track.coverPath ? (
                              <img src={platform.getCoverSrc(track.coverPath)} alt="" className="w-full h-full object-cover product-shadow" />
                            ) : (
                              <Heart className="h-4 w-4 text-coral/50" strokeWidth={1.5} />
                            )}
                          </button>
                          <div className="min-w-0">
                            <span className="block font-semibold text-[14px] truncate text-white">{track.title}</span>
                            {/* 移动端隐藏艺术家列，改为标题下方第二行展示 */}
                            <span className="block md:hidden text-[12px] text-white/40 truncate mt-0.5">{track.artist}</span>
                          </div>
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-white/50 truncate max-w-40 hidden md:table-cell">{track.artist}</td>
                      <td className="py-2.5 px-3 text-white/50 truncate max-w-48 hidden md:table-cell">{track.album}</td>
                      <td className="py-2 px-1 md:py-2.5 md:px-2 w-10">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleLiked(track.id)
                          }}
                          // 移动端无 hover，收藏按钮需常显；桌面端保持 hover 显示
                          className="opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-all duration-200 ease-apple p-1.5 hover:bg-mint/[0.075] rounded-sm"
                        >
                          <Heart
                            className={cn('h-4 w-4', track.liked ? 'text-coral fill-coral' : 'text-white/40')}
                            strokeWidth={1.7}
                          />
                        </button>
                      </td>
                      <td className="py-2 pr-1.5 pl-1 md:py-2.5 md:px-3 text-right text-white/50 text-caption tabular-nums w-12 md:w-16">{formatTime(track.duration)}</td>
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
                    <ContextMenuItem onClick={() => toggleLiked(track.id)}>
                      <Heart className="h-4 w-4 mr-2 text-coral fill-coral" strokeWidth={1.5} />
                      取消收藏
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageLayout>
  )
}
