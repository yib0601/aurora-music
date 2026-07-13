import React from 'react'
import { X, Music2 } from 'lucide-react'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { cn, formatTime } from '@/lib/utils'

/**
 * Apple 风格 QueueView 浮层
 * - 浮动卡片：1px hairline + 18px 圆角 + popover 阴影
 * - 无 glass blur
 */
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
    <div className="fixed right-8 bottom-24 w-80 max-h-[55vh] bg-popover border border-border rounded-lg shadow-popover overflow-hidden z-50 flex flex-col">
      <div className="flex items-center justify-between px-4 h-12 border-b border-border">
        <span className="font-display text-[15px] font-semibold tracking-[-0.224px] text-foreground">
          播放队列
        </span>
        <button
          onClick={() => setQueuePanel(false)}
          className="w-7 h-7 rounded-sm flex items-center justify-center text-foreground/60 hover:bg-foreground/[0.06] transition-colors duration-200 ease-apple"
        >
          <X className="h-4 w-4" strokeWidth={1.5} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin p-1.5">
        {queue.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-foreground/40">
            <Music2 className="h-10 w-10 mb-2 opacity-30" strokeWidth={1.5} />
            <p className="font-text text-[14px] tracking-[-0.224px]">队列为空</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {queue.map((track, idx) => (
              <button
                key={`${track.id}-${idx}`}
                onClick={() => handlePlayTrack(idx)}
                className={cn(
                  'w-full flex items-center gap-3 p-2 rounded-sm text-left transition-colors duration-200 ease-apple',
                  idx === currentIndex
                    ? 'bg-action-blue/[0.10] text-foreground'
                    : 'hover:bg-foreground/[0.04] text-foreground/70'
                )}
              >
                <div className="w-9 h-9 rounded-xs bg-secondary flex items-center justify-center flex-shrink-0 overflow-hidden">
                  {track.coverPath ? (
                    <img src={`file://${track.coverPath}`} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <Music2 className="h-3.5 w-3.5 opacity-40" strokeWidth={1.5} />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-text text-[13px] font-semibold truncate text-foreground tracking-[-0.224px]">
                    {track.title}
                  </p>
                  <p className="font-text text-[12px] text-foreground/50 truncate tracking-[-0.12px]">
                    {track.artist}
                  </p>
                </div>
                <span className="font-text text-[11px] text-foreground/40 tabular-nums tracking-[-0.12px]">
                  {formatTime(track.duration)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
