import { create } from 'zustand'

interface UIState {
  /** 全局搜索浮层开关：由各页头部工具栏搜索按钮与 ⌘/Ctrl+K 唤起，App 层统一渲染浮层 */
  searchOpen: boolean
  setSearchOpen: (open: boolean) => void
}

export const useUIStore = create<UIState>((set) => ({
  searchOpen: false,
  setSearchOpen: (searchOpen) => set({ searchOpen }),
}))
