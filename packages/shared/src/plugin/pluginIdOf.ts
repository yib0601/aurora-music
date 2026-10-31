/**
 * 「这条源由哪个插件执行」的**唯一**判定处。
 *
 * 改造前，形态判定散落在 31 处、且「能不能搜索」有四种写法。现在只有这一个函数
 * 知道 `kind` 与 `pluginId` 的映射关系；调用方一律拿 `pluginId` 去查注册表。
 *
 * ## 为什么保留 `kind` 兼容
 *
 * `kind` 是 v13 之前持久化里的字段，用户的老配置（以及大量既有测试）都用它。
 * 让 `pluginIdOf` 在缺 `pluginId` 时按 `kind` 推导，老数据**零迁移**即可继续工作，
 * 同时新代码不必再碰 `kind`。等确认没有老配置在用，删掉这个函数里的兼容分支即可。
 */

import type { OnlineSourceConfig } from '../types'

/** 未声明任何标识时的默认插件（与历史行为一致：缺省视为 aurora 协议源） */
export const DEFAULT_PLUGIN_ID = 'aurora'

/**
 * 从配置里取出插件 id。
 *
 * 优先级：显式 `pluginId` → 由 `kind` 推导 → 默认 `aurora`。
 * 不做「查注册表失败就回落」：没注册的 pluginId 是**配置错误**，
 * 调用方拿到后查不到插件，应当明确降级（跳过这条源），而不是悄悄换成别的插件执行。
 */
export function pluginIdOf(source: Pick<OnlineSourceConfig, 'kind' | 'pluginId'> | null | undefined): string {
  if (!source) return DEFAULT_PLUGIN_ID
  const explicit = typeof source.pluginId === 'string' ? source.pluginId.trim() : ''
  if (explicit) return explicit
  // 兼容分支：老配置只有 kind
  return source.kind === 'lx' ? 'lx' : DEFAULT_PLUGIN_ID
}

/**
 * 构造写入持久化的形态字段。
 *
 * 只写 `pluginId`，不再写 `kind`——`kind` 从此是只读的兼容层，
 * 避免出现「两个字段各说一套」的分叉（这正是改造前的老问题）。
 */
export function pluginFieldsOf(pluginId: string): { pluginId: string } {
  return { pluginId }
}
