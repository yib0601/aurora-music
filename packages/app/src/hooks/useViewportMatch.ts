import { useEffect, useState } from 'react'

/**
 * 订阅一条视口媒体查询。
 *
 * 用途限定在**外壳结构分档**（是否显示固定侧栏 / 顶部汉堡栏），不用于组件内部排版：
 * 组件内部分档一律走容器宽度（见 `useContainerWidth`），因为视口宽度与容器可用宽度
 * 没有稳定对应关系（播放条会被外层 clamp 到 640px，分屏 / 折叠屏更不成立）。
 *
 * 首帧同步取 `matchMedia().matches`（惰性初始值），而不是等 effect 里再设一次：
 * 后者会让外壳先按窄档画一帧再翻到宽档，侧栏/顶栏出现明显跳变。
 */
export function useViewportMatch(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    const mq = window.matchMedia(query)
    // 查询串变化（或首帧之后系统改了缩放）时对齐一次：懒初始值只保证挂载瞬间正确
    const sync = () => setMatches(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [query])

  return matches
}