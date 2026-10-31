/**
 * 插件注册表。
 *
 * 对齐仓库里唯一存在的注册表范式 `mediaProvider.ts` 的
 * `registerMediaProvider` / `getMediaProvider` / `registeredMediaProviderKinds`
 * —— 不引入第二套机制。
 *
 * 注册顺序**稳定**：`listPlugins()` 按注册顺序返回，UI 每次刷新看到的顺序一致
 * （Map 保证插入序，且重复注册同一 id 只替换实现、不改变位置）。
 */

import type { PluginCapability, SourcePlugin } from './types'

/** id → 插件。Map 的插入序即注册序 */
const PLUGINS = new Map<string, SourcePlugin>()

/** 插件 id 的合法形状（与主进程凭证落盘的文件名约束保持一致，两处都校验） */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/**
 * 注册插件。
 *
 * 同一 id 重复注册视为「替换实现」并**保留原位置**：这既是插件热更新需要的语义，
 * 也避免了多次 import 时列表顺序抖动。
 */
export function registerPlugin(plugin: SourcePlugin): void {
  if (!plugin || typeof plugin.id !== 'string' || !PLUGIN_ID_RE.test(plugin.id)) {
    // 插件 id 会成为凭证文件名的一部分，非法 id 必须挡在注册这一关，
    // 而不是等到落盘时才炸
    throw new Error(`[plugin] invalid plugin id: ${String(plugin?.id)}`)
  }
  PLUGINS.set(plugin.id, plugin)
}

/** 按 id 取插件；未注册返回 undefined（调用方据此降级，不抛错） */
export function getPlugin(id: string): SourcePlugin | undefined {
  if (typeof id !== 'string' || !id) return undefined
  return PLUGINS.get(id)
}

/** 全部已注册插件，按注册顺序 */
export function listPlugins(): SourcePlugin[] {
  return [...PLUGINS.values()]
}

/**
 * 某插件是否声明了某个能力。
 *
 * **只用于 UI 展示与诊断**；调用前判定请用 `typeof plugin.xxx === 'function'`，
 * 免得「声明」与「实现」变成两份真源。
 */
export function hasCapability(plugin: SourcePlugin, capability: PluginCapability): boolean {
  return Array.isArray(plugin?.capabilities) && plugin.capabilities.includes(capability)
}

/** 清空注册表（**仅供单测**：生产代码没有「卸载全部插件」的需求） */
export function clearPluginsForTest(): void {
  PLUGINS.clear()
}

/**
 * 撤销单个插件的注册。
 *
 * ## 与上一句注释为什么不再冲突
 *
 * 那句说的是**全部**：没有任何生产路径会一次清空注册表。v14 起用户可以在设置里卸载
 * 自己装的插件，而卸载必须同时做两件事 —— 删磁盘文件 + 从注册表移除实现。
 * 只删文件而留着注册，会出现最糟的观感：「插件已卸载，但音源还在工作，重启后才消失」。
 *
 * 调用方是 `plugin/installed.ts` 的 `unregisterInstalledPlugin`，它**只允许**撤销
 * 已安装插件：内置插件的实现编译在应用里，不存在"撤销"的语义。
 * 未注册的 id 静默返回 `false` —— 卸载流程不该因为"它本来就不在了"而失败。
 */
export function unregisterPlugin(id: string): boolean {
  if (typeof id !== 'string' || !id) return false
  return PLUGINS.delete(id)
}
