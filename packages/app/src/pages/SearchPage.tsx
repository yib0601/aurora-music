import { useState, useMemo, useEffect, useRef } from 'react'
import { Search as SearchIcon, Play, Plus, ListEnd, Music2, Heart } from 'lucide-react'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { cn, formatTime } from '@/lib/utils'
import { PageLayout } from '@/components/PageLayout'
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

/**
 * Apple Liquid Glass SearchPage
 * - 标题用 display-md 字号
 * - 搜索框：Liquid Glass 浮层 + pill 圆角 + Action Blue 焦点环
 * - 结果行用 row-hover（仅颜色变化，无位移）+ hairline 分隔
 * - 封面缩略图 rounded-xs + bg-white/[0.04] + product-shadow（仅 img）
 * - 收藏图标 active 态使用 text-coral fill-coral（珊瑚红强调）
 * - 空状态使用 card-utility 容器（白底 + 1px hairline + 18px 圆角）+ tagline 文案
 */
export function SearchPage() {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const tracks = useLibraryStore((s) => s.tracks)
  const toggleLike = useLibraryStore((s) => s.toggleLike)
  const likedTracks = useLibraryStore((s) => s.likedTracks)
  const playlists = usePlaylistStore((s) => s.playlists)
  const addTracksToPlaylist = usePlaylistStore((s) => s.addTracksToPlaylist)
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => setDebouncedQuery(query), 200)
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current) }
  }, [query])

  const results = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase()
    if (!q) return []
    return tracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.album.toLowerCase().includes(q)
    )
  }, [debouncedQuery, tracks])

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
    <PageLayout title="搜索">
      <div className="relative max-w-2xl mb-7">
        <SearchIcon className="absolute left-4 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-mint/70" strokeWidth={1.5} />
        <input
          type="text"
          placeholder="搜索歌曲、艺术家、专辑..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="glass-search-box rounded-[22px] h-[58px] w-full pl-11 pr-4 font-text text-[17px] text-white/92 outline-none placeholder:text-white/22 tracking-[-0.374px]"
          autoFocus
        />
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
        {!query.trim() ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="relative mb-6">
              <div className="absolute -inset-12 bg-gradient-to-b from-mint/10 to-transparent rounded-full blur-3xl" />
              <div className="relative w-32 h-32 rounded-[28px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                <SearchIcon className="h-14 w-14 text-mint/50" strokeWidth={1} />
              </div>
            </div>
            <p className="font-display text-[24px] font-bold text-white/90 mb-2 tracking-[-0.3px]">开始搜索</p>
            <p className="font-text text-[14px] text-white/40 tracking-[-0.15px]">输入关键词搜索你的音乐库</p>
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="relative mb-6">
              <div className="absolute -inset-12 bg-gradient-to-b from-coral/10 to-transparent rounded-full blur-3xl" />
              <div className="relative w-32 h-32 rounded-[28px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                <Music2 className="h-14 w-14 text-coral/50" strokeWidth={1} />
              </div>
            </div>
            <p className="font-display text-[24px] font-bold text-white/90 mb-2 tracking-[-0.3px]">未找到结果</p>
            <p className="font-text text-[14px] text-white/40 tracking-[-0.15px]">没有匹配 "{query}" 的歌曲</p>
          </div>
        ) : (
          <div className="space-y-5">
            <section>
              <h2 className="font-text text-[12px] font-semibold text-white/40 mb-3 px-1 tracking-[-0.12px]">
                歌曲 ({results.length})
              </h2>
              <div className="card-utility overflow-hidden">
                {results.slice(0, 30).map((track, idx) => (
                  <ContextMenu key={track.id}>
                    <ContextMenuTrigger asChild>
                      <div
                        className="row-hover flex items-center gap-3 px-4 py-3 cursor-pointer group border-b border-white/5 last:border-0 hover:bg-mint/[0.075]"
                        onDoubleClick={() => handlePlayTrack(track, idx, results)}
                      >
                        <span className="font-text text-[12px] text-white/35 w-5 text-right group-hover:hidden tabular-nums tracking-[-0.12px]">
                          {idx + 1}
                        </span>
                        <Play className="w-3 h-3 hidden group-hover:block text-mint" strokeWidth={1.8} />
                        <div className="w-10 h-10 rounded-xs bg-white/[0.04] flex items-center justify-center flex-shrink-0 overflow-hidden">
                          {track.coverPath ? (
                            <img src={`file://${track.coverPath}`} alt="" className="w-full h-full object-cover product-shadow" />
                          ) : (
                            <Music2 className="h-4 w-4 text-white/30" strokeWidth={1.6} />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-text text-[14px] font-semibold truncate text-white/92 tracking-[-0.224px]">{track.title}</p>
                          <p className="font-text text-[12px] text-white/50 truncate tracking-[-0.12px]">{track.artist}</p>
                        </div>
                        <span className="font-text text-[12px] text-white/35 truncate max-w-32 hidden md:block tracking-[-0.12px]">
                          {track.album}
                        </span>
                        <span className="font-text text-[12px] text-white/35 tabular-nums w-10 text-right tracking-[-0.12px]">
                          {formatTime(track.duration)}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleLike(track.id)
                          }}
                          className="p-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 ease-apple hover:bg-mint/[0.075] rounded-xs"
                        >
                          <Heart
                            className={cn('h-3.5 w-3.5', likedTracks.has(track.id) ? 'text-coral fill-coral' : 'text-white/40')}
                            strokeWidth={1.7}
                          />
                        </button>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-52">
                      <ContextMenuItem onClick={() => handlePlayTrack(track, idx, results)}>
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
                          <Plus className="h-4 w-4 mr-2 opacity-50" strokeWidth={1.5} />
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
    </PageLayout>
  )
}
