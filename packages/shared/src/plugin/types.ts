/**
 * 插件契约（shared 层，双端共用）
 *
 * ## 为什么是「可选方法」而不是「kind 联合」
 *
 * 改造前音源只有两种硬编码形态（`OnlineSourceKind = 'aurora' | 'lx'`），形态判定散落在
 * 4 层 15 个文件 31 处，加第三种形态要处处改分支；更糟的是「这条源能不能搜索」有四种
 * 不同写法，口径一分叉就出现「界面说能搜、实际搜不出」。
 *
 * 这里的模型是：**插件 = 一组能力，能力缺失用「方法不存在」表达**。
 * 调用方一律按能力探测（`typeof plugin.search === 'function'`），
 * **不得**再出现 `kind === 'xxx'` 这类形态判断。
 *
 * 沿用仓库既有范式：`packages/shared/src/mediaProvider.ts` 的 `MediaProvider` 与
 * app 平台层 `PlatformExtension` 的可选方法约定 —— 不引入第二套机制。
 *
 * ## 三条从既有代码里踩出来的强约束
 *
 * 1. **`SourceTrackRef` 保持不透明**：应用只携带、不解释，取址时原样交回插件。
 * 2. **空 `audioUrl` + `trackRef` = 惰性取址**，这是一等协议语义而非补丁
 *    （现例：洛雪脚本源只给元信息，取址逐曲按需触发）。
 * 3. **试听片段必须如实标记**：`resolveTrack` 返回 `isPreview` / `previewDurationMs`
 *    （现例：汽水 VIP-only 曲目只给 29–60 秒）。若把试听当完整曲目交给播放器，
 *    用户听到一半断掉，观感是「播放失败」而不是「试听」。
 *
 * ## 文本
 *
 * 本层**不烧中文界面文案**：展示名给文案键（`MessageKey`），失败原因走
 * `auroraError` 结构化信封，由显示端在渲染期按语言取值。
 */

import type { MessageKey } from '../i18n'
// 依赖声明的形状。type-only：本文件是契约形状层，不引入运行期依赖
import type { CapabilityRequirement } from './hostCapabilities'
import type {
  DownloadQuality,
  MusicHallOptions,
  OnlineSourceConfig,
  OnlineTrackSearchResult,
  RecommendPlaylist,
  SourceProbeResult,
  SourceTrackRef,
  ToplistDetail,
  ToplistGroup,
} from '../types'

/**
 * 插件能力标识。
 *
 * 用途只有两个：UI 展示能力徽章、判断某个能力是否「声明了但运行期不可用」。
 * **不要**用它替代 `typeof plugin.xxx === 'function'` 做调用前的判定——
 * 那会让「声明」与「实现」产生第二份真源。
 */
export type PluginCapability =
  | 'probe'
  | 'search'
  | 'resolveTrack'
  | 'lyrics'
  | 'playlistParse'
  | 'userPlaylists'
  | 'playlistTracks'
  | 'auth'
  /** 在线发现：推荐歌单列表 */
  | 'recommendPlaylists'
  /** 在线发现：榜单列表 */
  | 'toplists'
  /** 在线发现：榜单详情 */
  | 'toplistDetail'

/**
 * 插件凭证（登录态）。
 *
 * **不得**塞进 `OnlineSourceConfig`：那个类型会被渲染层的 persist 白名单截断
 * （`packages/app/src/stores/libraryStore.ts` 的 `partialize`），而且它是明文进
 * localStorage 的。凭证的落盘由桌面端 `safeStorage` 负责（见
 * `packages/desktop/src/ipc/pluginCredentials.ts`），本层只定义形状。
 *
 * 约定：`payload` 里放插件自己的不透明字段（如汽水的 `{ sessionid }`），
 * 上层不解释内容，只在调用插件时原样交回。
 */
export interface PluginCredential {
  pluginId: string
  /** 插件自定义的凭证载荷（不透明，可 JSON 序列化） */
  payload: Record<string, unknown>
  /** 写入时间（毫秒），用于 UI 显示「上次登录」与过期提示 */
  savedAt: number
}

/**
 * 前置检查结论。
 * `ok=false` 时 `reason` 是给人看的原因（插件负责给可读文案或结构化信封）。
 */
export interface PreflightResult {
  ok: boolean
  reason?: string
}

/** 登录态查询结果：只回状态，**不回凭证原文** */
export interface PluginAuthState {
  /** 是否已保存凭证 */
  loggedIn: boolean
  /**
   * 凭证是否仍然有效。
   * `unknown` = 未校验（离线 / 该插件不做校验），UI 不得据此显示「已失效」。
   */
  valid?: boolean
  /** 账号展示名（插件能给才给，用于「已登录为 xxx」） */
  accountName?: string
  /** 失效原因（`valid === false` 时给），结构化信封或自由文本 */
  reason?: string
}

/** 插件列出的歌单（「我的歌单」/ 歌单搜索结果共用一份形状） */
export interface PluginPlaylist {
  /** 插件内唯一的歌单 id（原样保存，导入时交回插件） */
  id: string
  title: string
  coverUrl?: string
  /** 曲目数（插件能给才给） */
  trackCount?: number
  /** 简介 */
  description?: string
}

/** 惰性取址的结果 */
export interface ResolvedAudio {
  url: string
  /** 实际音质档位（插件自报，供 UI 展示） */
  quality?: string
  /** 多音质地址（插件能给才给） */
  qualityUrls?: Partial<Record<DownloadQuality, string>>
  coverUrl?: string
  /**
   * **是否为试听片段**（不是完整曲目）。
   * 插件必须如实标记：把试听当完整曲目交给播放器，用户会在中途被截断，
   * 观感是「播放失败」而不是「试听」，这是本契约里最容易踩的一条。
   */
  isPreview?: boolean
  /** 试听片段时长（毫秒），`isPreview` 为 true 时给 */
  previewDurationMs?: number
  /** 完整曲目时长（毫秒），供 UI 显示「试听 0:30 / 全长 3:41」 */
  fullDurationMs?: number
  /** 地址过期时间（毫秒时间戳）。有则上层据此决定是否需要重新取址 */
  expireAt?: number
}

/**
 * 插件执行上下文。
 *
 * `fetch` 由**发起调用的那一侧**注入：桌面端在主进程（要 Node 网络栈、且渲染进程直连
 * 上游会被 CORS 拦），移动端在 WebView 内直调。插件实现只依赖这个注入的 fetch，
 * 不自带网络栈——否则同一份插件代码无法在两端共用。
 */
export interface PluginContext {
  /** 注入的网络实现（限制：不得读写宿主配置、数据库、文件系统） */
  fetch: typeof globalThis.fetch
  /** 附加请求头（用户在音源配置里填的 headers，同名覆盖） */
  headers?: Record<string, string>
  /** 已保存的凭证（未登录为 null）；插件自行决定怎么用 */
  credential?: PluginCredential | null
  /** 诊断日志出口（可选） */
  log?: (message: string, detail?: unknown) => void
}

/**
 * 音源插件。
 *
 * 所有能力方法都是**可选**的：不存在即表示不支持，调用方据此降级（隐藏入口 / 空态 /
 * 回落其它路径），而不是抛错、也不需要形态判断。
 */
export interface SourcePlugin {
  /** 插件唯一 id（落盘文件名、凭证键都用它）。必须匹配 `^[a-z0-9][a-z0-9._-]*$` */
  readonly id: string
  /** UI 展示名：**文案键**，渲染期 `t()` 取值 */
  readonly displayNameKey: MessageKey
  /** 一句话说明（文案键），用于设置页副标题 */
  readonly descriptionKey?: MessageKey
  /** 插件自身版本（与 App 版本无关） */
  readonly version: string
  /** 能力清单（供 UI 渲染徽章；调用前判定仍用方法是否存在） */
  readonly capabilities: readonly PluginCapability[]

  /**
   * **宿主依赖声明**：本插件要求宿主提供哪些能力。
   *
   * 与 `capabilities` 方向相反 —— 那个是「我能做什么」，这个是「我需要宿主给我什么」。
   * 由 `hostCapabilities.resolveRequirements()` 在**注册之前**判定：必需的缺失时
   * 插件不会被注册，UI 明确显示"当前平台缺少 X"，而不是装上去点播放才失败。
   *
   * 缺省视为「无依赖」：纯计算型插件（如只做字段映射）确实不需要任何宿主能力。
   * **内置插件手写**（作者就是仓库作者）；**声明式插件由清单推导**
   * （`requirementsOfManifest`），不提供手写入口，避免两份真源。
   */
  readonly requires?: readonly CapabilityRequirement[]

  // ─── 只读能力 ───────────────────────────────────────────────

  /** 探测：连通性 / 鉴权 / 可用能力，返回形态无关的结论 */
  probe?(config: OnlineSourceConfig, ctx: PluginContext): Promise<SourceProbeResult>

  /**
   * 执行前置检查：发请求**之前**判断这条源此刻能不能跑（如脚本源需要宿主已装配、
   * 脚本源码可下载）。返回不可用原因，调用方跳过该源并在日志里说明。
   *
   * 为什么需要它：某些形态的缺失会被误判成网络失败，把「脚本拉不下来」
   * 伪装成「全部音源请求失败」，用户完全无从下手。把判定留给插件自己最准。
   */
  preflight?(config: OnlineSourceConfig, ctx: PluginContext): Promise<PreflightResult>

  /** 搜索。不实现 = 该插件不提供搜索（如多数洛雪脚本只做取址） */
  search?(
    config: OnlineSourceConfig,
    query: string,
    quality: DownloadQuality | undefined,
    ctx: PluginContext
  ): Promise<OnlineTrackSearchResult[]>

  /**
   * 惰性取址：按曲目带的定位令牌向源索取播放地址。
   * 返回 null 表示「取不到，请上层回落按名搜索」，不要抛错。
   */
  resolveTrack?(
    config: OnlineSourceConfig,
    ref: SourceTrackRef,
    quality: DownloadQuality | undefined,
    ctx: PluginContext
  ): Promise<ResolvedAudio | null>

  /** 列出当前账号的歌单（需要登录的插件才有） */
  listUserPlaylists?(config: OnlineSourceConfig, ctx: PluginContext): Promise<PluginPlaylist[]>

  /** 取歌单内曲目（多数平台这一步**不需要登录**） */
  getPlaylistTracks?(
    config: OnlineSourceConfig,
    playlistId: string,
    ctx: PluginContext
  ): Promise<OnlineTrackSearchResult[]>

  // ─── 在线发现（可选，只读浏览） ──────────────────────────────
  //
  // 三个方法都是「浏览型」能力：返回的都是**临时集合**（不落库、不下载），
  // 点开某一条之后才进入搜索 / 取址路径。这一组取代了改造前硬编码在
  // `musicHall.ts` 里的 aurora 协议三端点——那时候「哪些源能提供推荐/榜单」
  // 由 `hallEndpointOf()` 返回非空串决定，等于把能力绑死在一种协议形态上。
  //
  // 三条纪律：
  // 1. **能力缺失 = 方法不存在**（与其它能力同一范式），UI 据此隐藏「音乐库」入口，
  //    而不是显示一个点了永远空白的页面。
  // 2. **返回空数组是合法结果**（该源没有榜单 / 分类下没有内容），不是错误；
  //    只有网络失败 / 非 2xx / 非 JSON 才抛错，由聚合层逐源捕获。
  // 3. **不在本层做多源聚合**：聚合策略（取第一个可用源 / 合并多源）属于调用方，
  //    插件只回答「我这一条能给什么」。

  /**
   * 推荐歌单列表。
   *
   * `options` 里的分类 / 排序 / 分页参数是**建议**：插件实现不了就忽略，
   * 不要为了尊重参数而返回空（用户看到的是「这条源没有推荐」，而他其实只是
   * 选了一个该源不支持的分类）。
   */
  recommendPlaylists?(
    config: OnlineSourceConfig,
    options: MusicHallOptions,
    ctx: PluginContext
  ): Promise<RecommendPlaylist[]>

  /** 榜单分组与榜单列表（每个榜单可带若干预览曲目，见 `options.preview`） */
  toplists?(
    config: OnlineSourceConfig,
    options: MusicHallOptions,
    ctx: PluginContext
  ): Promise<ToplistGroup[]>

  /** 单个榜单详情（`options.id` 为榜单 id） */
  toplistDetail?(
    config: OnlineSourceConfig,
    options: MusicHallOptions,
    ctx: PluginContext
  ): Promise<ToplistDetail>

  // ─── 登录（可选） ───────────────────────────────────────────

  /**
   * 登录并产出凭证。
   *
   * 返回值交给平台层加密落盘，**不经渲染层持久化**。
   * 弹窗 / 扫码 / 粘贴等交互形态由 UI 决定，插件只负责「拿到凭证」。
   */
  login?(ctx: PluginContext): Promise<PluginCredential>

  /** 校验凭证是否仍有效（拉一个轻量接口验证） */
  checkAuth?(credential: PluginCredential | null, ctx: PluginContext): Promise<PluginAuthState>

  /** 退出登录（清本地状态；插件有远端会话时可一并登出） */
  logout?(ctx: PluginContext): Promise<void>
}
