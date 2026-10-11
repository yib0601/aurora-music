import type { Track } from '@/types'

/**
 * 「上源提示音 / 试听片段」判据（纯函数，摆在 lib 层便于单测）。
 *
 * 部分上源对无权益曲目会下发数秒版权提示音（"该歌曲暂时无法播放…"）或试听片段：
 * 它们同样是 200 + audio/mpeg，加载必然成功，**只有时长暴露真相**。
 * 客户端不能把这种音频当正常播放——照播两三秒再跳下一首，用户只会看到
 * 「进度条闪一下、歌没了」，以为这首歌本身不能放（实测正是如此被上报的）。
 */

/** 判定为提示音的时长上限（秒）：正常曲目（含短间奏）不会这么短，提示音都在 3 秒上下 */
export const NOTICE_CLIP_MAX_SEC = 10

/** 期望时长的下限（秒）：元数据本身就几秒的条目（铃声、提示音素材）不适用本判据 */
export const NOTICE_CLIP_MIN_EXPECTED_SEC = 30

/**
 * 实际加载时长是否与曲目元数据严重不符。
 * @param track 正在播的曲目（duration 为元数据时长，秒）
 * @param actual 播放器加载后拿到的实际时长（秒）
 */
export function isNoticeLikeClip(track: Track, actual: number): boolean {
  if (!Number.isFinite(actual) || actual <= 0) return false
  const expected = track.duration || 0
  return actual < NOTICE_CLIP_MAX_SEC && expected >= NOTICE_CLIP_MIN_EXPECTED_SEC
}
