/**
 * 插件层出口。
 *
 * 上层（三端平台层、设置页）只从这里取插件与注册表，**不再按 kind 判断形态**。
 * 注册动作放在 import 期完成：与 `mediaProvider.ts` 把 webdav provider 随模块注册一致。
 */

import { ensureBuiltinsRegistered } from './builtins'

export type {
  PluginAuthState,
  PluginCapability,
  PluginContext,
  PluginCredential,
  PluginPlaylist,
  PreflightResult,
  ResolvedAudio,
  SourcePlugin,
} from './types'
export { registerPlugin, getPlugin, listPlugins, hasCapability, clearPluginsForTest } from './registry'
export {
  ensureBuiltinsRegistered,
  builtinPlugins,
  resetBuiltinsRegistrationForTest,
} from './builtins'
export { pluginIdOf, pluginFieldsOf, DEFAULT_PLUGIN_ID } from './pluginIdOf'
export {
  pluginForSource,
  canSearchSource,
  canParsePlaylist,
  canResolveTrack,
  sourceHasLyrics,
  needsAuth,
  sourceCacheKeyOf,
  searchViaPlugin,
  resolveTrackViaPlugin,
  probeViaPlugin,
  userPlaylistsViaPlugin,
  playlistTracksViaPlugin,
  preflightViaPlugin,
  hostContextOf,
} from './executor'
export { auroraPlugin, AURORA_PLUGIN_CAPABILITIES } from './auroraPlugin'
export { lxPlugin, LX_PLUGIN_CAPABILITIES } from './lxPlugin'
export { qishuiPlugin, qishuiCoverUrl, extractSessionId } from './qishuiPlugin'

// 兜底：任何 import 了插件层出口的模块都保证注册表已填充
ensureBuiltinsRegistered()
