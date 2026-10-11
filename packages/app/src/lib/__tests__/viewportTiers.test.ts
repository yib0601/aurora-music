import { describe, expect, it } from 'vitest'
import {
  isShortViewport,
  isSquatViewport,
  isUltrawideViewport,
  SHORT_VIEWPORT_MAX_HEIGHT,
  SHORT_VIEWPORT_QUERY,
  SQUAT_VIEWPORT_MAX_HEIGHT,
  SQUAT_VIEWPORT_QUERY,
  ULTRAWIDE_MIN_RATIO,
  ULTRAWIDE_VIEWPORT_QUERY,
} from '@/lib/viewportTiers'

/**
 * 空间档位（高度 / 宽高比）回归锁。
 *
 * 病灶：适配判据此前只有宽度维度，比例失衡的屏幕（手机横屏 915×412、
 * 车机 1280×720、21:9 超宽屏）在宽度上被判成宽档、纵向却装不下宽档尺寸 —
 * 详情页标题与操作按钮被底部播放条遮住、播放条在 412px 高的屏上吃掉 130px。
 *
 * 这里锁死三件事：
 * 1) 阈值本身（改动即需同步 tailwind.config.ts 的 screen 与 globals.css 的 @screen）；
 * 2) 真实设备矩阵的判定结果（默认窗口必须不入矮档，否则宽档观感会被动到）；
 * 3) 查询串与阈值的一致性（查询串是 JS 侧判据的唯一入口，漂了就会「class 生效、
 *    JS 不生效」这类最难查的错位）。
 */
describe('空间档位：矮屏 / 极矮屏 / 超宽屏', () => {
  it('矮档阈值 780：Electron 默认窗口 1280×800 不入档，宽档尺寸原样保留', () => {
    expect(SHORT_VIEWPORT_MAX_HEIGHT).toBe(780)
    expect(isShortViewport(1280, 800)).toBe(false)
    expect(isShortViewport(1440, 900)).toBe(false)
  })

  it('矮档命中：车机 720p、窗口最小高度、手机横屏、笔记本矮窗', () => {
    expect(isShortViewport(1280, 720)).toBe(true)
    expect(isShortViewport(1280, 600)).toBe(true)
    expect(isShortViewport(915, 412)).toBe(true)
    expect(isShortViewport(1366, 768)).toBe(true)
  })

  it('极矮档阈值 560：手机横屏命中，桌面最小高度 600 不命中', () => {
    expect(SQUAT_VIEWPORT_MAX_HEIGHT).toBe(560)
    expect(isSquatViewport(915, 412)).toBe(true)
    expect(isSquatViewport(844, 390)).toBe(true)
    expect(isSquatViewport(1280, 600)).toBe(false)
  })

  it('超宽档 2:1：21:9 / 32:9 命中，16:9 / 16:10 / 3:2 / 4:3 不命中', () => {
    expect(ULTRAWIDE_MIN_RATIO).toBe('2/1')
    expect(isUltrawideViewport(2560, 1080)).toBe(true) // 21:9
    expect(isUltrawideViewport(3840, 1080)).toBe(true) // 32:9
    expect(isUltrawideViewport(1920, 720)).toBe(true) // 8:3 车机
    expect(isUltrawideViewport(1920, 1080)).toBe(false)
    expect(isUltrawideViewport(1440, 900)).toBe(false)
    expect(isUltrawideViewport(2160, 1440)).toBe(false)
    expect(isUltrawideViewport(1024, 768)).toBe(false)
  })

  it('高度为 0（测量早期 / 极端环境）不判成超宽，避免除零得到 Infinity', () => {
    expect(isUltrawideViewport(1920, 0)).toBe(false)
  })

  it('查询串与阈值同源：改常量必须同时改到 JS 判据', () => {
    expect(SHORT_VIEWPORT_QUERY).toBe(`(max-height: ${SHORT_VIEWPORT_MAX_HEIGHT}px)`)
    expect(SQUAT_VIEWPORT_QUERY).toBe(`(max-height: ${SQUAT_VIEWPORT_MAX_HEIGHT}px)`)
    expect(ULTRAWIDE_VIEWPORT_QUERY).toBe(`(min-aspect-ratio: ${ULTRAWIDE_MIN_RATIO})`)
  })

  it('档位包含关系：极矮 ⊂ 矮（同一屏不可能只命中极矮而不命中矮）', () => {
    for (const [w, h] of [
      [915, 412],
      [844, 390],
      [1280, 600],
      [1920, 1080],
    ]) {
      if (isSquatViewport(w, h)) expect(isShortViewport(w, h)).toBe(true)
    }
  })
})
