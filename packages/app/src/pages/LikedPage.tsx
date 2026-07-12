import { useMemo } from 'react'
import { Heart } from 'lucide-react'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { formatTime, cn } from '@/lib/utils'

export function LikedPage() {
  const allTracks = useLibraryStore((s) => s.tracks)
  const toggleLiked = useLibraryStore((s) => s.toggleLiked)
  const tracks = useMemo(() => allTracks.filter((t) => t.liked), [allTracks])

  const handlePlay = (track: typeof tracks[0], idx: number) => {
    usePlayerStore.getState().playQueue(tracks, idx)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-5 mb-8 px-1">
        <div className="w-20 h-20 rounded-[18px] bg-gradient-to-br from-red-500/20 to-pink-500/20 flex items-center justify-center shadow-lg shadow-red-500/10">
          <Heart className="h-9 w-9 text-red-500 fill-red-500" strokeWidth={1.4} />
        </div>
        <div>
          <p className="text-[11px] font-semibold text-foreground/40 uppercase tracking-wider mb-1.5">列表</p>
          <h1 className="text-[26px] font-semibold tracking-tight text-foreground/90">我喜欢的音乐</h1>
          <p className="text-foreground/40 text-[13px] mt-1">{tracks.length} 首歌曲</p>
        </div>
      </div>

      {tracks.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-foreground/40">
          <div className="w-20 h-20 rounded-[18px] glass-card flex items-center justify-center mb-5">
            <Heart className="h-10 w-10 text-red-500/80" strokeWidth={1.5} />
          </div>
          <p className="text-lg font-medium mb-1 text-foreground/70">还没有收藏的歌曲</p>
          <p className="text-[13px] text-foreground/40">点击歌曲旁的爱心图标添加收藏</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
          <div className="glass-table">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border/15">
                  <th className="text-left py-3.5 px-4 font-medium text-foreground/35 w-10 text-[12px]">#</th>
                  <th className="text-left py-3.5 px-4 font-medium text-foreground/35 text-[12px]">标题</th>
                  <th className="text-left py-3.5 px-4 font-medium text-foreground/35 text-[12px]">艺术家</th>
                  <th className="text-left py-3.5 px-4 font-medium text-foreground/35 text-[12px] hidden md:table-cell">专辑</th>
                  <th className="w-10"></th>
                  <th className="text-right py-3.5 px-4 font-medium text-foreground/35 text-[12px] w-16">时长</th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((track, idx) => (
                  <tr
                    key={track.id}
                    className="hover:bg-foreground/[0.035] cursor-pointer transition-colors duration-200 ease-apple group border-b border-border/10 last:border-0"
                    onClick={() => handlePlay(track, idx)}
                  >
                    <td className="py-3 px-4 text-foreground/35 text-[13px]">{idx + 1}</td>
                    <td className="py-3 px-4 font-medium truncate max-w-xs text-foreground/90">{track.title}</td>
                    <td className="py-3 px-4 text-foreground/50 truncate max-w-40">{track.artist}</td>
                    <td className="py-3 px-4 text-foreground/50 truncate max-w-48 hidden md:table-cell">{track.album}</td>
                    <td className="py-3 px-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleLiked(track.id)
                        }}
                        className="opacity-0 group-hover:opacity-100 transition-all duration-200 ease-apple p-1.5 hover:bg-foreground/10 rounded-lg"
                      >
                        <Heart className={cn('h-4 w-4', track.liked ? 'text-red-500 fill-red-500' : 'text-foreground/40')} strokeWidth={1.7} />
                      </button>
                    </td>
                    <td className="py-3 px-4 text-right text-foreground/35 text-[12px] tabular-nums">{formatTime(track.duration)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
