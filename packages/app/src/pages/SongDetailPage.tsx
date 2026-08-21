import { useEffect, useMemo, useState, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Play, Pause, Heart, Plus, ListEnd, ListMusic, Music2, ArrowLeft,
  BarChart3, Clock, Calendar, Tag, HardDrive, Layers, History, MoreHorizontal,
  Disc3, Radio, Folder, ChevronDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PlayerBar } from '@/components/player/PlayerBar'
import { LyricsView } from '@/components/lyrics/LyricsView'
import { cn, formatTime } from '@/lib/utils'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { loadLyricsForTrack } from '@/services/lyrics.service'
import { platform } from '@/services/platform'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Track } from '@/types'

/**
 * SongDetailPage — 歌曲播放详情页
 * - 封面 Hero + 标题/艺术家/专辑
 * - 操作：播放/暂停、收藏、下一首播放、添加到队列、添加到播放列表
 * - 统计信息卡：播放次数/时长/年份/流派/文件大小/添加时间/最后播放
 * - 完整歌词（点击行跳转播放进度）
 * - 同专辑歌曲（点击封面/行进入对应详情）
 */
function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : 1)} ${units[i]}`
}

function formatDate(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function sourceLabel(track: Track): string {
  // 存量数据兼容：旧版本内置源的 onlineSource 值仍可识别展示
  if (track.onlineSourceName) return track.onlineSourceName
  if (track.onlineSource === 'netease') return '网易云'
  if (track.onlineSource === 'qq') return 'QQ 音乐'
  if (track.onlineSource === 'kugou') return '酷狗'
  return track.onlineSource ? '在线音乐' : '本地'
}

/** 歌词预览：按所查看曲目加载歌词，渲染为预览样式（聚焦当前播放行），自身订阅进度以同步高亮 */
function TrackLyrics({ track, onLineClick }: { track: Track; onLineClick: (time: number) => void }) {
  // null = 加载中，'' = 无歌词，其他 = 歌词文本
  const [lrc, setLrc] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLrc(null)
    loadLyricsForTrack(track)
      .then((text) => {
        if (!cancelled) setLrc(text || '')
      })
    return () => {
      cancelled = true
    }
  }, [track.id, track.title, track.artist, track.album, track.duration])

  if (lrc === null) {
    return (
      <p className="font-text text-[14px] text-white/30 py-10 text-center tracking-[-0.15px]">
        搜索歌词中…
      </p>
    )
  }

  return (
    <LyricsView
      lyricsText={lrc}
      className="max-h-[300px]"
      onLineClick={onLineClick}
    />
  )
}

export function SongDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const tracks = useLibraryStore((s) => s.tracks)
  const toggleLike = useLibraryStore((s) => s.toggleLike)
  const likedTracks = useLibraryStore((s) => s.likedTracks)
  const playlists = usePlaylistStore((s) => s.playlists)
  const addTracksToPlaylist = usePlaylistStore((s) => s.addTracksToPlaylist)
  const createPlaylist = usePlaylistStore((s) => s.createPlaylist)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const volume = usePlayerStore((s) => s.volume)
  const muted = usePlayerStore((s) => s.muted)
  const repeatMode = usePlayerStore((s) => s.repeatMode)
  const shuffleMode = usePlayerStore((s) => s.shuffleMode)

  // 内嵌播放功能框回调（复用 playerStore 动作）
  const handleTogglePlay = useCallback(() => usePlayerStore.getState().togglePlay(), [])
  const handleNext = useCallback(() => usePlayerStore.getState().next(), [])
  const handlePrevious = useCallback(() => usePlayerStore.getState().previous(), [])
  const handleSeek = useCallback((seconds: number) => usePlayerStore.getState().seekTo(seconds), [])
  const handleVolumeChange = useCallback((v: number) => usePlayerStore.getState().setVolume(v), [])
  const handleToggleMute = useCallback(() => usePlayerStore.getState().toggleMute(), [])
  const handleCyclePlayMode = useCallback(() => usePlayerStore.getState().cyclePlayMode(), [])

  const [showNewPlaylistDialog, setShowNewPlaylistDialog] = useState(false)
  const [newPlName, setNewPlName] = useState('')
  const [showMoreInfo, setShowMoreInfo] = useState(false)

  // 跟随当前播放曲目：在详情页内切换歌曲（下一首/上一首/队列自动切换）时，详情页同步切换
  const lastTrackIdRef = useRef<string | null>(currentTrack?.id ?? null)
  useEffect(() => {
    const curId = currentTrack?.id ?? null
    if (curId !== lastTrackIdRef.current && curId && curId !== id) {
      navigate(`/song/${curId}`, { replace: true })
    }
    lastTrackIdRef.current = curId
  }, [currentTrack, id, navigate])

  // 从音乐库查找，找不到则回退到播放器队列（如在线搜索的歌曲）
  const track = useMemo(() => {
    const fromLibrary = tracks.find((t) => t.id === id)
    if (fromLibrary) return fromLibrary
    const fromQueue = usePlayerStore
      .getState()
      .queue.find((t) => t.id === id)
    return fromQueue || null
  }, [id, tracks])

  const isLiked = track ? likedTracks.has(track.id) : false
  const isCurrent = !!track && currentTrack?.id === track.id

  // 同专辑歌曲（同专辑同艺术家，按音轨号排序，包含当前歌曲用于整张播放）
  const albumTracks = useMemo(() => {
    if (!track || !track.album) return []
    return tracks
      .filter((t) => t.album === track.album && t.artist === track.artist)
      .sort((a, b) => (a.trackNumber || 0) - (b.trackNumber || 0))
  }, [track, tracks])

  const handlePlay = () => {
    if (!track) return
    const player = usePlayerStore.getState()
    if (isCurrent) {
      player.togglePlay()
      return
    }
    if (albumTracks.length > 0) {
      const idx = albumTracks.findIndex((t) => t.id === track.id)
      player.playQueue(albumTracks, idx < 0 ? 0 : idx)
    } else {
      player.playTrack(track)
    }
  }

  const handlePlayNext = () => {
    if (track) usePlayerStore.getState().addToPlayNext(track)
  }

  const handleAddToQueue = () => {
    if (track) usePlayerStore.getState().addToQueue(track)
  }

  const handleAddToPlaylist = (playlistId: string) => {
    if (track) addTracksToPlaylist(playlistId, [track.id])
  }

  const handleCreateAndAdd = () => {
    if (newPlName.trim() && track) {
      const pl = createPlaylist(newPlName.trim())
      addTracksToPlaylist(pl.id, [track.id])
      setNewPlName('')
      setShowNewPlaylistDialog(false)
    }
  }

  const statItems = useMemo(() => {
    if (!track) return []
    return [
      { icon: BarChart3, label: '播放次数', value: `${track.playCount || 0} 次` },
      { icon: Clock, label: '时长', value: formatTime(track.duration) },
      { icon: Calendar, label: '年份', value: track.year ? String(track.year) : '—' },
      { icon: Tag, label: '流派', value: track.genre || '—' },
      { icon: Layers, label: '音轨号', value: track.trackNumber ? `#${track.trackNumber}` : '—' },
      { icon: HardDrive, label: '文件大小', value: formatBytes(track.fileSize) },
      { icon: History, label: '添加时间', value: formatDate(track.addedAt) },
      { icon: History, label: '最后播放', value: formatDate(track.lastPlayedAt) },
    ]
  }, [track])

  if (!track) {
    return (
      <div className="flex flex-col h-full px-8 pt-8 pb-4">
        <div className="flex-1 flex flex-col items-center justify-center">
          <div className="relative mb-6">
            <div className="absolute -inset-16 bg-gradient-to-b from-mint/8 to-transparent rounded-full blur-3xl" />
            <div className="relative w-[120px] h-[120px] rounded-[28px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
              <Music2 className="h-[52px] w-[52px] text-mint/60" strokeWidth={1} />
            </div>
          </div>
          <h2 className="font-display text-[22px] font-semibold text-white/90 mb-2 tracking-[-0.3px]">
            {tracks.length === 0 ? '正在加载歌曲…' : '未找到这首歌曲'}
          </h2>
          <p className="font-text text-[14px] text-white/40 mb-6 tracking-[-0.15px]">
            {tracks.length === 0 ? '请稍候，音乐库正在加载' : '歌曲可能已被移除'}
          </p>
          <button
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-mint text-[#030608] font-semibold text-[14px] hover:brightness-110 transition-all duration-200 active:scale-95"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.6} />
            返回上一页
          </button>
        </div>
      </div>
    )
  }

  const coverSrc = track.coverPath ? platform.getCoverSrc(track.coverPath) : null

  return (
    <div className="flex flex-col px-8 pt-8">
      {/* 返回按钮 */}
      <button
        onClick={() => navigate(-1)}
        className="mb-6 inline-flex items-center gap-1.5 text-[13px] font-semibold text-white/50 hover:text-mint transition-colors duration-200 ease-apple w-fit"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.6} />
        返回
      </button>

      {/* Hero 区 */}
      <div className="flex items-start gap-8">
        {/* 封面 */}
        <div className="relative w-[220px] h-[220px] flex-shrink-0">
          <div
            className="absolute -inset-8 rounded-[40px] blur-3xl opacity-60"
            style={{ background: 'radial-gradient(circle at 30% 30%, rgba(0,245,212,.16), transparent 70%)' }}
          />
          <div className="relative w-full h-full rounded-[24px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center overflow-hidden">
            {coverSrc ? (
              <img src={coverSrc} alt={track.title} className="w-full h-full object-cover product-shadow" />
            ) : (
              <Music2 className="h-20 w-20 text-mint/40" strokeWidth={1} />
            )}
          </div>
          {track.onlineUrl && (
            <span className="absolute top-3 left-3 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-black/55 backdrop-blur-md text-[11px] font-semibold text-mint">
              <Radio className="h-3 w-3" strokeWidth={1.8} />
              {sourceLabel(track)}
            </span>
          )}
        </div>

        {/* 标题 + 操作 */}
        <div className="flex-1 min-w-0 pt-2">
          <p className="font-text text-[12px] font-semibold uppercase tracking-wider text-mint/70 mb-2">
            {sourceLabel(track)} · 歌曲详情
          </p>
          <h1 className="font-display text-[34px] font-bold text-white/98 leading-tight tracking-[-0.5px] break-words">
            {track.title}
          </h1>
          <p className="font-text text-[16px] text-white/55 mt-2 tracking-[-0.224px]">
            {track.artist}
            {track.album ? <span className="text-white/35"> · {track.album}</span> : null}
          </p>

          {/* 操作按钮 */}
          <div className="flex items-center gap-2.5 mt-6">
            <Button variant="primary" size="lg" onClick={handlePlay}>
              {isCurrent && isPlaying ? (
                <Pause className="h-4 w-4 mr-1.5" fill="currentColor" strokeWidth={1.5} />
              ) : (
                <Play className="h-4 w-4 mr-1.5 ml-0.5" fill="currentColor" strokeWidth={1.5} />
              )}
              {isCurrent && isPlaying ? '暂停' : '播放'}
            </Button>

            <Button
              variant="utility"
              size="icon"
              className={cn('h-11 w-11', isLiked && 'text-coral')}
              onClick={() => toggleLike(track.id)}
              title={isLiked ? '取消收藏' : '收藏'}
            >
              <Heart className={cn('h-[18px] w-[18px]', isLiked && 'fill-coral')} strokeWidth={1.6} />
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="utility" size="icon" className="h-11 w-11" title="更多操作">
                  <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={1.6} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                <DropdownMenuItem onClick={handlePlayNext}>
                  <ListEnd className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  下一首播放
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleAddToQueue}>
                  <Plus className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  添加到队列
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {playlists.length > 0 &&
                  playlists.map((pl) => (
                    <DropdownMenuItem key={pl.id} onClick={() => handleAddToPlaylist(pl.id)}>
                      <ListMusic className="h-4 w-4 mr-2 opacity-50" strokeWidth={1.5} />
                      {pl.name}
                    </DropdownMenuItem>
                  ))}
                <DropdownMenuItem onClick={() => setShowNewPlaylistDialog(true)}>
                  <Plus className="h-4 w-4 mr-2 opacity-50" strokeWidth={1.5} />
                  新建播放列表并添加
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => toggleLike(track.id)}>
                  <Heart className={cn('h-4 w-4 mr-2', isLiked && 'fill-coral text-coral')} strokeWidth={1.5} />
                  {isLiked ? '取消收藏' : '收藏'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {track.path && (
            <p className="flex items-center gap-1.5 mt-5 font-text text-[12px] text-white/30 truncate max-w-xl tracking-[-0.12px]">
              <Folder className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.5} />
              <span className="truncate">{track.path}</span>
            </p>
          )}
        </div>
      </div>

      {/* 更多信息 — 默认收起，展开查看详细统计 */}
      <section className="mt-9">
        <button
          onClick={() => setShowMoreInfo((v) => !v)}
          className="flex items-center gap-1.5 text-[12px] font-semibold text-white/40 uppercase tracking-wider hover:text-mint transition-colors duration-200 ease-apple"
        >
          <ChevronDown
            className={cn('h-3.5 w-3.5 transition-transform duration-200', showMoreInfo && 'rotate-180')}
            strokeWidth={1.8}
          />
          更多信息
        </button>
        {showMoreInfo && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
            {statItems.map(({ icon: Icon, label, value }) => (
              <div
                key={label}
                className="card-utility rounded-[16px] px-4 py-3.5 flex items-center gap-3"
              >
                <div className="w-9 h-9 rounded-[10px] bg-white/[0.05] flex items-center justify-center flex-shrink-0">
                  <Icon className="h-4 w-4 text-mint/70" strokeWidth={1.5} />
                </div>
                <div className="min-w-0">
                  <p className="font-text text-[11px] text-white/40 tracking-[-0.12px]">{label}</p>
                  <p className="font-text text-[14px] font-semibold text-white/90 truncate tracking-[-0.224px]">
                    {value}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 歌词 */}
      <section className="mt-9">
        <h2 className="font-text text-[12px] font-semibold text-white/40 uppercase tracking-wider mb-3">
          歌词
        </h2>
        <div className="card-utility rounded-[18px] px-6 py-6">
          <TrackLyrics track={track} onLineClick={(t) => usePlayerStore.getState().seekTo(t)} />
        </div>
      </section>

      {/* 同专辑歌曲 */}
      {albumTracks.length > 0 && (
        <section className="mt-9">
          <h2 className="font-text text-[12px] font-semibold text-white/40 uppercase tracking-wider mb-3">
            来自专辑「{track.album}」
          </h2>
          <div className="card-utility overflow-hidden">
            {albumTracks.map((t, idx) => (
              <div
                key={t.id}
                className={cn(
                  'row-hover group flex items-center gap-3 px-4 py-2.5 cursor-pointer border-b border-white/5 last:border-0 hover:bg-mint/[0.075]',
                  t.id === track.id && 'bg-mint/[0.06]'
                )}
                onDoubleClick={() => {
                  usePlayerStore.getState().playQueue(albumTracks, idx)
                }}
              >
                <span className="font-text text-[12px] text-white/35 w-5 text-right group-hover:hidden tabular-nums tracking-[-0.12px]">
                  {idx + 1}
                </span>
                <Play className="w-3.5 h-3.5 hidden group-hover:block text-mint" strokeWidth={1.8} />
                {/* 封面图标 → 进入详情 */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    navigate(`/song/${t.id}`)
                  }}
                  className="w-10 h-10 rounded-xs bg-white/[0.04] flex items-center justify-center flex-shrink-0 overflow-hidden transition-transform duration-200 ease-apple hover:scale-105"
                  title="查看歌曲详情"
                >
                  {t.coverPath ? (
                    <img
                      src={platform.getCoverSrc(t.coverPath)}
                      alt=""
                      className="w-full h-full object-cover product-shadow"
                    />
                  ) : (
                    <Disc3 className="h-4 w-4 text-white/30" strokeWidth={1.5} />
                  )}
                </button>
                <button
                  onClick={() => navigate(`/song/${t.id}`)}
                  className="flex-1 min-w-0 text-left"
                >
                  <p
                    className={cn(
                      'font-text text-[14px] font-semibold truncate tracking-[-0.224px]',
                      t.id === track.id ? 'text-mint' : 'text-white/92'
                    )}
                  >
                    {t.title}
                  </p>
                  <p className="font-text text-[12px] text-white/45 truncate tracking-[-0.12px]">
                    {t.artist}
                  </p>
                </button>
                <span className="font-text text-[12px] text-white/35 tabular-nums w-10 text-right tracking-[-0.12px]">
                  {formatTime(t.duration)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 内置播放功能框 — 粘性固定在详情页底部，无需滚动即可操作 */}
      <div className="sticky bottom-0 z-10 -mx-8 px-8 pt-5 pb-4 bg-gradient-to-t from-background/90 via-background/35 to-transparent">
        <PlayerBar
          currentTrack={currentTrack}
          volume={volume}
          muted={muted}
          repeatMode={repeatMode}
          shuffleMode={shuffleMode}
          onTogglePlay={handleTogglePlay}
          onNext={handleNext}
          onPrevious={handlePrevious}
          onSeek={handleSeek}
          onVolumeChange={handleVolumeChange}
          onToggleMute={handleToggleMute}
          onCyclePlayMode={handleCyclePlayMode}
        />
      </div>

      <Dialog open={showNewPlaylistDialog} onOpenChange={setShowNewPlaylistDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>新建播放列表</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="播放列表名称"
            value={newPlName}
            onChange={(e) => setNewPlName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateAndAdd()
            }}
          />
          <DialogFooter>
            <Button variant="secondary" onClick={() => setShowNewPlaylistDialog(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={handleCreateAndAdd}>创建并添加</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
