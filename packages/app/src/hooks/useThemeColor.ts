import { useEffect, useRef } from 'react'
import { extractColorsFromUrl } from '@/lib/colorExtractor'

export function useThemeColor(coverPath: string | undefined) {
  const lastPathRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!coverPath) {
      document.documentElement.style.removeProperty('--accent-from-color')
      document.documentElement.style.removeProperty('--accent-to-color')
      // 重置 ambient 光晕到默认 Action Blue
      document.documentElement.style.removeProperty('--ambient-from')
      document.documentElement.style.removeProperty('--ambient-to')
      return
    }

    if (coverPath === lastPathRef.current) return
    lastPathRef.current = coverPath

    const url = (window as any).Capacitor
      ? (window as any).Capacitor.convertFileSrc(coverPath)
      : (window as any).electronAPI
        ? `file://${coverPath}`
        : coverPath

    extractColorsFromUrl(url).then((colors) => {
      if (!colors) return
      const root = document.documentElement
      // 保留原 accent 变量（lyrics 等场景使用）
      root.style.setProperty('--accent-from-color', `rgba(${colors.primary.r},${colors.primary.g},${colors.primary.b},0.18)`)
      root.style.setProperty('--accent-to-color', `rgba(${colors.secondary.r},${colors.secondary.g},${colors.secondary.b},0.1)`)
      // 同时驱动 ambient-backdrop 光晕，让 Liquid Glass 折射出当前封面的色调
      root.style.setProperty('--ambient-from', `rgba(${colors.primary.r},${colors.primary.g},${colors.primary.b},0.14)`)
      root.style.setProperty('--ambient-to', `rgba(${colors.secondary.r},${colors.secondary.g},${colors.secondary.b},0.08)`)
    })
  }, [coverPath])
}
