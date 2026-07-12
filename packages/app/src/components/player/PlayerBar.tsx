import React, { useState, useCallback, useRef } from 'react'
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

  return (
    <div className="glass-card px-5 py-3.5 flex items-center gap-6">
      <div className="flex items-center gap-3.5 min-w-0 w-52 flex-shrink-0">
        <div className="w-12 h-12 rounded-[13px] bg-gradient-to-br from-primary/25 to-primary/8 border border-white/[0.08] flex items-center justify-center flex-shrink-0 overflow-hidden shadow-lg shadow-black/20">
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
            <Music2 className="h-5 w-5 text-foreground/35" strokeWidth={1.5} />
          )}
        </div>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold truncate text-foreground/90 leading-tight">
            {currentTrack?.title || '未在播放'}
          </p>
          <p className="text-[11px] text-foreground/45 truncate mt-0.5 leading-tight">
            {currentTrack?.artist || '选择一首歌曲开始'}
          </p>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center gap-2 max-w-2xl">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full text-foreground/40 hover:text-foreground/80 hover:bg-white/[0.06] transition-all duration-200 ease-apple"
            onClick={onCyclePlayMode}
            title={
              shuffleMode === 'on' ? '随机播放' :
              repeatMode === 'one' ? '单曲循环' :
              repeatMode === 'all' ? '列表循环' : '随机播放'
            }
          >
            {shuffleMode === 'on' ? (
              <Shuffle className="h-[15px] w-[15px] text-primary" strokeWidth={1.5} />
            ) : repeatMode === 'one' ? (
              <Repeat1 className="h-[15px] w-[15px] text-primary" strokeWidth={1.5} />
            ) : repeatMode === 'all' ? (
              <Repeat className="h-[15px] w-[15px] text-primary" strokeWidth={1.5} />
            ) : (
              <Repeat className="h-[15px] w-[15px]" strokeWidth={1.5} />
            )}
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-white/[0.06] transition-all duration-200 ease-apple" onClick={onPrevious}>
            <SkipBack className="h-[15px] w-[15px]" strokeWidth={1.5} />
          </Button>
          <Button
            variant="default"
            size="icon"
            className="h-10 w-10 rounded-full bg-gradient-to-br from-primary to-primary/85 shadow-lg shadow-primary/25 mx-1.5 transition-all duration-200 ease-apple hover:scale-[1.05] active:scale-95 border border-white/[0.12]"
            onClick={onTogglePlay}
            disabled={!currentTrack}
          >
            {isPlaying ? <Pause className="h-[17px] w-[17px]" strokeWidth={1.8} /> : <Play className="h-[17px] w-[17px] ml-0.5" strokeWidth={1.8} />}
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-white/[0.06] transition-all duration-200 ease-apple" onClick={onNext} disabled={!currentTrack}>
            <SkipForward className="h-[15px] w-[15px]" strokeWidth={1.5} />
          </Button>
        </div>
        <div className="flex items-center gap-3 w-full">
          <span className="text-[10px] text-foreground/40 w-9 text-right tabular-nums font-medium">
            {formatTime(displayedProgress)}
          </span>
          <div className="flex-1 relative group h-3 flex items-center">
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
                background: `linear-gradient(to right, hsl(var(--primary)) 0%, hsl(var(--primary)) ${progressPercent}%, hsl(var(--muted-foreground) / 0.15) ${progressPercent}%, hsl(var(--muted-foreground) / 0.15) 100%)`,
              }}
            />
          </div>
          <span className="text-[10px] text-foreground/40 w-9 tabular-nums font-medium">
            {formatTime(duration)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2.5 w-44 flex-shrink-0 justify-end">
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-8 w-8 rounded-full hover:bg-white/[0.06] transition-all duration-200 ease-apple', showQueuePanel && 'text-primary bg-primary/10')}
          onClick={toggleQueuePanel}
        >
          <ListMusic className="h-[15px] w-[15px]" strokeWidth={1.5} />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-white/[0.06] transition-all duration-200 ease-apple" onClick={onToggleMute}>
          {muted || volume === 0 ? (
            <VolumeX className="h-[15px] w-[15px] text-foreground/45" strokeWidth={1.5} />
          ) : (
            <Volume2 className="h-[15px] w-[15px]" strokeWidth={1.5} />
          )}
        </Button>
        <div className="flex-1 relative max-w-24 h-3 flex items-center">
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
              background: `linear-gradient(to right, hsl(var(--primary)) 0%, hsl(var(--primary)) ${volumePercent}%, hsl(var(--muted-foreground) / 0.15) ${volumePercent}%, hsl(var(--muted-foreground) / 0.15) 100%)`,
            }}
          />
        </div>
      </div>
    </div>
  )
}
