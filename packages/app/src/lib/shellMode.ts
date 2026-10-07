/**
 * 外壳结构分档：应用外壳（左侧导航栏 + 右侧封面瓷砖）按**屏幕尺寸**决定形态，
 * 不按平台名。车机是这条规则最典型的反例——10 寸车机竖屏常见 1280×800 /
 * 800×1280 像素，Capacitor 报 mobile，但不管横竖都比手机大得多：
 *   旧实现里顶部汉堡栏被自己的 `md:hidden` 吃掉、固定侧栏又被 `!mobile` 挡掉，
 *   两者同时消失 → 竖屏车机上整个导航入口归零。
 *
 * 判据为什么必须是「两个维度」而不是单纯宽度：
 *   手机横屏 844×390 与车机竖屏 800×1280，宽度只差 44px，靠宽度分不开；
 *   而短边 390 vs 800 一眼可辨。故取「宽高都 ≥520」或「宽 ≥1024」为「大屏」。
 *   大屏恒用固定侧栏（车机是常驻安装、纯触屏、无窗口管理的场景，常驻侧栏
 *   比汉堡抽屉更合适）；手机形态（至少一边 < 520）才用汉堡 + 抽屉。
 *
 * 短边阈值为什么是 520 而不是更大的值——**必须按 CSS 像素而非物理像素算**：
 *   10 寸车机常见 1280×800 物理像素，但车机 density 多为 mdpi/hdpi，
 *   CSS 像素要除以 dpr：dpr=1 → 1280×800；dpr=1.5 → 853×533。
 *   若把阈值定在 600，dpr=1.5 的车机会落到 533 而漏判成手机形态。
 *   取 520：车机 dpr≤1.54 均命中，同时仍高于任何手机横屏的短边
 *   （手机横屏短边最大约 448），手机横屏不会被误判成车机。
 *
 * 纯函数、无 React 依赖，边界由单测锁死。
 */

/** 固定侧栏的启用阈值（宽）：与右侧封面瓷砖的 `hidden lg:block` 同档，
 *  否则 768–1023 区间会出现「左栏走固定侧栏、右瓷砖仍按视口断点隐藏」的参差外壳。 */
export const WIDE_SHELL_MIN_WIDTH = 1024

/** 「大屏」短边阈值（CSS 像素）：低于此值即视为手机形态。
 *  520 高于所有手机横屏短边（≤448），低于车机 dpr≤1.54 时的短边（如 533）。 */
export const LARGE_SCREEN_MIN_SIDE = 520

/** 运行时媒体查询串（单一事实源：由上面两个常量生成，避免数字漂移）。
 *  逗号在媒体查询里是「或」：宽够 或 宽高都够。 */
export const LARGE_SCREEN_QUERY =
  `(min-width: ${WIDE_SHELL_MIN_WIDTH}px), ` +
  `(min-width: ${LARGE_SCREEN_MIN_SIDE}px) and (min-height: ${LARGE_SCREEN_MIN_SIDE}px)`

export type ShellMode = 'wide' | 'drawer'

/** 是否大屏（与 LARGE_SCREEN_QUERY 语义逐字对应） */
export function isLargeScreen(w: number, h: number): boolean {
  return w >= WIDE_SHELL_MIN_WIDTH || (w >= LARGE_SCREEN_MIN_SIDE && h >= LARGE_SCREEN_MIN_SIDE)
}

/**
 * 解析外壳形态。
 * - 桌面（非 mobile）恒为 `wide`：桌面端窄窗口宁可挤，也不切成抽屉——TitleBar /
 *   窗口缩放手柄 / 菜单等桌面外壳元素全按 `wide` 布局，中途切换会撕裂外壳。
 * - 移动端：大屏（车机横竖屏、平板）走 `wide`，与桌面同构；手机形态才用抽屉。
 */
export function resolveShellMode(input: { mobile: boolean; largeScreen: boolean }): ShellMode {
  if (!input.mobile) return 'wide'
  return input.largeScreen ? 'wide' : 'drawer'
}