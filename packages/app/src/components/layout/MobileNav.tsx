import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Menu, X, Heart, Clock, Settings, ListMusic, Link2, Plus, Library, Radio } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { NAV_LABEL_KEYS, ROUTES, ROUTE_BUILDERS, visibleNavItems, type NavItem } from '@/lib/routes'
import { useHallAvailable } from '@/hooks/useHallAvailability'
import { useLikedDisplayCount } from '@/hooks/useLikedDisplayCount'
import { PlaylistImportDialog } from '@/components/PlaylistImportDialog'
import { CreatePlaylistDialog } from '@/components/layout/CreatePlaylistDialog'
import { usePlaylistStore } from '@/stores/playlistStore'
import { useUIStore } from '@/stores/uiStore'
import { useT } from '@/i18n'
import { BrandMark } from '@/components/common/BrandMark'

/**
 * 移动端导航：顶部汉堡菜单 + 左侧抽屉（DS 化）
 * - 左上角菜单按钮，点击滑出左侧抽屉（替代底部 BottomTabBar）
 * - 顶栏展示品牌名（页面内容区已有大标题，不重复展示页面标题）
 * - 顶栏右缘是 App 注入的常驻控件插槽（当前为全局搜索入口；设置页不注入）
 * - 抽屉含 3 个内容导航入口（音乐库 / 我的音乐 / 最近播放）+ 设置 + 歌单分组
 *   （分组第一行是系统歌单「收藏」，其下是自建歌单列表，分组标题右侧可新建歌单；
 *    这些入口点击后都先收起抽屉再切路由 / 开对话框）
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
 * 这张表也是全量表：没有可用音源时「音乐库」要隐藏，过滤与侧栏同源
 * （`visibleNavItems`）——两张表各写一份判断，移动端与桌面端迟早给出不同答案。
 *
 * 「收藏」**不在这张表里**，与桌面侧栏完全一致：它是系统歌单，固定渲染在下方
 * 歌单分组的第一行（路由仍走 `ROUTES.liked`，计数见 `useLikedDisplayCount`）。
 * 两张表因此可以逐项对照，不再有「同一项在移动端算导航、在桌面算歌单」的分叉。
 */
const navItems: NavItem[] = [
  { to: ROUTES.hall, icon: Radio, labelKey: NAV_LABEL_KEYS.hall },
  { to: ROUTES.library, icon: Library, labelKey: NAV_LABEL_KEYS.library },
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
      ? 'bg-mint/[0.09] border-mint/[0.12] text-white'
      : 'border-transparent text-white/65 hover:text-white hover:bg-white/[0.045]',
  )

export function MobileNav({ children }: { children?: ReactNode }) {
  const t = useT()
  // 没有可用音源时抽屉里不出现「音乐库」：点进去只有引导空态，
  // 抽屉第一项就是它，会让人以为整个应用没内容（判定见 lib/hallAvailability.ts）
  const hallAvailable = useHallAvailable()
  const items = visibleNavItems(navItems, hallAvailable)
  const open = useUIStore((s) => s.mobileDrawerOpen)
  const setOpen = useUIStore((s) => s.setMobileDrawerOpen)
  // 抽屉里的歌单分组与桌面侧栏读同一份 store：两处各持一份必然漂移
  const playlists = usePlaylistStore((s) => s.playlists)
  // 系统歌单「收藏」的条数：去重后的展示行数，与收藏页同一口径（见 useLikedDisplayCount）
  const likedCount = useLikedDisplayCount()

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
  const [showCreateDialog, setShowCreateDialog] = useState(false)

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
        <span className="flex items-center gap-2">
          <BrandMark className="h-7 w-7" />
          <span className="font-display text-[15px] font-semibold text-white/[0.90] tracking-[-0.2px]">
            {t('nav.brand.name')}
          </span>
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

        <nav className="flex flex-col gap-px px-3 mt-2 shrink-0">
          {items.map(({ to, icon: Icon, labelKey }) => (
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
        </nav>

        {/*
          歌单分组：与桌面侧栏同构——分组标题与系统歌单「收藏」固定，只有自建歌单
          列表滚动。抽屉只有 280px 宽，歌单多时整块必须能被压缩（flex-1 + min-h-0），
          否则列表会把这上面的主导航和下面的「导入歌单」一起顶出屏幕外。
        */}
        <div className="mt-3 flex-1 flex flex-col min-h-0 px-3">
          <div className="flex items-center justify-between px-3 py-1.5 shrink-0">
            <span className="font-text text-[11px] font-semibold text-white/65 uppercase tracking-wider">
              {t('nav.item.playlists')}
            </span>
            {/*
              新建歌单：位置与语义对齐桌面侧栏（分组标题右侧的 +）。
              必须先 setOpen(false) 再开对话框——抽屉是 z-[70]，Dialog 的遮罩/内容是
              z-50，抽屉不收起的话弹窗会被压在抽屉底下（导入入口同理）。
            */}
            <button
              type="button"
              className="btn-icon"
              onClick={() => {
                setOpen(false)
                setShowCreateDialog(true)
              }}
              title={t('shell.playlist.create')}
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
          </div>
          {/*
            系统歌单「收藏」：不是 playlistStore 里的 Playlist——不能改名/删除，路由仍是 /liked。
            它参与同步，但用的是另一套记录（每首歌一条、逐条裁决，见 docs/playlist-sync.md §5.1）。
            计数是去重后的展示行数（见 useLikedDisplayCount），与收藏页实际行数同源。
            行高/字号走本抽屉的 drawerLinkClass。
          */}
          <NavLink
            to={ROUTES.liked}
            onClick={() => setOpen(false)}
            className={({ isActive }) => cn(drawerLinkClass(isActive), 'min-w-0 shrink-0')}
          >
            <Heart className="h-5 w-5 shrink-0 group-aria-[current=page]:text-mint" strokeWidth={1.6} />
            <span className="truncate">{t('nav.item.liked')}</span>
            <span className="text-[11px] text-white/65 ml-auto tabular-nums font-semibold">
              {likedCount}
            </span>
          </NavLink>
          {/* 自建歌单：抽屉里**唯一**滚动的区域 */}
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin flex flex-col gap-px">
            {playlists.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-white/65 leading-relaxed">{t('shell.playlist.empty')}</p>
            ) : (
              playlists.map((pl) => (
                <NavLink
                  key={pl.id}
                  to={ROUTE_BUILDERS.playlist(pl.id)}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) => cn(drawerLinkClass(isActive), 'min-w-0')}
                >
                  <ListMusic className="h-5 w-5 shrink-0 group-aria-[current=page]:text-mint" strokeWidth={1.6} />
                  <span className="truncate">{pl.name}</span>
                  <span className="text-[11px] text-white/65 ml-auto tabular-nums font-semibold">
                    {pl.trackIds.length}
                  </span>
                </NavLink>
              ))
            )}
          </div>
        </div>

        {/* 导入歌单：固定在抽屉底部（不随歌单列表滚动），safe-area 内边距挂在这里 */}
        <div className="mt-3 px-3 pb-[env(safe-area-inset-bottom)] shrink-0">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setShowImportDialog(true)
            }}
            className="w-full flex items-center gap-3 px-3 py-3 rounded-ds-panel text-[14px] tracking-[-0.2px] text-white/70 hover:text-white hover:bg-white/[0.05] transition-all duration-200 text-left"
          >
            <Link2 className="h-5 w-5" strokeWidth={1.6} />
            {t('shell.playlist.importLink')}
          </button>
        </div>
      </aside>

      <PlaylistImportDialog open={showImportDialog} onOpenChange={setShowImportDialog} />
      {/* 新建歌单：与桌面侧栏共用同一份对话框（见 CreatePlaylistDialog） */}
      <CreatePlaylistDialog open={showCreateDialog} onOpenChange={setShowCreateDialog} />
    </>
  )
}