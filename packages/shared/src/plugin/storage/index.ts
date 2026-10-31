/**
 * 存储插件层出口（内置注册 + 契约 + 注册表）。
 *
 * 注册动作放在 import 期完成：与本仓既有的音源插件（`plugin/index.ts`）、
 * 以及改造前的 `mediaProvider.ts` 把 webdav provider 随模块注册一致。
 * 上层（三端平台层、设置页、播放代理）只从这里取插件与注册表，
 * **不再按 kind 判断形态**。
 */

import { registerStoragePlugin } from './registry'
import { webdavStoragePlugin } from './webdavStoragePlugin'

export type {
  StorageFieldDef,
  StorageFieldKind,
  StoragePlugin,
  StoragePluginCapability,
  StoragePluginMeta,
  StorageProbeResult,
} from './types'
export { storageCapabilitiesOf } from './types'
export { storageFieldValue, storageStringField } from './fields'
export {
  isStorageTransportError,
  markTransportError,
  storageErrorStatus,
} from './errors'
export {
  DEFAULT_STORAGE_PLUGIN_ID,
  clearStoragePluginsForTest,
  getStoragePlugin,
  librarySourcePluginId,
  listStoragePluginMeta,
  listStoragePlugins,
  registerStoragePlugin,
  registeredStoragePluginIds,
  storagePluginOf,
} from './registry'
export { WEBDAV_STORAGE_FIELDS, webdavStoragePlugin } from './webdavStoragePlugin'

/**
 * 内置存储插件清单（按注册顺序，UI 列出的顺序即此顺序）。
 *
 * 目前只有 webdav：它是唯一的落成协议。新增协议（SMB / SFTP / Jellyfin …）
 * 在这里追加一项即可，设置页与播放代理零改动。
 */
export const BUILTIN_STORAGE_PLUGINS = [webdavStoragePlugin] as const

for (const plugin of BUILTIN_STORAGE_PLUGINS) registerStoragePlugin(plugin)
