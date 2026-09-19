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
  mintGlow: string
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
  mintGlow: 'rgba(0,245,212,.5)',
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
    // 光晕用 color-mix 推导，保证与主色同源
    mintGlow: `color-mix(in srgb, ${mintRaw} 50%, transparent)`,
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
      ctx.shadowBlur = 12
      ctx.shadowColor = palette.mintGlow
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
      ctx.shadowBlur = 12
      ctx.shadowColor = palette.mintGlow
      for (let i = 0; i < barCount; i++) {
        const dataIndex = Math.floor((i / barCount) * bufferLength)
        const value = freqData[dataIndex] / 255
        const barHeight = value * radius * 0.8
        const angle = i * step - Math.PI / 2

        const x1 = centerX + Math.cos(angle) * radius
        const y1 = centerY + Math.sin(angle) * radius
        const x2 = centerX + Math.cos(angle) * (radius + barHeight)
        const y2 = centerY + Math.sin(angle) * (radius + barHeight)

        // 前半分 mint，后半分辅助色
        const isMintHalf = i < barCount / 2
        const baseAlpha = 0.3 + value * 0.7
        ctx.strokeStyle = isMintHalf ? palette.mint : palette.accent2
        ctx.lineWidth = 2
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
      }

      ctx.beginPath()
      ctx.arc(centerX, centerY, radius * 0.5, 0, Math.PI * 2)
      ctx.fillStyle = `color-mix(in srgb, ${palette.mint} 10%, transparent)`
      ctx.fill()
      ctx.shadowBlur = 0
      ctx.shadowColor = 'transparent'
    } else {
      analyser.getByteFrequencyData(freqData)
      const barWidth = w / barCount
      const gap = barWidth * 0.2

      // 主色 → 辅助色横向过渡 + 逐条纵向亮度衰减
      // （原为「薄荷青174° → 香槟金42°」跨色相插值，香槟金不在体系内，已收敛）
      ctx.shadowBlur = 12
      ctx.shadowColor = palette.mintGlow
      for (let i = 0; i < barCount; i++) {
        const dataIndex = Math.floor((i / barCount) * bufferLength * 0.6)
        const value = freqData[dataIndex] / 255
        const barHeight = value * h * 0.8
        const x = i * barWidth + gap / 2
        const y = h - barHeight

        // 横向按位置在 mint 与辅助色之间取色（用 color-mix 保证同源亮度）
        const t = i / barCount
        const topColor = `color-mix(in srgb, ${palette.accent2} ${(t * 100).toFixed(1)}%, ${palette.mint})`
        const bottomColor = `color-mix(in srgb, ${topColor} 35%, transparent)`
        const gradient = ctx.createLinearGradient(x, y, x, h)
        gradient.addColorStop(0, topColor)
        gradient.addColorStop(1, bottomColor)

        ctx.fillStyle = gradient
        const r = Math.min(2, barWidth / 2)
        ctx.beginPath()
        ctx.roundRect(x, y, barWidth - gap, barHeight, r)
        ctx.fill()
      }
      ctx.shadowBlur = 0
      ctx.shadowColor = 'transparent'
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
