import { Heart } from 'lucide-react'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { formatTime, cn } from '@/lib/utils'

export function LikedPage() {
  const tracks = useLibraryStore((s) => s.tracks.filter((t) => t.liked))
  const toggleLiked = useLibraryStore((s) => s.toggleLiked)

  const handlePlay = (track: typeof tracks[0], idx: number) => {
    usePlayerStore.getState().playQueue(tracks, idx)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-4 mb-6 px-1">
        <div className="w-20 h-20 rounded-xl bg-gradient-to-br from-red-500 to-pink-600 flex items-center justify-center shadow-lg shadow-red-500/20">
          <Heart className="h-10 w-10 text-white fill-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">我喜欢的音乐</h1>
          <p className="text-foreground/50 text-sm">{tracks.length} 首歌曲</p>
        </div>
      </div>

      {tracks.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-foreground/40">
          <Heart className="h-16 w-16 mb-4 opacity-30" />
          <p className="text-lg font-medium mb-2">还没有收藏的歌曲</p>
          <p className="text-sm">点击歌曲旁的爱心图标添加收藏</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-thin pr-2">
          <div className="glass rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left py-3 px-4 font-medium text-foreground/50 w-10">#</th>
                  <th className="text-left py-3 px-4 font-medium text-foreground/50">标题</th>
                  <th className="text-left py-3 px-4 font-medium text-foreground/50">艺术家</th>
                  <th className="text-left py-3 px-4 font-medium text-foreground/50 hidden md:table-cell">专辑</th>
                  <th className="w-10"></th>
                  <th className="text-right py-3 px-4 font-medium text-foreground/50 w-16">时长</th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((track, idx) => (
                  <tr
                    key={track.id}
                    className="hover:bg-foreground/5 cursor-pointer transition-colors group"
                    onClick={() => handlePlay(track, idx)}
                  >
                    <td className="py-2.5 px-4 text-foreground/40">{idx + 1}</td>
                    <td className="py-2.5 px-4 font-medium truncate max-w-xs">{track.title}</td>
                    <td className="py-2.5 px-4 text-foreground/60 truncate max-w-40">{track.artist}</td>
                    <td className="py-2.5 px-4 text-foreground/60 truncate max-w-48 hidden md:table-cell">{track.album}</td>
                    <td className="py-2.5 px-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleLiked(track.id)
                        }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity"
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
