import { describe, expect, it } from 'vitest'
import { LANGUAGE_PREFERENCES } from '@aurora/shared'
import {
  DEFAULT_DOWNLOAD_QUALITY,
  DEFAULT_THEME,
  DOWNLOAD_QUALITY_OPTION_ORDER,
  THEME_OPTION_ORDER,
} from '@/lib/settingOptions'

/**
 * 设置页选项组的「默认值 = 最左那一格」回归锁。
 *
 * 这条约定是 UI 语义而不是纯样式：左起第一格被用户读成「出厂状态」，
 * 默认值一旦藏到右边，用户要么找不到、要么以为默认是别的档。
 * 顺序与默认值分散在多处时（store 初值 / 首屏脚本 / 页面常量数组），
 * 只改一半就会出现「默认值和最左那一格不是同一个」的静默错位 —— 这里钉住。
 *
 * 语言组不在本文件：它的顺序由 `@aurora/shared` 的 `LANGUAGE_PREFERENCES`
 * 给出（'system' 恒为首项），下面只做一次端到端确认。
 */
describe('设置项默认值与展示顺序', () => {
  it('主题：默认「跟随系统」，且排在选项组最左', () => {
    expect(DEFAULT_THEME).toBe('system')
    expect(THEME_OPTION_ORDER[0]).toBe(DEFAULT_THEME)
  })

  it('下载音质：默认「无损 FLAC」，且排在选项组最左', () => {
    expect(DEFAULT_DOWNLOAD_QUALITY).toBe('flac')
    expect(DOWNLOAD_QUALITY_OPTION_ORDER[0]).toBe(DEFAULT_DOWNLOAD_QUALITY)
  })

  it('顺序数组覆盖全部档位且不重复：漏一档会让设置页少一格，用户没法选回去', () => {
    // 排序后比对的是「值域」：新增档位必须同时加进顺序数组，否则这里先红
    expect([...THEME_OPTION_ORDER].sort()).toEqual(['dark', 'light', 'system'])
    expect(new Set(THEME_OPTION_ORDER).size).toBe(THEME_OPTION_ORDER.length)

    expect([...DOWNLOAD_QUALITY_OPTION_ORDER].sort()).toEqual(['128', '320', 'flac'])
    expect(new Set(DOWNLOAD_QUALITY_OPTION_ORDER).size).toBe(DOWNLOAD_QUALITY_OPTION_ORDER.length)
  })

  it('语言：默认「跟随系统」同样是顺序数组的首项', () => {
    expect(LANGUAGE_PREFERENCES[0]).toBe('system')
  })
})
