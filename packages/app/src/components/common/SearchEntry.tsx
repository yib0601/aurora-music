import { Search } from 'lucide-react'
import { useUIStore } from '@/stores/uiStore'

/**
 * 全局搜索入口：带固定长度的伪输入框（放大镜 + 占位文案），
 * 点击唤起全局搜索浮层（真实输入在浮层内完成，避免顶栏与浮层双输入框状态同步）。
 *
 * 位置由 App 层统一装配在**应用顶栏**上，三种外壳形态各取其一：
 * 桌面标题栏（TitleBar 插槽）/ 窄档移动端顶栏（MobileNav 插槽）/
 * 无窗口控制时的浮层顶栏。因此本组件自身不带定位与外边距，
 * 各页面的头部工具栏**不再**放置它（避免同一入口出现两处）。
 * 设置页不注入（配置页不提供搜索）。
 * 框内不展示快捷键提示：⌘/Ctrl+K 仍由 App 层全局监听，只是不占输入框空间。
 */
export function SearchEntry() {
  const setSearchOpen = useUIStore((s) => s.setSearchOpen)
  return (
    <button
      onClick={() => setSearchOpen(true)}
      title="搜索"
      aria-label="搜索"
      className="search-entry"
    >
      <Search className="h-4 w-4 flex-shrink-0" strokeWidth={1.5} />
      {/* 占位写明搜索范围（歌曲/歌手/专辑），比单字「搜索」更能说明这个框能做什么；
          小屏由 .search-entry 媒体查询隐藏文字只留放大镜 */}
      <span className="search-entry-label font-text text-[13px] tracking-[-0.15px] whitespace-nowrap">
        搜索歌曲、歌手、专辑
      </span>
    </button>
  )
}
