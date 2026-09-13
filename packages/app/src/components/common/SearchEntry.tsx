import { Search } from 'lucide-react'
import { useUIStore } from '@/stores/uiStore'

/**
 * 头部工具栏搜索入口：带固定长度的伪输入框（放大镜 + 占位文案 + 快捷键提示），
 * 点击唤起全局搜索浮层（真实输入在浮层内完成，避免头部与浮层双输入框状态同步）。
 * 各页头部工具栏统一复用，保证入口位置与形态一致。
 */
export function SearchEntry() {
  const setSearchOpen = useUIStore((s) => s.setSearchOpen)
  return (
    <button
      onClick={() => setSearchOpen(true)}
      title="搜索 (⌘K)"
      aria-label="搜索"
      className="search-entry"
    >
      <Search className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.5} />
      <span className="font-text text-[12px] tracking-[-0.12px] whitespace-nowrap">搜索</span>
      <kbd className="search-entry-hint hidden md:inline font-text text-[10px] leading-none whitespace-nowrap">
        ⌘K
      </kbd>
    </button>
  )
}
