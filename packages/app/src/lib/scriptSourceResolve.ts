/**
 * 「这条曲目是否该先问脚本源要地址」的**同步**判据。
 *
 * ## 为什么需要一个独立模块
 *
 * 播放器要用它在点播的同一 tick 里决定「立即起播」还是「先进取址闸门」
 * （见 `stores/playerStore.ts` 的 `hasResolvableGap`）。这个判据必须同步：
 * 异步判据会让同一 tick 内的两次点播出现回调乱序（先点的后落地）。
 * 而「哪个脚本源认领哪个平台」的策略在 `@aurora/shared`，这里只负责把当前音源配置
 * 同步取出来 —— 读 zustand 的 `getState`，不发请求、不产生 I/O。
 *
 * 判据本身（曲目是否自带脚本令牌、有没有源内 id、源是否启用或已声明平台）全部在
 * shared 的 `hasScriptSourceCandidate` 里，与真正取址时用的是同一份候选筛选逻辑；
 * 两处若各写一份，会出现「闸门说该问、取址却找不到候选」这类只能靠日志发现的偏差。
 */
import { hasScriptSourceCandidate } from '@aurora/shared'
import { useLibraryStore } from '@/stores/libraryStore'
import type { Track } from '@/types'

export function needsScriptResolve(track: Track | null | undefined): boolean {
  if (!track) return false
  // 本地文件（含移动端已落盘的远端缓存）直接播，没有「现取地址」这回事
  if (track.path) return false
  try {
    return hasScriptSourceCandidate(useLibraryStore.getState().onlineSources, track)
  } catch {
    // 音源配置尚未初始化（应用极早期）：当作没有候选，走既有路径而不是崩
    return false
  }
}
