import React, { useState, useCallback } from 'react'
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Volume2, VolumeX, Music2, ListMusic } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn, formatTime } from '@/lib/utils'
import type { RepeatMode, ShuffleMode, Track } from '@/types'
import { usePlaylistStore } from '@/stores/playlistStore'

interface PlayerBarProps {
  currentTrack?: Track | null
  isPlaying: boolean
  progress: number
  duration: number
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
 * Apple 风格 PlayerBar
 * - 表面：与主区域同色，无 glass / 无阴影
 * - 顶部 1px hairline 分隔
 * - 播放按钮：圆形 Action Blue + 唯一的 active scale(0.95)
 * - 进度条/音量条：4px 高度，hover 显示白色 thumb
 */
export function PlayerBar({
  currentTrack,
  isPlaying,
  progress,
  duration,
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

  const playModeActive = shuffleMode === 'on' || repeatMode !== 'off'

  return (
    <div className="border-t border-border px-6 py-3 flex items-center gap-6 bg-background">
      {/* 左侧：当前曲目信息 */}
      <div className="flex items-center gap-3 min-w-0 w-52 flex-shrink-0">
        <div className="w-11 h-11 rounded-sm bg-secondary flex items-center justify-center flex-shrink-0 overflow-hidden">
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
            <Music2 className="h-5 w-5 text-foreground/30" strokeWidth={1.5} />
          )}
        </div>
        <div className="min-w-0">
          <p className="font-text text-[14px] font-semibold truncate text-foreground tracking-[-0.224px] leading-tight">
            {currentTrack?.title || '未在播放'}
          </p>
          <p className="font-text text-[12px] text-foreground/50 truncate mt-0.5 leading-tight tracking-[-0.12px]">
            {currentTrack?.artist || '选择一首歌曲开始'}
          </p>
        </div>
      </div>

      {/* 中间：播放控制 + 进度条 */}
      <div className="flex-1 flex flex-col items-center gap-1.5 max-w-2xl">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn('text-foreground/40 hover:text-foreground', playModeActive && 'text-action-blue')}
            onClick={onCyclePlayMode}
            title={
              shuffleMode === 'on' ? '随机播放' :
              repeatMode === 'one' ? '单曲循环' :
              repeatMode === 'all' ? '列表循环' : '随机播放'
            }
          >
            {shuffleMode === 'on' ? (
              <Shuffle className="h-4 w-4" strokeWidth={1.5} />
            ) : repeatMode === 'one' ? (
              <Repeat1 className="h-4 w-4" strokeWidth={1.5} />
            ) : repeatMode === 'all' ? (
              <Repeat className="h-4 w-4" strokeWidth={1.5} />
            ) : (
              <Repeat className="h-4 w-4" strokeWidth={1.5} />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-foreground/70 hover:text-foreground"
            onClick={onPrevious}
          >
            <SkipBack className="h-4 w-4" strokeWidth={1.5} />
          </Button>
          <Button
            variant="primary"
            size="icon"
            className="h-9 w-9 mx-1"
            onClick={onTogglePlay}
            disabled={!currentTrack}
          >
            {isPlaying
              ? <Pause className="h-4 w-4" strokeWidth={2} fill="currentColor" />
              : <Play className="h-4 w-4 ml-0.5" strokeWidth={2} fill="currentColor" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-foreground/70 hover:text-foreground"
            onClick={onNext}
            disabled={!currentTrack}
          >
            <SkipForward className="h-4 w-4" strokeWidth={1.5} />
          </Button>
        </div>
        <div className="flex items-center gap-3 w-full">
          <span className="font-text text-[11px] text-foreground/50 w-10 text-right tabular-nums tracking-[-0.12px]">
            {formatTime(displayedProgress)}
          </span>
          <div className="flex-1 relative h-4 flex items-center">
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
              className="w-full disabled:opacity-40"
              style={{
                background: `linear-gradient(to right, var(--action-blue) 0%, var(--action-blue) ${progressPercent}%, hsl(var(--muted-foreground) / 0.18) ${progressPercent}%, hsl(var(--muted-foreground) / 0.18) 100%)`,
              }}
            />
          </div>
          <span className="font-text text-[11px] text-foreground/50 w-10 tabular-nums tracking-[-0.12px]">
            {formatTime(duration)}
          </span>
        </div>
      </div>

      {/* 右侧：队列 + 音量 */}
      <div className="flex items-center gap-2 w-44 flex-shrink-0 justify-end">
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn('text-foreground/50 hover:text-foreground', showQueuePanel && 'text-action-blue bg-action-blue/[0.08]')}
          onClick={toggleQueuePanel}
        >
          <ListMusic className="h-4 w-4" strokeWidth={1.5} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-foreground/50 hover:text-foreground"
          onClick={onToggleMute}
        >
          {muted || volume === 0 ? (
            <VolumeX className="h-4 w-4 text-foreground/40" strokeWidth={1.5} />
          ) : (
            <Volume2 className="h-4 w-4" strokeWidth={1.5} />
          )}
        </Button>
        <div className="flex-1 relative max-w-24 h-4 flex items-center">
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
            className="w-full"
            style={{
              background: `linear-gradient(to right, var(--action-blue) 0%, var(--action-blue) ${volumePercent}%, hsl(var(--muted-foreground) / 0.18) ${volumePercent}%, hsl(var(--muted-foreground) / 0.18) 100%)`,
            }}
          />
        </div>
      </div>
    </div>
  )
}
