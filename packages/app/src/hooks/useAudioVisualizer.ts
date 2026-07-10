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
    const freqData = new Uint8Array(bufferLength)
    const timeData = new Uint8Array(bufferLength)

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
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary') || '#8b5cf6'
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
    } else if (currentMode === 'circular') {
      analyser.getByteFrequencyData(freqData)
      const centerX = w / 2
      const centerY = h / 2
      const radius = Math.min(w, h) * 0.3
      const step = (Math.PI * 2) / barCount

      for (let i = 0; i < barCount; i++) {
        const dataIndex = Math.floor((i / barCount) * bufferLength)
        const value = freqData[dataIndex] / 255
        const barHeight = value * radius * 0.8
        const angle = i * step - Math.PI / 2

        const x1 = centerX + Math.cos(angle) * radius
        const y1 = centerY + Math.sin(angle) * radius
        const x2 = centerX + Math.cos(angle) * (radius + barHeight)
        const y2 = centerY + Math.sin(angle) * (radius + barHeight)

        const hue = 260 + i * (60 / barCount)
        ctx.strokeStyle = `hsla(${hue}, 80%, 60%, ${0.3 + value * 0.7})`
        ctx.lineWidth = 2
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
      }

      ctx.beginPath()
      ctx.arc(centerX, centerY, radius * 0.5, 0, Math.PI * 2)
      ctx.fillStyle = 'hsla(260, 80%, 60%, 0.1)'
      ctx.fill()
    } else {
      analyser.getByteFrequencyData(freqData)
      const barWidth = w / barCount
      const gap = barWidth * 0.2

      for (let i = 0; i < barCount; i++) {
        const dataIndex = Math.floor((i / barCount) * bufferLength * 0.6)
        const value = freqData[dataIndex] / 255
        const barHeight = value * h * 0.8
        const x = i * barWidth + gap / 2
        const y = h - barHeight

        const hue = 260 + i * (60 / barCount)
        const gradient = ctx.createLinearGradient(x, y, x, h)
        gradient.addColorStop(0, `hsla(${hue}, 80%, 60%, 0.9)`)
        gradient.addColorStop(1, `hsla(${hue}, 80%, 40%, 0.3)`)

        ctx.fillStyle = gradient
        const r = Math.min(2, barWidth / 2)
        ctx.beginPath()
        ctx.roundRect(x, y, barWidth - gap, barHeight, r)
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
