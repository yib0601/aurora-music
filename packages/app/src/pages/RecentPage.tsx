import { useMemo, useState } from 'react'
import { Clock, Play, Plus, ListEnd, ListPlus, Heart, Music } from 'lucide-react'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { dedupeTracksForDisplay } from '@aurora/shared'
import { usePlaylistStore } from '@/stores/playlistStore'
import { useNavigate } from 'react-router-dom'
import { formatTime, cn, isDesktop } from '@/lib/utils'
import { LIBRARY_ROUTE, NAV_LABEL_KEYS } from '@/lib/routes'
import { useT } from '@/i18n'
import { PageLayout } from '@/components/PageLayout'
import { PageTitle, EmptyText, EmptyTitle } from '@/components/PageHeading'
import { CoverImage } from '@/components/common/CoverImage'
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
  const t = useT()
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
    // 同一首歌在多来源都有且都被播过时只留一份（本机优先），避免最近播放里重复
    return dedupeTracksForDisplay(merged).tracks
  }, [allTracks, recentPlayedTracks])
  const playlists = usePlaylistStore((s) => s.playlists)
  const addTracksToPlaylist = usePlaylistStore((s) => s.addTracksToPlaylist)

  // 取址交给 store：队列与当前曲目立即落地，播放条马上显示这首歌，
  // 在线直链在后台取（取不到时 store 统一提示），不再阻塞在这里
  const handlePlay = (_track: Track, idx: number) => {
    usePlayerStore.getState().playQueue(tracks, idx)
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
        // 与曲库页同款头部：标题左；搜索入口已上移到应用顶栏（全局常驻）
        <div className="flex items-end justify-between gap-4 mb-6 md:mb-8">
          <div className="min-w-0">
            <PageTitle>{t('library.recent.title')}</PageTitle>
          </div>
          {/* 搜索入口已上移到应用顶栏（全局常驻），页头不再放置 */}
        </div>
      }
    >
      {tracks.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center">
          <div className="relative mb-6">
            <div className="absolute -inset-16 bg-gradient-to-b from-mint/[0.06] to-transparent rounded-full blur-3xl" />
            <div className="relative w-[120px] h-[120px] rounded-[24px] bg-white/[0.03] border border-white/[0.08] flex items-center justify-center">
              <Clock className="h-[52px] w-[52px] text-mint/60" strokeWidth={1} />
            </div>
          </div>
          <EmptyTitle>{t('library.recent.empty.title')}</EmptyTitle>
          <EmptyText>{t('library.recent.empty.hint')}</EmptyText>
          <button
            onClick={() => navigate(LIBRARY_ROUTE)}
            className="pill pill-lg pill-mint"
          >
            <Music className="h-4 w-4" strokeWidth={1.6} />
            {t('library.action.goToLibrary', { label: t(NAV_LABEL_KEYS.library) })}
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
            <table className="w-full font-text text-body">
              {/* 移动端空间宝贵，隐藏表头（列表语义已由双行布局表达） */}
              <thead className="hidden md:table-header-group">
                <tr className="border-b border-white/[0.08]">
                  <th className="text-left py-2.5 px-3 font-semibold text-white/50 text-caption">{t('common.label.title')}</th>
                  <th className="text-left py-2.5 px-3 font-semibold text-white/50 text-caption">{t('common.label.artist')}</th>
                  <th className="text-left py-2.5 px-3 font-semibold text-white/50 text-caption">{t('common.label.album')}</th>
                  <th className="text-right py-2.5 px-3 font-semibold text-white/50 text-caption w-16">{t('common.label.duration')}</th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((track, idx) => (
                  <ContextMenu key={track.id}>
                    <ContextMenuTrigger asChild>
                      <tr
                        className="row-hover cursor-pointer border-b border-white/[0.05] last:border-0"
                        onClick={() => handlePlay(track, idx)}
                      >
                        <td className="py-3.5 px-1.5 md:py-3.5 md:px-3 max-w-xs">
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
                              title={t('library.action.viewDetails')}
                              className="w-11 h-11 rounded-[12px] bg-white/[0.04] flex items-center justify-center overflow-hidden flex-shrink-0 transition-transform duration-200 ease-apple hover:scale-105"
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
                        {t('common.action.play')}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handlePlayNext(track)}>
                        <ListEnd className="h-4 w-4 mr-2" strokeWidth={1.5} />
                        {t('library.action.playNext')}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleAddToQueue(track)}>
                        <Plus className="h-4 w-4 mr-2" strokeWidth={1.5} />
                        {t('library.action.addToQueue')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>
                          <ListPlus className="h-4 w-4 mr-2" strokeWidth={1.5} />
                          {t('library.action.addToPlaylist')}
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent className="w-48">
                          {playlists.length === 0 ? (
                            <div className="px-2 py-1.5 text-sm text-white/50">{t('library.playlist.empty')}</div>
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
                        {likedTracks.has(track.id) ? t('library.action.unlike') : t('library.action.like')}
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
