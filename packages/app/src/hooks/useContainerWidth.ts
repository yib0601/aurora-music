import { useLayoutEffect, useRef, useState } from 'react'

/**
 * 测量元素自身的内容盒宽度（px）。
 *
 * 用途：组件内部布局分档时，判据取**容器实际可用宽度**而不是视口宽度、更不是
 * 平台判定。理由与 LibraryPage 的网格分列一致：
 * - 播放条宽度由外层定位容器决定（移动端 `100%-32px`、桌面 clamp 到 640px），
 *   与视口宽度不成比例，用媒体查询会出现「视口 800px 但播放条只有 640px」的错判；
 * - 同一份 UI 会出现在手机、平板分屏、折叠屏展开、桌面窄窗口等多种宽度下，
 *   平台名（isMobile）与可用宽度没有稳定对应关系。
 *
 * 首帧不闪：用 useLayoutEffect 同步测量一次再渲染，而不是等 ResizeObserver 的
 * 异步回调——后者会让宽档布局先画一帧再翻到窄档。宽度返回 null 表示尚未测量。
 */
export function useContainerWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const measure = () => {
      const next = el.getBoundingClientRect().width
      // 亚像素抖动不写入 state：拖动窗口时 0.2px 的差值会带来无意义的重渲染
      setWidth((prev) => (prev !== null && Math.abs(prev - next) < 0.5 ? prev : next))
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return { ref, width }
}