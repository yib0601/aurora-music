/**
 * 存储插件层出口（内置注册 + 契约 + 注册表）。
 *
 * 注册动作放在 import 期完成：与本仓既有的音源插件（`plugin/index.ts`）、
 * 以及改造前的 `mediaProvider.ts` 把 webdav provider 随模块注册一致。
 * 上层（三端平台层、设置页、播放代理）只从这里取插件与注册表，
 * **不再按 kind 判断形态**。
 */

import { registerStoragePlugin } from './registry'
import { isolatePluginStep } from '../health'
import { webdavStoragePlugin } from './webdavStoragePlugin'
import { sftpStoragePlugin } from './sftpStoragePlugin'
import { smbStoragePlugin } from './smbStoragePlugin'

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

// SFTP / SMB：协议实现依赖（ssh2 / @marsaud/smb2）**只装在桌面端**，
// 所以这里用注入模式（setSsh2Module / setSmb2Module）而不是直接 import 那两个包。
export {
  SFTP_STORAGE_FIELDS,
  parseRangeHeader,
  sftpConnectionOf,
  sftpRemotePathOf,
  sftpStoragePlugin,
  setSsh2Module,
  ssh2Available,
} from './sftpStoragePlugin'
export type {
  Ssh2Client,
  Ssh2ConnectConfig,
  Ssh2FileEntry,
  Ssh2Module,
  Ssh2ReadStream,
  Ssh2Sftp,
  Ssh2Stats,
} from './sftpStoragePlugin'
export {
  SMB_STORAGE_FIELDS,
  parseSmbRangeHeader,
  setSmb2Module,
  smb2Available,
  smbPathOf,
  smbStoragePlugin,
} from './smbStoragePlugin'
export type {
  Smb2Client,
  Smb2Constructor,
  Smb2FileEntry,
  Smb2Options,
  Smb2Stats,
} from './smbStoragePlugin'

/**
 * 内置存储插件清单（按注册顺序，UI 列出的顺序即此顺序）。
 *
 * 目前只有 webdav：它是唯一的落成协议。新增协议（SMB / SFTP / Jellyfin …）
 * 在这里追加一项即可，设置页与播放代理零改动。
 */
/**
 * 内置存储插件清单（按注册顺序，UI 列出的顺序即此顺序）。
 *
 * 注意：SFTP 与 SMB 的**依赖**只在桌面端存在。在移动端它们仍会出现在列表里，
 * 但 `probe` 会返回「本机不支持」—— 这比"插件凭空消失"更可解释
 * （用户能看懂"这台设备不支持"，而不是"为什么我的 NAS 在手机上没了"）。
 */
export const BUILTIN_STORAGE_PLUGINS = [
  webdavStoragePlugin,
  sftpStoragePlugin,
  smbStoragePlugin,
] as const

/**
 * 注册内置存储插件 —— **模块求值期**执行，因此这里是全仓离"启动崩溃"最近的一行。
 *
 * `registerStoragePlugin` 对非法 id 与缺失 `fields` 都会抛错，而这段代码在任何
 * `import '@aurora/shared'` 的模块体里跑：一次抛错等于把整个包（以及依赖它的
 * 主进程入口）在 import 阶段打挂，表现是"双击图标没反应"，连日志都来不及落盘。
 *
 * 所以逐条包住：坏的那条进失败清单（UI 启动后会提示），其余照常注册，
 * 存储能力本身仍可用。
 */
for (const plugin of BUILTIN_STORAGE_PLUGINS) {
  isolatePluginStep('storage', (plugin as { id?: string } | undefined)?.id, () =>
    registerStoragePlugin(plugin)
  )
}
