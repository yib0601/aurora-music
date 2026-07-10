import React from 'react'
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
  onToggleShuffle: () => void
  onCycleRepeat: () => void
}

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
  onToggleShuffle,
  onCycleRepeat,
}: PlayerBarProps) {
  const progressPercent = duration > 0 ? (progress / duration) * 100 : 0
  const effectiveVolume = muted ? 0 : volume
  const { showQueuePanel, toggleQueuePanel } = usePlaylistStore()

  return (
    <div className="glass-strong rounded-xl mx-3 mb-3 p-3 flex items-center gap-4">
      <div className="flex items-center gap-3 min-w-0 w-56 flex-shrink-0">
        <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-purple-500/30 to-pink-500/30 flex items-center justify-center flex-shrink-0 overflow-hidden">
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
            <Music2 className="h-6 w-6 text-foreground/40" />
          )}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">
            {currentTrack?.title || '未在播放'}
          </p>
          <p className="text-xs text-foreground/50 truncate">
            {currentTrack?.artist || '选择一首歌曲开始'}
          </p>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center gap-1 max-w-2xl">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onToggleShuffle}
          >
            <Shuffle className={cn('h-4 w-4', shuffleMode === 'on' ? 'text-primary' : 'text-foreground/50')} />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onPrevious}>
            <SkipBack className="h-5 w-5" />
          </Button>
          <Button
            variant="default"
            size="icon"
            className="h-10 w-10 rounded-full bg-primary hover:bg-primary/90"
            onClick={onTogglePlay}
          >
            {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-0.5" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onNext}>
            <SkipForward className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onCycleRepeat}
          >
            {repeatMode === 'one' ? (
              <Repeat1 className="h-4 w-4 text-primary" />
            ) : (
              <Repeat className={cn('h-4 w-4', repeatMode === 'all' ? 'text-primary' : 'text-foreground/50')} />
            )}
          </Button>
        </div>
        <div className="flex items-center gap-2 w-full">
          <span className="text-xs text-foreground/50 w-10 text-right tabular-nums">
            {formatTime(progress)}
          </span>
          <div className="flex-1 relative group">
            <input
              type="range"
              min={0}
              max={duration || 100}
              value={progress}
              step={0.1}
              onChange={(e) => onSeek(parseFloat(e.target.value))}
              className="w-full"
              style={{
                background: `linear-gradient(to right, hsl(var(--primary)) 0%, hsl(var(--primary)) ${progressPercent}%, hsl(var(--muted)) ${progressPercent}%, hsl(var(--muted)) 100%)`,
                borderRadius: '2px',
                height: '4px',
              }}
            />
          </div>
          <span className="text-xs text-foreground/50 w-10 tabular-nums">
            {formatTime(duration)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 w-44 flex-shrink-0 justify-end">
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-8 w-8', showQueuePanel && 'text-primary')}
          onClick={toggleQueuePanel}
        >
          <ListMusic className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onToggleMute}>
          {muted || volume === 0 ? (
            <VolumeX className="h-4 w-4 text-foreground/50" />
          ) : (
            <Volume2 className="h-4 w-4" />
          )}
        </Button>
        <div className="flex-1 relative max-w-24">
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={effectiveVolume}
            onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
            className="w-full"
            style={{
              background: `linear-gradient(to right, hsl(var(--primary)) 0%, hsl(var(--primary)) ${effectiveVolume * 100}%, hsl(var(--muted)) ${effectiveVolume * 100}%, hsl(var(--muted)) 100%)`,
              borderRadius: '2px',
              height: '4px',
            }}
          />
        </div>
      </div>
    </div>
  )
}
