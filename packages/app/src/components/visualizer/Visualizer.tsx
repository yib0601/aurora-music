import React, { useRef } from 'react'
import { useAudioVisualizer, type VisualizerMode } from '@/hooks/useAudioVisualizer'

interface VisualizerProps {
  mode?: VisualizerMode
  className?: string
}

export function Visualizer({ mode = 'bars', className }: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useAudioVisualizer(canvasRef, { mode })

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: '100%', height: '100%' }}
    />
  )
}
