/**
 * 存储插件注册表。
 *
 * 对齐仓库里既有的两个注册表范式（`plugin/registry.ts` 的音源插件、原
 * `mediaProvider.ts` 的 MediaProvider），**不引入第二套机制**：
 * 一个 Map、插入序即列表序、同 id 重复注册按「替换实现、保留位置」处理。
 *
 * 本文件是「来源配置 → 插件」的**唯一查表入口**：
 * - `storagePluginOf(config)` 收口了「配置里到底该用哪个插件」这件事
 *   （`pluginId` 优先、缺失回落 `kind`），上层因此不需要写第二个判定；
 * - 平台层过去有 `providerFor()` 与「又直接 `getMediaProvider(cfg.kind)` 一次」两套查法，
 *   现在都应当换成这一个函数。
 */

import type { LibrarySourceConfig } from '../../webdav'
import { storageCapabilitiesOf, type StoragePlugin, type StoragePluginMeta } from './types'

/** id → 插件。Map 的插入序即注册序 */
const STORAGE_PLUGINS = new Map<string, StoragePlugin>()

/**
 * 插件 id 的合法形状。
 *
 * 与音源插件（`plugin/registry.ts`）和主进程凭证文件名（`safeFileName`）**同一正则**：
 * 存储插件的 id 同样会进入配置与（将来的）凭证文件名，三处口径必须一致。
 */
const STORAGE_PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** 未声明任何标识时的默认插件（与历史行为一致：缺省视为 webdav 网络存储） */
export const DEFAULT_STORAGE_PLUGIN_ID = 'webdav'

/**
 * 注册插件。
 *
 * 同一 id 重复注册视为「替换实现」并**保留原位置**：这既是插件热更新需要的语义，
 * 也避免了多次 import 时列表顺序抖动（UI 每次刷新看到的顺序一致）。
 */
export function registerStoragePlugin(plugin: StoragePlugin): void {
  const id = plugin?.id
  if (typeof id !== 'string' || !STORAGE_PLUGIN_ID_RE.test(id)) {
    // id 会进入持久化配置，非法 id 必须挡在注册这一关，而不是等到落盘才炸
    throw new Error(`[storage-plugin] invalid plugin id: ${String(id)}`)
  }
  if (!Array.isArray(plugin.fields)) {
    // 字段声明是 UI 通用渲染的输入；缺失会让设置页渲染出空表单而不报错，必须在注册期拦下
    throw new Error(`[storage-plugin] plugin "${id}" must declare a fields array`)
  }
  STORAGE_PLUGINS.set(id, plugin)
}

/** 按 id 取插件；未注册返回 undefined（调用方据此降级，不抛错） */
export function getStoragePlugin(id: string): StoragePlugin | undefined {
  if (typeof id !== 'string' || !id) return undefined
  return STORAGE_PLUGINS.get(id)
}

/** 全部已注册插件，按注册顺序 */
export function listStoragePlugins(): StoragePlugin[] {
  return [...STORAGE_PLUGINS.values()]
}

/** 已注册插件 id，按注册顺序（UI 列出可添加的来源类型） */
export function registeredStoragePluginIds(): string[] {
  return [...STORAGE_PLUGINS.keys()]
}

/**
 * 全部插件的**纯数据**元信息，顺序与 `listStoragePlugins()` 完全一致。
 *
 * 为什么要单独有它：`StoragePlugin` 上挂着方法，Electron IPC 走 structured clone，
 * 函数会直接抛 `DataCloneError`——渲染层要渲染「可添加的存储类型」只能用这一份。
 */
export function listStoragePluginMeta(): StoragePluginMeta[] {
  return listStoragePlugins().map((plugin) => ({
    id: plugin.id,
    displayNameKey: plugin.displayNameKey,
    descriptionKey: plugin.descriptionKey,
    version: plugin.version,
    // 浅拷贝字段数组：调用方 push 不该改到注册表里的插件
    fields: plugin.fields.map((f) => ({ ...f })),
    capabilities: storageCapabilitiesOf(plugin),
  }))
}

/**
 * 「这条来源配置由哪个插件实现」的**唯一**判定处。
 *
 * 优先级：显式 `pluginId` → `kind` → 默认 `webdav`。
 *
 * 为什么保留 `kind` 兜底：`kind` 是本轮改造之前持久化里的唯一形态字段，
 * 用户的老配置（以及既有测试）都只有它。让这里按 `kind` 推导，老数据**零迁移**即可
 * 继续工作，同时新代码不必再碰 `kind`。等确认没有老配置在用，删掉这一个分支即可。
 *
 * 不做「查注册表失败就回落默认插件」：没注册的 id 是**配置错误**，调用方查不到插件后
 * 应当明确降级（跳过这条来源 / 给出「不支持的类型」），而不是悄悄换成别的协议去读写。
 */
export function librarySourcePluginId(
  source: Pick<LibrarySourceConfig, 'kind' | 'pluginId'> | null | undefined
): string {
  if (!source) return DEFAULT_STORAGE_PLUGIN_ID
  const explicit = typeof source.pluginId === 'string' ? source.pluginId.trim() : ''
  if (explicit) return explicit
  const kind = typeof source.kind === 'string' ? source.kind.trim() : ''
  return kind || DEFAULT_STORAGE_PLUGIN_ID
}

/**
 * 取某条来源配置对应的插件（**上层唯一查法**）。
 *
 * 组合了「配置 → 插件 id」与「id → 注册表」两步，免得调用方各写一遍、
 * 或者写成两套（平台层历史上确实出现过 `providerFor()` 与裸 `getMediaProvider` 并存）。
 */
export function storagePluginOf(
  source: Pick<LibrarySourceConfig, 'kind' | 'pluginId'> | null | undefined
): StoragePlugin | undefined {
  return getStoragePlugin(librarySourcePluginId(source))
}

/** 清空注册表（**仅供单测**：生产代码没有「卸载全部插件」的需求） */
export function clearStoragePluginsForTest(): void {
  STORAGE_PLUGINS.clear()
}
