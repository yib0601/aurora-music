/**
 * Android 系统栏（状态栏）配色同步。
 *
 * ── 为什么必须显式设置 ──
 * Capacitor 的 StatusBar 插件配置只在 `load()` 时应用一次，且 Android 端的
 * 系统栏默认跟随系统主题：深色播放器下会留下**顶部一道系统浅色条**，
 * 与 app 近黑背景形成割裂（真机截图实测状态栏 #757575、导航栏 #FAFAFA，
 * 而 app 背景是 #0A0A0A）。主题切换后也不会自愈，必须在每次主题变更时同步。
 *
 * ── 语义（容易写反，务必对齐官方定义）──
 *   Style.Light = 浅色图标 → 用于**深色**背景
 *   Style.Dark  = 深色图标 → 用于**浅色**背景
 * 即 style 描述的是**图标颜色**，不是背景明暗。
 *
 * ── Android 15+ 的行为差异 ──
 * targetSdk 35+ 在 Android 15 上强制 edge-to-edge，此时 setBackgroundColor /
 * setOverlaysWebView 会被系统忽略（状态栏透明、WebView 铺满），但 setStyle
 * 仍然有效。因此这里两次调用各自独立 catch，任一失败都不影响另一个。
 *
 * 非 Capacitor 环境（桌面端 / 浏览器预览）下 Capacitor.Plugins 不存在，
 * 直接静默返回，不做任何降级。
 */

const BG_DARK = '#0A0A0A'
const BG_LIGHT = '#F9F8F8'

interface StatusBarPlugin {
  setStyle(options: { style: string }): Promise<void>
  setBackgroundColor(options: { color: string }): Promise<void>
}

function getStatusBar(): StatusBarPlugin | null {
  if (typeof window === 'undefined') return null
  const cap = (window as any).Capacitor
  // 桌面端 bundle 里 Capacitor 也会被注入（见 lib/utils 的 isMobile 注释），
  // 但 electronAPI 存在时系统栏归宿主窗口管，这里不插手
  if ((window as any).electronAPI) return null
  return cap?.Plugins?.StatusBar ?? null
}

/** 按当前主题刷新系统栏；插件不可用时静默跳过 */
export function syncSystemBars(isDark: boolean): void {
  const bar = getStatusBar()
  if (!bar) return
  Promise.resolve()
    .then(() => bar.setStyle({ style: isDark ? 'LIGHT' : 'DARK' }))
    .catch(() => {})
  Promise.resolve()
    .then(() => bar.setBackgroundColor({ color: isDark ? BG_DARK : BG_LIGHT }))
    .catch(() => {})
}
