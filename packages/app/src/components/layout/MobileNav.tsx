import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Menu, X, Heart, Clock, Settings, Link2, Library, Radio } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { NAV_LABEL_KEYS, ROUTES, type NavItem } from '@/lib/routes'
import { PlaylistImportDialog } from '@/components/PlaylistImportDialog'
import { useUIStore } from '@/stores/uiStore'
import { useT } from '@/i18n'

/**
 * 移动端导航：顶部汉堡菜单 + 左侧抽屉（DS 化）
 * - 左上角菜单按钮，点击滑出左侧抽屉（替代底部 BottomTabBar）
 * - 顶栏展示品牌名（页面内容区已有大标题，不重复展示页面标题）
 * - 顶栏右缘是 App 注入的常驻控件插槽（当前为全局搜索入口；设置页不注入）
 * - 抽屉含 5 个主导航入口，点击切换路由并关闭抽屉
 * - 遮罩点击关闭；抽屉 glass 材质 + safe-area 适配
 * - 抽屉开关全局化到 uiStore：App 层的系统返回键处理需要能收起它
 *
 * ⚠️ 本组件**不得再写宽度断点**（原本的 `md:hidden` 已移除）。
 * 是否挂载完全由 App 层的 `{showMobileNav && ...}` 决定，与本组件内部无关。
 * 原因：坐标系不同。车机是像素密度极低的大屏——10 寸车机竖屏常见 1280×800 /
 * 800×1280 像素，电容单位下宽度远超 md(768)。若这里再写 `md:hidden`，App 层按
 * isMobile 挂了组件、组件自己却被宽度断点藏起来，顶部汉堡栏与左侧固定侧栏
 * 会**同时消失**，整个导航入口归零（手机窄屏测不出，车机必现）。
 * 同类教训见 MobileNowPlaying 的同名注释。
 *
 * 视觉取 DS 语言：active 态用 surface 层级 + 1px 发丝描边标识选中，
 * 品牌 mint 收敛为图标强调色，不再整块铺色；圆角走 DS panel 档。
 * 抽屉开关、路由跳转与关闭逻辑一字未改。
 */
/**
 * 主导航表（扁平，无分组标题；与桌面侧栏 Sidebar 同源同顺序，仅样式不同）。
 * 路径一律取 `@/lib/routes` 的常量，不在本文件写路径字面量。
 * 表里存**键**不存译文（理由见 Sidebar 同名注释与 NavItem.labelKey）：
 * 模块级数组存字符串会把语言冻在模块加载那一刻。
 * 顺序与取名理由见 Sidebar 同名注释：音乐库（在线）居首并与主屏一致。
 */
const navItems: NavItem[] = [
  { to: ROUTES.hall, icon: Radio, labelKey: NAV_LABEL_KEYS.hall },
  { to: ROUTES.library, icon: Library, labelKey: NAV_LABEL_KEYS.library },
  { to: ROUTES.liked, icon: Heart, labelKey: 'nav.item.liked' },
  { to: ROUTES.recent, icon: Clock, labelKey: 'nav.item.recent' },
]

/** 独立入口（设置是应用配置，不是内容），与内容项用间距区隔 */
const footerItems: NavItem[] = [{ to: ROUTES.settings, icon: Settings, labelKey: 'nav.item.settings' }]

/**
 * 抽屉导航项样式。抽成一处：内容项与组外项两条渲染路径共用，
 * 内联两份同样的 className 必然漂移（改一处忘另一处 → 选中态不一致）。
 */
const drawerLinkClass = (isActive: boolean, spaced = false) =>
  cn(
    'group flex items-center gap-3 px-3 py-3 rounded-ds-panel text-[14px] tracking-[-0.2px] transition-all duration-200 border',
    spaced && 'mt-3',
    isActive
      ? 'bg-white/[0.07] border-white/[0.10] text-white'
      : 'border-transparent text-white/70 hover:text-white hover:bg-white/[0.05]',
  )

export function MobileNav({ children }: { children?: ReactNode }) {
  const t = useT()
  const open = useUIStore((s) => s.mobileDrawerOpen)
  const setOpen = useUIStore((s) => s.setMobileDrawerOpen)

  // 抽屉开关切换时玻璃降级：glass-regular 抽屉 300ms 滑动时，模糊区域背后的
  // 内容每帧变化，软件渲染下每帧重算模糊会掉帧；滑动期间临时关闭玻璃模糊
  //（复用 .glass-perf-lite），动画结束后恢复。挂在 open 变化上，汉堡按钮、
  // 遮罩点击与系统返回键三种触发源统一覆盖
  const prevOpen = useRef(open)
  useEffect(() => {
    if (prevOpen.current === open) return
    prevOpen.current = open
    document.documentElement.classList.add('glass-perf-lite')
    const t = setTimeout(() => {
      document.documentElement.classList.remove('glass-perf-lite')
    }, 350)
    return () => clearTimeout(t)
  }, [open])
  const [showImportDialog, setShowImportDialog] = useState(false)

  return (
    <>
      {/* 顶部栏：左上角菜单按钮 + 当前页面标题 */}
      <header
        className="relative z-40 flex items-center gap-2 pl-2 pr-4 h-[calc(3rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]"
        aria-label={t('shell.nav.topBar')}
      >
        <button
          onClick={() => setOpen(true)}
          aria-label={t('shell.nav.openMenu')}
          className="w-10 h-10 flex items-center justify-center rounded-full text-white/80 hover:text-white hover:bg-white/10 active:scale-95 transition"
        >
          <Menu className="h-5 w-5" strokeWidth={1.8} />
        </button>
        {/* 顶栏展示品牌名而非页面标题：页面内容区已有同名大标题，重复展示显得冗余 */}
        <span className="font-display text-[15px] font-semibold text-white/[0.90] tracking-[-0.2px]">
          {t('nav.brand.name')}
        </span>
        {/* 右侧：App 注入的常驻控件（全局搜索入口；设置页不注入则为空）。
            ml-auto 把它推到右缘，与汉堡按钮分列两端，中间留出拖拽/点击空白 */}
        {children && <div className="ml-auto flex items-center">{children}</div>}
      </header>

      {/* 遮罩：点击关闭抽屉 */}
      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        />
      )}

      {/* 左侧抽屉菜单 */}
      <aside
        className={cn(
          'fixed top-0 left-0 bottom-0 z-[70] w-[280px] glass-regular glass-flush-top flex flex-col transition-transform duration-300 ease-apple border-r border-white/5',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between pl-4 pr-2 h-[calc(3rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] shrink-0">
          <span className="font-display font-semibold text-[16px] text-white/[0.96] tracking-[-0.2px]">
            {t('shell.brand.full')}
          </span>
          <button
            onClick={() => setOpen(false)}
            aria-label={t('shell.nav.closeMenu')}
            className="w-9 h-9 flex items-center justify-center rounded-full text-white/60 hover:text-white hover:bg-white/10 active:scale-95 transition"
          >
            <X className="h-5 w-5" strokeWidth={1.8} />
          </button>
        </div>

        <nav className="flex flex-col gap-px px-3 mt-2 pb-[env(safe-area-inset-bottom)]">
          {navItems.map(({ to, icon: Icon, labelKey }) => (
            <NavLink key={to} to={to} onClick={() => setOpen(false)} className={({ isActive }) => drawerLinkClass(isActive)}>
              <Icon className="h-5 w-5 group-aria-[current=page]:text-mint" strokeWidth={1.6} />
              {t(labelKey)}
            </NavLink>
          ))}
          {footerItems.map(({ to, icon: Icon, labelKey }) => (
            <NavLink key={to} to={to} onClick={() => setOpen(false)} className={({ isActive }) => drawerLinkClass(isActive, true)}>
              <Icon className="h-5 w-5 group-aria-[current=page]:text-mint" strokeWidth={1.6} />
              {t(labelKey)}
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setShowImportDialog(true)
            }}
            className="flex items-center gap-3 px-3 py-3 rounded-ds-panel text-[14px] tracking-[-0.2px] text-white/70 hover:text-white hover:bg-white/[0.05] transition-all duration-200 text-left"
          >
            <Link2 className="h-5 w-5" strokeWidth={1.6} />
            {t('shell.playlist.importLink')}
          </button>
        </nav>
      </aside>

      <PlaylistImportDialog open={showImportDialog} onOpenChange={setShowImportDialog} />
    </>
  )
}