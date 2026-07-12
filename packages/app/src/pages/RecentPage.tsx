import { useMemo } from 'react'
import { Clock } from 'lucide-react'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { formatTime } from '@/lib/utils'

export function RecentPage() {
  const allTracks = useLibraryStore((s) => s.tracks)
  const tracks = useMemo(
    () =>
      [...allTracks]
        .filter((t) => t.lastPlayedAt)
        .sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0)),
    [allTracks]
  )

  const handlePlay = (track: typeof tracks[0], idx: number) => {
    usePlayerStore.getState().playQueue(tracks, idx)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-5 mb-8 px-1">
        <div className="w-20 h-20 rounded-[18px] bg-gradient-to-br from-primary/25 to-primary/5 border border-border/30 flex items-center justify-center shadow-lg shadow-primary/10">
          <Clock className="h-9 w-9 text-primary" strokeWidth={1.4} />
        </div>
        <div>
          <p className="text-[11px] font-semibold text-foreground/40 uppercase tracking-wider mb-1.5">列表</p>
          <h1 className="text-[26px] font-semibold tracking-tight text-foreground/90">最近播放</h1>
          <p className="text-foreground/40 text-[13px] mt-1">{tracks.length} 首歌曲</p>
        </div>
      </div>

      {tracks.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-foreground/40">
          <div className="w-20 h-20 rounded-[18px] glass-card flex items-center justify-center mb-5">
            <Clock className="h-10 w-10 text-primary/70" strokeWidth={1.5} />
          </div>
          <p className="text-lg font-medium mb-1 text-foreground/70">还没有播放记录</p>
          <p className="text-[13px] text-foreground/40">开始播放你喜欢的音乐吧</p>
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
                  <th className="text-right py-3.5 px-4 font-medium text-foreground/35 text-[12px] w-16">时长</th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((track, idx) => (
                  <tr
                    key={track.id}
                    className="hover:bg-foreground/[0.035] cursor-pointer transition-colors duration-200 ease-apple border-b border-border/10 last:border-0"
                    onClick={() => handlePlay(track, idx)}
                  >
                    <td className="py-3 px-4 text-foreground/35 text-[13px]">{idx + 1}</td>
                    <td className="py-3 px-4 font-medium truncate max-w-xs text-foreground/90">{track.title}</td>
                    <td className="py-3 px-4 text-foreground/50 truncate max-w-40">{track.artist}</td>
                    <td className="py-3 px-4 text-foreground/50 truncate max-w-48 hidden md:table-cell">{track.album}</td>
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
