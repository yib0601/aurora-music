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
    <div className="flex flex-col h-full p-8">
      <div className="flex items-center gap-5 mb-8">
        <div className="w-20 h-20 rounded-lg bg-white/[0.04] border border-white/5 flex items-center justify-center">
          <Clock className="h-9 w-9 text-mint" strokeWidth={1.4} />
        </div>
        <div>
          <p className="font-text text-caption text-white/50 mb-1.5">列表</p>
          <h1 className="font-display text-[34px] font-semibold tracking-[-0.374px] text-white leading-tight">
            最近播放
          </h1>
          <p className="font-text text-[14px] text-white/50 tracking-[-0.224px] mt-1">
            {tracks.length} 首歌曲
          </p>
        </div>
      </div>

      {tracks.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="card-utility p-lg flex flex-col items-center text-center max-w-sm">
            <div className="w-20 h-20 rounded-lg bg-white/[0.04] border border-white/5 flex items-center justify-center mb-5">
              <Clock className="h-10 w-10 text-mint" strokeWidth={1.5} />
            </div>
            <p className="text-tagline text-white mb-1">还没有播放记录</p>
            <p className="font-text text-caption text-white/50">开始播放你喜欢的音乐吧</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
          <table className="w-full font-text text-body">
            <thead>
              <tr className="border-b border-white/10">
                <th className="text-left py-3.5 px-4 font-semibold text-white/50 w-10 text-caption">#</th>
                <th className="text-left py-3.5 px-4 font-semibold text-white/50 text-caption">标题</th>
                <th className="text-left py-3.5 px-4 font-semibold text-white/50 text-caption">艺术家</th>
                <th className="text-left py-3.5 px-4 font-semibold text-white/50 text-caption hidden md:table-cell">专辑</th>
                <th className="text-right py-3.5 px-4 font-semibold text-white/50 text-caption w-16">时长</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((track, idx) => (
                <tr
                  key={track.id}
                  className="row-hover cursor-pointer border-b border-white/5 last:border-0 hover:bg-mint/[0.075]"
                  onClick={() => handlePlay(track, idx)}
                >
                  <td className="py-3 px-4 text-white/50 text-caption">{idx + 1}</td>
                  <td className="py-3 px-4 font-semibold truncate max-w-xs text-white">{track.title}</td>
                  <td className="py-3 px-4 text-white/50 truncate max-w-40">{track.artist}</td>
                  <td className="py-3 px-4 text-white/50 truncate max-w-48 hidden md:table-cell">{track.album}</td>
                  <td className="py-3 px-4 text-right text-white/50 text-caption tabular-nums">{formatTime(track.duration)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
