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
    <div className="fixed right-8 bottom-24 w-80 max-h-[55vh] glass-strong rounded-2xl overflow-hidden z-50 flex flex-col shadow-2xl border border-border/30">
      <div className="flex items-center justify-between p-4 border-b border-border/30">
        <span className="text-sm font-semibold">播放队列</span>
        <button onClick={() => setQueuePanel(false)} className="p-1.5 hover:bg-foreground/10 rounded-lg transition-colors">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
        {queue.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-foreground/40">
            <Music2 className="h-10 w-10 mb-2 opacity-30" />
            <p className="text-sm">队列为空</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {queue.map((track, idx) => (
              <button
                key={`${track.id}-${idx}`}
                onClick={() => handlePlayTrack(idx)}
                className={cn(
                  'w-full flex items-center gap-3 p-2 rounded-xl text-left transition-all',
                  idx === currentIndex
                    ? 'bg-primary/15 text-foreground'
                    : 'hover:bg-foreground/5 text-foreground/70'
                )}
              >
                <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary/15 to-primary/5 border border-border/30 flex items-center justify-center flex-shrink-0 overflow-hidden">
                  {track.coverPath ? (
                    <img src={`file://${track.coverPath}`} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <Music2 className="h-3.5 w-3.5 opacity-40" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{track.title}</p>
                  <p className="text-[10px] text-foreground/40 truncate">{track.artist}</p>
                </div>
                <span className="text-[10px] text-foreground/35 tabular-nums">{formatTime(track.duration)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
