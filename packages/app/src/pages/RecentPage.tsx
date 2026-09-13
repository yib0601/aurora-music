import { useMemo, useState } from 'react'
import { Clock, Play, Plus, ListEnd, ListPlus, Heart, Music } from 'lucide-react'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { useNavigate } from 'react-router-dom'
import { formatTime, cn, isDesktop } from '@/lib/utils'
import { PageLayout } from '@/components/PageLayout'
import { SearchEntry } from '@/components/common/SearchEntry'
import { CoverImage } from '@/components/common/CoverImage'
import { toast } from '@/components/common/Toast'
import { ensurePlayableTrack } from '@/services/playlistIO.service'
import type { Track } from '@/types'
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
  const recentPlayedTracks = useLibraryStore((s) => s.recentPlayedTracks)
  const toggleLike = useLibraryStore((s) => s.toggleLike)
  const likedTracks = useLibraryStore((s) => s.likedTracks)
  // 数据源 = 最近播放记录（本地 + 在线统一登记）；本地曲目优先取曲库最新对象
  // （封面/元数据可能已被扫描更新），在线曲目不进曲库，直接用记录快照。
  // 旧版本升级兼容：曲库里带 lastPlayedAt 但没有记录条目的本地曲目也一并展示
  const tracks = useMemo(() => {
    const libraryById = new Map(allTracks.map((t) => [t.id, t]))
    const recIds = new Set(recentPlayedTracks.map((t) => t.id))
    const merged: Track[] = recentPlayedTracks
      .map((rec) => (rec.path && libraryById.has(rec.id) ? libraryById.get(rec.id)! : rec))
      .filter((t) => t.lastPlayedAt)
    for (const t of allTracks) {
      if (t.lastPlayedAt && !recIds.has(t.id)) merged.push(t)
    }
    merged.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0))
    return merged
  }, [allTracks, recentPlayedTracks])
  const playlists = usePlaylistStore((s) => s.playlists)
  const addTracksToPlaylist = usePlaylistStore((s) => s.addTracksToPlaylist)

  const handlePlay = async (track: Track, idx: number) => {
    // 在线曲目播放地址会过期（落盘时已剥离），播放前按需重新取址
    const playable = await ensurePlayableTrack(track)
    if (!playable) {
      toast('无法播放该在线歌曲：未配置音乐源或搜索无结果', { type: 'error' })
      return
    }
    const queue = tracks.map((t) => (t.id === playable.id ? playable : t))
    usePlayerStore.getState().playQueue(queue, idx)
  }

  const handlePlayNext = (track: Track) => {
    usePlayerStore.getState().addToPlayNext(track)
  }

  const handleAddToQueue = (track: Track) => {
    usePlayerStore.getState().addToQueue(track)
  }

  const handleAddToPlaylist = (trackId: string, playlistId: string) => {
    addTracksToPlaylist(playlistId, [trackId])
  }

  return (
    <PageLayout
      header={
        // 与音乐库页同款头部：标题左、工具栏右；搜索入口固定在标题右侧原位置
        <div className="flex items-end justify-between gap-4 mb-6 md:mb-8">
          <div className="min-w-0">
            <h1 className="font-display text-[24px] md:text-[32px] font-semibold tracking-[-0.374px] text-white/98 leading-tight">
              最近播放
            </h1>
            <p className="font-text text-[13px] text-white/50 mt-1 tracking-[-0.2px]">
              {tracks.length === 0 ? '你的播放历史' : `${tracks.length} 首歌曲`}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 pb-1">
            <SearchEntry />
          </div>
        </div>
      }
    >
      {tracks.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center">
          <div className="relative mb-6">
            <div className="absolute -inset-16 bg-gradient-to-b from-mint/8 to-transparent rounded-full blur-3xl" />
            <div className="relative w-[120px] h-[120px] rounded-[28px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
              <Clock className="h-[52px] w-[52px] text-mint/60" strokeWidth={1} />
            </div>
          </div>
          <h2 className="font-display text-[22px] font-semibold text-white/90 mb-2 tracking-[-0.3px]">
            还没有播放记录
          </h2>
          <p className="font-text text-[14px] text-white/50 mb-6 tracking-[-0.15px]">
            导入音乐后，你播放的歌曲会出现在这里
          </p>
          <button
            onClick={() => navigate('/library')}
            className="pill pill-lg pill-mint"
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
                  <th className="text-right py-2.5 px-3 font-semibold text-white/50 text-caption w-16">时长</th>
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
                        <td className="py-2 px-1.5 md:py-2.5 md:px-3 max-w-xs">
                          <div className="flex items-center gap-3 min-w-0">
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                // 桌面端保留单击进详情；移动端与点击播放条一致：播放并打开全屏 Now Playing 浮层（不推进路由）
                                if (isDesktop()) navigate(`/song/${track.id}`)
                                else {
                                  handlePlay(track, idx)
                                  usePlaylistStore.getState().setMobileNowPlaying(true)
                                }
                              }}
                              title="查看歌曲详情"
                              className="w-11 h-11 md:w-9 md:h-9 rounded-[8px] bg-white/[0.04] flex items-center justify-center overflow-hidden flex-shrink-0 transition-transform duration-200 ease-apple hover:scale-105"
                            >
                              <CoverImage
                                track={track}
                                className="w-full h-full object-cover product-shadow"
                                fallback={<Clock className="h-4 w-4 text-white/30" strokeWidth={1.5} />}
                              />
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
    </PageLayout>
  )
}
