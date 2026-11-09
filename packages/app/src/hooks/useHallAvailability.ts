/**
 * 渲染期的「音乐库是否可用」。
 *
 * 为什么要有这个 hook 而不是各处直接调 `hallAvailability()`：
 * store 里的那个是**快照**（`getState()`），只在调用那一刻正确。侧栏入口与主屏落点
 * 是常驻 UI：用户在设置页添加/停用音源后，它们必须立刻跟着变——不能等下一次路由
 * 切换才刷新（用户会看到「明明配好了，入口还是没了」）。所以订阅 `onlineSources`。
 *
 * 只订阅音源配置，不订阅平台能力：`supportsMusicHall()` 在应用生命周期内是常量
 * （由运行环境决定，浏览器版没有主进程转发），没有「运行期变成支持」的场景。
 *
 * 插件级启停（`setDisabledPluginIds`）目前没有反应式通道，切换插件开关后
 * 导航要等到下一次重渲染才会更新——这与既有渲染层镜像的限制一致，
 * 不在这里造第二套状态（详见 `services/pluginAvailability.ts` 的说明）。
 */

import { useMemo } from 'react'
import { hallAvailabilityOf } from '@/lib/hallAvailability'
import { supportsMusicHall } from '@/services/platform'
import { useLibraryStore } from '@/stores/libraryStore'

export function useHallAvailable(): boolean {
  const sources = useLibraryStore((s) => s.onlineSources)
  return useMemo(() => hallAvailabilityOf(sources, supportsMusicHall()) === 'ok', [sources])
}
