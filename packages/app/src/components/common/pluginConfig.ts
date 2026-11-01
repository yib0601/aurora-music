/**
 * 插件自带配置的**归属判定**（纯逻辑，可单测）。
 *
 * ## 这一层解决什么
 *
 * 改造前，插件的配置散在设置页的两个分区里，且与插件列表分处不同位置：
 *
 * - 「在线源」分区里同时放着音源配置行、插件登录面板和插件列表；
 * - 「我的音乐」分区里放着网络存储配置行（而存储本身也是插件）。
 *
 * 于是同一条信息出现在两处：用户在插件列表里看到「Aurora 协议源」开着的开关，
 * 却要去另一个行里找它的服务地址；想给 SFTP 改密码，得先去「我的音乐」，而
 * 「我的音乐」这个词与「SFTP」之间没有任何语义联系。
 *
 * 现在配置一律**按插件归属**：每份配置都带 `pluginId`（老配置由 `kind` 推导，见
 * `pluginIdOf` / `librarySourcePluginId`），插件设置面板据此把自己那份挑出来。
 * 本文件是「哪份配置属于哪个插件」的**唯一**判定处，UI 只消费它的结果。
 *
 * ## 为什么不在 UI 里直接 filter
 *
 * 归属判定涉及两条不同的兼容规则（音源按 `pluginIdOf`，存储按 `librarySourcePluginId`），
 * 两者都带老配置兜底分支。写进 JSX 就等于让每个渲染点各记一遍，漏一处就会出现
 * 「这条配置在插件设置里看不见」——而它仍然在后台工作，是最难排查的一类错位。
 */

import type { PluginCatalogEntry } from '@aurora/shared'
import type { PluginFormKind } from './pluginForm'
import { librarySourcePluginId, pluginIdOf } from '@aurora/shared'
import type { LibrarySourceConfig, OnlineSourceConfig } from '@/types'

/**
 * 一个插件可能拥有的配置面。
 *
 * 三种面互不排斥（未来可能出现「既能搜索又要登录」的存储插件），所以是数组而不是
 * 单值枚举。`'auth'` 不是配置而是一份**凭证**，但它对用户同样是「这个插件自己的设置」，
 * 放在同一个面板里才不用记住「登录要去另一行」。
 */
export type PluginConfigSurface = 'sources' | 'storage' | 'auth'

/** 某个插件当前持有的配置（已按归属挑好） */
export interface PluginConfigBundle {
  /** 这个插件执行的在线音源配置（含歌词形态） */
  sources: OnlineSourceConfig[]
  /** 这个插件执行的网络存储配置 */
  librarySources: LibrarySourceConfig[]
  /** 这个插件能配置哪些面（决定面板显示哪些分段） */
  surfaces: PluginConfigSurface[]
}

/** 能力清单里是否声明了某能力（目录条目上是字符串数组，声明与实现在此不做真源判断） */
function declares(entry: PluginCatalogEntry, capability: string): boolean {
  return Array.isArray(entry.capabilities) && entry.capabilities.includes(capability)
}

/**
 * 本端是否真的能配这一类插件（能力探测，答案随端而变）。
 *
 * 为什么这个判断必须参与「有没有配置面」：插件目录是**跨域统一视图**
 * （`buildPluginCatalog` 总是带上内置存储插件），于是手机端的插件列表里
 * 同样会出现 WebDAV / SFTP / SMB 条目。但移动端没有主进程侧的存储代理与扫描，
 * 那一条目的「配置」打开后是一个空的网络存储分区 —— 用户看到的是"功能坏了"。
 *
 * 所以「有没有配置面」必须同时回答「这个端做不做得到」，两处判定若分开写，
 * 迟早出现「卡片上有齿轮、点开是空的」。
 */
export interface PluginConfigCapability {
  /** 本端是否具备存储插件代理与扫描（`platform.scanLibrarySource` 存在） */
  storage?: boolean
}

/**
 * 这个插件有哪些可配置面。
 *
 * 判据是**域 + 能力声明**，不是插件 id：
 * - `domain === 'source'`：它的配置是「在线音源」（服务地址 / 脚本链接 / 歌单 id）；
 * - `domain === 'storage'`：它的配置是「网络存储」（服务地址 + 账号）；
 * - 声明了 `auth`：它需要一份登录凭证。
 *
 * `capability.storage` 为 false 时**整个存储面不出现**（见上一条注释：那是"这一端
 * 做不到"，不是"这个插件没有"）。缺省（不传）按支持处理，便于纯逻辑单测。
 *
 * 纯歌词插件（`domain === 'lyrics'` 且无 auth）在这套模型里没有用户配置，
 * 因此返回空数组 —— 面板据此不显示「配置」入口，而不是给一个空面板。
 */
export function pluginConfigSurfaces(
  entry: PluginCatalogEntry,
  capability: PluginConfigCapability = {}
): PluginConfigSurface[] {
  const surfaces: PluginConfigSurface[] = []
  if (entry.domain === 'source') surfaces.push('sources')
  if (entry.domain === 'storage' && capability.storage !== false) surfaces.push('storage')
  if (declares(entry, 'auth')) surfaces.push('auth')
  return surfaces
}

/**
 * 这个插件是否**有**可配置项（决定插件的「配置」按钮显不显示）。
 *
 * 与 `pluginConfigSurfaces().length > 0` 同义，但调用点读起来更直白：
 * UI 要回答的是「这个插件我能进去配点什么吗」，不是「它有哪几个面」。
 *
 * **必须与面板传同一个 `capability`**：卡片上的齿轮与面板里的分区若用了不同判据，
 * 就会出现"点进去是空的"（这正是本函数收 capability 入参的理由）。
 */
export function hasPluginConfig(
  entry: PluginCatalogEntry,
  capability: PluginConfigCapability = {}
): boolean {
  return pluginConfigSurfaces(entry, capability).length > 0
}

/**
 * 按插件归属挑出配置。
 *
 * 归属判定全部委托给 shared 的两个**唯一**入口（音源 `pluginIdOf`、
 * 存储 `librarySourcePluginId`）：它们各自带「老配置只有 `kind`」的兜底分支，
 * 在这里重新推导一遍就会与执行侧的口径分叉 —— 表现为「设置里配好了，但播放时
 * 走的是另一个插件」，或反过来。
 */
export function configsOfPlugin(
  entry: PluginCatalogEntry,
  onlineSources: readonly OnlineSourceConfig[],
  librarySources: readonly LibrarySourceConfig[],
  capability: PluginConfigCapability = {}
): PluginConfigBundle {
  const surfaces = pluginConfigSurfaces(entry, capability)
  return {
    surfaces,
    sources: surfaces.includes('sources')
      ? onlineSources.filter((source) => pluginIdOf(source) === entry.id)
      : [],
    librarySources: surfaces.includes('storage')
      ? librarySources.filter((source) => librarySourcePluginId(source) === entry.id)
      : [],
  }
}

/**
 * 插件列表里给用户的一句话摘要。
 *
 * 目的只有一个：让人在**不进面板**的情况下看出「这个插件我配过东西没有」。
 * 返回的是 `{ sources, librarySources }` 两个数字而不是拼好的句子 ——
 * 拼接需要语言与复数规则，那属于渲染层（数据层不烧文案，与全仓一致）。
 */
export function configSummaryOf(bundle: PluginConfigBundle): {
  sources: number
  librarySources: number
  auth: boolean
} {
  return {
    sources: bundle.sources.length,
    librarySources: bundle.librarySources.length,
    auth: bundle.surfaces.includes('auth'),
  }
}

/**
 * 新建配置时应写入的插件 id。
 *
 * 走 `pluginFieldsOf` 的形状（只写 `pluginId`，不再写 `kind`）—— 这一步直接决定
 * 新配置归谁所有：写成 `kind` 会让归属判定退到老配置兜底分支，而兜底只认
 * aurora / lx 两种，第三方插件写 `kind` 等于把归属丢掉。
 */
export function newConfigOwner(entry: PluginCatalogEntry): { pluginId: string } {
  return { pluginId: entry.id }
}

/**
 * 新建一条音源时，它该不该**默认启用**。
 *
 * ## 为什么这是一条需要单测的规则
 *
 * 三种形态的答案不同，且其中一个答案是"看探测结果"：
 *
 * - `service`（协议源）：地址由用户明确填的服务地址派生，能存就是能用 → 启用；
 * - `playlist`（歌单形态）：只是一个歌单定位串，取曲目时才会发请求 → 启用；
 * - `script`（洛雪脚本）：**脚本能不能跑取决于它当下能不能下载并执行**。
 *   探测没通过就落 `enabled: false` —— 源不可用就不该默认参与搜索，否则每次搜索
 *   都要白等一轮脚本拉取失败。
 *
 * 第三档是最容易在重构里丢的一条：它不像前两档那样"存了就完事"，而是一个
 * 「允许先存下来、但先别用」的中间态。改造中它确实丢过一次（新增弹窗搬家的
 * 四个保存分支各写各的 `enabled: true`），而当时没有任何单测覆盖保存动作 ——
 * 所以现在把这条判定提成一个纯函数，让"存下来用什么状态"只有一处答案。
 *
 * `probeOk` 只在 `script` 形态下有意义；另外两档传什么都返回 `true`
 * （不做防御式忽略：调用方读起来就是"这两档恒启用"）。
 */
export function newSourceEnabled(formKind: PluginFormKind, probeOk?: boolean): boolean {
  if (formKind === 'script') return probeOk === true
  return true
}
