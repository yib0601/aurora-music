/**
 * 睡眠定时器的时间语义（纯函数，便于单测）。
 *
 * 设计要点：只保存**结束时间戳**，剩余时间永远由「现在」推导。
 *
 * 为什么不用 setInterval 存一个「剩余秒数」再递减：渲染进程在后台会被浏览器
 * 节流（Electron 隐藏窗口、移动端 WebView 进后台更激进），1 秒的 interval 可能
 * 十几次才跑一回，递减出来的数字会比真实时间慢一大截——用户看到「还剩 8 分钟」
 * 实际已经过了 12 分钟。时间戳方案下节流只会让**显示**跳一下，到点判定始终
 * 对齐真实时钟。
 */

/** 睡眠定时器档位（分钟）。语义恒为「到点暂停」，不是退出应用 */
export const SLEEP_TIMER_PRESETS = [15, 30, 60] as const

export const MINUTE_MS = 60_000

/** 由「从现在起 N 分钟」算出结束时间戳（毫秒） */
export function sleepEndsAtFromNow(minutes: number, now: number = Date.now()): number {
  return now + minutes * MINUTE_MS
}

/**
 * 剩余毫秒数：已到点或已过点返回 0（不返回负数）。
 * `now` 显式传入，测试与「同一帧内多次读取」都能得到一致结果。
 */
export function sleepRemainingMs(endsAt: number, now: number = Date.now()): number {
  const left = endsAt - now
  return left > 0 ? left : 0
}

/** 是否已到点 */
export function isSleepTimerDue(endsAt: number, now: number = Date.now()): boolean {
  return sleepRemainingMs(endsAt, now) === 0
}

/**
 * 剩余时间的展示形态：`10:05` / `0:42`。
 *
 * 用**向上取整**而不是截断：剩 0.6 秒时截断会显示 0:00，而定时器其实还没到点，
 * 用户会以为它坏了。向上取整保证「显示 0:00 的那一刻」正好是要停的那一刻。
 */
export function formatSleepRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00'
  const totalSeconds = Math.ceil(ms / 1000)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
