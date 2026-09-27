import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function generateId(): string {
  return crypto.randomUUID()
}

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronAPI
}

export function isMobile(): boolean {
  // 注意：桌面端 bundle 会静态引入 @capacitor/core（经 platform/mobile 链），
  // 其 IIFE 会把 window.Capacitor 注入到桌面端，因此必须先排除 electronAPI，
  // 否则桌面端会被误判为移动端，导致左侧导航栏被隐藏
  if (typeof window === 'undefined') return false
  if ((window as any).electronAPI) return false
  const cap = (window as any).Capacitor
  if (!cap) return false
  // 纯浏览器环境（vite dev 预览）getPlatform() === 'web'，应使用桌面端布局
  return cap.getPlatform?.() !== 'web'
}

/**
 * 移动端 UI 布局判定：与 isMobile() 同源，另支持 URL 强制切换 ——
 * 桌面浏览器加 `?ui=mobile` / `?ui=desktop` 即可预览对应布局，便于在没有
 * 真机/模拟器时调移动端排版（配合 packages/app/mobile-lab.html）。
 *
 * ⚠️ 只用于「排版分支」，不可拿它做平台能力判断：它不改变 platform 实现的选择，
 * 数据层仍按 Capacitor 真实平台走。更新器 / 文件夹选择 / 权限等功能判定
 * 一律继续用 isMobile()。
 */
export function isMobileUI(): boolean {
  if (typeof window !== 'undefined') {
    try {
      const forced = new URLSearchParams(window.location.search).get('ui')
      if (forced === 'mobile') return true
      if (forced === 'desktop') return false
    } catch {
      // URL 解析异常时回落到真实平台判定
    }
  }
  return isMobile()
}
