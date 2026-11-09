/**
 * 「音乐库是否可用」的**唯一判据**。
 *
 * 三处必须给出同一个答案，否则就是本仓库反复修过的那类错位：
 * 1. 侧栏 / 移动端抽屉是否显示「音乐库」入口；
 * 2. 应用主屏落点（可用时是音乐库，否则回落到我的音乐）；
 * 3. 音乐库页面自己的空态原因（文案仍由 `hallUnavailableReason` 翻译）。
 *
 * 之前只有 (3) 存在（`stores/musicHallStore.ts` 里的四段 if），而导航与主屏都硬编码
 * 认定「音乐库永远是第一屏」：于是没有音源的用户一进来就被丢进引导空态，侧栏还留着
 * 一个点进去什么也没有的入口。把判据挪到这里之后，三处读同一份结论。
 *
 * 判定顺序（顺序即优先级，与既有空态文案一一对应）：
 *   - 平台不支持在线能力（浏览器版没有主进程转发，`supportsMusicHall()` 为 false）
 *   - 一条音源都没配
 *   - 配了但全部停用
 *   - 有启用的源，但没有一条具备「在线发现」能力（`canBrowseHall`，按插件方法存在性判定）
 *
 * 判据只吃**入参**、不读 store：store 里的读取（`getState()`）留在 store，
 * 渲染期的订阅留在 hook（`hooks/useHallAvailability.ts`），这样这条判据可以在
 * node 环境下直接单测，不依赖平台层。
 */

import { canBrowseHall } from '@aurora/shared'
import type { OnlineSourceConfig } from '@aurora/shared'

/** `ok` 表示可用；其余四种是「不可用」的具体原因 */
export type HallAvailability =
  | 'ok'
  | 'unsupportedEnv'
  | 'noSource'
  | 'allDisabled'
  | 'sourceUnsupported'

/**
 * 判定当前音源配置下的音乐库可用性。
 *
 * `sources` 用只读数组接收：调用方传入 store 里的原数组，本函数不改写、不拷贝出副作用。
 * `envSupported` 由调用方传入（生产环境是 `supportsMusicHall()`），而不是在这里 import
 * 平台层 —— 平台层在模块加载时就会探测运行环境，测试里不需要为它造桩。
 */
export function hallAvailabilityOf(
  sources: readonly OnlineSourceConfig[] | null | undefined,
  envSupported: boolean
): HallAvailability {
  // 先看环境：浏览器版即使配了音源也没有转发在线请求的能力，空态文案要指向这一点，
  // 而不是让用户去检查一个永远不会生效的配置
  if (!envSupported) return 'unsupportedEnv'
  const list = (sources ?? []).filter(Boolean)
  if (list.length === 0) return 'noSource'
  // `enabled` 缺省视为启用：老版本持久化里可能没有这个字段，
  // 与取数口径（`pickHallSource` 里 `enabled === false` 才跳过）保持一致
  const enabled = list.filter((source) => source.enabled !== false)
  if (enabled.length === 0) return 'allDisabled'
  // 「能发现」= 插件实现了 recommendPlaylists 或 toplists；
  // 只看来源形态（是否 aurora 协议 / 有没有填地址）会把声明式插件挡在外面
  if (!enabled.some((source) => canBrowseHall(source))) return 'sourceUnsupported'
  return 'ok'
}
