import { useEffect, useState, type CSSProperties } from 'react'
import {
  Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1,
  ChevronDown, Heart, ListMusic, Music2,
} from 'lucide-react'
import { cn, formatTime } from '@/lib/utils'
import type { RepeatMode, ShuffleMode } from '@/types'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { LyricsView } from '@/components/lyrics/LyricsView'
import { platform } from '@/services/platform'

interface Props {
  open: boolean
  onClose: () => void
}

/**
 * 移动端全屏 Now Playing 视图
 * - 点击 PlayerBar 触发，下滑/点 ChevronDown 关闭
 * - 大封面 + 标题 + 进度条 + 大控件 + 歌词
 * - 触控目标 ≥ 48×48，主播放按钮 72×72
 * - 不含音量控件（移动端交由系统硬件音量键）
 */
export function MobileNowPlaying({ open, onClose }: Props) {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const progress = usePlayerStore((s) => s.progress)
  const duration = usePlayerStore((s) => s.duration)
  const repeatMode = usePlayerStore((s) => s.repeatMode)
  const shuffleMode = usePlayerStore((s) => s.shuffleMode)
  const toggleQueuePanel = usePlaylistStore((s) => s.toggleQueuePanel)
  const likedTracks = useLibraryStore((s) => s.likedTracks)
  const toggleLike = useLibraryStore((s) => s.toggleLike)

  const [seeking, setSeeking] = useState(false)
  const [seekValue, setSeekValue] = useState(0)

  // open 切换时重置 seeking 状态
  useEffect(() => {
    if (!open) {
      setSeeking(false)
      setSeekValue(0)
    }
  }, [open])

  // 阻止背景滚动
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // 注意：所有 hooks 必须在 early return 之前调用，避免 React hooks 顺序错误
  if (!open) return null

  const displayedProgress = seeking ? seekValue : progress
  const progressPercent = duration > 0 ? (displayedProgress / duration) * 100 : 0
  const playModeActive = shuffleMode === 'on' || repeatMode !== 'off'
  const isLiked = currentTrack ? likedTracks.has(currentTrack.id) : false
  const coverSrc = currentTrack?.coverPath ? platform.getCoverSrc(currentTrack.coverPath) : null

  const handleSeekStart = () => { setSeeking(true); setSeekValue(progress) }
  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => setSeekValue(parseFloat(e.target.value))
  const handleSeekCommit = () => { setSeeking(false); usePlayerStore.getState().seekTo(seekValue) }

  const cyclePlayMode = () => usePlayerStore.getState().cyclePlayMode()

  return (
    <div className="md:hidden fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-xl">
      {/* 顶部栏：关闭按钮 */}
      <header className="flex items-center justify-between px-4 pt-[env(safe-area-inset-top)] pb-2">
        <button
          onClick={onClose}
          aria-label="关闭"
          className="w-11 h-11 flex items-center justify-center rounded-full text-white/60 hover:text-white hover:bg-white/10 active:scale-95 transition"
        >
          <ChevronDown className="h-6 w-6" strokeWidth={1.8} />
        </button>
        <span className="flex-1 min-w-0 px-1 text-center text-[13px] font-semibold text-white/70 truncate">
          {currentTrack
            ? currentTrack.artist
              ? `${currentTrack.title} - ${currentTrack.artist}`
              : currentTrack.title
            : '正在播放'}
        </span>
        <button
          onClick={() => { toggleQueuePanel(); onClose() }}
          aria-label="队列"
          className="w-11 h-11 flex items-center justify-center rounded-full text-white/60 hover:text-white hover:bg-white/10 active:scale-95 transition"
        >
          <ListMusic className="h-5 w-5" strokeWidth={1.6} />
        </button>
      </header>

      {/* 大封面：矮屏自动缩小，给歌词留空间 */}
      <div className="px-8 pt-2 pb-4 flex justify-center">
        <div className="relative w-full max-w-[min(320px,42vh)] aspect-square">
          <div
            className="absolute -inset-6 rounded-[40px] blur-3xl opacity-50"
            style={{ background: 'radial-gradient(circle at 30% 30%, rgba(var(--fc-accent-rgb),.20), transparent 70%)' }}
          />
          <div className="relative w-full h-full rounded-[24px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center overflow-hidden product-shadow">
            {coverSrc ? (
              <img src={coverSrc} alt={currentTrack?.title || ''} className="w-full h-full object-cover" />
            ) : (
              <Music2 className="h-20 w-20 text-mint/40" strokeWidth={1} />
            )}
          </div>
        </div>
      </div>

      {/* 歌词：置于播放控件上方；歌曲标题信息已移至顶部栏 */}
      <div className="flex-1 min-h-0 px-6">
        <LyricsView className="h-full" onLineClick={(t) => usePlayerStore.getState().seekTo(t)} />
      </div>

      {/* 进度条：32px 触控高度 + 发光常显滑块 */}
      <div className="px-6 pb-1">
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-white/50 w-10 text-right tabular-nums">
            {formatTime(displayedProgress)}
          </span>
          <input
            type="range"
            min={0}
            max={duration || 100}
            value={displayedProgress}
            step={0.1}
            disabled={!currentTrack}
            onTouchStart={handleSeekStart}
            onChange={handleSeekChange}
            onTouchEnd={handleSeekCommit}
            className="seek-bar seek-lg flex-1 cursor-pointer disabled:opacity-40"
            style={{ '--seek': `${progressPercent}%` } as CSSProperties}
          />
          <span className="text-[11px] text-white/50 w-10 tabular-nums">
            {formatTime(duration)}
          </span>
        </div>
      </div>

      {/* 控制按钮：播放模式 / 上一首 / 播放 / 下一首 / 收藏，左右对称 */}
      <div className="px-6 pb-[calc(env(safe-area-inset-bottom)+12px)] flex items-center justify-between">
        <button
          onClick={cyclePlayMode}
          aria-label="播放模式"
          className={cn(
            'w-12 h-12 flex items-center justify-center rounded-full active:scale-90 transition',
            playModeActive ? 'text-mint' : 'text-white/50 hover:text-white',
          )}
        >
          {shuffleMode === 'on' ? (
            <Shuffle className="h-[22px] w-[22px]" strokeWidth={1.8} />
          ) : repeatMode === 'one' ? (
            <Repeat1 className="h-[22px] w-[22px]" strokeWidth={1.8} />
          ) : repeatMode === 'all' ? (
            <Repeat className="h-[22px] w-[22px]" strokeWidth={1.8} />
          ) : (
            <Shuffle className="h-[22px] w-[22px]" strokeWidth={1.8} />
          )}
        </button>
        <button
          onClick={() => usePlayerStore.getState().previous()}
          disabled={!currentTrack}
          aria-label="上一首"
          className="w-14 h-14 flex items-center justify-center rounded-full text-white/90 hover:text-white active:scale-90 transition disabled:opacity-40"
        >
          <SkipBack className="h-7 w-7" fill="currentColor" strokeWidth={1.5} />
        </button>
        {/* 主播放按钮：76px 大圆形 */}
        <button
          onClick={() => usePlayerStore.getState().togglePlay()}
          disabled={!currentTrack}
          aria-label={isPlaying ? '暂停' : '播放'}
          className="w-[76px] h-[76px] rounded-full flex items-center justify-center bg-mint text-mint-fg disabled:opacity-40 active:scale-95 transition shadow-[0_10px_30px_rgba(0,245,212,.35),inset_0_1px_0_rgba(255,255,255,.25)]"
        >
          {isPlaying ? (
            <Pause className="h-8 w-8" fill="currentColor" strokeWidth={1.5} />
          ) : (
            <Play className="h-8 w-8 ml-1" fill="currentColor" strokeWidth={1.5} />
          )}
        </button>
        <button
          onClick={() => usePlayerStore.getState().next()}
          disabled={!currentTrack}
          aria-label="下一首"
          className="w-14 h-14 flex items-center justify-center rounded-full text-white/90 hover:text-white active:scale-90 transition disabled:opacity-40"
        >
          <SkipForward className="h-7 w-7" fill="currentColor" strokeWidth={1.5} />
        </button>
        <button
          onClick={() => currentTrack && toggleLike(currentTrack.id)}
          aria-label={isLiked ? '取消收藏' : '收藏'}
          className={cn(
            'w-12 h-12 flex items-center justify-center rounded-full active:scale-90 transition',
            isLiked ? 'text-coral' : 'text-white/50 hover:text-white',
          )}
        >
          <Heart className={cn('h-[22px] w-[22px]', isLiked && 'fill-coral')} strokeWidth={1.6} />
        </button>
      </div>

    </div>
  )
}
