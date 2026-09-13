import { useMemo } from 'react'
import { dedupeTracksForDisplay } from '@aurora/shared'
import { useLibraryStore } from '@/stores/libraryStore'
import type { Track } from '@/types'

/**
 * 展示用曲库：同一首歌（歌名 + 歌手 + 时长相同）在多个来源都有时，
 * 只保留优先副本（本机优先，否则第一次扫描到的，见 @aurora/shared 的 preferTrackCopy）。
 *
 * 为什么不放在 store 里做成派生状态：store 的每次写入都要重算，容易漏掉某条
 * 更新路径而留下一份过期副本；用 useMemo 从 tracks 现算则永远与源数据一致，
 * 且 tracks 只在扫描/更新时变化，重算频率极低。
 *
 * 注意这只影响展示：被隐藏的副本仍留在曲库中，歌单/收藏/播放历史对它的引用
 * 照常有效（详见 dedupeTracksForDisplay 的说明）。
 */
export function useDisplayTracks(): { tracks: Track[]; hidden: number } {
  const tracks = useLibraryStore((s) => s.tracks)
  return useMemo(() => dedupeTracksForDisplay(tracks), [tracks])
}
