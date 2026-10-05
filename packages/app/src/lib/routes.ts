/**
 * 路由路径的**唯一事实源**。
 *
 * 背景：路径字面量此前散落在 12 处（App 的返回键分层、主屏判定与常驻挂载判定、
 * 两处导航表、各页空态按钮与跳转、useGoBack 兜底）。改一次路径要全仓搜字符串，
 * 且「哪些页面算主屏」「哪些页面常驻挂载」这类**语义**没有落点，只能靠读字符串猜。
 *
 * 约定：
 * - 跳转与判定一律走本文件的常量/构造器/匹配函数，组件里不再出现裸路径字面量；
 * - 动态段（:id）只在这里拼，调用方不写模板字符串；
 * - 路径值本身仍是字符串（react-router 的要求），改路径只改本文件。
 */

import type { LucideIcon } from 'lucide-react'

/** 页面路径（静态段） */
export const ROUTES = {
  root: '/',
  /** 本地音乐（曲库）：应用默认主屏 */
  library: '/library',
  /** 音乐馆：推荐歌单 + 排行榜（在线发现入口） */
  hall: '/hall',
  liked: '/liked',
  recent: '/recent',
  settings: '/settings',
} as const

/**
 * 应用主屏：冷启动落地页、返回兜底目标、移动端「再按一次退出」的主屏判定都用它。
 *
 * 主屏是**本地音乐**而非音乐馆：用户自己扫描入库的曲库是长期资产，
 * 音乐馆是发现入口，冷启动应落在自己的资产上。
 */
export const HOME_ROUTE = ROUTES.library

/**
 * 唯一**常驻挂载**的页面：离开它时用 `visibility` 隐藏而非卸载，保留布局尺寸与
 * 滚动位置（虚拟列表不会因容器归零而停摆，返回时零重建）。
 * 其他页面一律按需挂载 —— 两个虚拟列表同时常驻会让内存与 ResizeObserver 翻倍。
 */
export const KEEP_ALIVE_ROUTE = ROUTES.library

/** 带动态段的页面路径：react-router 的 `<Route path>` 与下方 isRoute 判定共用 */
export const ROUTE_PATHS = {
  /** 歌曲详情：沉浸式视图（隐藏侧栏与右侧瓷砖） */
  songDetail: '/song/:id',
  playlist: '/playlist/:id',
  /** 音乐馆 · 推荐歌单详情（dataId 形如 `diss-<歌单号>`） */
  hallPlaylist: `${ROUTES.hall}/playlist/:id`,
  /** 音乐馆 · 榜单详情（id 为榜单 topId） */
  hallToplist: `${ROUTES.hall}/toplist/:id`,
} as const

/** 动态路径构造器：拼参数只在这里做 */
export const ROUTE_BUILDERS = {
  songDetail: (id: string) => `/song/${id}`,
  playlist: (id: string) => `/playlist/${id}`,
  hallPlaylist: (id: string) => `${ROUTES.hall}/playlist/${id}`,
  hallToplist: (id: string) => `${ROUTES.hall}/toplist/${id}`,
}

/**
 * 判定当前路径是否命中某个路由模式（支持 `:param` 段）。
 *
 * 替代手写的 `pathname.startsWith('/song/')` 一类字面量判断：段数必须完全一致，
 * 避免 `/hall/playlist/x/y` 这类多余层级被误判命中。
 */
export function isRoute(pattern: string, pathname: string): boolean {
  const patternSegs = pattern.split('/').filter(Boolean)
  const pathSegs = pathname.split('/').filter(Boolean)
  if (patternSegs.length !== pathSegs.length) return false
  return patternSegs.every((seg, i) => (seg.startsWith(':') ? pathSegs[i].length > 0 : seg === pathSegs[i]))
}

/** 导航条目：两处导航表（侧栏 / 移动端抽屉）共用同一份形状 */
export interface NavItem {
  to: string
  /** lucide 图标组件（不可写成自定的 {className,strokeWidth} 窄类型：strokeWidth 允许 string | number） */
  icon: LucideIcon
  label: string
}