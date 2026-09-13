import { create } from 'zustand'

interface UIState {
  /** 全局搜索浮层开关：由各页头部工具栏搜索按钮与 ⌘/Ctrl+K 唤起，App 层统一渲染浮层 */
  searchOpen: boolean
  setSearchOpen: (open: boolean) => void
  /** 移动端左侧导航抽屉开关（全局化：MobileNav 渲染，系统返回键也需关闭它） */
  mobileDrawerOpen: boolean
  setMobileDrawerOpen: (open: boolean) => void
}

export const useUIStore = create<UIState>((set) => ({
  searchOpen: false,
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  mobileDrawerOpen: false,
  setMobileDrawerOpen: (mobileDrawerOpen) => set({ mobileDrawerOpen }),
}))
