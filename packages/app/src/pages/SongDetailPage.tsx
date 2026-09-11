import { useEffect, useMemo, useState, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Play, Pause, Heart, Plus, ListEnd, ListMusic, Music2, ArrowLeft,
  BarChart3, Clock, Calendar, Tag, HardDrive, Layers, History, MoreHorizontal,
  Disc3, Radio, Folder, ChevronDown, type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PlayerBar } from '@/components/player/PlayerBar'
import { LyricsView } from '@/components/lyrics/LyricsView'
import { cn, formatTime } from '@/lib/utils'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { loadLyricsForTrack } from '@/services/lyrics.service'
import { CoverImage } from '@/components/common/CoverImage'
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
 * SongDetailPage — 歌曲播放详情页（参考网易云音乐 / QQ 音乐的沉浸式播放页）
 * - 全屏封面模糊背景，随歌曲切换营造沉浸氛围
 * - 旋转黑胶唱片封面（播放中旋转，暂停时停转）
 * - 标题/艺术家/操作/属性 与唱片并排的 Hero 区
 * - 歌词与同专辑歌曲左右双栏（移动端纵向堆叠）
 * - 更多信息折叠面板：播放次数/文件大小/添加时间/最后播放/文件路径
 * - 底部内嵌播放控制台（与全局悬浮播放条同款）
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

/** 歌词预览：按所查看曲目加载歌词，自身订阅进度以同步高亮 */
function TrackLyrics({ track, onLineClick, className }: { track: Track; onLineClick: (time: number) => void; className?: string }) {
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
      className={className ?? 'h-[300px]'}
      onLineClick={onLineClick}
    />
  )
}

/** 旋转黑胶唱片：封面嵌在唱片中心，播放中匀速旋转 */
function VinylCover({ track, spinning }: { track: Track; spinning: boolean }) {
  return (
    <div className="relative">
      {/* 封面色光晕：唱片下方铺一层主题色氛围光 */}
      <div
        aria-hidden
        className="absolute -inset-10 rounded-full blur-3xl opacity-60"
        style={{ background: 'radial-gradient(circle at 40% 35%, rgba(var(--fc-accent-rgb),.22), transparent 70%)' }}
      />
      {/* 唱片本体：旋转层 */}
      <div className={cn('vinyl-disc relative aspect-square rounded-full', spinning && 'is-playing')}>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-[62%] aspect-square rounded-full overflow-hidden ring-1 ring-white/10 bg-[#0b0c0f]">
            <CoverImage
              track={track}
              alt={track.title}
              className="w-full h-full object-cover"
              fallback={
                <div className="w-full h-full flex items-center justify-center">
                  <Music2 className="h-14 w-14 text-white/25" strokeWidth={1} />
                </div>
              }
            />
          </div>
        </div>
        {/* 唱片中心轴孔 */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[6%] aspect-square rounded-full bg-[#08090b] ring-1 ring-white/15" />
      </div>
      {/* 静态高光：不随唱片旋转，模拟顶部打光 */}
      <div
        aria-hidden
        className="absolute inset-0 rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle at 30% 22%, rgba(255,255,255,.13), transparent 46%)' }}
      />
    </div>
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

  // 歌曲属性（展示区直接可见）：年份 / 流派 / 时长 / 音轨号，
  // 缺失项不渲染，避免出现「流派 —」这类空占位
  const quickFacts = useMemo(() => {
    if (!track) return [] as { icon: LucideIcon; label: string; value: string }[]
    const facts: { icon: LucideIcon; label: string; value: string }[] = []
    if (track.year) facts.push({ icon: Calendar, label: '年份', value: String(track.year) })
    if (track.genre) facts.push({ icon: Tag, label: '流派', value: track.genre })
    if (track.duration) facts.push({ icon: Clock, label: '时长', value: formatTime(track.duration) })
    if (track.trackNumber) facts.push({ icon: Layers, label: '音轨', value: `#${track.trackNumber}` })
    return facts
  }, [track])

  // 音乐库属性（默认收起，展开后可见）
  const statItems = useMemo(() => {
    if (!track) return [] as { icon: LucideIcon; label: string; value: string }[]
    return [
      { icon: BarChart3, label: '播放次数', value: `${track.playCount || 0} 次` },
      { icon: HardDrive, label: '文件大小', value: formatBytes(track.fileSize) },
      { icon: History, label: '添加时间', value: formatDate(track.addedAt) },
      { icon: History, label: '最后播放', value: track.lastPlayedAt ? formatDate(track.lastPlayedAt) : '从未播放' },
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
            className="pill pill-lg pill-mint"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.6} />
            返回上一页
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex flex-col min-h-full">
      {/* 沉浸式封面背景：封面放大模糊铺满整页内容高度，滚动无接缝 */}
      <div aria-hidden className="absolute inset-0 overflow-hidden pointer-events-none">
        <CoverImage
          track={track}
          alt=""
          className="absolute inset-0 w-full h-full object-cover scale-125 blur-[64px] opacity-55"
        />
        {/* 压暗/提亮遮罩：保证前景文字可读，并随主题（深/浅）自动适配 */}
        <div className="absolute inset-0 bg-gradient-to-b from-background/75 via-background/50 to-background/95" />
        <div
          className="absolute inset-0"
          style={{ background: 'radial-gradient(ellipse 60% 45% at 28% 18%, rgba(var(--fc-accent-rgb),.10), transparent 65%)' }}
        />
      </div>

      {/* 前景内容：收窄居中成列，Hero/歌词/专辑共用同一视觉轴，避免宽屏下内容松散 */}
      <div className="relative mx-auto w-full max-w-[880px] px-4 md:px-8 pt-4 md:pt-8 pb-6">
        {/* 返回：圆形玻璃按钮，融入沉浸背景 */}
        <button
          onClick={() => navigate(-1)}
          aria-label="返回"
          title="返回"
          className="glass-saved-button mb-6 md:mb-8 w-10 h-10 rounded-full flex items-center justify-center text-white/80 hover:text-white transition-colors duration-200 ease-apple"
        >
          <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={1.6} />
        </button>

        {/* Hero：黑胶唱片 + 歌曲信息 */}
        <section className="flex flex-col md:flex-row items-center gap-6 md:gap-10">
          {/* 唱片：移动端居中缩小，桌面端放大 */}
          <div className="w-[min(56vw,220px)] md:w-[220px] xl:w-[250px] flex-shrink-0">
            <VinylCover track={track} spinning={isCurrent && isPlaying} />
          </div>

          {/* 标题 + 操作 + 属性 */}
          <div className="flex-1 min-w-0 flex flex-col items-center md:items-start text-center md:text-left">
            <p className="inline-flex items-center gap-1.5 font-text text-[11px] font-semibold uppercase tracking-[0.16em] text-mint/80 mb-3">
              <Radio className="h-3 w-3" strokeWidth={1.8} />
              {sourceLabel(track)} · 歌曲详情
            </p>
            <h1 className="font-display text-[26px] md:text-[32px] font-bold text-white/98 leading-tight tracking-[-0.5px] break-words">
              {track.title}
            </h1>
            <p className="font-text text-[15px] md:text-[16px] text-white/55 mt-2 tracking-[-0.224px]">
              {track.artist}
              {track.album ? <span className="text-white/45"> · {track.album}</span> : null}
            </p>

            {/* 操作按钮 */}
            <div className="flex items-center gap-2.5 mt-5">
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

            {/* 歌曲属性：年份/流派/时长/音轨 */}
            {quickFacts.length > 0 && (
              <div className="flex flex-wrap items-center justify-center md:justify-start gap-2 mt-5">
                {quickFacts.map(({ icon: Icon, label, value }) => (
                  <span
                    key={label}
                    className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-3 rounded-full bg-white/[0.045] border border-white/[0.07] backdrop-blur-sm"
                  >
                    <Icon className="h-3.5 w-3.5 text-mint/60 flex-shrink-0" strokeWidth={1.6} />
                    <span className="font-text text-[11px] text-white/40 tracking-[-0.12px]">{label}</span>
                    <span className="font-text text-[12px] font-semibold text-white/85 tracking-[-0.12px]">{value}</span>
                  </span>
                ))}
              </div>
            )}

            {/* 更多信息 — 默认收起保持紧凑 */}
            <div className="mt-5 w-full">
              <button
                onClick={() => setShowMoreInfo((v) => !v)}
                className="inline-flex items-center gap-1.5 font-text text-[12px] font-semibold text-white/50 hover:text-mint transition-colors duration-200 ease-apple"
              >
                <ChevronDown
                  className={cn('h-3.5 w-3.5 transition-transform duration-200', showMoreInfo && 'rotate-180')}
                  strokeWidth={1.8}
                />
                更多信息
              </button>
              {showMoreInfo && (
                <div className="mt-4 rounded-2xl bg-white/[0.035] border border-white/[0.07] backdrop-blur-md p-5">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-x-8 gap-y-5">
                    {statItems.map(({ icon: Icon, label, value }) => (
                      <div key={label} className="flex items-center gap-3 min-w-0">
                        <Icon className="h-4 w-4 text-mint/60 flex-shrink-0" strokeWidth={1.5} />
                        <div className="min-w-0">
                          <p className="font-text text-[11px] text-white/40 tracking-[-0.12px]">{label}</p>
                          <p className="font-text text-[14px] font-semibold text-white/90 truncate tracking-[-0.224px]">
                            {value}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                  {track.path && (
                    <p className="flex items-center gap-1.5 mt-4 font-text text-[12px] text-white/40 tracking-[-0.12px]">
                      <Folder className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.5} />
                      <span className="truncate">{track.path}</span>
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* 歌词：独占整行，当前行居中滚动 */}
        <section className="mt-10 md:mt-12">
          <h2 className="font-text text-[12px] font-semibold text-white/55 uppercase tracking-wider mb-3">
            歌词
          </h2>
          <div className="card-utility px-4 py-5 h-[360px] md:h-[420px]">
            <TrackLyrics
              track={track}
              className="h-full"
              onLineClick={(t) => usePlayerStore.getState().seekTo(t)}
            />
          </div>
        </section>

        {/* 同专辑歌曲：独立成行，置于歌词下方 */}
        {albumTracks.length > 0 && (
          <section className="mt-8 md:mt-10">
            <h2 className="font-text text-[12px] font-semibold text-white/55 uppercase tracking-wider mb-3">
              来自专辑「{track.album}」
            </h2>
            <div className="card-utility overflow-hidden">
              <div className="max-h-[340px] md:max-h-[420px] overflow-y-auto scrollbar-thin">
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
                      className="w-10 h-10 rounded-[8px] bg-white/[0.04] flex items-center justify-center flex-shrink-0 overflow-hidden transition-transform duration-200 ease-apple hover:scale-105"
                      title="查看歌曲详情"
                    >
                      <CoverImage
                        track={t}
                        className="w-full h-full object-cover product-shadow"
                        fallback={<Disc3 className="h-4 w-4 text-white/30" strokeWidth={1.5} />}
                      />
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
            </div>
          </section>
        )}
      </div>

      {/* 内置播放功能框 — 粘性固定在详情页底部，无需滚动即可操作 */}
      {/* 与主页面悬浮播放条同宽（640px）居中，避免全屏下播放条被拉成一条长横杆 */}
      <div className="sticky bottom-0 z-10 px-4 md:px-8 pt-5 pb-[calc(env(safe-area-inset-bottom)+12px)] bg-gradient-to-t from-background/90 via-background/35 to-transparent">
        <div className="max-w-[640px] mx-auto">
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
