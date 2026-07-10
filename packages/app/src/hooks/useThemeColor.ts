import { useEffect, useRef } from 'react'
import { extractColorsFromUrl } from '@/lib/colorExtractor'

export function useThemeColor(coverPath: string | undefined) {
  const lastPathRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!coverPath) {
      document.documentElement.style.removeProperty('--accent-from-color')
      document.documentElement.style.removeProperty('--accent-to-color')
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
      root.style.setProperty('--accent-from-color', `rgba(${colors.primary.r},${colors.primary.g},${colors.primary.b},0.18)`)
      root.style.setProperty('--accent-to-color', `rgba(${colors.secondary.r},${colors.secondary.g},${colors.secondary.b},0.1)`)
    })
  }, [coverPath])
}
