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
  /** 我的音乐（本地曲库） */
  library: '/library',
  /** 音乐库：推荐歌单 + 排行榜（在线发现入口，应用第一屏） */
  hall: '/hall',
  liked: '/liked',
  recent: '/recent',
  settings: '/settings',
} as const

/**
 * 两个音乐页的用户可见名称：导航 label、页面标题、空态按钮与各处内嵌文案共用这两处。
 *
 * 命名轴是**所有权/来源**：
 * - 我的音乐 = 用户自己扫描入库的本地/WebDAV 资产，长期有效、离线可播
 * - 音乐库 = 由音源服务实时提供的推荐与榜单，即点即播、不入库（在线内容的第一屏）
 *
 * 名称沿革（三度调整，改名前先读完这段）：
 *   1. 「音乐库 / 音乐馆」——同词根 + 同「盛放音乐的容器」语义，只差一个字，
 *      用户反馈「分不清哪个是做什么的」，遂改为下一版；
 *   2. 「我的音乐 / 在线音乐」+「我的 / 在线」分组——语义清楚，但分组标题冗余，
 *      且用户希望在线内容排第一；
 *   3. 当前版：「音乐库」指在线发现页（排第一位、作为主屏），本地页保留「我的音乐」，
 *      取消分组标题。注意**「音乐库」这个名字的归属换过一次**
 *      （上一版它是本地页名），读旧注释/旧文档时勿按字面理解。
 *
 * ⚠️ 「在线音乐」仍是既有**来源泛称**，用于 `SearchOverlay` 的来源徽章兜底名与结果分组名、
 * `SongDetailPage` 的来源标签（`'在线音乐' : '本地'`）。那是「曲目来自哪个源」的标签，
 * 与页面名不是一层语义，故不随页面改名而动。
 *
 * 注意 `LIBRARY_LABEL` 是**页面名**，不能代入「构建你的专属 X」一类修饰句
 * （「专属我的音乐」不通）；那类文案改用「曲库」这个普通名词。
 */
export const LIBRARY_LABEL = '我的音乐'

/** 音乐库页（在线推荐歌单 + 排行榜）的用户可见名称，标识符仍沿用 MusicHall* */
export const HALL_LABEL = '音乐库'

/** 我的音乐页的路由：从各处跳回「本地曲库」用它，不要用 HOME_ROUTE（主屏已换到音乐库） */
export const LIBRARY_ROUTE = ROUTES.library

/**
 * 应用主屏：冷启动落地页、返回兜底目标、移动端「再按一次退出」的主屏判定都用它。
 *
 * 主屏是**音乐库**（在线推荐 + 排行榜），它是导航第一项，也与「第一位即主屏」的产品决定一致。
 * 注意主屏 ≠ 常驻挂载页：后者固定是我的音乐（见 KEEP_ALIVE_ROUTE），两者已解耦。
 *
 * 代价（已知并接受）：无音源 / 断网 / 浏览器版无在线能力时，冷启动首屏是引导空态而非内容。
 */
export const HOME_ROUTE = ROUTES.hall

/**
 * 唯一**常驻挂载**的页面：离开它时用 `visibility` 隐藏而非卸载，保留布局尺寸与
 * 滚动位置（虚拟列表不会因容器归零而停摆，返回时零重建）。
 * 其他页面一律按需挂载 —— 两个虚拟列表同时常驻会让内存与 ResizeObserver 翻倍。
 *
 * 固定为我的音乐（本地曲库）：它是唯一持有「数千行虚拟列表」的重页面，
 * 常驻收益只在它身上成立。主屏换成音乐库后本值**不变**，两者不要合并。
 */
export const KEEP_ALIVE_ROUTE = ROUTES.library

/** 带动态段的页面路径：react-router 的 `<Route path>` 与下方 isRoute 判定共用 */
export const ROUTE_PATHS = {
  /** 歌曲详情：沉浸式视图（隐藏侧栏与右侧瓷砖） */
  songDetail: '/song/:id',
  playlist: '/playlist/:id',
  /** 在线音乐 · 推荐歌单详情（dataId 形如 `diss-<歌单号>`） */
  hallPlaylist: `${ROUTES.hall}/playlist/:id`,
  /** 在线音乐 · 榜单详情（id 为榜单 topId） */
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

/**
 * 导航分组：组标题 + 组内条目。
 *
 * 分组的价值在于把「从哪来」这层语义画出来，否则用户只能靠名字猜
 * （见本文件 LIBRARY_LABEL 处对「音乐库 / 音乐馆」命名缺陷的说明）。
 * 组标题是**分区标签**，不要与组内项名逐字重复。
 */
export interface NavGroup {
  title: string
  items: NavItem[]
}