import React from 'react'
import { X, Music2, Trash2 } from 'lucide-react'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { cn, formatTime } from '@/lib/utils'

/**
 * Mineradio 深色风格 QueueView 浮层
 * - 悬浮玻璃卡片：glass-floating + 16px 圆角
 * - 薄荷青主色高亮当前曲目
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

  const handleRemoveTrack = (index: number) => {
    usePlayerStore.getState().removeFromQueue(index)
  }

  return (
    <div className="fixed right-8 bottom-24 w-80 max-h-[55vh] glass-floating rounded-[16px] overflow-hidden z-50 flex flex-col">
      <div className="flex items-center justify-between px-4 h-12 border-b border-white/10 dark:border-white/5">
        <span className="font-display text-[15px] font-semibold tracking-[-0.224px] text-foreground">
          播放队列
        </span>
        <button
          onClick={() => setQueuePanel(false)}
          className="w-7 h-7 rounded-sm flex items-center justify-center text-foreground/60 hover:text-coral hover:bg-white/20 dark:hover:bg-white/10 transition-colors duration-200 ease-apple"
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
              <div
                key={`${track.id}-${idx}`}
                className={cn(
                  'group w-full flex items-center gap-3 p-2 rounded-md text-left transition-all duration-200 ease-apple border',
                  idx === currentIndex
                    ? 'border-mint/36 bg-mint/[0.075] shadow-[0_10px_28px_rgba(0,245,212,.06)] text-foreground'
                    : 'border-transparent hover:bg-white/[0.07] hover:-translate-y-px text-foreground/70'
                )}
              >
                <button
                  onClick={() => handlePlayTrack(idx)}
                  className="flex items-center gap-3 flex-1 min-w-0"
                >
                  <div className="w-[38px] h-[38px] rounded-[7px] bg-secondary flex items-center justify-center flex-shrink-0 overflow-hidden">
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
                <button
                  onClick={() => handleRemoveTrack(idx)}
                  className="w-6 h-6 rounded-sm flex items-center justify-center text-foreground/30 opacity-0 group-hover:opacity-100 hover:bg-coral/78 hover:text-white transition-all duration-200 ease-apple"
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
