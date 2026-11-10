/**
 * 同步插件层出口（内置插件注册 + 契约 + 注册表 + 快照/合并/曲目解析）。
 *
 * 注册动作放在**模块求值期**完成，与 `plugin/storage/index.ts`、`plugin/index.ts` 一致：
 * 上层（三端平台层、设置页、同步引擎）只从这里取插件与注册表，
 * **不再按 `pluginId` 判断形态**（能力一律用方法存在性判定）。
 */

import { isolatePluginStep } from '../health'
import { lanSyncPlugin } from './lanSyncPlugin'
import { registerSyncPlugin } from './registry'
import { webdavSyncPlugin } from './webdavSyncPlugin'

// ─── 契约类型（`types.ts` 已定稿，勿改语义） ───────────────
export type {
  LanPeerInfo,
  LanSyncBridge,
  LanSyncStatus,
  LanSyncTarget,
  SyncCapability,
  SyncConfig,
  SyncContext,
  SyncDirection,
  SyncFieldDef,
  SyncFieldKind,
  SyncPlugin,
  SyncProbeResult,
  SyncSecrets,
  SyncSnapshot,
  SyncTrackMeta,
  SyncTrackRef,
  SyncedPlaylist,
} from './types'
export { SYNC_LAN_PROTOCOL_VERSION, SYNC_SNAPSHOT_FORMAT, syncCapabilitiesOf, syncPluginAvailable } from './types'

// ─── 注册表 ────────────────────────────────────────────────
export {
  SYNC_PLUGIN_ID_RE,
  clearSyncPluginsForTest,
  getLanSyncBridge,
  getSyncPlugin,
  listSyncPluginMeta,
  listSyncPlugins,
  registerSyncPlugin,
  setLanSyncBridge,
  unregisterSyncPlugin,
} from './registry'
export type { SyncPluginMeta } from './registry'

// ─── 快照 ──────────────────────────────────────────────────
export {
  SYNC_TOMBSTONE_TTL_MS,
  isSnapshotOfDevice,
  isTombstoneExpired,
  parseSnapshot,
  pruneSnapshot,
  serializeSnapshot,
  snapshotContentHash,
} from './snapshot'

// ─── 曲目引用 ──────────────────────────────────────────────
export { buildMatchIndex, resolveSyncTrackRef, toSyncTrackRef } from './trackRef'
export type { SyncMatchIndex, SyncMatchIndexOptions, SyncMatchTrack } from './trackRef'

// ─── 合并 ──────────────────────────────────────────────────
export { mergeSnapshots } from './merge'
export type { MergeOutcome } from './merge'

// ─── 内置插件 ──────────────────────────────────────────────
export { webdavSyncPlugin } from './webdavSyncPlugin'
export { lanSyncPlugin } from './lanSyncPlugin'

/**
 * 内置同步插件清单（按注册顺序，UI 列出的顺序即此顺序）。
 *
 * WebDAV 全平台可用；局域网同步依赖桌面端主进程桥，`available()` 会如实返回 false
 * （移动端入口隐藏）——不把它从这里删掉，是为了让"这台设备不支持"可解释。
 */
export const BUILTIN_SYNC_PLUGINS = [webdavSyncPlugin, lanSyncPlugin] as const

/**
 * 注册内置同步插件 —— **模块求值期**执行，因此这里是全仓离"启动崩溃"最近的一行。
 *
 * `registerSyncPlugin` 对非法 id 与缺失 `fields` 都会抛错，而这段代码在任何
 * `import '@aurora/shared'` 的模块体里跑：一次抛错等于把整个包（以及依赖它的
 * 主进程入口）在 import 阶段打挂，表现是"双击图标没反应"，连日志都来不及落盘。
 *
 * 所以逐条包住（`isolatePluginStep('sync', …)`）：坏的那条进失败清单，其余照常注册，
 * 同步能力本身仍可用。
 */
for (const plugin of BUILTIN_SYNC_PLUGINS) {
  isolatePluginStep('sync', (plugin as { id?: string } | undefined)?.id, () =>
    registerSyncPlugin(plugin)
  )
}
