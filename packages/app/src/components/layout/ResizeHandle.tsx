import React from 'react'
import { isDesktop } from '@/lib/utils'

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const RESIZE = 6 // 边缘响应宽度（px）
const MIN_W = 800
const MIN_H = 600

type Bounds = { x: number; y: number; width: number; height: number }

function edgeToCursor(edge: Edge): string {
  const map: Record<Edge, string> = {
    n: 'ns-resize',
    s: 'ns-resize',
    e: 'ew-resize',
    w: 'ew-resize',
    ne: 'nesw-resize',
    sw: 'nesw-resize',
    nw: 'nwse-resize',
    se: 'nwse-resize',
  }
  return map[edge]
}

function startResize(
  edge: Edge,
  startBounds: Bounds,
  startScreenX: number,
  startScreenY: number,
) {
  const api = (window as any).electronAPI
  if (!api?.setBounds) return

  const onMove = (e: PointerEvent) => {
    const dx = e.screenX - startScreenX
    const dy = e.screenY - startScreenY
    let { x, y, width, height } = startBounds

    if (edge.includes('e')) {
      width = Math.max(MIN_W, startBounds.width + dx)
    }
    if (edge.includes('s')) {
      height = Math.max(MIN_H, startBounds.height + dy)
    }
    if (edge.includes('w')) {
      const newW = Math.max(MIN_W, startBounds.width - dx)
      x = startBounds.x + (startBounds.width - newW)
      width = newW
    }
    if (edge.includes('n')) {
      const newH = Math.max(MIN_H, startBounds.height - dy)
      y = startBounds.y + (startBounds.height - newH)
      height = newH
    }

    api.setBounds({ x, y, width, height })
  }

  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    document.body.style.cursor = ''
  }

  document.body.style.cursor = edgeToCursor(edge)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

function Handle({
  edge,
  className,
  style,
}: {
  edge: Edge
  className?: string
  style: React.CSSProperties
}) {
  const onPointerDown = async (e: React.PointerEvent) => {
    e.preventDefault()
    const api = (window as any).electronAPI
    if (!api?.getBounds) return
    const bounds: Bounds | null = await api.getBounds()
    if (!bounds) return
    startResize(edge, bounds, e.nativeEvent.screenX, e.nativeEvent.screenY)
  }

  return (
    <div
      className={`absolute z-50 titlebar-no-drag ${className || ''}`}
      style={{ touchAction: 'none', cursor: edgeToCursor(edge), ...style }}
      onPointerDown={onPointerDown}
    />
  )
}

export function ResizeHandles() {
  if (!isDesktop()) return null

  return (
    <>
      <Handle edge="n" style={{ top: 0, left: RESIZE, right: RESIZE, height: RESIZE }} />
      <Handle edge="s" style={{ bottom: 0, left: RESIZE, right: RESIZE, height: RESIZE }} />
      <Handle edge="w" style={{ top: RESIZE, bottom: RESIZE, left: 0, width: RESIZE }} />
      <Handle edge="e" style={{ top: RESIZE, bottom: RESIZE, right: 0, width: RESIZE }} />
      <Handle edge="nw" style={{ top: 0, left: 0, width: RESIZE, height: RESIZE }} />
      <Handle edge="ne" style={{ top: 0, right: 0, width: RESIZE, height: RESIZE }} />
      <Handle edge="sw" style={{ bottom: 0, left: 0, width: RESIZE, height: RESIZE }} />
      <Handle edge="se" style={{ bottom: 0, right: 0, width: RESIZE, height: RESIZE }} />
    </>
  )
}
