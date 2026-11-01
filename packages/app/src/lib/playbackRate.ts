/**
 * 变速播放的档位与数值格式（纯函数，便于单测）。
 *
 * 为什么档位写死在代码里而不是让用户自由拖：变速会改变音高与节奏，
 * 连续档位在触控上既难以精确、又容易滑到一个「能听但难听」的怪速率。
 * 五档覆盖了播客/有声书的常用场景（0.75 慢听、1.25/1.5 快听、2 跳听）。
 */

/** 可选档位（升序，UI 直接按此顺序渲染） */
export const PLAYBACK_RATE_PRESETS = [0.75, 1, 1.25, 1.5, 2] as const

/**
 * 归一化的上下界。
 *
 * 比 UI 档位更宽是刻意的：持久化里可能留着旧版本或手改过的值，
 * 这里只负责挡住「会直接炸播放器」的取值（0、负数、NaN、无穷大）。
 * Howler 的 rate 会一路传到 HTMLMediaElement.playbackRate，
 * 越界值在部分内核上抛 InvalidStateError 而不是被夹住。
 */
export const MIN_PLAYBACK_RATE = 0.5
export const MAX_PLAYBACK_RATE = 2

/**
 * 归一化速率：非数值 / 非正数一律回落 1（原速），其余夹到 [MIN, MAX]。
 *
 * 回落而不是报错：速率是个纯装饰性偏好，为一条脏数据让播放器抛错不值当。
 */
export function normalizePlaybackRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 1
  return Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, rate))
}

/**
 * 档位的数值展示：0.75 → `0.75`，1.5 → `1.5`，2 → `2`。
 *
 * 刻意**不走 Intl**：小数点符号会随语言从 `.` 变成 `,`，而这里的值要嵌进
 * 字典的 `{rate}×` 模板里；统一用 `.` 才能保证「1.5×」在两种语言下都是同一个
 * 可读的量，也让单测有确定断言。
 */
export function formatRateValue(rate: number): string {
  return String(Number(rate.toFixed(2)))
}
