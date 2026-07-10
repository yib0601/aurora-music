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
        <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-red-500/20 to-pink-500/20 flex items-center justify-center shadow-lg shadow-red-500/10">
          <Heart className="h-9 w-9 text-red-500 fill-red-500" />
        </div>
        <div>
          <p className="text-xs font-medium text-foreground/45 uppercase tracking-wider mb-1">列表</p>
          <h1 className="text-3xl font-bold tracking-tight">我喜欢的音乐</h1>
          <p className="text-foreground/45 text-sm mt-0.5">{tracks.length} 首歌曲</p>
        </div>
      </div>

      {tracks.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-foreground/40">
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-red-500/25 to-red-500/5 border border-border/30 flex items-center justify-center mb-5">
            <Heart className="h-10 w-10 text-red-500/80" />
          </div>
          <p className="text-lg font-medium mb-1">还没有收藏的歌曲</p>
          <p className="text-sm text-foreground/45">点击歌曲旁的爱心图标添加收藏</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
          <div className="rounded-2xl border border-border/30 overflow-hidden bg-foreground/[0.02]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/30 bg-foreground/[0.02]">
                  <th className="text-left py-3 px-4 font-medium text-foreground/45 w-10">#</th>
                  <th className="text-left py-3 px-4 font-medium text-foreground/45">标题</th>
                  <th className="text-left py-3 px-4 font-medium text-foreground/45">艺术家</th>
                  <th className="text-left py-3 px-4 font-medium text-foreground/45 hidden md:table-cell">专辑</th>
                  <th className="w-10"></th>
                  <th className="text-right py-3 px-4 font-medium text-foreground/45 w-16">时长</th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((track, idx) => (
                  <tr
                    key={track.id}
                    className="hover:bg-foreground/[0.04] cursor-pointer transition-colors group border-b border-border/20 last:border-0"
                    onClick={() => handlePlay(track, idx)}
                  >
                    <td className="py-2.5 px-4 text-foreground/40">{idx + 1}</td>
                    <td className="py-2.5 px-4 font-medium truncate max-w-xs">{track.title}</td>
                    <td className="py-2.5 px-4 text-foreground/55 truncate max-w-40">{track.artist}</td>
                    <td className="py-2.5 px-4 text-foreground/55 truncate max-w-48 hidden md:table-cell">{track.album}</td>
                    <td className="py-2.5 px-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleLiked(track.id)
                        }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-foreground/10 rounded"
                      >
                        <Heart className={cn('h-4 w-4', track.liked ? 'text-red-500 fill-red-500' : 'text-foreground/40')} />
                      </button>
                    </td>
                    <td className="py-2.5 px-4 text-right text-foreground/40 tabular-nums">{formatTime(track.duration)}</td>
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
