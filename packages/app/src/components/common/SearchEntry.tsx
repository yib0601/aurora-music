import { Search } from 'lucide-react'
import { useUIStore } from '@/stores/uiStore'

/**
 * 头部工具栏搜索入口：带固定长度的伪输入框（放大镜 + 占位文案），
 * 点击唤起全局搜索浮层（真实输入在浮层内完成，避免头部与浮层双输入框状态同步）。
 * 各页头部工具栏统一复用，保证入口位置与形态一致。
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
      <span className="font-text text-[13px] tracking-[-0.15px] whitespace-nowrap">搜索</span>
    </button>
  )
}
