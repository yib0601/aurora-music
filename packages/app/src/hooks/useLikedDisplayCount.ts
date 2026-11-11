import { useMemo } from 'react'
import { dedupeTracksForDisplay } from '@aurora/shared'
import { useLibraryStore } from '@/stores/libraryStore'

/**
 * 系统歌单「收藏」在导航里显示的条数 = 收藏页实际渲染的行数。
 *
 * 口径与收藏页（`pages/LikedPage.tsx`）**同源**：先筛 `liked`，再在收藏集合内去重，
 * 取去重后的长度。顺序不能反——先对全库去重再筛，只会收藏了 NAS 副本、本机副本未收藏时，
 * 择优会选中本机副本、把唯一被收藏的那份藏掉（收藏页注释里有完整说明）。
 *
 * 为什么不用 `likedTracks.size` 直接算：那是**已收藏的记录数**，同一首歌存在多个副本时
 * 会比收藏页多几行。导航里的数字是给用户校准「点进去看到几首」用的，两个数不一致
 * 就是一条可复现的困惑源，所以宁可在这里多算一次去重。
 *
 * 为什么用 useMemo 现算而不是存进 store：去重要遍历整库，写进 store 就得在每条
 * 曲库写入路径上重算（漏掉一条就留下一份过期计数）；从 `tracks` 派生则永远一致。
 * `tracks` 只在扫描/增删/收藏切换时变，重算频率与曲库规模同阶，可接受。
 *
 * 侧栏（Sidebar）与移动端抽屉（MobileNav）共用本 hook：两处各写一份，迟早漂移。
 */
export function useLikedDisplayCount(): number {
  const tracks = useLibraryStore((s) => s.tracks)
  return useMemo(
    () => dedupeTracksForDisplay(tracks.filter((t) => t.liked)).tracks.length,
    [tracks]
  )
}
