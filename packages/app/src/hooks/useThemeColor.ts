import { useEffect, useRef } from 'react'
import { extractColorsFromUrl } from '@/lib/colorExtractor'
import { platform } from '@/services/platform'

/**
 * coverSrcOrPath：在线封面 URL（http/https）或本地 coverPath；
 * 在线 URL 直接使用，本地路径走 platform 协议转换
 */
export function useThemeColor(coverSrcOrPath: string | undefined) {
  const lastPathRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!coverSrcOrPath) {
      document.documentElement.style.removeProperty('--accent-from-color')
      document.documentElement.style.removeProperty('--accent-to-color')
      // 重置 ambient 光晕到默认 Action Blue
      document.documentElement.style.removeProperty('--ambient-from')
      document.documentElement.style.removeProperty('--ambient-to')
      return
    }

    if (coverSrcOrPath === lastPathRef.current) return
    lastPathRef.current = coverSrcOrPath

    const url = /^https?:\/\//i.test(coverSrcOrPath)
      ? coverSrcOrPath
      : platform.getCoverSrc(coverSrcOrPath)

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
  }, [coverSrcOrPath])
}
