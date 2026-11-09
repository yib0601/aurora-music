import { useLocation, useNavigate } from 'react-router-dom'
import { useHallAvailable } from '@/hooks/useHallAvailability'
import { homeRoute, ROUTE_BUILDERS } from './routes'

/**
 * 返回上一屏。
 *
 * 裸 navigate(-1) 在历史栈底是 no-op（history.go(-1) 无处可退）：
 * 冷启动深链直达详情页、或详情页成为首条历史时，返回按钮点了毫无反应。
 * react-router 给每条历史写入 state.idx（首条为 0），据此判断能否真退；
 * 退不了时兜底回主屏，用 replace 避免把详情页留在栈里造成「返回又回去」。
 *
 * 兜底目标在**渲染期**取（`homeRoute`）：没有可用音源时主屏是我的音乐，
 * 硬编码音乐库会让这类用户点返回落到一个只有空态的页面。
 * 调用方仍可传 `fallback` 覆盖（少数页面需要回自己的上级页）。
 */
export function useGoBack(fallback?: string) {
  const navigate = useNavigate()
  const hallAvailable = useHallAvailable()
  return () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx
    if (typeof idx === 'number' && idx > 0) navigate(-1)
    else navigate(fallback ?? homeRoute(hallAvailable), { replace: true })
  }
}

/**
 * 进入歌曲详情。
 *
 * 已在该歌曲详情页时不重复 push 同路径条目：否则点返回会「退回」
 * 同一页面，视觉上与返回按钮失效无异（专辑列表点当前曲、播放条/
 * 瓷砖封面等入口都会触发）。
 */
export function useOpenSongDetail() {
  const navigate = useNavigate()
  const location = useLocation()
  return (id: string) => {
    const target = ROUTE_BUILDERS.songDetail(id)
    if (location.pathname === target) return
    navigate(target)
  }
}
