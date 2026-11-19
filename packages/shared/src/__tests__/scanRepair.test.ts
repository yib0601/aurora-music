import { describe, expect, it } from 'vitest'
import { isIncompleteScanRecord, MIN_PLAUSIBLE_TRACK_SECONDS } from '../scanRepair'

/**
 * 判据的边界：这条规则决定「哪些存量记录会被重解析一次」。
 * 漏判 → 用户那边永久 0:00；误判 → 每次扫描都白解析一遍（真·短音频）。
 */
describe('isIncompleteScanRecord', () => {
  it('时长缺失或非正数一律算残次', () => {
    expect(isIncompleteScanRecord({ duration: undefined })).toBe(true)
    expect(isIncompleteScanRecord({ duration: 0 })).toBe(true)
    expect(isIncompleteScanRecord({ duration: Number.NaN })).toBe(true)
    expect(isIncompleteScanRecord({ duration: -1 })).toBe(true)
  })

  it('没落过 fileSize 的毫秒级时长算残次（真机现场的 0.023 / 0.048 / 0.743 秒）', () => {
    for (const duration of [0.023, 0.048, 0.743]) {
      expect(isIncompleteScanRecord({ duration })).toBe(true)
    }
  })

  it('落过 fileSize 的短音频不算残次：它是按完整文件解析出来的', () => {
    expect(isIncompleteScanRecord({ duration: 0.743, fileSize: 4_695_096 })).toBe(false)
    expect(isIncompleteScanRecord({ duration: 2, fileSize: 24_000 })).toBe(false)
  })

  it('时长正常的记录（含历史无 fileSize 的老记录）不复位', () => {
    expect(isIncompleteScanRecord({ duration: 383.315 })).toBe(false)
    expect(isIncompleteScanRecord({ duration: 383.315, fileSize: 4_695_096 })).toBe(false)
  })

  it('阈值边界：恰好 5 秒不算残次，差一点算', () => {
    expect(isIncompleteScanRecord({ duration: MIN_PLAUSIBLE_TRACK_SECONDS })).toBe(false)
    expect(isIncompleteScanRecord({ duration: MIN_PLAUSIBLE_TRACK_SECONDS - 0.001 })).toBe(true)
  })
})
