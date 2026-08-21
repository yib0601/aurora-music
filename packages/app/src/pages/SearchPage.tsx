import { useState, useMemo, useEffect, useRef } from 'react'
import { Search as SearchIcon, Play, Plus, ListEnd, Music2, Heart, Loader2, Cloud, HardDrive } from 'lucide-react'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { useNavigate } from 'react-router-dom'
import { platform } from '@/services/platform'
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
import type { Track, OnlineTrackSearchResult } from '@/types'

/**
 * Apple Liquid Glass SearchPage
 * - 标题用 display-md 字号
 * - 搜索框：Liquid Glass 浮层 + pill 圆角 + Action Blue 焦点环
 * - 结果行用 row-hover（仅颜色变化，无位移）+ hairline 分隔
 * - 封面缩略图 rounded-xs + bg-white/[0.04] + product-shadow（仅 img）
 * - 收藏图标 active 态使用 text-coral fill-coral（珊瑚红强调）
 * - 空状态使用 card-utility 容器（白底 + 1px hairline + 18px 圆角）+ tagline 文案
 * - 本地/在线双 tab：本地走内存过滤，在线按用户配置的歌源协议搜索
 */
export function SearchPage() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [tab, setTab] = useState<'local' | 'online'>('local')
  const [onlineResults, setOnlineResults] = useState<OnlineTrackSearchResult[]>([])
  const [onlineLoading, setOnlineLoading] = useState(false)
  const [onlineError, setOnlineError] = useState<string | null>(null)
  const tracks = useLibraryStore((s) => s.tracks)
  const toggleLike = useLibraryStore((s) => s.toggleLike)
  const likedTracks = useLibraryStore((s) => s.likedTracks)
  const playlists = usePlaylistStore((s) => s.playlists)
  const addTracksToPlaylist = usePlaylistStore((s) => s.addTracksToPlaylist)
  // 歌源配置：应用不内置任何源，全部由用户按协议配置
  const onlineSources = useLibraryStore((s) => s.onlineSources)
  // 已启用的源（空数组 = 用户尚未配置任何源，搜索页需给出引导）
  const enabledSourceCount = useMemo(
    () => onlineSources.filter((s) => s.enabled && s.apiUrl).length,
    [onlineSources]
  )
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>()
  // 并发取消：每次发起新搜索递增 seq，响应回来时校验是否仍是最新一次
  const searchSeqRef = useRef(0)

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => setDebouncedQuery(query), 200)
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current) }
  }, [query])

  const localResults = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase()
    if (!q) return []
    return tracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.album.toLowerCase().includes(q)
    )
  }, [debouncedQuery, tracks])

  // 在线搜索：tab=online 且 query 非空时触发
  useEffect(() => {
    const q = debouncedQuery.trim()
    if (tab !== 'online' || !q) {
      setOnlineResults([])
      setOnlineError(null)
      return
    }
    const seq = ++searchSeqRef.current
    setOnlineLoading(true)
    setOnlineError(null)
    platform
      .searchOnlineTracks(q, {
        sources: onlineSources,
      })
      .then((res) => {
        if (seq !== searchSeqRef.current) return
        setOnlineResults(res)
      })
      .catch((err) => {
        if (seq !== searchSeqRef.current) return
        // 展示主进程返回的直白中文错误（如"网络请求失败，请检查网络连接"）
        setOnlineError(err?.message || '搜索失败，请稍后重试')
        setOnlineResults([])
      })
      .finally(() => {
        if (seq !== searchSeqRef.current) return
        setOnlineLoading(false)
      })
  }, [debouncedQuery, tab, onlineSources])

  // 在线结果转 Track（复用播放器逻辑）：path 置空，onlineUrl 携带播放地址
  const onlineTracks: Track[] = useMemo(() => {
    return onlineResults.map((r) => ({
      id: r.id,
      path: '',
      title: r.title,
      artist: r.artist,
      album: r.album,
      duration: r.duration,
      addedAt: Date.now(),
      playCount: 0,
      liked: false,
      onlineUrl: r.audioUrl,
      onlineSource: r.source,
      onlineSourceName: r.sourceName,
      onlineId: r.id,
    }))
  }, [onlineResults])

  // 按来源分组：每个源一个分组，顺序跟随结果出现顺序（即用户配置的源顺序）
  const onlineGroups = useMemo(() => {
    type Group = { key: string; label: string; tracks: Track[] }
    const groupMap = new Map<string, Group>()
    for (const t of onlineTracks) {
      const name = t.onlineSourceName || '在线音乐'
      if (!groupMap.has(name)) {
        groupMap.set(name, { key: name, label: name, tracks: [] })
      }
      groupMap.get(name)!.tracks.push(t)
    }
    return Array.from(groupMap.values())
  }, [onlineTracks])

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
      <div className="relative max-w-xl mb-5">
        <SearchIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-mint/70" strokeWidth={1.5} />
        <input
          type="text"
          placeholder="搜索歌曲、艺术家、专辑..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="glass-search-box rounded-full h-11 w-full pl-10 pr-4 font-text text-[14px] text-white/92 outline-none placeholder:text-white/28 tracking-[-0.224px]"
          autoFocus
        />
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
        {!query.trim() ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="relative mb-5">
              <div className="absolute -inset-10 bg-gradient-to-b from-mint/10 to-transparent rounded-full blur-3xl" />
              <div className="relative w-24 h-24 rounded-[24px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                <SearchIcon className="h-10 w-10 text-mint/50" strokeWidth={1} />
              </div>
            </div>
            <p className="font-display text-[20px] font-bold text-white/90 mb-1.5 tracking-[-0.3px]">开始搜索</p>
            <p className="font-text text-[13px] text-white/40 tracking-[-0.15px]">输入关键词搜索你的音乐库</p>
          </div>
        ) : (
          <>
            {/* 本地/在线 tab 切换 */}
            <div className="flex items-center gap-1 mb-4 px-1">
              <button
                onClick={() => setTab('local')}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold tracking-[-0.12px] transition-colors duration-200 ease-apple',
                  tab === 'local'
                    ? 'bg-mint/[0.12] text-mint'
                    : 'text-white/40 hover:text-white/70 hover:bg-white/[0.04]'
                )}
              >
                <HardDrive className="h-3 w-3" strokeWidth={1.8} />
                本地 ({localResults.length})
              </button>
              <button
                onClick={() => setTab('online')}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold tracking-[-0.12px] transition-colors duration-200 ease-apple',
                  tab === 'online'
                    ? 'bg-mint/[0.12] text-mint'
                    : 'text-white/40 hover:text-white/70 hover:bg-white/[0.04]'
                )}
              >
                <Cloud className="h-3 w-3" strokeWidth={1.8} />
                在线
              </button>
            </div>

            {tab === 'local' ? (
              localResults.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full">
                  <div className="relative mb-5">
                    <div className="absolute -inset-10 bg-gradient-to-b from-coral/10 to-transparent rounded-full blur-3xl" />
                    <div className="relative w-24 h-24 rounded-[24px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                      <Music2 className="h-10 w-10 text-coral/50" strokeWidth={1} />
                    </div>
                  </div>
                  <p className="font-display text-[20px] font-bold text-white/90 mb-1.5 tracking-[-0.3px]">未找到结果</p>
                  <p className="font-text text-[14px] text-white/40 tracking-[-0.15px]">没有匹配 "{query}" 的本地歌曲</p>
                </div>
              ) : (
                <div className="space-y-5">
                  <section>
                    <div className="card-list overflow-hidden">
                      {localResults.slice(0, 30).map((track, idx) => (
                        <ContextMenu key={track.id}>
                          <ContextMenuTrigger asChild>
                            <div
                              className="row-hover flex items-center gap-3 px-4 py-2.5 cursor-pointer group border-b border-white/5 last:border-0 hover:bg-mint/[0.075]"
                              onDoubleClick={() => handlePlayTrack(track, idx, localResults)}
                            >
                              {/* 序号/播放图标叠放在固定宽度容器内切换，避免 hover 时布局抖动 */}
                              <span className="w-6 flex-shrink-0 flex items-center justify-center relative">
                                <span className="font-text text-[12px] text-white/35 tabular-nums tracking-[-0.12px] transition-opacity duration-150 group-hover:opacity-0">
                                  {idx + 1}
                                </span>
                                <Play className="w-3 h-3 absolute text-mint opacity-0 transition-opacity duration-150 group-hover:opacity-100" strokeWidth={1.8} />
                              </span>
                              <div
                                onClick={(e) => {
                                  e.stopPropagation()
                                  navigate(`/song/${track.id}`)
                                }}
                                title="查看歌曲详情"
                                className="w-10 h-10 rounded-xs bg-white/[0.04] flex items-center justify-center flex-shrink-0 overflow-hidden cursor-pointer transition-transform duration-200 ease-apple hover:scale-105"
                              >
                                {track.coverPath ? (
                                  <img src={platform.getCoverSrc(track.coverPath)} alt="" className="w-full h-full object-cover product-shadow" />
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
                            <ContextMenuItem onClick={() => handlePlayTrack(track, idx, localResults)}>
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
              )
            ) : enabledSourceCount === 0 ? (
              <div className="flex flex-col items-center justify-center h-full">
                <div className="relative mb-5">
                  <div className="absolute -inset-10 bg-gradient-to-b from-mint/10 to-transparent rounded-full blur-3xl" />
                  <div className="relative w-24 h-24 rounded-[24px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                    <Cloud className="h-10 w-10 text-mint/50" strokeWidth={1} />
                  </div>
                </div>
                <p className="font-display text-[20px] font-bold text-white/90 mb-1.5 tracking-[-0.3px]">未配置音乐源</p>
                <p className="font-text text-[14px] text-white/40 tracking-[-0.15px] mb-5 text-center max-w-xs">
                  应用不内置任何音乐源，请先在设置中配置符合协议的搜索接口
                </p>
                <button
                  onClick={() => navigate('/settings')}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-mint/[0.12] text-mint text-[13px] font-semibold hover:bg-mint/20 transition-colors duration-200 ease-apple"
                >
                  前往设置音乐源
                </button>
              </div>
            ) : onlineLoading ? (
              <div className="flex flex-col items-center justify-center h-full">
                <Loader2 className="h-10 w-10 text-mint/60 animate-spin mb-4" strokeWidth={1.5} />
                <p className="font-text text-[14px] text-white/50 tracking-[-0.15px]">正在搜索在线音乐...</p>
              </div>
            ) : onlineError ? (
              <div className="flex flex-col items-center justify-center h-full">
                <div className="relative mb-5">
                  <div className="absolute -inset-10 bg-gradient-to-b from-coral/10 to-transparent rounded-full blur-3xl" />
                  <div className="relative w-24 h-24 rounded-[24px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                    <Music2 className="h-10 w-10 text-coral/50" strokeWidth={1} />
                  </div>
                </div>
                <p className="font-display text-[20px] font-bold text-white/90 mb-1.5 tracking-[-0.3px]">搜索失败</p>
                <p className="font-text text-[14px] text-white/40 tracking-[-0.15px]">{onlineError}</p>
              </div>
            ) : onlineTracks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full">
                <div className="relative mb-5">
                  <div className="absolute -inset-10 bg-gradient-to-b from-coral/10 to-transparent rounded-full blur-3xl" />
                  <div className="relative w-24 h-24 rounded-[24px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                    <Music2 className="h-10 w-10 text-coral/50" strokeWidth={1} />
                  </div>
                </div>
                <p className="font-display text-[20px] font-bold text-white/90 mb-1.5 tracking-[-0.3px]">未找到结果</p>
                <p className="font-text text-[14px] text-white/40 tracking-[-0.15px]">没有匹配 "{query}" 的在线歌曲</p>
              </div>
            ) : (
              <div className="space-y-5">
                {onlineGroups.map((group) => (
                  <section key={group.key}>
                    <h2 className="font-text text-[12px] font-semibold text-white/40 mb-3 px-1 tracking-[-0.12px]">
                      {group.label} ({group.tracks.length})
                    </h2>
                    <div className="card-list overflow-hidden">
                      {group.tracks.map((track, idx) => {
                        // 找到该曲目在 onlineResults 中的原始索引，用于取封面 URL
                        const resultIdx = onlineResults.findIndex((r) => r.id === track.id)
                        return (
                          <ContextMenu key={track.id}>
                            <ContextMenuTrigger asChild>
                              <div
                                className="row-hover flex items-center gap-3 px-4 py-2.5 cursor-pointer group border-b border-white/5 last:border-0 hover:bg-mint/[0.075]"
                                onDoubleClick={() => handlePlayTrack(track, idx, group.tracks)}
                              >
                                {/* 序号/播放图标叠放在固定宽度容器内切换，避免 hover 时布局抖动 */}
                                <span className="w-6 flex-shrink-0 flex items-center justify-center relative">
                                  <span className="font-text text-[12px] text-white/35 tabular-nums tracking-[-0.12px] transition-opacity duration-150 group-hover:opacity-0">
                                    {idx + 1}
                                  </span>
                                  <Play className="w-3 h-3 absolute text-mint opacity-0 transition-opacity duration-150 group-hover:opacity-100" strokeWidth={1.8} />
                                </span>
                                <div className="w-10 h-10 rounded-xs bg-white/[0.04] flex items-center justify-center flex-shrink-0 overflow-hidden">
                                  {onlineResults[resultIdx]?.coverUrl ? (
                                    <img src={onlineResults[resultIdx].coverUrl} alt="" className="w-full h-full object-cover product-shadow" referrerPolicy="no-referrer" />
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
                              </div>
                            </ContextMenuTrigger>
                            <ContextMenuContent className="w-52">
                              <ContextMenuItem onClick={() => handlePlayTrack(track, idx, group.tracks)}>
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
                            </ContextMenuContent>
                          </ContextMenu>
                        )
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </PageLayout>
  )
}
