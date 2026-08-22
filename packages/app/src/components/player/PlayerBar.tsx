import React, { useState } from 'react'
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Volume2, VolumeX, Music2, ListMusic } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { cn, formatTime, isMobile, getTrackCoverSrc } from '@/lib/utils'
import type { RepeatMode, ShuffleMode, Track } from '@/types'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'

interface PlayerBarProps {
  currentTrack?: Track | null
  volume: number
  muted: boolean
  repeatMode: RepeatMode
  shuffleMode: ShuffleMode
  onTogglePlay: () => void
  onNext: () => void
  onPrevious: () => void
  onSeek: (seconds: number) => void
  onVolumeChange: (v: number) => void
  onToggleMute: () => void
  onCyclePlayMode: () => void
  onOpenNowPlaying?: () => void
}

/**
 * Mineradio 悬浮胶囊控制台风格 PlayerBar
 * - 胶囊形玻璃面板（glass-saved-panel）
 * - 顶部进度条 + 三列控制网格（曲目信息 / 播放控制 / 音量）
 * - 主播放按钮使用 glass-saved-button 圆形玻璃
 * - 普通控制按钮使用 btn-icon（36×36，11px 圆角）
 *
 * ⚠️ 性能：isPlaying / progress / duration 在此自行订阅，
 * 避免向上冒泡到 AppLayout 触发整树重渲染
 */
export function PlayerBar({
  currentTrack,
  volume,
  muted,
  repeatMode,
  shuffleMode,
  onTogglePlay,
  onNext,
  onPrevious,
  onSeek,
  onVolumeChange,
  onToggleMute,
  onCyclePlayMode,
  onOpenNowPlaying,
}: PlayerBarProps) {
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const progress = usePlayerStore((s) => s.progress)
  const duration = usePlayerStore((s) => s.duration)
  const navigate = useNavigate()
  const [seeking, setSeeking] = useState(false)
  const [seekValue, setSeekValue] = useState(0)
  const [seekingVolume, setSeekingVolume] = useState(false)
  const [volumeValue, setVolumeValue] = useState(0)
  const showQueuePanel = usePlaylistStore((s) => s.showQueuePanel)
  const toggleQueuePanel = usePlaylistStore((s) => s.toggleQueuePanel)

  const mobile = isMobile()
  const displayedProgress = seeking ? seekValue : progress
  const displayedVolume = seekingVolume ? volumeValue : (muted ? 0 : volume)
  const progressPercent = duration > 0 ? (displayedProgress / duration) * 100 : 0
  const volumePercent = displayedVolume * 100

  const handleSeekStart = () => {
    setSeeking(true)
    setSeekValue(progress)
  }

  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSeekValue(parseFloat(e.target.value))
  }

  const handleSeekCommit = () => {
    setSeeking(false)
    onSeek(seekValue)
  }

  const handleVolumeStart = () => {
    setSeekingVolume(true)
    setVolumeValue(muted ? 0 : volume)
  }

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setVolumeValue(parseFloat(e.target.value))
  }

  const handleVolumeCommit = () => {
    setSeekingVolume(false)
    onVolumeChange(volumeValue)
  }

  // 播放模式激活：shuffle 开启 或 repeat 非 off
  const playModeActive = shuffleMode === 'on' || repeatMode !== 'off'

  // ───────────────────────── 移动端紧凑布局 ─────────────────────────
  // 去掉桌面 grid + 音量控件；触控目标 ≥ 44×44；封面/标题点击进全屏 Now Playing
  if (mobile) {
    const openNowPlaying = () => {
      if (onOpenNowPlaying) onOpenNowPlaying()
      else if (currentTrack) navigate(`/song/${currentTrack.id}`)
    }
    return (
      <div className="glass-saved-panel rounded-[20px] px-3 py-2 flex items-center gap-1.5 relative overflow-hidden">
        {/* 顶部进度细线：迷你条上一眼可见播放进度 */}
        <div className="absolute inset-x-0 top-0 h-[2px] bg-white/[0.08]">
          <div
            className="h-full rounded-r-full transition-[width] duration-300 ease-linear"
            style={{
              width: `${progressPercent}%`,
              background: 'linear-gradient(to right, rgba(0,245,212,.35), rgba(0,245,212,.95))',
              boxShadow: progressPercent > 0 ? '0 0 8px rgba(0,245,212,.5)' : 'none',
            }}
          />
        </div>
        <button
          onClick={openNowPlaying}
          title="展开播放器"
          className="flex items-center gap-2.5 min-w-0 flex-1 py-1 active:scale-[0.99] transition"
        >
          <div className="w-10 h-10 rounded-[9px] flex-shrink-0 overflow-hidden bg-white/5 flex items-center justify-center">
            {getTrackCoverSrc(currentTrack) ? (
              <img
                src={getTrackCoverSrc(currentTrack)!}
                alt={currentTrack!.title}
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            ) : (
              <Music2 className="h-4 w-4 text-white/30" strokeWidth={1.5} />
            )}
          </div>
          <div className="min-w-0 flex flex-col">
            <p className="text-[13px] font-bold text-white/92 truncate tracking-[-0.224px]">
              {currentTrack?.title || '未在播放'}
            </p>
            <p className="text-[10.5px] text-white/48 truncate tracking-[-0.12px]">
              {currentTrack?.artist || '选择一首歌曲'}
            </p>
          </div>
        </button>

        <button
          className="w-11 h-11 flex items-center justify-center rounded-full text-white/90 active:scale-90 transition disabled:opacity-40"
          onClick={onPrevious}
          disabled={!currentTrack}
          aria-label="上一首"
        >
          <SkipBack className="h-5 w-5" fill="currentColor" strokeWidth={1.5} />
        </button>
        <button
          className="w-12 h-12 flex items-center justify-center rounded-full bg-white/[0.08] text-white active:scale-95 transition disabled:opacity-40"
          onClick={onTogglePlay}
          disabled={!currentTrack}
          aria-label={isPlaying ? '暂停' : '播放'}
        >
          {isPlaying ? (
            <Pause className="h-5 w-5" fill="currentColor" strokeWidth={1.5} />
          ) : (
            <Play className="h-5 w-5 ml-0.5" fill="currentColor" strokeWidth={1.5} />
          )}
        </button>
        <button
          className="w-11 h-11 flex items-center justify-center rounded-full text-white/90 active:scale-90 transition disabled:opacity-40"
          onClick={onNext}
          disabled={!currentTrack}
          aria-label="下一首"
        >
          <SkipForward className="h-5 w-5" fill="currentColor" strokeWidth={1.5} />
        </button>
        <button
          className={cn(
            'w-11 h-11 flex-shrink-0 flex items-center justify-center rounded-full active:scale-90 transition',
            showQueuePanel ? 'text-mint bg-mint/[0.10]' : 'text-white/60',
          )}
          onClick={toggleQueuePanel}
          aria-label="队列"
        >
          <ListMusic className="h-5 w-5" strokeWidth={1.5} />
        </button>
      </div>
    )
  }

  // ───────────────────────── 桌面端三列网格（原布局） ─────────────────────────
  return (
    <div className="glass-saved-panel rounded-[24px] px-[18px] py-2 flex flex-col gap-1.5">
      {/* 进度条 - 居中 */}
      <div className="flex items-center gap-3">
        <span className="text-[12px] text-white/50 w-12 text-right tabular-nums">
          {formatTime(displayedProgress)}
        </span>
        <div className="flex-1 relative flex items-center">
          <input
            type="range"
            min={0}
            max={duration || 100}
            value={displayedProgress}
            step={0.1}
            disabled={!currentTrack}
            onMouseDown={handleSeekStart}
            onTouchStart={handleSeekStart}
            onChange={handleSeekChange}
            onMouseUp={handleSeekCommit}
            onTouchEnd={handleSeekCommit}
            onMouseLeave={() => seeking && handleSeekCommit()}
            className="seek-bar w-full cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
            style={{ '--seek': `${progressPercent}%` } as React.CSSProperties}
          />
        </div>
        <span className="text-[12px] text-white/50 w-12 tabular-nums">
          {formatTime(duration)}
        </span>
      </div>

      {/* 三列控制网格：曲目信息 / 播放控制 / 音量 */}
      <div className="grid grid-cols-[minmax(0,1fr)_max-content_minmax(0,1fr)] gap-3 items-center">
        {/* 左列：曲目信息（封面 + 标题 + 艺术家） */}
        <div className="flex items-center gap-3 min-w-0 justify-start">
          <button
            onClick={() => currentTrack && navigate(`/song/${currentTrack.id}`)}
            title="查看歌曲详情"
            className="w-[40px] h-[40px] rounded-[9px] flex-shrink-0 overflow-hidden bg-white/5 flex items-center justify-center cursor-pointer transition-transform duration-200 ease-apple hover:scale-105"
            style={{
              boxShadow:
                '0 6px 18px rgba(0,0,0,.20), inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 1px rgba(255,255,255,.07)',
            }}
          >
            {getTrackCoverSrc(currentTrack) ? (
              <img
                src={getTrackCoverSrc(currentTrack)!}
                alt={currentTrack!.title}
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none'
                }}
              />
            ) : (
              <Music2 className="h-4 w-4 text-white/30" strokeWidth={1.5} />
            )}
          </button>
          <div className="min-w-0 flex flex-col gap-0.5">
            <p className="text-[12.5px] font-bold text-white/92 truncate hover:text-white hover:[text-shadow:0_0_12px_rgba(0,245,212,.16)] transition-all">
              {currentTrack?.title || '未在播放'}
            </p>
            <p className="text-[10.5px] text-white/48 truncate">
              {currentTrack?.artist || '选择一首歌曲开始'}
            </p>
          </div>
        </div>

        {/* 中列：播放控制（shuffle / prev / play / next / queue） */}
        <div className="flex items-center gap-2 justify-center">
          <button
            className={cn(
              'btn-icon w-7 h-7 rounded-[8px] flex items-center justify-center',
              playModeActive &&
                'text-mint [text-shadow:0_0_8px_rgba(0,245,212,.12)]',
            )}
            onClick={onCyclePlayMode}
            title={
              shuffleMode === 'on'
                ? '随机播放'
                : repeatMode === 'one'
                  ? '单曲循环'
                  : repeatMode === 'all'
                    ? '列表循环'
                    : '随机播放'
            }
          >
            {shuffleMode === 'on' ? (
              <Shuffle className="h-[16px] w-[16px]" strokeWidth={1.5} />
            ) : repeatMode === 'one' ? (
              <Repeat1 className="h-[16px] w-[16px]" strokeWidth={1.5} />
            ) : repeatMode === 'all' ? (
              <Repeat className="h-[16px] w-[16px]" strokeWidth={1.5} />
            ) : (
              <Shuffle className="h-[16px] w-[16px]" strokeWidth={1.5} />
            )}
          </button>
          <button
            className="btn-icon w-7 h-7 rounded-[8px] flex items-center justify-center"
            onClick={onPrevious}
            disabled={!currentTrack}
          >
            <SkipBack className="h-[16px] w-[16px]" strokeWidth={1.5} />
          </button>
          {/* 主播放按钮：圆形 glass-saved-button，44×44 */}
          <button
            className="glass-saved-button w-[44px] h-[44px] rounded-full flex items-center justify-center disabled:opacity-40 disabled:pointer-events-none"
            onClick={onTogglePlay}
            disabled={!currentTrack}
            style={{ color: 'rgba(255,255,255,.96)' }}
          >
            {isPlaying ? (
              <Pause className="h-[18px] w-[18px]" fill="currentColor" strokeWidth={1.5} />
            ) : (
              <Play className="h-[18px] w-[18px] ml-0.5" fill="currentColor" strokeWidth={1.5} />
            )}
          </button>
          <button
            className="btn-icon w-7 h-7 rounded-[8px] flex items-center justify-center"
            onClick={onNext}
            disabled={!currentTrack}
          >
            <SkipForward className="h-[16px] w-[16px]" strokeWidth={1.5} />
          </button>
          <button
            className={cn(
              'btn-icon w-7 h-7 rounded-[8px] flex items-center justify-center',
              showQueuePanel && 'text-mint bg-mint/[0.08]',
            )}
            onClick={toggleQueuePanel}
            title="队列"
          >
            <ListMusic className="h-[16px] w-[16px]" strokeWidth={1.5} />
          </button>
        </div>

        {/* 右列：音量控制 */}
        <div className="flex items-center gap-2 justify-end">
          <button
            className="btn-icon w-7 h-7 rounded-[8px] flex items-center justify-center"
            onClick={onToggleMute}
            title={muted || volume === 0 ? '取消静音' : '静音'}
          >
            {muted || volume === 0 ? (
              <VolumeX className="h-[14px] w-[14px]" strokeWidth={1.5} />
            ) : (
              <Volume2 className="h-[14px] w-[14px]" strokeWidth={1.5} />
            )}
          </button>
          <div className="w-24 h-3 flex items-center">
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={displayedVolume}
              onMouseDown={handleVolumeStart}
              onTouchStart={handleVolumeStart}
              onChange={handleVolumeChange}
              onMouseUp={handleVolumeCommit}
              onTouchEnd={handleVolumeCommit}
              onMouseLeave={() => seekingVolume && handleVolumeCommit()}
              className="w-full h-1 rounded-full appearance-none cursor-pointer"
              style={{
                background: `linear-gradient(to right, rgba(0,245,212,.45) 0%, rgba(0,245,212,.9) ${volumePercent}%, rgba(255,255,255,.095) ${volumePercent}%, rgba(255,255,255,.095) 100%)`,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
