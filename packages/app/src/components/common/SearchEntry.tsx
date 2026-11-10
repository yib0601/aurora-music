import { Search } from 'lucide-react'
import { useUIStore } from '@/stores/uiStore'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'

/**
 * 全局搜索入口：带固定长度的伪输入框（放大镜 + 占位文案），
 * 点击唤起全局搜索浮层（真实输入在浮层内完成，避免顶栏与浮层双输入框状态同步）。
 *
 * 位置由 App 层统一装配，两处互斥：
 * - 宽档：窗口顶部工具带左端（与页面大标题同轴；高度档固定 44、宽度自适应，
 *   由 App 按带子实测宽度经 `--top-search-w` 下发，见 globals.css 的
 *   `.search-entry-compact` —— 带子里还有 30px 的窗口控制按钮与更新胶囊，
 *   高度必须落在同一网格上）
 * - 窄档手机：MobileNav 顶栏右缘（自然宽度，<640px 退化成 36px 图标按钮）
 * 因此本组件自身不带定位与外边距；各页面的头部工具栏**不再**放置它
 * （避免同一入口出现两处）。设置页不注入（配置页不提供搜索）。
 * 框内右端展示快捷键键帽（⌘K / Ctrl K）：⌘/Ctrl+K 由 App 层全局监听，
 * 这里只是把它显性化 —— 文案只填满入口左半，胶囊右半会空出一大片，
 * 键帽同时承担「支住构图」和「告诉用户有快捷键」两件事。
 * 仅桌面档展示，窄窗收成图标钮时由 globals.css 的媒体查询隐藏
 * （手机上既没有物理修饰键，44px 的方钮也塞不下）。
 *
 * 文案在渲染期取（`useT`）：语言切换时这个常驻顶栏组件必须跟着变，
 * 所以键存在 `search.entry` 里而不是写成常量。
 */
/** 键帽上的修饰键：与 App 层监听（`metaKey || ctrlKey`）保持同一套习惯写法。
 *  app 内没有同步的系统判定（getSystemInfo 是异步 IPC），这里直接看 UA ——
 *  只影响键帽画什么字，不影响真实快捷键是否可用。 */
const SHORTCUT_LABEL = /Mac|iPhone|iPad|iPod/.test(
  typeof navigator === 'undefined' ? '' : navigator.userAgent,
)
  ? '⌘K'
  : 'Ctrl K'

export function SearchEntry({ className }: { className?: string }) {
  const setSearchOpen = useUIStore((s) => s.setSearchOpen)
  const t = useT()
  return (
    <button
      onClick={() => setSearchOpen(true)}
      title={t('common.action.search')}
      aria-label={t('common.action.search')}
      className={cn('search-entry glass-control', className)}
    >
      {/* 图标与文字的字号/尺寸一律由 .search-entry / .search-entry-compact 给
          （见 globals.css）：这两个 css 类在同一层里能互相覆盖，而写在这里的
          Tailwind 尺寸类在 utilities 层，会把 compact 档的字号/图标一起钉死成 md 档规格 */}
      <Search className="search-entry-icon flex-shrink-0" strokeWidth={1.5} />
      {/* 占位写明搜索范围（歌曲/歌手/专辑），比单字「搜索」更能说明这个框能做什么；
          小屏由 .search-entry 媒体查询隐藏文字只留放大镜 */}
      <span className="search-entry-label font-text tracking-[-0.15px] whitespace-nowrap">
        {t('search.entry.placeholder')}
      </span>
      {/* aria-hidden：键帽是视觉提示，不该并进按钮的可访问名（否则读屏会念成
          「搜索 歌曲、歌手、专辑 Ctrl K」） */}
      <kbd className="search-entry-kbd" aria-hidden>
        {SHORTCUT_LABEL}
      </kbd>
    </button>
  )
}
