import React, { useEffect, useRef } from 'react'
import { X, Music2, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { CoverImage } from '@/components/common/CoverImage'
import { cn, formatTime, isDesktop } from '@/lib/utils'

/**
 * 队列浮层（DS 皮肤）
 * - 玻璃浮层：32px 圆角 + DS 的 hairline 描边，材质为液态玻璃（glass-liquid）
 * - 当前曲目用 mint 发丝描边 + 极轻底色标识，不再用大面积色块与投影
 */
export function QueueView() {
  const navigate = useNavigate()
  const queue = usePlayerStore((s) => s.queue)
  const currentIndex = usePlayerStore((s) => s.currentIndex)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const showQueuePanel = usePlaylistStore((s) => s.showQueuePanel)
  const setQueuePanel = usePlaylistStore((s) => s.setQueuePanel)
  const panelRef = useRef<HTMLDivElement>(null)

  // 点击浮层外部自动关闭；播放条上的队列开关按钮已 stopPropagation 自行 toggle，
  // 不会冒泡到 document 触发这里的关闭（否则 React 同步渲染会让浮层刚打开就被关掉）
  useEffect(() => {
    if (!showQueuePanel) return
    const onClickOutside = (e: MouseEvent) => {
      const el = panelRef.current
      if (el && e.target instanceof Node && !el.contains(e.target)) {
        setQueuePanel(false)
      }
    }
    document.addEventListener('click', onClickOutside)
    return () => document.removeEventListener('click', onClickOutside)
  }, [showQueuePanel, setQueuePanel])

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
    <div ref={panelRef} className="absolute right-0 bottom-full mb-3 w-80 max-h-[55vh] glass-liquid rounded-[16px] overflow-hidden z-50 flex flex-col">
      <div className="flex items-center justify-between px-4 h-12 border-b border-white/[0.06]">
        <span className="font-display text-[15px] font-semibold tracking-[-0.224px] text-foreground">
          播放队列
        </span>
        <button
          onClick={() => setQueuePanel(false)}
          className="btn-icon text-foreground/60 hover:text-coral"
        >
          <X className="h-4 w-4" strokeWidth={1.5} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin p-1.5">
        {queue.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-foreground/65">
            <Music2 className="h-10 w-10 mb-2 opacity-30" strokeWidth={1.5} />
            <p className="font-text text-[14px] tracking-[-0.224px]">队列为空</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {queue.map((track, idx) => (
              <div
                key={`${track.id}-${idx}`}
                className={cn(
                  'group w-full flex items-center gap-3 p-2 rounded-[10px] text-left transition-colors duration-200 ease-apple border',
                  idx === currentIndex
                    ? 'border-mint/25 bg-mint/[0.06] text-foreground'
                    : 'border-transparent text-foreground/70 hover:bg-white/[0.05]'
                )}
              >
                <button
                  onClick={() => {
                    // 桌面端进详情；移动端与点击播放条一致：播放该曲并打开全屏 Now Playing 浮层（不推进路由）
                    if (isDesktop()) navigate(`/song/${track.id}`)
                    else {
                      handlePlayTrack(idx)
                      usePlaylistStore.getState().setMobileNowPlaying(true)
                    }
                  }}
                  title="查看歌曲详情"
                  className="w-10 h-10 rounded-[10px] bg-secondary flex items-center justify-center flex-shrink-0 overflow-hidden cursor-pointer transition-transform duration-200 ease-apple hover:scale-105"
                >
                  <CoverImage
                    track={track}
                    className="w-full h-full object-cover"
                    fallback={<Music2 className="h-3.5 w-3.5 opacity-40" strokeWidth={1.5} />}
                  />
                </button>
                <button
                  onClick={() => handlePlayTrack(idx)}
                  className="flex items-center gap-3 flex-1 min-w-0"
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-text text-[13px] font-semibold truncate text-foreground tracking-[-0.224px]">
                      {track.title}
                    </p>
                    <p className="font-text text-[12px] text-foreground/50 truncate tracking-[-0.12px]">
                      {track.artist}
                    </p>
                  </div>
                  <span className="font-text text-[11px] text-foreground/65 tabular-nums tracking-[-0.12px]">
                    {formatTime(track.duration)}
                  </span>
                </button>
                <button
                  onClick={() => handleRemoveTrack(idx)}
                  className="btn-icon !rounded-[10px] text-foreground/30 opacity-0 group-hover:opacity-100 hover:bg-coral/78 hover:text-white"
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
