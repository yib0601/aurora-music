import { useEffect, useRef } from 'react'
import { extractColorsFromUrl } from '@/lib/colorExtractor'
import { platform } from '@/services/platform'

/** 把 8bit 通道值压到合法的 0-255 范围 */
const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)))

/**
 * 由提取色推导出一组「色场」用色。
 *
 * 为什么不直接拿封面原色：
 * 封面主色可能是低饱和的灰（人像、黑白专辑），直接铺上去背景仍是灰的，
 * 玻璃又变成折射一片死灰 —— 这正是改造前 8% 透明度的老问题。
 * 所以这里做两件事：
 *   1. 提饱和度：把颜色往「离灰轴更远」的方向推，保证背景有色相可折射；
 *   2. 保证亮度下限：过暗的主色（深棕、墨绿）会让整个背景沉下去。
 * 参考站极光用的 #1A3870 / #2D5F9E / #4A8AC4 正是「中低亮度 + 中高饱和」的蓝，
 * 这里用同样的取值区间，只是色相跟随封面。
 */
function toFieldColor(
  r: number, g: number, b: number,
  alpha: number,
  { satBoost = 1.35, minLum = 46 }: { satBoost?: number; minLum?: number } = {},
): string {
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  // 提饱和：以亮度为轴向外扩张，越接近灰的颜色被推得越远
  let nr = lum + (r - lum) * satBoost
  let ng = lum + (g - lum) * satBoost
  let nb = lum + (b - lum) * satBoost
  // 提亮度下限：避免深色封面把背景基调压死
  const newLum = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb
  if (newLum < minLum && newLum > 0.5) {
    const k = minLum / newLum
    nr *= k; ng *= k; nb *= k
  }
  return `rgba(${clamp(nr)},${clamp(ng)},${clamp(nb)},${alpha})`
}

export function useThemeColor(coverPath: string | undefined) {
  const lastPathRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!coverPath) {
      document.documentElement.style.removeProperty('--accent-from-color')
      document.documentElement.style.removeProperty('--accent-to-color')
      // 回到 CSS 里声明的默认色场（品牌 mint + 深蓝）
      document.documentElement.style.removeProperty('--ambient-from')
      document.documentElement.style.removeProperty('--ambient-to')
      document.documentElement.style.removeProperty('--ambient-glow')
      return
    }

    if (coverPath === lastPathRef.current) return
    lastPathRef.current = coverPath

    // 远端封面（在线曲目）直接用 https 地址，本地路径才走 cover-local 协议
    const url = /^https?:\/\//i.test(coverPath) ? coverPath : platform.getCoverSrc(coverPath)

    extractColorsFromUrl(url).then((colors) => {
      if (!colors) return
      const root = document.documentElement
      const { primary, secondary } = colors

      // 保留原 accent 变量（lyrics 等场景使用）
      root.style.setProperty('--accent-from-color', `rgba(${primary.r},${primary.g},${primary.b},0.18)`)
      root.style.setProperty('--accent-to-color', `rgba(${secondary.r},${secondary.g},${secondary.b},0.1)`)

      // 驱动 ambient 色场。不透明度必须与 CSS 默认值同量级（.50/.62/.48），
      // 否则「有封面」时背景反而比「无封面」更暗，玻璃通透感会随播放消失。
      root.style.setProperty('--ambient-from', toFieldColor(primary.r, primary.g, primary.b, 0.50))
      root.style.setProperty('--ambient-to', toFieldColor(secondary.r, secondary.g, secondary.b, 0.62))
      // 第三色斑取主副色混合，避免与另两个色斑色相冲突时出现脏色
      const mixR = (primary.r + secondary.r) / 2
      const mixG = (primary.g + secondary.g) / 2
      const mixB = (primary.b + secondary.b) / 2
      root.style.setProperty('--ambient-glow', toFieldColor(mixR, mixG, mixB, 0.48, { satBoost: 1.2, minLum: 44 }))
    })
  }, [coverPath])
}
