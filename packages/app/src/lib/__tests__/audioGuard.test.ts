import { describe, it, expect } from 'vitest'
import {
  isNoticeLikeClip,
  shouldTreatAsNoticeClip,
  NOTICE_CLIP_DURATION_RATIO,
  NOTICE_CLIP_MIN_EXPECTED_SEC,
} from '../audioGuard'
import type { Track } from '@/types'

/**
 * 「上源提示音 / 试听片段」闸门判据。
 *
 * 实测上报场景一：榜单里点「黄昏 / 周传雄」（元数据 344 秒），上源给回来的
 * 是一条 2 秒版权提示音——播放条显示 0:01 / 0:02，用户听到「该歌曲暂时无法播放」。
 *
 * 实测上报场景二（元数据缺失）：乐源对无权益曲目回落到兜底音源时把 duration 恒写成 0，
 * 于是「expected >= 30」的旧判据整段失效——同样一条 3 秒提示音，元数据标 200 时被拦下，
 * 标 0 时照播，`ended` 触发自动下一首，整条队列以每首约 3 秒的节奏跳空。
 *
 * 实测上报场景三（本文件新增的主力回归点）：上源给出的**试听片段是 48~221 秒**，
 * 全部大于旧的绝对阈值 10 秒，于是整批放行——用户听到「一首歌放半分钟就没了」。
 * 判据因此改为与曲目自身期望时长**按比例**比较（见 audioGuard 文件头）。
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

  it('9 秒片段仍判为异常', () => {
    expect(isNoticeLikeClip(track(), 9.9)).toBe(true)
  })

  it('正常曲目：实际时长与元数据同量级时放行', () => {
    expect(isNoticeLikeClip(track(), 344)).toBe(false)
    expect(isNoticeLikeClip(track(), 298)).toBe(false)
  })

  /**
   * 旧判据「实际 >= 10 秒一律放行」的**反面**：对一条 344 秒的曲目，10 秒音频
   * 只占 3%，它同样是片段。这条断言把「绝对阈值不可用」钉死在测试里
   * （实测片段 48~221 秒全部被旧绝对阈值放行，见下一个 describe）。
   */
  it('长曲目拿到 10 / 30 秒音频仍判异常（绝对阈值 10 秒已废弃）', () => {
    expect(isNoticeLikeClip(track(), 10)).toBe(true)
    expect(isNoticeLikeClip(track(), 30)).toBe(true)
    // 「短间奏/短曲不该被拦」的诉求由「元数据本身就短」分支承担，与 actual 无关
    expect(isNoticeLikeClip(track({ duration: 15 }), 10)).toBe(false)
  })

  it('元数据本身就短（铃声等）不适用本判据', () => {
    expect(isNoticeLikeClip(track({ duration: 6 }), 6)).toBe(false)
    // 元数据可信且 < 20 秒：知道它就是短的，实际再短也只是同一个短素材
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
 * 实测回归：2026-10-30 凌晨对线上音源取的 379 条真实搜索结果。
 *
 * 判定方式：`ffprobe -show_entries format=duration` 取整包（可疑项整文件下载后复核，
 * 排除 Range 截断造成的探测假象）。合法整曲 342 条比值 ≥ 0.95；试听片段 15 条
 * 落在 0.190~0.840。**旧判据（实际 < 10 秒）对这 15 条一条都拦不住**——
 * 这正是用户上报「很多歌只播一小段 / 提示没有资源」的来源。
 */
describe('实测片段回归（比例闸，2026-10-30 语料）', () => {
  /** [曲名, 元数据秒, 实测秒] —— 全部来自真实语料，比值均 < 0.85 */
  const CLIPS: [string, number, number][] = [
    ['孤勇者', 256, 48.5],
    ['桃花诺', 219, 77.6],
    ['当爱已成往事', 302, 95.1],
    ['今生今世', 263, 102.3],
    ['如果我们不曾相遇', 202, 116.6],
    ['关键词', 210, 130.9],
    ['可惜不是你', 285, 160.7],
    ['步步', 273, 178.0],
    ['耿', 269, 198.4],
    ['璀璨冒险人', 273, 202.2],
    ['无名的人', 282, 212.0],
    ['天龙八部之宿敌', 264, 221.6],
  ]

  it('12 条实测片段全部判为异常（含点名的 48.5 / 77.6 / 130.9 / 178 / 212 秒）', () => {
    for (const [title, meta, probed] of CLIPS) {
      expect(isNoticeLikeClip(track({ title, duration: meta }), probed), `${title} ${probed}/${meta}`).toBe(true)
    }
  })

  it('每一条的实测时长都 ≥ 10 秒：证明绝对阈值必然漏判', () => {
    for (const [title, , probed] of CLIPS) {
      expect(probed, title).toBeGreaterThanOrEqual(10)
    }
    // 逐条对照：旧判据（actual >= 10 → 放行）与现行比例闸结论相反
    expect(isNoticeLikeClip(track({ title: '孤勇者', duration: 256 }), 48.5)).toBe(true)
    expect(48.5 >= 10).toBe(true)
  })

  it('合法整曲（实测/元数据比值 ≥ 0.95）一律放行，不误杀', () => {
    const FULL: [string, number, number][] = [
      ['江南 320 档', 262, 262.3],
      ['不染', 320, 319.8],
      ['整曲恰等元数据', 256, 256],
      ['大鱼 0.96 档', 300, 288],
      ['十年 0.962 档', 316, 304],
    ]
    for (const [title, meta, probed] of FULL) {
      expect(isNoticeLikeClip(track({ title, duration: meta }), probed), `${title} ${probed}/${meta}`).toBe(false)
    }
  })

  /**
   * 比例边界与已知不确定带。
   *
   * 系数 0.85 贴着观测带下沿：0.85~0.95 之间语料里既有正常整曲（大鱼 0.96、
   * 十年 0.962）也有可疑项（人间 0.906、来生缘 0.919），取 0.85 是保守选择——
   * 宁可漏掉个别片段，也不误杀正常曲目。这两条断言把这个取舍明确写下来，
   * 后人收紧系数时会看到自己动了什么。
   */
  it('比例边界：恰好 0.85 放行，0.849 判异常', () => {
    expect(isNoticeLikeClip(track({ duration: 200 }), 200 * NOTICE_CLIP_DURATION_RATIO)).toBe(false)
    expect(isNoticeLikeClip(track({ duration: 200 }), 200 * NOTICE_CLIP_DURATION_RATIO - 0.1)).toBe(true)
    // 0.95 以上（正常整曲所在区间）当然放行
    expect(isNoticeLikeClip(track({ duration: 200 }), 190)).toBe(false)
  })

  it('已知不确定带 0.85~0.95 放行（保守取值，接受漏判个别片段）', () => {
    // 人间 0.906 / 来生缘 0.919 这类边界样本：现行系数下放行
    expect(isNoticeLikeClip(track({ duration: 200 }), 181.2)).toBe(false)
    expect(isNoticeLikeClip(track({ duration: 200 }), 183.8)).toBe(false)
  })

  it('系数与「期望时长下限」都被钉住，改任一处都会在此失败', () => {
    expect(NOTICE_CLIP_DURATION_RATIO).toBe(0.85)
    expect(NOTICE_CLIP_MIN_EXPECTED_SEC).toBe(20)
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
    // 比例闸同样只对在线来源生效：实测片段 48.5 秒
    expect(shouldTreatAsNoticeClip(track({ duration: 256 }), 48.5, true)).toBe(true)
  })

  it('非在线曲目一律放行：本地短文件不是「上源提示音」', () => {
    // 元数据 344 秒却只解出 2 秒：本地文件损坏，走加载失败/跳过语义，不走闸门
    expect(shouldTreatAsNoticeClip(track({ path: '/music/a.flac' }), 2, false)).toBe(false)
    // 比例闸下的同一条：本地长曲目的短音频也不由本闸门拦（走加载失败路径）
    expect(shouldTreatAsNoticeClip(track({ path: '/music/a.flac', duration: 256 }), 48.5, false)).toBe(false)
    // 用户自己的短素材（铃声、录音）
    expect(shouldTreatAsNoticeClip(track({ path: '/music/ring.flac', duration: 0 }), 3, false)).toBe(false)
    expect(shouldTreatAsNoticeClip(track({ path: '/music/ring.flac', duration: 3 }), 3, false)).toBe(false)
  })
})
