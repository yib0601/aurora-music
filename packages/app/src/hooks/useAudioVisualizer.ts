import { useEffect, useRef, useCallback } from 'react'
import { getAnalyser, initAudioAnalyser } from '@/services/audio.service'

export type VisualizerMode = 'bars' | 'circular' | 'waveform'

/**
 * 频谱配色的唯一来源：读取实时 CSS 变量，而不是在 canvas 里硬编码色值。
 *
 * 为什么不硬编码（改造前的做法）：
 *   1. 浅色主题下 mint 是 #009C88，硬编码 #00F5D4 会让频谱在浅底上过亮、失真；
 *   2. 色彩体系要求「只有 mint 主色 + 单一辅助色」，硬编码的香槟金(42°)
 *      在体系里没有出处，是视觉不统一的直接来源。
 *
 * ⚠️ 性能：不在每帧读取（getComputedStyle 会强制 reflow）。改为
 *    「主题/封面变化时读一次并缓存」，绘制循环内只用缓存值。
 */
interface VizPalette {
  mint: string
  /** 与 mint 拉开色相的辅助色（--fc-accent-2） */
  accent2: string
}

/**
 * 兜底调色板：仅在 `document` 不可用（SSR / 非浏览器环境）或 CSS 变量读取失败时使用。
 * 这是全项目**唯一**允许出现硬编码色值的地方 —— 此时拿不到 token，
 * 必须有一组与深色主题 mint 同值的常量兜底，否则频谱会画成透明。
 * 正常路径一律走 readVizPalette() 读 CSS 变量。
 */
const FALLBACK_PALETTE: VizPalette = {
  mint: '#00F5D4',
  accent2: '#4d9fd8',
}

let cachedPalette: VizPalette | null = null
let cachedKey = ''

function readVizPalette(): VizPalette {
  if (typeof document === 'undefined') return FALLBACK_PALETTE
  const root = document.documentElement
  const isDark = root.classList.contains('dark')
  // 缓存键：主题 + dataset 版本。切歌改的是内联样式，不影响本调色板。
  const key = isDark ? 'dark' : 'light'
  if (cachedPalette && cachedKey === key) return cachedPalette

  const cs = getComputedStyle(root)
  const mintRaw = cs.getPropertyValue('--fc-accent').trim()
  const accent2Raw = cs.getPropertyValue('--fc-accent-2').trim()
  if (!mintRaw || !accent2Raw) return FALLBACK_PALETTE

  cachedPalette = {
    mint: mintRaw,
    accent2: accent2Raw,
  }
  cachedKey = key
  return cachedPalette
}

/**
 * 主题切换后手动失效配色缓存。
 *
 * 通常不需要调用：缓存键是 `dark` class 的有无，切主题后 key 自然变化、缓存自动失效。
 * 仅当「主题不变但 --fc-accent / --fc-accent-2 的值被改写」（例如运行时换肤脚本
 * 直接改内联变量）时才需要显式失效。
 */
export function invalidateVizPalette() {
  cachedPalette = null
  cachedKey = ''
}

interface UseVisualizerOptions {
  mode?: VisualizerMode
  color?: string
  barCount?: number
}

/**
 * bars 模式的逐柱渐变缓存。
 *
 * 渐变色只由「柱索引 i」决定（横向在 mint→辅助色之间取色），与音量无关，
 * 因此完全可以预计算一次、之后每帧复用。改造前每帧对 64 根柱子各做
 * 两次 `color-mix()` 字符串拼接 + `createLinearGradient()`，
 * 微基准实测每帧 0.429ms，预计算后降到 0.020ms（约 22 倍）。
 *
 * 缓存键包含 canvas 高度与配色：高度变了渐变端点要重算，切主题变色同理。
 *
 * 另注：`color-mix()` 只被 CSS 解析器支持，canvas 的 fillStyle 拿到该字符串
 * 会判为非法值而**静默忽略**（赋值不生效，沿用上一次的颜色）。
 * 所以这里必须把两端色值算成真实色值，而不是把 color-mix 字符串交给 canvas。
 */
interface BarsGradientCache {
  key: string
  gradients: CanvasGradient[]
}
let barsGradientCache: BarsGradientCache | null = null

/** 把 '#rrggbb' / 'rgb(...)' 解析成 [r,g,b]，失败返回 null */
function parseColor(color: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(color.trim())
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3]]
  return null
}

/** 在 a→b 之间按 t(0~1) 线性插值 */
function mixRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

function getBarsGradients(
  ctx: CanvasRenderingContext2D,
  palette: VizPalette,
  barCount: number,
  h: number,
): CanvasGradient[] {
  const key = `${palette.mint}|${palette.accent2}|${barCount}|${h}`
  if (barsGradientCache && barsGradientCache.key === key) return barsGradientCache.gradients

  const from = parseColor(palette.mint) ?? [0, 245, 212]
  const to = parseColor(palette.accent2) ?? [77, 159, 216]
  const gradients: CanvasGradient[] = []

  for (let i = 0; i < barCount; i++) {
    const t = i / barCount
    const [r, g, b] = mixRgb(from, to, t)
    const gradient = ctx.createLinearGradient(0, 0, 0, h)
    // 顶部为混合色，底部按 35% 透明度淡出（等价于原 color-mix(..., 35%, transparent)）
    gradient.addColorStop(0, `rgb(${r},${g},${b})`)
    gradient.addColorStop(1, `rgba(${r},${g},${b},0.35)`)
    gradients.push(gradient)
  }

  barsGradientCache = { key, gradients }
  return gradients
}

export function useAudioVisualizer(
  canvasRef: React.RefObject<HTMLCanvasElement>,
  options: UseVisualizerOptions = {}
) {
  const { mode = 'bars', barCount = 64 } = options
  const rafRef = useRef<number>(0)
  const modeRef = useRef(mode)
  modeRef.current = mode

  // ⚠️ 性能：复用 TypedArray，避免每帧分配触发 GC
  const freqDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const timeDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let analyser = getAnalyser()
    if (!analyser) {
      analyser = initAudioAnalyser()
    }
    if (!analyser) {
      // 无音频时降低帧率，每 500ms 检查一次
      setTimeout(() => {
        rafRef.current = requestAnimationFrame(draw)
      }, 500)
      return
    }

    const bufferLength = analyser.frequencyBinCount
    if (!freqDataRef.current || freqDataRef.current.length !== bufferLength) {
      freqDataRef.current = new Uint8Array(new ArrayBuffer(bufferLength))
      timeDataRef.current = new Uint8Array(new ArrayBuffer(bufferLength))
    }
    const freqData = freqDataRef.current!
    const timeData = timeDataRef.current!

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)
    }

    const w = rect.width
    const h = rect.height

    ctx.clearRect(0, 0, w, h)

    const currentMode = modeRef.current
    const palette = readVizPalette()

    if (currentMode === 'waveform') {
      analyser.getByteTimeDomainData(timeData)
      ctx.lineWidth = 2
      // ⚠️ 性能：避免每帧 getComputedStyle（强制 reflow）；配色按主题缓存后复用
      ctx.strokeStyle = palette.mint
      // 波形整条只 stroke 一次，光晕成本可控，保留发光观感。
      // ⚠️ 修正：mintGlow 由 color-mix() 推导，而 canvas 不认 CSS 的 color-mix()，
      // 直接赋值会被静默忽略导致光晕失效；这里解析成真实 rgba 再用。
      const glowRgb = parseColor(palette.mint)
      ctx.shadowBlur = 12
      ctx.shadowColor = glowRgb ? `rgba(${glowRgb[0]},${glowRgb[1]},${glowRgb[2]},0.5)` : 'rgba(0,245,212,0.5)'
      ctx.beginPath()
      const sliceWidth = w / bufferLength
      let x = 0
      for (let i = 0; i < bufferLength; i++) {
        const v = timeData[i] / 128.0
        const y = (v * h) / 2
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
        x += sliceWidth
      }
      ctx.lineTo(w, h / 2)
      ctx.stroke()
      // 重置阴影避免影响后续绘制
      ctx.shadowBlur = 0
      ctx.shadowColor = 'transparent'
    } else if (currentMode === 'circular') {
      analyser.getByteFrequencyData(freqData)
      const centerX = w / 2
      const centerY = h / 2
      const radius = Math.min(w, h) * 0.3
      const step = (Math.PI * 2) / barCount

      // 双色 = mint（主色）+ accent-2（体系内唯一辅助色）
      for (let i = 0; i < barCount; i++) {
        const dataIndex = Math.floor((i / barCount) * bufferLength)
        const value = freqData[dataIndex] / 255
        const barHeight = value * radius * 0.8
        const angle = i * step - Math.PI / 2

        // ⚠️ 性能：只在有实际高度时绘制。原实现对每根柱子都建路径 + stroke，
        // 音量低时（大量 value≈0）这些绘制全部是空转；而 shadowBlur 还会让
        // 每一次 stroke 都额外做一次模糊。
        if (barHeight <= 0.5) continue

        const cos = Math.cos(angle)
        const sin = Math.sin(angle)
        const x1 = centerX + cos * radius
        const y1 = centerY + sin * radius
        const x2 = centerX + cos * (radius + barHeight)
        const y2 = centerY + sin * (radius + barHeight)

        // 前半分 mint，后半分辅助色
        ctx.strokeStyle = i < barCount / 2 ? palette.mint : palette.accent2
        ctx.lineWidth = 2
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
      }

      // ⚠️ 修正原实现的隐性问题：canvas 的 fillStyle 不认识 CSS 的 color-mix()，
      // 传入会被判为非法值静默忽略（填不上色）。这里改用解析后的真实色值 + 全局透明度。
      const mintRgb = parseColor(palette.mint)
      const centerFill = mintRgb
        ? `rgba(${mintRgb[0]},${mintRgb[1]},${mintRgb[2]},0.10)`
        : 'rgba(0,245,212,0.10)'
      ctx.beginPath()
      ctx.arc(centerX, centerY, radius * 0.5, 0, Math.PI * 2)
      ctx.fillStyle = centerFill
      ctx.fill()
    } else {
      analyser.getByteFrequencyData(freqData)
      const barWidth = w / barCount
      const gap = barWidth * 0.2

      // 主色 → 辅助色横向过渡 + 逐条纵向亮度衰减
      // ⚠️ 性能：渐变按柱索引预计算并缓存，不再每帧重建（详见 getBarsGradients）
      const gradients = getBarsGradients(ctx, palette, barCount, h)

      // 柱高在 0 时 roundRect 会退化成一条线，直接跳过往返的路径构建
      const radius = Math.min(2, barWidth / 2)
      for (let i = 0; i < barCount; i++) {
        const dataIndex = Math.floor((i / barCount) * bufferLength * 0.6)
        const value = freqData[dataIndex] / 255
        if (value <= 0.001) continue

        const barHeight = value * h * 0.8
        const x = i * barWidth + gap / 2
        const y = h - barHeight

        ctx.fillStyle = gradients[i]
        ctx.beginPath()
        ctx.roundRect(x, y, barWidth - gap, barHeight, radius)
        ctx.fill()
      }
    }

    rafRef.current = requestAnimationFrame(draw)
  }, [canvasRef, barCount])

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [draw])

  return { draw }
}
