import { describe, it, expect } from 'vitest'
import { isNoticeLikeClip, shouldTreatAsNoticeClip } from '../audioGuard'
import type { Track } from '@/types'

/**
 * 「上源提示音」闸门判据。
 *
 * 实测上报场景：榜单里点「黄昏 / 周传雄」（元数据 344 秒），上源给回来的
 * 是一条 2 秒版权提示音——播放条显示 0:01 / 0:02，用户听到「该歌曲暂时无法播放」。
 * 这条判据负责把这种音频挡在「正常播放」之外。
 *
 * 第二条上报场景（元数据缺失）：乐源对无权益曲目回落到兜底音源时把 duration 恒写成 0，
 * 于是「expected >= 30」的旧判据整段失效——同样一条 3 秒提示音，元数据标 200 时被拦下，
 * 标 0 时照播，`ended` 触发自动下一首，整条队列以每首约 3 秒的节奏跳空。
 */
function track(overrides: Partial<Track> = {}): Track {
  return {
    id: 't1',
    path: '',
    title: '黄昏',
    artist: '周传雄',
    album: '',
    duration: 344,
    addedAt: 0,
    playCount: 0,
    liked: false,
    ...overrides,
  }
}

describe('isNoticeLikeClip', () => {
  it('2 秒提示音 vs 344 秒元数据：判为异常', () => {
    expect(isNoticeLikeClip(track(), 2)).toBe(true)
  })

  it('9 秒片段仍判为异常（阈值内）', () => {
    expect(isNoticeLikeClip(track(), 9.9)).toBe(true)
  })

  it('正常曲目：实际时长与元数据同量级时放行', () => {
    expect(isNoticeLikeClip(track(), 344)).toBe(false)
    expect(isNoticeLikeClip(track(), 298)).toBe(false)
  })

  it('10 秒及以上一律放行（短间奏/短曲不该被拦）', () => {
    expect(isNoticeLikeClip(track(), 10)).toBe(false)
    expect(isNoticeLikeClip(track(), 30)).toBe(false)
  })

  it('元数据本身就短（铃声等）不适用本判据', () => {
    expect(isNoticeLikeClip(track({ duration: 6 }), 6)).toBe(false)
    // 元数据可信且 < 30 秒：知道它就是短的，实际再短也只是同一个短素材
    expect(isNoticeLikeClip(track({ duration: 3 }), 3)).toBe(false)
    expect(isNoticeLikeClip(track({ duration: 6 }), 3)).toBe(false)
  })

  it('时长不可用（NaN / 0 / 负数）不判异常，交给加载失败路径', () => {
    expect(isNoticeLikeClip(track(), Number.NaN)).toBe(false)
    expect(isNoticeLikeClip(track(), 0)).toBe(false)
    expect(isNoticeLikeClip(track(), -1)).toBe(false)
  })

  /**
   * 元数据缺失（源把 duration 写成 0）时不再依赖 expected：实际时长本身就能定性。
   * 这是疯狂跳曲那条通路的直接回归点——旧判据下 lines 会整段失效。
   */
  it('元数据 duration=0（源未给/无权益回落）：实际 3 秒判为提示音', () => {
    expect(isNoticeLikeClip(track({ duration: 0 }), 3)).toBe(true)
    expect(isNoticeLikeClip(track({ duration: 0 }), 2)).toBe(true)
    expect(isNoticeLikeClip(track({ duration: 0 }), 9.9)).toBe(true)
    // 兜底判据同样不该误伤长音频：duration 未知但实际够长，就是正常播放
    expect(isNoticeLikeClip(track({ duration: 0 }), 12)).toBe(false)
    expect(isNoticeLikeClip(track({ duration: 0 }), 235)).toBe(false)
  })

  it('元数据是负数 / NaN / 缺失（undefined）同样按「未知」处理', () => {
    expect(isNoticeLikeClip(track({ duration: -1 }), 3)).toBe(true)
    expect(isNoticeLikeClip(track({ duration: Number.NaN }), 3)).toBe(true)
    // 持久化快照或上游 JSON 缺字段时是 undefined：`undefined <= 0` 为 false，
    // 只判数值范围会把它当成「可信的短时长」而放行
    expect(isNoticeLikeClip(track({ duration: undefined as unknown as number }), 3)).toBe(true)
    // Infinity 同样不是可信时长
    expect(isNoticeLikeClip(track({ duration: Number.POSITIVE_INFINITY }), 3)).toBe(true)
  })

  it('元数据真实为 3 秒（expected=3）：不误判为提示音', () => {
    expect(isNoticeLikeClip(track({ duration: 3 }), 3)).toBe(false)
    expect(isNoticeLikeClip(track({ duration: 3 }), 2.9)).toBe(false)
    expect(isNoticeLikeClip(track({ duration: 15 }), 3)).toBe(false)
  })

  it('expected=20 是「长曲」边界：恰好 20 仍按长曲判异常', () => {
    expect(isNoticeLikeClip(track({ duration: 20 }), 5)).toBe(true)
    expect(isNoticeLikeClip(track({ duration: 19.9 }), 5)).toBe(false)
  })

  /**
   * 与音源侧的「可播时长下限」对齐（乐源 `core/http.py` 的 `MIN_AUDIO_SEC = 20`）。
   *
   * 两侧错位会留出无人区：音源探测放行（>= 20）并把时长回填，客户端却因「元数据没到 30」
   * 而不认定异常 —— 一条 3 秒提示音只要元数据落在 20~29 就照播并触发自动下一首。
   * 这条断言把数字钉死，改任何一侧时都会在这里失败，逼着一起改。
   */
  it('20~29 秒区间的元数据必须判异常（曾与音源阈值 30/20 错位而漏判）', () => {
    for (const dur of [20, 22, 25, 29, 29.9]) {
      expect(isNoticeLikeClip(track({ duration: dur }), 3)).toBe(true)
      expect(isNoticeLikeClip(track({ duration: dur }), 2)).toBe(true)
    }
    // 实际够长就放行，与元数据无关
    expect(isNoticeLikeClip(track({ duration: 25 }), 25)).toBe(false)
  })

  it('元数据 < 20 秒仍按「短素材」放行（铃声/提示音素材不该被拦）', () => {
    expect(isNoticeLikeClip(track({ duration: 19.9 }), 3)).toBe(false)
    expect(isNoticeLikeClip(track({ duration: 15 }), 3)).toBe(false)
    expect(isNoticeLikeClip(track({ duration: 6 }), 6)).toBe(false)
  })
})

/**
 * 播放器调用点用的是带来源的判据（audio.service 的 onload）。
 * 「非在线曲目不受影响」必须与 duration=0 一起被钉住：把用户自己的短录音、
 * 铃声判成异常，比原 bug 更烦人。
 */
describe('shouldTreatAsNoticeClip', () => {
  it('在线曲目：沿用同一判据', () => {
    expect(shouldTreatAsNoticeClip(track(), 2, true)).toBe(true)
    expect(shouldTreatAsNoticeClip(track(), 344, true)).toBe(false)
    expect(shouldTreatAsNoticeClip(track({ duration: 0 }), 3, true)).toBe(true)
    expect(shouldTreatAsNoticeClip(track({ duration: 3 }), 3, true)).toBe(false)
  })

  it('非在线曲目一律放行：本地短文件不是「上源提示音」', () => {
    // 元数据 344 秒却只解出 2 秒：本地文件损坏，走加载失败/跳过语义，不走闸门
    expect(shouldTreatAsNoticeClip(track({ path: '/music/a.flac' }), 2, false)).toBe(false)
    // 用户自己的短素材（铃声、录音）
    expect(shouldTreatAsNoticeClip(track({ path: '/music/ring.flac', duration: 0 }), 3, false)).toBe(false)
    expect(shouldTreatAsNoticeClip(track({ path: '/music/ring.flac', duration: 3 }), 3, false)).toBe(false)
  })
})