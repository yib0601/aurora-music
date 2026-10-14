import type { Track } from '@/types'

/**
 * 「上源提示音 / 试听片段」判据（纯函数，摆在 lib 层便于单测）。
 *
 * 部分上源对无权益曲目会下发数秒版权提示音（"该歌曲暂时无法播放…"）或试听片段：
 * 它们同样是 200 + audio/mpeg，加载必然成功，**只有时长暴露真相**。
 * 客户端不能把这种音频当正常播放——照播两三秒再跳下一首，用户只会看到
 * 「进度条闪一下、歌没了」，以为这首歌本身不能放（实测正是如此被上报的）。
 *
 * ⚠️ 元数据 `duration` 只能当**佐证**，不能当必要条件：源对无权益曲目回落到兜底
 * 音源时会把 duration 恒写成 0（实测用户歌单「周杰伦」5/5 条如此）。早先
 * 「expected >= 30 才算提示音」的判据对这批曲目整段失效——同样一条 3 秒提示音，
 * 元数据标 200 时被拦下并发 shortStream，标 0 时照播，`ended` 触发自动下一首，
 * 20 首队列以每首约 3 秒的节奏跳空。所以元数据缺失时改由**实际解码时长**兜底。
 *
 * 这条兜底的关键是区分两种「短」：
 *   - 元数据 <= 0 / NaN / 缺失 = **不知道**这首歌该多长 —— 实际只有 3 秒时，它是
 *     正常曲目的概率极低，按提示音处理（宁可明确报错，也不要照播后连环跳）；
 *   - 元数据为正且本身很短（铃声、提示音素材） = **知道它就是短的** —— 放行。
 * 两者混为一谈会把用户自己的短素材判成异常，那比原 bug 更烦人。
 */

/** 判定为提示音的时长上限（秒）：正常曲目（含短间奏）不会这么短，提示音都在 3 秒上下 */
export const NOTICE_CLIP_MAX_SEC = 10

/**
 * 元数据可信时，期望时长的下限（秒）：元数据本身就几秒的条目（铃声、提示音素材）不适用本判据。
 *
 * ⚠️ 必须与**音源侧的可播时长下限对齐**（乐源 `core/http.py` 的 `MIN_AUDIO_SEC = 20`）。
 * 早先这里写 30，而音源侧是 20，两者之间留出 20~29 秒的无人区：音源探测放行（>= 20）
 * 并把它当作真实时长回填，客户端却因为「元数据没到 30」而不认定异常 —— 一条 3 秒提示音
 * 只要元数据落在这一段就照播并触发自动下一首，正是上报的连环跳。
 *
 * 降到 20 不会误伤铃声类素材：本条只在 `actual < NOTICE_CLIP_MAX_SEC` 时才被求值，
 * 元数据 6 秒 + 实际 6 秒的条目早在上一行就返回了。
 */
export const NOTICE_CLIP_MIN_EXPECTED_SEC = 20

/**
 * 元数据时长是否「不可信」：0、负数、NaN、undefined 都归为「不知道这首歌该多长」。
 *
 * ⚠️ 必须用 typeof 卡住非数字：曲目可能来自持久化快照或上游 JSON，duration 缺失时
 * 是 undefined，而 `undefined <= 0` 为 false——只判数值范围会把它当成「可信的短时长」
 * 而放行，正是本判据要堵的漏洞。
 */
function hasUnknownDuration(track: Track): boolean {
  const expected = track.duration
  return typeof expected !== 'number' || !Number.isFinite(expected) || expected <= 0
}

/**
 * 实际加载时长是否说明「上源给的是一条提示音 / 试听片段」。
 * @param track 正在播的曲目（duration 为元数据时长，秒）
 * @param actual 播放器加载后拿到的实际时长（秒）
 */
export function isNoticeLikeClip(track: Track, actual: number): boolean {
  // 实际时长拿不到时不下结论：交给加载失败路径，不要凭猜测拦停正常音频
  if (!Number.isFinite(actual) || actual <= 0) return false
  // 够长就是正常音频，与元数据无关（源把时长写错、写 0 都可能）
  if (actual >= NOTICE_CLIP_MAX_SEC) return false
  // 元数据不知道这首歌多长：实际这么短只可能是提示音，不再依赖 expected 才有判据
  if (hasUnknownDuration(track)) return true
  // 元数据可信：只有它明确说明本曲是长曲（>= 30 秒）时，短实际时长才算异常
  return track.duration >= NOTICE_CLIP_MIN_EXPECTED_SEC
}

/**
 * 播放器闸门的完整判据：只有**在线来源**才做这项判定。
 *
 * 本地文件短就是用户自己的短素材（铃声、片头、录音），客户端没有立场说它异常；
 * 而且本机路径带什么都没关系的元数据，判错只会让用户文件放不出来。
 * 在线来源的「短」才有解释力：上源拿不到权益时给的就是一条版权提示音。
 *
 * 判据收进本模块（而不是留在 audio.service 的 onload 里）是为了能被单测覆盖——
 * 「非在线曲目不受影响」这条必须和 duration=0 一起被钉住，否则下次改判据时
 * 很容易把本地短文件一起拦掉。
 */
export function shouldTreatAsNoticeClip(track: Track, actual: number, isOnline: boolean): boolean {
  if (!isOnline) return false
  return isNoticeLikeClip(track, actual)
}
