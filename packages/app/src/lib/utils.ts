import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { platform } from '@/services/platform'
import type { Track } from '@/types'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 获取曲目封面图片 src：在线歌直接用 coverUrl，本地歌走 platform 协议转换
 */
export function getTrackCoverSrc(track: Track | null | undefined): string | null {
  if (!track) return null
  if (track.coverUrl) return track.coverUrl
  if (track.coverPath) return platform.getCoverSrc(track.coverPath)
  return null
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
