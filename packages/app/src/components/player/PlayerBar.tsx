import React, { useState } from 'react'
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Volume2, VolumeX, Music2, ListMusic } from 'lucide-react'
import { cn, formatTime } from '@/lib/utils'
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
}: PlayerBarProps) {
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const progress = usePlayerStore((s) => s.progress)
  const duration = usePlayerStore((s) => s.duration)
  const [seeking, setSeeking] = useState(false)
  const [seekValue, setSeekValue] = useState(0)
  const [seekingVolume, setSeekingVolume] = useState(false)
  const [volumeValue, setVolumeValue] = useState(0)
  const showQueuePanel = usePlaylistStore((s) => s.showQueuePanel)
  const toggleQueuePanel = usePlaylistStore((s) => s.toggleQueuePanel)

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

  return (
    <div className="glass-saved-panel rounded-[24px] px-[18px] py-2 flex flex-col gap-1.5">
      {/* 进度条 - 居中 */}
      <div className="flex items-center gap-3">
        <span className="text-[12px] text-white/50 w-12 text-right tabular-nums">
          {formatTime(displayedProgress)}
        </span>
        <div className="flex-1 relative h-3 flex items-center group">
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
            className="w-full h-1 group-hover:h-[5px] rounded-full appearance-none cursor-pointer disabled:opacity-40 disabled:pointer-events-none transition-all"
            style={{
              background: `linear-gradient(to right, rgba(255,255,255,.92) 0%, rgba(0,245,212,.74) ${progressPercent}%, rgba(255,255,255,.095) ${progressPercent}%, rgba(255,255,255,.095) 100%)`,
            }}
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
          <div
            className="w-[40px] h-[40px] rounded-[9px] flex-shrink-0 overflow-hidden bg-white/5 flex items-center justify-center"
            style={{
              boxShadow:
                '0 6px 18px rgba(0,0,0,.20), inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 1px rgba(255,255,255,.07)',
            }}
          >
            {currentTrack?.coverPath ? (
              <img
                src={`file://${currentTrack.coverPath}`}
                alt={currentTrack.title}
                className="w-full h-full object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none'
                }}
              />
            ) : (
              <Music2 className="h-4 w-4 text-white/30" strokeWidth={1.5} />
            )}
          </div>
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
                background: `linear-gradient(to right, rgba(255,255,255,.92) 0%, rgba(0,245,212,.74) ${volumePercent}%, rgba(255,255,255,.095) ${volumePercent}%, rgba(255,255,255,.095) 100%)`,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
