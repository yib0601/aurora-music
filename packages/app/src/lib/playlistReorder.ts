/**
 * 歌单内的「上移 / 下移」位置计算。
 *
 * 为什么需要这一层：仓库没有安装任何拖拽库（无 dnd-kit 等，也不为此新增依赖），
 * 歌单排序走菜单项调用既有的 `playlistStore.reorderTracks(playlistId, from, to)`。
 * 而页面上渲染的是 `playlistTracks`（**已过滤掉曲库里不存在的 id** 的展示列表），
 * reorderTracks 操作的是 `playlist.trackIds`（**原始持久化顺序**）。
 * 一旦歌单里有过被移出曲库的歌，两组下标就错位——直接用渲染下标去 reorder，
 * 换位的会是相邻的另一首歌（用户看到「点了上移但动的是别的行」）。
 *
 * 所以把「展示列表下标 → 原始顺序下标」的换算收在这里，UI 只负责渲染
 * `up >= 0` / `down >= 0` 与传值，边界也在这里判一次：
 * 第一行没有目标位置（up = -1）、最后一行没有（down = -1）。
 */

/** 一侧的移动目标：-1 表示「无此方向」（该方向不渲染菜单项） */
export interface MoveTargets {
  /** 上移的目标位置（在 trackIds 里的下标），-1 = 不允许上移 */
  up: number
  /** 下移的目标位置（在 trackIds 里的下标），-1 = 不允许下移 */
  down: number
}

/**
 * 计算某一行在当前展示列表里的上/下移目标位置。
 *
 * @param trackIds    歌单的原始顺序（playlist.trackIds）
 * @param visibleIds  当前展示出来的 id 顺序（已过滤掉曲库里不存在的曲目）
 * @param index       该行在 visibleIds 里的下标
 */
export function moveTargetsAt(
  trackIds: readonly string[],
  visibleIds: readonly string[],
  index: number
): MoveTargets {
  const none: MoveTargets = { up: -1, down: -1 }
  if (!Number.isInteger(index) || index < 0 || index >= visibleIds.length) return none
  const selfId = visibleIds[index]
  const from = trackIds.indexOf(selfId)
  // 自己不在原始顺序里（数据不同步），任何移动都无从谈起
  if (from < 0) return none

  const upId = index > 0 ? visibleIds[index - 1] : undefined
  const downId = index < visibleIds.length - 1 ? visibleIds[index + 1] : undefined
  return {
    up: upId === undefined ? -1 : trackIds.indexOf(upId),
    down: downId === undefined ? -1 : trackIds.indexOf(downId),
  }
}
