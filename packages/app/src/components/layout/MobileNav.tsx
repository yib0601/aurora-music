import { useState } from 'react'
import { Menu, X, Music, Heart, Clock, Search, Settings } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { cn } from '@/lib/utils'

/**
 * 移动端导航：顶部汉堡菜单 + 左侧抽屉
 * - 左上角菜单按钮，点击滑出左侧抽屉（替代底部 BottomTabBar）
 * - 顶栏展示品牌名（页面内容区已有大标题，不重复展示页面标题）
 * - 抽屉含 5 个主导航入口，点击切换路由并关闭抽屉
 * - 遮罩点击关闭；抽屉 glass 材质 + safe-area 适配
 */
const navItems = [
  { to: '/library', icon: Music, label: '音乐库' },
  { to: '/liked', icon: Heart, label: '收藏' },
  { to: '/recent', icon: Clock, label: '最近播放' },
  { to: '/search', icon: Search, label: '搜索' },
  { to: '/settings', icon: Settings, label: '设置' },
]

export function MobileNav() {
  const [open, setOpen] = useState(false)

  return (
    <>
      {/* 顶部栏：左上角菜单按钮 + 当前页面标题 */}
      <header
        className="md:hidden relative z-40 flex items-center gap-2 pl-2 pr-4 h-[calc(3rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]"
        aria-label="顶部导航"
      >
        <button
          onClick={() => setOpen(true)}
          aria-label="打开菜单"
          className="w-10 h-10 flex items-center justify-center rounded-full text-white/80 hover:text-white hover:bg-white/10 active:scale-95 transition"
        >
          <Menu className="h-5 w-5" strokeWidth={1.8} />
        </button>
        {/* 顶栏展示品牌名而非页面标题：页面内容区已有同名大标题，重复展示显得冗余 */}
        <span className="font-display text-[15px] font-semibold text-white/90 tracking-[-0.2px]">
          Aurora
        </span>
      </header>

      {/* 遮罩：点击关闭抽屉 */}
      {open && (
        <div
          className="md:hidden fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        />
      )}

      {/* 左侧抽屉菜单 */}
      <aside
        className={cn(
          'md:hidden fixed top-0 left-0 bottom-0 z-[70] w-[280px] glass-regular flex flex-col transition-transform duration-300 ease-apple border-r border-white/5',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between pl-4 pr-2 h-[calc(3rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] shrink-0">
          <span className="font-display font-semibold text-[16px] text-white/96 tracking-[-0.2px]">
            Aurora Music
          </span>
          <button
            onClick={() => setOpen(false)}
            aria-label="关闭菜单"
            className="w-9 h-9 flex items-center justify-center rounded-full text-white/60 hover:text-white hover:bg-white/10 active:scale-95 transition"
          >
            <X className="h-5 w-5" strokeWidth={1.8} />
          </button>
        </div>

        <nav className="flex flex-col gap-px px-3 mt-2 pb-[env(safe-area-inset-bottom)]">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-3 rounded-xl text-[14px] tracking-[-0.2px] transition-all duration-200',
                  isActive
                    ? 'bg-mint/[0.10] text-mint'
                    : 'text-white/70 hover:text-white hover:bg-white/[0.05]',
                )
              }
            >
              <Icon className="h-5 w-5" strokeWidth={1.6} />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
    </>
  )
}