import { describe, it, expect } from 'vitest'
import { isNoticeLikeClip } from '../audioGuard'
import type { Track } from '@/types'

/**
 * 「上源提示音」闸门判据。
 *
 * 实测上报场景：榜单里点「黄昏 / 周传雄」（元数据 344 秒），上源给回来的
 * 是一条 2 秒版权提示音——播放条显示 0:01 / 0:02，用户听到「该歌曲暂时无法播放」。
 * 这条判据负责把这种音频挡在「正常播放」之外。
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
    expect(isNoticeLikeClip(track({ duration: 0 }), 2)).toBe(false)
  })

  it('时长不可用（NaN / 0 / 负数）不判异常，交给加载失败路径', () => {
    expect(isNoticeLikeClip(track(), Number.NaN)).toBe(false)
    expect(isNoticeLikeClip(track(), 0)).toBe(false)
    expect(isNoticeLikeClip(track(), -1)).toBe(false)
  })
})
