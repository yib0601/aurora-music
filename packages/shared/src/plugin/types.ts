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
  LyricsSourceConfig,
  MusicHallOptions,
  OnlineSourceConfig,
  OnlineTrackSearchResult,
  ParsedSong,
  PlaylistParseResult,
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
  /**
   * **脚本宿主**（`script.host` 能力解析出的实现）。
   *
   * 只有声明了 `requires: [{ id: 'script.host' }]` 的插件才会拿到它；没声明的插件
   * 这里恒为 `undefined`。缺脚本能力的端（浏览器）永远是 `undefined`。
   *
   * ## 为什么要有这个字段
   *
   * 改造前插件内部直接 `getLxHostDeps()` 读**模块级单例**，于是：
   * - 「这个插件需要宿主提供什么」只能靠读实现代码才知道；
   * - 单测与桌面/移动两端共用同一份隐式全局，无法按调用点注入替身。
   *
   * 现在依赖走声明（`requires`）、实现走注入（本字段），插件实现里不再 import
   * `lxHost` 的单例读取函数。
   *
   * ## 类型为什么不在本文件定义
   *
   * `LxHostDeps` 属于 `lxHost`（脚本宿主域）。在契约层重复声明一遍会形成第二份真源，
   * 所以这里用结构化最小形状：插件能看到的只有它真正会用的那几个成员。
   * 需要完整类型的地方（`lxHost` 内部）继续用 `LxHostDeps`。
   */
  scriptHost?: ScriptHostLike
}

/**
 * 脚本宿主的最小结构形状（`PluginContext.scriptHost` 用）。
 *
 * 刻意只列**判定与执行必需**的成员，不照抄 `LxHostDeps` 全部字段：
 * 契约层暴露得越窄，将来换实现时的兼容面越小。`LxHostDeps` 结构上满足本接口。
 */
export interface ScriptHostLike {
  /** 脚本的网络请求通道（宿主代发，绕开 CORS） */
  request: (...args: never[]) => unknown
  env?: 'desktop' | 'mobile'
  version?: string
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

  /**
   * 解析歌单**分享链接**（粘贴「分享文案 + 链接」时走这条）。
   *
   * ## 为什么它与 `getPlaylistTracks` 是两个方法
   *
   * 两者的输入语义完全不同，混成一个会逼着实现方在内部判形态：
   * - `getPlaylistTracks(config, playlistId)`：调用方**已经有**一个歌单标识
   *   （插件自己列出来的「我的歌单」条目），直接按 id 拉曲目；
   * - `parsePlaylist(config, shareUrl)`：调用方只有一个**来自外部的链接**，
   *   「这个链接对应哪个歌单、要怎么换成可请求的地址」是插件才知道的知识
   *   （aurora 用 `{url}` 模板把链接当参数透传，汽水要解析出 playlist_id，
   *   别的平台可能要先去重定向拿 id）。
   *
   * ## v15：把「能力被协议劫持」收回到契约
   *
   * 改造前歌单链接解析走 `playlistResolver.parsePlaylistLink`，它用
   * `playlistEndpointOf()`（**aurora 协议私有**的端点派生）判断「哪些源能做这件事」，
   * 完全不询问插件。后果与歌词链路当初那处一模一样：
   *
   * - 装来的声明式插件即便在清单里写了 `playlistTracks`，也永远进不了这条链路；
   * - `playlistTracksViaPlugin` / `userPlaylistsViaPlugin` 写好了却**零生产调用方**；
   * - 「这条源能不能解析歌单」有两份真源（`capabilities` 声明 vs 端点派生）。
   *
   * 现在插件自己回答这件事。`playlistResolver` 保留为**协议实现**（aurora 仍用它），
   * 但「谁来解析」的判定权归注册表。
   *
   * 返回 `PlaylistParseResult`（而不是裸的 `ParsedSong[]`）：
   * 歌单名是**只有解析方才知道**的信息（有的平台在响应里给、有的在链接里给、
   * 有的根本没有）。把它从返回值里抹掉，调用方就只能退化成「导入的歌单」这种
   * 兜底名 —— 而用户明明粘的是一份有名字的分享链接。`truncated` 同理（分页时用）。
   *
   * 失败抛结构化错误（调用方据此逐源收集失败原因，取配置顺序上最后一个）。
   */
  parsePlaylist?(
    config: OnlineSourceConfig,
    shareUrl: string,
    ctx: PluginContext,
    options?: { limit?: number }
  ): Promise<PlaylistParseResult>


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

  // ─── 歌词（可选） ───────────────────────────────────────────

  /**
   * 把「本插件提供的歌词源」交给上层聚合器。
   *
   * ## 为什么是「交出配置」而不是「自己取歌词」
   *
   * 歌词不是一个源说了算的：既有 `searchLyrics` 做的是**多源聚合**
   * （用户源优先 + 内置 LRCLIB 兜底 + 延迟对冲并发 + 首个非空胜出）。
   * 若让每个插件自己实现"取歌词"，那套聚合要被复写 N 遍，且各插件行为会漂移。
   *
   * 所以插件只回答一个问题：**「把哪一条源交给聚合器」**。返回 `null` =
   * 本插件此刻不提供歌词（例如端点未配置 / 该源形态不支持）。
   *
   * ## 与 `capabilities` 里 `'lyrics'` 的关系
   *
   * `capabilities` 只是给 UI 渲染徽章的**声明**，调用前的判定一律用
   * `typeof plugin.lyricsSource === 'function'`（本仓一贯口径：能力 = 方法存在性）。
   * 改造前 aurora 声明了 `lyrics` 但**没有对应方法**，能力只能靠
   * `lyricEndpointOf()` 这个协议私有派生函数间接体现 —— 声明式插件因此永远
   * 接不进歌词链路。本方法就是补上那个缺失的契约位。
   */
  lyricsSource?(
    config: OnlineSourceConfig,
    ctx: PluginContext
  ): LyricsSourceConfig | null

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
