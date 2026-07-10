import { Clock } from 'lucide-react'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { formatTime } from '@/lib/utils'

export function RecentPage() {
  const tracks = useLibraryStore((s) =>
    [...s.tracks]
      .filter((t) => t.lastPlayedAt)
      .sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0))
  )

  const handlePlay = (track: typeof tracks[0], idx: number) => {
    usePlayerStore.getState().playQueue(tracks, idx)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-4 mb-6 px-1">
        <div className="w-20 h-20 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center shadow-lg shadow-blue-500/20">
          <Clock className="h-10 w-10 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">最近播放</h1>
          <p className="text-foreground/50 text-sm">{tracks.length} 首歌曲</p>
        </div>
      </div>

      {tracks.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-foreground/40">
          <Clock className="h-16 w-16 mb-4 opacity-30" />
          <p className="text-lg font-medium mb-2">还没有播放记录</p>
          <p className="text-sm">开始播放你喜欢的音乐吧</p>
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
                  <th className="text-right py-3 px-4 font-medium text-foreground/50 w-16">时长</th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((track, idx) => (
                  <tr
                    key={track.id}
                    className="hover:bg-foreground/5 cursor-pointer transition-colors"
                    onClick={() => handlePlay(track, idx)}
                  >
                    <td className="py-2.5 px-4 text-foreground/40">{idx + 1}</td>
                    <td className="py-2.5 px-4 font-medium truncate max-w-xs">{track.title}</td>
                    <td className="py-2.5 px-4 text-foreground/60 truncate max-w-40">{track.artist}</td>
                    <td className="py-2.5 px-4 text-foreground/60 truncate max-w-48 hidden md:table-cell">{track.album}</td>
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
