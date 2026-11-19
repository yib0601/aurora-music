/**
 * 「扫描跑在文件写完之前」留下的残次记录：判定与自愈口径（桌面端 / 移动端共用）。
 *
 * 成因（真机 2026-11-19 现场）：下载工具先创建文件、再往里灌字节。扫描若正好落在
 * 这个窗口里，解析器只看到开头几帧，于是给出一个毫秒级的时长（实测 0.023s /
 * 0.048s / 0.743s），此时标签也还没落盘，artist/title 一并退化成文件名。文件随后
 * 下载完整，但两端对「已入库记录」都按 path 命中即复用：
 *   - 桌面端只比对 fileSize —— 文件后来变大了，重解析一次就能自愈；
 *   - 移动端此前既不做 fileSize 比对、也没有任何重解析路径，这类记录会永久停在
 *     0:00，用户重扫多少次都修不好（`formatTime(0.743)` 就是 `0:00`）。
 *
 * 所以移动端必须有一条自己的判据，两端共用同一份口径。判据只认时长，不猜文件名
 * （无标签曲目本来就是合法的）：
 *   - 时长缺失 / 非正数 → 必然是坏记录；
 *   - 时长小于 5 秒 **且** 从未落过 fileSize → 极可能是「只读到前几帧」。落过
 *     fileSize 说明这条记录是按完整文件解析出来的，真·短音频（铃声、提示音、
 *     语音备忘）不该每次扫描都被重解析一遍（重解析有 IO 代价，且没有收益）。
 *
 * 阈值取 5 秒：实测残次值都在 1 秒以内，留了一个数量级以上的余量；而被误判的
 * 唯一代价是「该文件被多解析一次」，随后落上 fileSize 即收敛，不会反复发生。
 */
export const MIN_PLAUSIBLE_TRACK_SECONDS = 5

/**
 * 该记录是否需要重解析以修复。
 *
 * 调用方语义：命中即为「不要复用旧记录，按当前文件重新解析并覆写」。
 */
export function isIncompleteScanRecord(track: {
  /** 时长（秒） */
  duration?: number
  /** 上次解析时落库的文件字节数（历史记录可能没有这一列） */
  fileSize?: number | null
}): boolean {
  const duration = track.duration
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return true
  if (track.fileSize == null && duration < MIN_PLAUSIBLE_TRACK_SECONDS) return true
  return false
}
