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
  return typeof window !== 'undefined' && !(window as any).electronAPI && !!(window as any).Capacitor
}
