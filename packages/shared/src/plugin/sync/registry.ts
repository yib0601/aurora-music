/**
 * 歌单同步插件注册表。
 *
 * 与存储插件注册表（`../storage/registry.ts`）**同一套范式**，不引入第二套机制：
 * 一个 Map、插入序即列表序、同 id 重复注册按「替换实现、保留位置」处理。
 *
 * 本文件是「配置里写的 `pluginId` → 到底哪个插件」的唯一查表入口。与存储侧的一处
 * 刻意差异：**没有 `DEFAULT` 回落**。同步配置的 `pluginId` 只可能由 UI 从
 * `listSyncPluginMeta()` 里选出来，缺失就是数据损坏，悄悄换成 `webdav-sync`
 * 去写用户的远端目录是最坏的一种"容错"。
 */

import {
  syncCapabilitiesOf,
  syncPluginAvailable,
  type LanSyncBridge,
  type SyncCapability,
  type SyncFieldDef,
  type SyncPlugin,
} from './types'
import type { MessageKey } from '../../i18n'
// 插件启停门禁。`availability` 零依赖（纯内存表），这条 import 不进任何环。
import { isPluginEnabled } from '../availability'

/** id → 插件。Map 的插入序即注册序 */
const SYNC_PLUGINS = new Map<string, SyncPlugin>()

/**
 * 插件 id 的合法形状。
 *
 * 与音源插件（`plugin/registry.ts`）、存储插件（`STORAGE_PLUGIN_ID_RE`）**同一正则**：
 * 同步插件的 id 同样会进持久化配置与（将来的）凭证文件名，三处口径必须一致。
 */
export const SYNC_PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/**
 * 插件的**纯数据**元信息。
 *
 * 为什么要单独有它：`SyncPlugin` 上挂着方法，Electron IPC 走 structured clone，
 * 函数会直接抛 `DataCloneError`——主进程/渲染层要渲染「可添加的同步方式」只能用这一份。
 */
export interface SyncPluginMeta {
  readonly id: string
  readonly displayNameKey: MessageKey
  readonly descriptionKey?: MessageKey
  readonly version: string
  readonly fields: readonly SyncFieldDef[]
  readonly capabilities: readonly SyncCapability[]
  /** 运行期可用性（缺依赖的插件为 false：入口隐藏，已存配置显示「此平台不支持」） */
  readonly available: boolean
  /** 用户在插件管理里是否启用了它（`availability` 的启停表） */
  readonly enabled: boolean
}

/**
 * 注册插件。
 *
 * 同一 id 重复注册视为「替换实现」并**保留原位置**：这既是插件热更新需要的语义，
 * 也避免了多次 import 时列表顺序抖动（UI 每次刷新看到的顺序一致）。
 */
export function registerSyncPlugin(plugin: SyncPlugin): void {
  const id = plugin?.id
  if (typeof id !== 'string' || !SYNC_PLUGIN_ID_RE.test(id)) {
    // id 会进入持久化配置，非法 id 必须挡在注册这一关，而不是等到落盘才炸
    throw new Error(`[sync-plugin] invalid plugin id: ${String(id)}`)
  }
  if (!Array.isArray(plugin.fields)) {
    // 字段声明是 UI 通用渲染的输入；缺失会让设置页渲染出空表单而不报错，必须在注册期拦下
    throw new Error(`[sync-plugin] plugin "${id}" must declare a fields array`)
  }
  SYNC_PLUGINS.set(id, plugin)
}

/**
 * 撤销注册（插件被卸载 / 单测清理）。
 *
 * 不抛错也不校验形状：撤销一个没注册过的 id 是幂等的空操作——调用方常常在
 * 「配置里还留着一个已卸载插件的记录」这种场景下批量撤销，让这里抛错只会逼出 try/catch。
 */
export function unregisterSyncPlugin(id: string): void {
  if (typeof id !== 'string' || !id) return
  SYNC_PLUGINS.delete(id)
}

/**
 * 按 id 取插件；未注册返回 undefined（调用方据此降级，不抛错）。
 *
 * **这里不查启停表**：停用是用户对本机 UI 的决定，而"该源用哪个实现"是数据问题。
 * 需要两者合并判断的调用方请自己再问一次 `isPluginEnabled(plugin.id)`
 * （原因与存储侧的 `storagePluginOf` 注释同一段：停用 vs 未注册要给用户不同的解释）。
 */
export function getSyncPlugin(id: string): SyncPlugin | undefined {
  if (typeof id !== 'string' || !id) return undefined
  return SYNC_PLUGINS.get(id)
}

/** 全部已注册插件，按注册顺序 */
export function listSyncPlugins(): SyncPlugin[] {
  return [...SYNC_PLUGINS.values()]
}

/**
 * 全部插件的**纯数据**元信息，顺序与 `listSyncPlugins()` 完全一致。
 *
 * 纯数据是可过 IPC 的硬要求：`fields` 逐项浅拷贝、`capabilities` 每次新建数组，
 * 调用方 push 不该改到注册表里的插件。
 */
export function listSyncPluginMeta(): SyncPluginMeta[] {
  return listSyncPlugins().map((plugin) => {
    const meta: SyncPluginMeta = {
      id: plugin.id,
      displayNameKey: plugin.displayNameKey,
      ...(plugin.descriptionKey ? { descriptionKey: plugin.descriptionKey } : {}),
      version: plugin.version,
      fields: plugin.fields.map((f) => ({ ...f })),
      capabilities: syncCapabilitiesOf(plugin),
      available: syncPluginAvailable(plugin),
      enabled: isPluginEnabled(plugin.id),
    }
    return meta
  })
}

/* ------------------------------------------------------------------ *
 * 局域网桥（主进程能力，仅桌面端）
 * ------------------------------------------------------------------ */

/**
 * 宿主注入的局域网桥。
 *
 * 为什么是「注册表里的一个槽」而不是 `SyncContext.lan` 之外的第二条路：
 * `available()` 必须在**没有 ctx** 的地方也能回答（插件管理页要列入口），
 * 所以桥的存在性只能落在一个进程级单例上；`ctx.lan` 是它的一次调用级快照。
 */
let lanBridge: LanSyncBridge | null = null

/**
 * 注入 / 清空局域网桥。传 `null` 表示「本平台没有这个能力」。
 *
 * 桌面端在启动时装桥，非桌面端永远不装：`lan-sync` 的 `available()` 就是问这一个槽。
 */
export function setLanSyncBridge(bridge: LanSyncBridge | null): void {
  lanBridge = bridge ?? null
}

/** 当前的局域网桥；非桌面端为 null */
export function getLanSyncBridge(): LanSyncBridge | null {
  return lanBridge
}

/** 清空注册表（**仅供单测**：生产代码没有「卸载全部插件」的需求） */
export function clearSyncPluginsForTest(): void {
  SYNC_PLUGINS.clear()
}
