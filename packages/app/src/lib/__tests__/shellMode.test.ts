import { describe, expect, it } from 'vitest'
import {
  isLargeScreen,
  LARGE_SCREEN_MIN_SIDE,
  LARGE_SCREEN_QUERY,
  resolveShellMode,
  WIDE_SHELL_MIN_WIDTH,
} from '@/lib/shellMode'

/**
 * 外壳分档回归锁。
 *
 * 本次线上问题就是这组判据错了：车机竖屏（10 寸，1280×800 / 800×1280 像素）上，
 * 旧实现把「导航形态」绑定在平台名（isMobile）上，而顶部汉堡栏自身又带 `md:hidden`，
 * 导致固定侧栏与汉堡栏**同时消失**，导航入口归零。
 * 这里锁的是「移动端 + 大屏 → 固定侧栏」，防止再退回去。
 */
describe('外壳结构分档', () => {
  it('车机 1280×800：走固定侧栏（竖屏车机主场景）', () => {
    expect(resolveShellMode({ mobile: true, largeScreen: isLargeScreen(1280, 800) })).toBe('wide')
  })

  it('车机 800×1280：短边 800 也走固定侧栏，不退化成汉堡抽屉', () => {
    expect(isLargeScreen(800, 1280)).toBe(true)
    expect(resolveShellMode({ mobile: true, largeScreen: isLargeScreen(800, 1280) })).toBe('wide')
  })

  it('手机竖屏 390×844 走抽屉（原移动端形态不回退）', () => {
    expect(isLargeScreen(390, 844)).toBe(false)
    expect(resolveShellMode({ mobile: true, largeScreen: isLargeScreen(390, 844) })).toBe('drawer')
  })

  it('手机横屏 844×390 走抽屉：短边 390 是手机形态，宽度再大也不给常驻侧栏', () => {
    expect(isLargeScreen(844, 390)).toBe(false)
    expect(resolveShellMode({ mobile: true, largeScreen: isLargeScreen(844, 390) })).toBe('drawer')
  })

  it('区分「车机竖屏 800 宽」与「手机横屏 844 宽」靠短边，不靠宽度', () => {
    // 两者宽度只差 44px，宽度阈值分不开；短边 800 vs 390 一眼可辨
    expect(isLargeScreen(800, 1280)).toBe(true)
    expect(isLargeScreen(844, 390)).toBe(false)
  })

  it('桌面端恒为固定侧栏：桌面外壳（TitleBar/窗口手柄）不能中途换成抽屉', () => {
    expect(resolveShellMode({ mobile: false, largeScreen: false })).toBe('wide')
    expect(resolveShellMode({ mobile: false, largeScreen: true })).toBe('wide')
  })

  it('阈值常量：短边档 520 高于任何手机横屏短边，避免误判', () => {
    expect(LARGE_SCREEN_MIN_SIDE).toBe(520)
    expect(WIDE_SHELL_MIN_WIDTH).toBe(1024)
    // 手机长边最大约 930（如 430×932），低于 1024，故不会命中宽度档
    expect(isLargeScreen(430, 932)).toBe(false)
  })

  it('按 CSS 像素算：10 寸车机 1280×800 物理像素在 dpr=1.5 下是 853×533，仍必须判为大屏', () => {
    // 车机 density 多为 mdpi/hdpi，CSS 像素 = 物理像素 / dpr。
    // 若短边阈值取 600，dpr=1.5 的车机（533）会被漏判成手机形态 → 侧栏再次消失。
    expect(isLargeScreen(1280 / 1.5, 800 / 1.5)).toBe(true)
    expect(isLargeScreen(1280, 800)).toBe(true)
    expect(isLargeScreen(1280 / 2, 800 / 2)).toBe(false) // dpr=2 已属手机/平板高密度屏，纯宽度档接管
    // 车机竖屏 800×1280 物理像素在 dpr=1.5 下是 533×853
    expect(isLargeScreen(800 / 1.5, 1280 / 1.5)).toBe(true)
  })

  it('手机横屏短边最大 448，低于 520，不会与车机混淆', () => {
    for (const [w, h] of [[932, 430], [844, 390], [896, 414], [960, 448]]) {
      expect(isLargeScreen(w, h)).toBe(false)
    }
  })

  it('媒体查询串由常量生成，数字不会与阈值漂移', () => {
    expect(LARGE_SCREEN_QUERY).toContain(`(min-width: ${WIDE_SHELL_MIN_WIDTH}px)`)
    expect(LARGE_SCREEN_QUERY).toContain(`(min-width: ${LARGE_SCREEN_MIN_SIDE}px)`)
    expect(LARGE_SCREEN_QUERY).toContain(`(min-height: ${LARGE_SCREEN_MIN_SIDE}px)`)
    // 逗号 = 媒体查询里的「或」，两档必须并列，否则 800×1280 车机会漏判
    expect(LARGE_SCREEN_QUERY).toContain('), (min-width:')
  })

  it('边界：恰好压线即大屏（与 CSS min-width/min-height 语义一致）', () => {
    expect(isLargeScreen(1024, 300)).toBe(true)
    expect(isLargeScreen(1023, 300)).toBe(false)
    expect(isLargeScreen(520, 520)).toBe(true)
    expect(isLargeScreen(520, 519)).toBe(false)
  })
})