import React from 'react'
import { X, Music2 } from 'lucide-react'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { cn, formatTime } from '@/lib/utils'

export function QueueView() {
  const queue = usePlayerStore((s) => s.queue)
  const currentIndex = usePlayerStore((s) => s.currentIndex)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const showQueuePanel = usePlaylistStore((s) => s.showQueuePanel)
  const setQueuePanel = usePlaylistStore((s) => s.setQueuePanel)

  if (!showQueuePanel) return null

  const handlePlayTrack = (index: number) => {
    const track = queue[index]
    if (!track) return
    usePlayerStore.getState().playQueue(queue, index)
  }

  return (
    <div className="fixed right-8 bottom-24 w-80 max-h-[55vh] glass-strong rounded-[20px] overflow-hidden z-50 flex flex-col shadow-2xl border border-white/10">
      <div className="flex items-center justify-between p-4 border-b border-border/15">
        <span className="text-[13px] font-semibold text-foreground/90">播放队列</span>
        <button onClick={() => setQueuePanel(false)} className="p-1.5 hover:bg-foreground/10 rounded-lg transition-all duration-200 ease-apple hover:scale-105">
          <X className="h-4 w-4" strokeWidth={1.7} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
        {queue.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-foreground/40">
            <Music2 className="h-10 w-10 mb-2 opacity-30" strokeWidth={1.5} />
            <p className="text-[13px]">队列为空</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {queue.map((track, idx) => (
              <button
                key={`${track.id}-${idx}`}
                onClick={() => handlePlayTrack(idx)}
                className={cn(
                  'w-full flex items-center gap-3 p-2 rounded-[13px] text-left transition-all duration-200 ease-apple',
                  idx === currentIndex
                    ? 'bg-primary/12 text-foreground'
                    : 'hover:bg-foreground/[0.04] text-foreground/65'
                )}
              >
                <div className="w-9 h-9 rounded-[11px] bg-gradient-to-br from-primary/15 to-primary/5 border border-border/25 flex items-center justify-center flex-shrink-0 overflow-hidden">
                  {track.coverPath ? (
                    <img src={`file://${track.coverPath}`} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <Music2 className="h-3.5 w-3.5 opacity-40" strokeWidth={1.6} />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-medium truncate text-foreground/90">{track.title}</p>
                  <p className="text-[11px] text-foreground/40 truncate">{track.artist}</p>
                </div>
                <span className="text-[11px] text-foreground/35 tabular-nums">{formatTime(track.duration)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
