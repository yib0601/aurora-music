export interface ColorRGB {
  r: number
  g: number
  b: number
}

export interface ExtractedColors {
  primary: ColorRGB
  secondary: ColorRGB
  vibrant: ColorRGB
  muted: ColorRGB
  darkVibrant: ColorRGB
  lightMuted: ColorRGB
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  const l = (max + min) / 2

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6
        break
      case g:
        h = ((b - r) / d + 2) / 6
        break
      case b:
        h = ((r - g) / d + 4) / 6
        break
    }
  }
  return [h * 360, s * 100, l * 100]
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')
}

function getLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    c /= 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs
}

export function extractColorsFromImage(imageData: ImageData): ExtractedColors {
  const pixels = imageData.data
  const colorBuckets: Map<string, { r: number; g: number; b: number; count: number; h: number; s: number; l: number }> = new Map()

  const bucketSize = 24

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]
    const g = pixels[i + 1]
    const b = pixels[i + 2]
    const a = pixels[i + 3]

    if (a < 128) continue

    const [h, s, l] = rgbToHsl(r, g, b)

    if (l < 10 || l > 90) continue
    if (s < 15) continue

    const br = Math.round(r / bucketSize) * bucketSize
    const bg = Math.round(g / bucketSize) * bucketSize
    const bb = Math.round(b / bucketSize) * bucketSize
    const key = `${br},${bg},${bb}`

    const existing = colorBuckets.get(key)
    if (existing) {
      existing.r += r
      existing.g += g
      existing.b += b
      existing.count++
      existing.h += h
      existing.s += s
      existing.l += l
    } else {
      colorBuckets.set(key, { r, g, b, count: 1, h, s, l })
    }
  }

  const colors = Array.from(colorBuckets.values())
    .map((c) => ({
      r: Math.round(c.r / c.count),
      g: Math.round(c.g / c.count),
      b: Math.round(c.b / c.count),
      count: c.count,
      h: c.h / c.count,
      s: c.s / c.count,
      l: c.l / c.count,
    }))
    .sort((a, b) => b.count - a.count)

  if (colors.length === 0) {
    return {
      primary: { r: 139, g: 92, b: 246 },
      secondary: { r: 236, g: 72, b: 153 },
      vibrant: { r: 139, g: 92, b: 246 },
      muted: { r: 100, g: 100, b: 120 },
      darkVibrant: { r: 88, g: 28, b: 135 },
      lightMuted: { r: 200, g: 180, b: 220 },
    }
  }

  const vibrant = colors.find((c) => c.s > 50 && c.l > 30 && c.l < 70) || colors[0]
  const muted = colors.find((c) => c.s < 40 && c.l > 30 && c.l < 70) || colors[Math.min(colors.length - 1, 2)]
  const darkVibrant = colors.find((c) => c.s > 40 && c.l < 35) || { ...vibrant, l: 25 }
  const lightMuted = colors.find((c) => c.s < 30 && c.l > 65) || { ...muted, l: 70 }

  return {
    primary: { r: vibrant.r, g: vibrant.g, b: vibrant.b },
    secondary: { r: muted.r, g: muted.g, b: muted.b },
    vibrant: { r: vibrant.r, g: vibrant.g, b: vibrant.b },
    muted: { r: muted.r, g: muted.g, b: muted.b },
    darkVibrant: { r: Math.round(darkVibrant.r * 0.7), g: Math.round(darkVibrant.g * 0.7), b: Math.round(darkVibrant.b * 0.7) },
    lightMuted: { r: Math.min(255, lightMuted.r + 40), g: Math.min(255, lightMuted.g + 40), b: Math.min(255, lightMuted.b + 40) },
  }
}

export async function extractColorsFromUrl(url: string): Promise<ExtractedColors | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        const size = 100
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(null)
          return
        }
        ctx.drawImage(img, 0, 0, size, size)
        const imageData = ctx.getImageData(0, 0, size, size)
        resolve(extractColorsFromImage(imageData))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

export function rgbToCssVar(rgb: ColorRGB): string {
  return `${rgb.r} ${rgb.g} ${rgb.b}`
}

export function getContrastColor(rgb: ColorRGB): string {
  const lum = getLuminance(rgb.r, rgb.g, rgb.b)
  return lum > 0.5 ? '#000000' : '#ffffff'
}
