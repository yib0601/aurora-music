import { useEffect, useRef, useCallback } from 'react'
import { getAnalyser, initAudioAnalyser } from '@/services/audio.service'

export type VisualizerMode = 'bars' | 'circular' | 'waveform'

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
      rafRef.current = requestAnimationFrame(draw)
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

    if (currentMode === 'waveform') {
      analyser.getByteTimeDomainData(timeData)
      ctx.lineWidth = 2
      // ⚠️ 性能：避免每帧 getComputedStyle（强制 reflow）；缓存颜色
      // Mineradio 风格：薄荷青波形 + 发光
      ctx.strokeStyle = '#00F5D4'
      ctx.shadowBlur = 12
      ctx.shadowColor = 'rgba(0,245,212,.5)'
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

      // Mineradio 风格：薄荷青 + 香槟金双色 + 发光
      ctx.shadowBlur = 12
      ctx.shadowColor = 'rgba(0,245,212,.5)'
      for (let i = 0; i < barCount; i++) {
        const dataIndex = Math.floor((i / barCount) * bufferLength)
        const value = freqData[dataIndex] / 255
        const barHeight = value * radius * 0.8
        const angle = i * step - Math.PI / 2

        const x1 = centerX + Math.cos(angle) * radius
        const y1 = centerY + Math.sin(angle) * radius
        const x2 = centerX + Math.cos(angle) * (radius + barHeight)
        const y2 = centerY + Math.sin(angle) * (radius + barHeight)

        // 前半薄荷青，后半香槟金
        const isMintHalf = i < barCount / 2
        const baseAlpha = 0.3 + value * 0.7
        ctx.strokeStyle = isMintHalf
          ? `hsla(174, 100%, 48%, ${baseAlpha})`
          : `hsla(42, 88%, 64%, ${baseAlpha})`
        ctx.lineWidth = 2
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
      }

      ctx.beginPath()
      ctx.arc(centerX, centerY, radius * 0.5, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(0,245,212,0.1)'
      ctx.fill()
      ctx.shadowBlur = 0
      ctx.shadowColor = 'transparent'
    } else {
      analyser.getByteFrequencyData(freqData)
      const barWidth = w / barCount
      const gap = barWidth * 0.2

      // Mineradio 风格：薄荷青到香槟金渐变 + 发光
      ctx.shadowBlur = 12
      ctx.shadowColor = 'rgba(0,245,212,.5)'
      for (let i = 0; i < barCount; i++) {
        const dataIndex = Math.floor((i / barCount) * bufferLength * 0.6)
        const value = freqData[dataIndex] / 255
        const barHeight = value * h * 0.8
        const x = i * barWidth + gap / 2
        const y = h - barHeight

        // 从薄荷青（174°）到香槟金（42°）插值
        const t = i / barCount
        const hue = 174 - (174 - 42) * t
        const sat = 100 - (100 - 88) * t
        const light = 48 + (64 - 48) * t
        const gradient = ctx.createLinearGradient(x, y, x, h)
        gradient.addColorStop(0, `hsla(${hue}, ${sat}%, ${light}%, 0.85)`)
        gradient.addColorStop(1, `hsla(${hue}, ${sat}%, ${light - 10}%, 0.35)`)

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
