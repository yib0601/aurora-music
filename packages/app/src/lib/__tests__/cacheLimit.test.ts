import { describe, expect, it } from 'vitest'
import {
  CACHE_LIMIT_MAX_GB,
  CACHE_LIMIT_MIN_GB,
  formatCacheLimit,
  GB_PRESETS,
  gbToMb,
  mbToGb,
  parseCacheLimitGbDraft,
} from '@/lib/cacheLimit'

/**
 * 缓存容量档位换算回归锁。
 *
 * 这组判据把「用户看到的 GB」和「落盘/下发的 MB」钉死在一起：
 * 0 必须是「不限制」档而不是 0 GB，越界草稿必须返回 null（由 UI 提示非法），
 * 而不是被悄悄钳到边界 —— 否则用户填 200 会以为生效了 200 GB。
 */
describe('缓存容量档位换算', () => {
  it('区间与档位常量：预设档位全部落在合法区间内', () => {
    expect(CACHE_LIMIT_MIN_GB).toBe(0.5)
    expect(CACHE_LIMIT_MAX_GB).toBe(100)
    expect(GB_PRESETS).toEqual([1, 2, 5, 10, 50])
    for (const gb of GB_PRESETS) {
      expect(gb).toBeGreaterThanOrEqual(CACHE_LIMIT_MIN_GB)
      expect(gb).toBeLessThanOrEqual(CACHE_LIMIT_MAX_GB)
    }
  })

  it('mbToGb：1024 进制换算，不限制档（0）得到 0', () => {
    expect(mbToGb(1024)).toBe(1)
    expect(mbToGb(512)).toBe(0.5)
    expect(mbToGb(1536)).toBe(1.5)
    expect(mbToGb(0)).toBe(0)
  })

  it('gbToMb：四舍五入到整数 MB，且与 mbToGb 往返一致', () => {
    expect(gbToMb(1)).toBe(1024)
    expect(gbToMb(0.5)).toBe(512)
    expect(gbToMb(1.5)).toBe(1536)
    expect(gbToMb(20)).toBe(20480)
    expect(gbToMb(CACHE_LIMIT_MAX_GB)).toBe(102400)
    for (const gb of GB_PRESETS) {
      expect(mbToGb(gbToMb(gb))).toBe(gb)
    }
  })

  it('formatCacheLimit：0 显示「不限制」，不显示 0 GB', () => {
    expect(formatCacheLimit(0)).toBe('不限制')
    // 负值同样按「不限制」兜底：它不是可生效的容量
    expect(formatCacheLimit(-1024)).toBe('不限制')
  })

  it('formatCacheLimit：GB 文案去掉多余零', () => {
    expect(formatCacheLimit(1024)).toBe('1 GB')
    expect(formatCacheLimit(512)).toBe('0.5 GB')
    expect(formatCacheLimit(1536)).toBe('1.5 GB')
    expect(formatCacheLimit(20480)).toBe('20 GB')
    expect(formatCacheLimit(102400)).toBe('100 GB')
    expect(formatCacheLimit(2048)).toBe('2 GB')
    expect(formatCacheLimit(5120)).toBe('5 GB')
  })

  it('parseCacheLimitGbDraft：空串与空白 → null', () => {
    expect(parseCacheLimitGbDraft('')).toBeNull()
    expect(parseCacheLimitGbDraft('   ')).toBeNull()
  })

  it('parseCacheLimitGbDraft：非数字与非法值 → null', () => {
    expect(parseCacheLimitGbDraft('abc')).toBeNull()
    expect(parseCacheLimitGbDraft('1GB')).toBeNull()
    expect(parseCacheLimitGbDraft('Infinity')).toBeNull()
    expect(parseCacheLimitGbDraft('NaN')).toBeNull()
  })

  it('parseCacheLimitGbDraft：0 与负数 → null（「不限制」不走输入框）', () => {
    expect(parseCacheLimitGbDraft('0')).toBeNull()
    expect(parseCacheLimitGbDraft('-1')).toBeNull()
  })

  it('parseCacheLimitGbDraft：越界 → null，不静默钳制到边界', () => {
    expect(parseCacheLimitGbDraft('0.4')).toBeNull()
    expect(parseCacheLimitGbDraft('100.5')).toBeNull()
    expect(parseCacheLimitGbDraft('1000')).toBeNull()
  })

  it('parseCacheLimitGbDraft：边界值与小数合法，返回对应 MB', () => {
    expect(parseCacheLimitGbDraft('0.5')).toBe(512)
    expect(parseCacheLimitGbDraft('100')).toBe(102400)
    expect(parseCacheLimitGbDraft('1')).toBe(1024)
    expect(parseCacheLimitGbDraft('1.5')).toBe(1536)
    expect(parseCacheLimitGbDraft(' 2 ')).toBe(2048)
  })
})