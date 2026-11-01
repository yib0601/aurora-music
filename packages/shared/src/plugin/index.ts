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
export {
  registerPlugin,
  unregisterPlugin,
  getPlugin,
  listPlugins,
  hasCapability,
  clearPluginsForTest,
} from './registry'
export {
  ensureBuiltinsRegistered,
  builtinPlugins,
  degradedBuiltins,
  resetBuiltinsRegistrationForTest,
} from './builtins'
// 宿主能力注册表：插件「需要宿主给什么」的判定层。
// 与 `../health`（加载是否成功）是两件事：那个记"坏了"，这个记"这个端做不了"。
export {
  HOST_CAPABILITY_VERSION,
  clearHostCapabilitiesForTest,
  describeMissingCapabilities,
  getHostCapability,
  listHostCapabilities,
  registerHostCapability,
  requirementsOfManifest,
  resolveRequirements,
  unregisterHostCapability,
} from './hostCapabilities'
export type {
  CapabilityGap,
  CapabilityRequirement,
  HostCapability,
  HostCapabilityId,
  ManifestDependencyInput,
  PluginAvailability,
} from './hostCapabilities'
export type { PluginFailure, PluginFailureStage, PluginStartupReport } from './health'
export {
  clearPluginFailuresForTest,
  isolatePluginStep,
  notePluginFailure,
  pluginFailures,
  pluginStartupReport,
} from './health'
export { pluginIdOf, pluginFieldsOf, DEFAULT_PLUGIN_ID } from './pluginIdOf'
export {
  pluginForSource,
  canSearchSource,
  canParsePlaylist,
  canResolveTrack,
  sourceHasLyrics,
  lyricsSourceViaPlugin,
  needsAuth,
  sourceCacheKeyOf,
  searchViaPlugin,
  resolveTrackViaPlugin,
  probeViaPlugin,
  userPlaylistsViaPlugin,
  playlistTracksViaPlugin,
  preflightViaPlugin,
  hostContextOf,
  canBrowseHall,
  recommendViaPlugin,
  toplistsViaPlugin,
  toplistDetailViaPlugin,
} from './executor'
// 单曲取址的统一编排（跨端共用；取代两端的 `kind === 'lx'` 形态分支）
export {
  resolveTrackAudioViaPlugin,
  trackRefFor,
} from './trackAudio'
export type { TrackResolution, TrackResolutionInput } from './trackAudio'
export { auroraPlugin, AURORA_PLUGIN_CAPABILITIES } from './auroraPlugin'
export { lxPlugin, LX_PLUGIN_CAPABILITIES } from './lxPlugin'
export { qishuiPlugin, qishuiCoverUrl, extractSessionId } from './qishuiPlugin'

// 兜底：任何 import 了插件层出口的模块都保证注册表已填充
ensureBuiltinsRegistered()
