/**
 * 插件执行器门面：上层**唯一**的音源调用入口。
 *
 * 改造前，这些操作按 `kind` 分派散落在 31 处（shared 16 / 平台层 10 / IPC 1 / UI 4），
 * 且「这条源能不能搜索」有四种写法。现在统一走这里：
 *
 * - 判定一律按**能力是否存在**（`typeof plugin.search === 'function'`），不看 `kind`；
 * - 找不到插件 = 配置错误，**跳过该源**并给出可读原因，而不是换别的插件执行；
 * - 能力缺失 = 正常降级（不参与聚合 / 不显示入口），不是错误。
 *
 * 上层（`musicSource.ts` 的聚合、平台层、设置页）只调本门面，不再 import 各形态实现。
 */

import type {
  DownloadQuality,
  OnlineSourceConfig,
  OnlineTrackSearchResult,
  SourceProbeResult,
  SourceTrackRef,
} from '../types'
import type { PluginContext, PreflightResult, ResolvedAudio, SourcePlugin } from './types'
import { getPlugin } from './registry'
import { pluginIdOf } from './pluginIdOf'
// 注册内置插件：执行器是所有人必经的门面。**在函数内调用**而不是模块顶层，
// 否则会撞上 musicSource → executor → builtins → auroraPlugin → musicSource 的环，
// 拿到尚未初始化的插件对象（见 builtins.ts 顶部说明）
import { ensureBuiltinsRegistered } from './builtins'

export { pluginIdOf }

/**
 * 取这条配置对应的插件。
 *
 * 返回 undefined 有三种可能，对调用方的含义都一样（跳过该源）：
 * 1. pluginId 指向的插件没注册（配置错误 / 插件被卸载）；
 * 2. 注册了但源被停用（enabled === false）；
 * 3. 配置本身为空。
 */
export function pluginForSource(
  source: OnlineSourceConfig | null | undefined
): SourcePlugin | undefined {
  ensureBuiltinsRegistered()
  if (!source) return undefined
  if (source.enabled === false) return undefined
  return getPlugin(pluginIdOf(source))
}

/**
 * 这条源是否可参与搜索聚合。
 *
 * 取代改造前的四种写法（`searchEndpointOf` / `isSearchableSource` / `isLxUsable` /
 * UI 里各写一遍）——它们的口径一旦分叉，就会出现「界面说能搜、实际搜不出」。
 */
export function canSearchSource(source: OnlineSourceConfig | null | undefined): boolean {
  ensureBuiltinsRegistered()
  const plugin = pluginForSource(source)
  if (!plugin || typeof plugin.search !== 'function') return false
  // 协议源还需要一条可用地址：URL 留空的源按约定只用于歌单解析
  if (plugin.id === 'aurora' && !String(source?.sourceUrl || '').trim()) return false
  // 脚本源还需要脚本地址
  if (plugin.id === 'lx' && !String(source?.sourceUrl || '').trim()) return false
  return true
}

/** 这条源是否能解析歌单（决定歌单导入时是否把它列进候选） */
export function canParsePlaylist(source: OnlineSourceConfig | null | undefined): boolean {
  ensureBuiltinsRegistered()
  const plugin = pluginForSource(source)
  return Boolean(plugin && typeof plugin.getPlaylistTracks === 'function')
}

/**
 * 这条源是否具备歌词能力。
 *
 * 判定依据是「插件能否派生出歌词端点」——协议源的端点由 `lyricEndpointOf` 派生，
 * 其它形态（脚本源等）没有这一层，自然为否。
 * 旧实现是 `if (source.kind === 'lx') continue`，加第三种形态时会漏掉它；
 * 现在改为按插件能力询问，新增插件只需声明 `lyrics` 能力。
 */
export function sourceHasLyrics(source: OnlineSourceConfig | null | undefined): boolean {
  const plugin = pluginForSource(source)
  if (!plugin) return false
  return plugin.capabilities.includes('lyrics')
}

/** 这条源是否支持惰性取址 */
export function canResolveTrack(source: OnlineSourceConfig | null | undefined): boolean {
  ensureBuiltinsRegistered()
  const plugin = pluginForSource(source)
  return Boolean(plugin && typeof plugin.resolveTrack === 'function')
}

/** 这条源是否需要登录才能用完它的全部能力 */
export function needsAuth(source: OnlineSourceConfig | null | undefined): boolean {
  ensureBuiltinsRegistered()
  const plugin = pluginForSource(source)
  return Boolean(plugin && typeof plugin.login === 'function')
}

/**
 * 搜索缓存键。
 *
 * 键里必须含「插件 id + 地址」：用户改了地址而 id 未变时缓存要立刻失效；
 * 不同插件共用一个地址也不能串味（改造前 lx 用特殊前缀正是为此）。
 */
export function sourceCacheKeyOf(source: OnlineSourceConfig): string {
  return `${pluginIdOf(source)}\u0001${source.id}\u0001${String(source.sourceUrl || '').trim()}`
}

// ─── 执行门面 ────────────────────────────────────────────────

/**
 * 搜索。能力缺失返回空数组（不是抛错）：调用方把它当「该源没搜到」，
 * 这正是改造前 `kind === 'lx'` 跳过逻辑想表达的语义。
 */
export async function searchViaPlugin(
  source: OnlineSourceConfig,
  query: string,
  quality: DownloadQuality | undefined,
  ctx: PluginContext
): Promise<OnlineTrackSearchResult[]> {
  ensureBuiltinsRegistered()
  const plugin = pluginForSource(source)
  if (!plugin || typeof plugin.search !== 'function') return []
  return plugin.search(source, query, quality, ctx)
}

/**
 * 惰性取址。失败返回 null（调用方回落按名搜索）——不抛错，这是既有编排的约定：
 * 取址失败不该打断播放，也不该交给播放器一个空地址。
 */
export async function resolveTrackViaPlugin(
  source: OnlineSourceConfig,
  ref: SourceTrackRef,
  quality: DownloadQuality | undefined,
  ctx: PluginContext
): Promise<ResolvedAudio | null> {
  ensureBuiltinsRegistered()
  const plugin = pluginForSource(source)
  if (!plugin || typeof plugin.resolveTrack !== 'function') return null
  return plugin.resolveTrack(source, ref, quality, ctx)
}

/** 探测。能力缺失时给「本环境不具备该能力」的结论，而不是抛错 */
export async function probeViaPlugin(
  source: OnlineSourceConfig,
  ctx: PluginContext,
  unavailableConclusion: (kind: OnlineSourceConfig['kind']) => SourceProbeResult
): Promise<SourceProbeResult> {
  ensureBuiltinsRegistered()
  const plugin = pluginForSource({ ...source, enabled: true })
  if (!plugin || typeof plugin.probe !== 'function') {
    return unavailableConclusion(source.kind)
  }
  return plugin.probe(source, ctx)
}

/** 列用户歌单（需要登录） */
export async function userPlaylistsViaPlugin(
  source: OnlineSourceConfig,
  ctx: PluginContext
): Promise<import('./types').PluginPlaylist[]> {
  ensureBuiltinsRegistered()
  const plugin = pluginForSource(source)
  if (!plugin || typeof plugin.listUserPlaylists !== 'function') return []
  return plugin.listUserPlaylists(source, ctx)
}

/** 取歌单内曲目 */
export async function playlistTracksViaPlugin(
  source: OnlineSourceConfig,
  playlistRef: string,
  ctx: PluginContext
): Promise<OnlineTrackSearchResult[]> {
  ensureBuiltinsRegistered()
  const plugin = pluginForSource(source)
  if (!plugin || typeof plugin.getPlaylistTracks !== 'function') return []
  return plugin.getPlaylistTracks(source, playlistRef, ctx)
}

/**
 * 构造插件执行上下文。
 *
 * `fetch` 用全局实现：插件不自带网络栈，同一份代码才能在两端共用。
 * 桌面端注册宿主时已把 Node 网络栈装进全局；移动端用的是 CapacitorHttp 包装版。
 */
export function hostContextOf(source?: OnlineSourceConfig | null): PluginContext {
  return {
    fetch: globalThis.fetch,
    headers: source?.headers,
  }
}

/**
 * 执行前置检查。插件没实现 `preflight` 视为「总是可跑」。
 *
 * 返回 `ok=false` 时调用方应**跳过该源**并把 `reason` 记进日志：
 * 这是「这条源此刻不可用」，不是「所有源请求失败」。
 */
export async function preflightViaPlugin(
  source: OnlineSourceConfig,
  ctx: PluginContext
): Promise<PreflightResult> {
  ensureBuiltinsRegistered()
  const plugin = pluginForSource(source)
  if (!plugin || typeof plugin.preflight !== 'function') return { ok: true }
  return plugin.preflight(source, ctx)
}
