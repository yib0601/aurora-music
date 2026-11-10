import type {
  PlatformInterface,
  FileInfo,
  AudioMetadata,
  DatabaseAdapter,
  WindowControls,
  OnlineTrackSearchResult,
  OnlineSearchOptions,
  OnlineSourceConfig,
  DownloadQuality,
  SourceProbeInput,
  SourceProbeResult,
  LyricsSearchOptions,
  LyricsSearchResult,
  Track,
  LibrarySourceConfig,
  RecommendPlaylist,
  ToplistGroup,
  ToplistDetail,
  MusicHallOptions,
  MusicHallSource,
  LoggingRendererApi,
  StoragePluginMeta,
  StorageCredentialState,
} from '@/types'
import type { EncryptedAudioFile } from '@aurora/shared'
import {
  createMobilePlatform as createMobilePlatformImpl,
  setFolderPickerHandler,
  DEFAULT_MOBILE_DOWNLOAD_DIR,
} from './mobile'
import { createWebPlatform, isFileSystemAccessSupported } from './web'
import {
  auroraError,
  auroraProbeToResult,
  encodeFilePathToUrl,
  encodePathSegments,
  lxInspectionToProbe,
  parseErrorInfo,
  parseSourceInput,
  probeAuroraService,
  pluginIdOf,
  resolveTrackAudioAcrossScriptSources,
  sourceSongIdOf,
  stripIpcPrefix,
  trackRefFor,
  unavailableProbe,
} from '@aurora/shared'
import type {
  AudioFocusYieldBehavior,
  LanSyncBridge,
  PluginAuthState as PluginAuthStateInfo,
  PluginCatalogEntry,
  PluginInstallResult as PluginInstallResultInfo,
  PluginPlaylist as PluginPlaylistInfo,
  PluginStartupReport as PluginStartupReportInfo,
  ResolvedAudio,
  SourceTrackRef,
  SyncSnapshot,
} from '@aurora/shared'

/** 插件元信息（渲染层只消费这些字段，拿不到插件实现） */
export interface PluginMetaInfo {
  id: string
  displayNameKey: string
  descriptionKey?: string
  version: string
  capabilities: readonly string[]
  hasCredential: boolean
  /**
   * 用户是否启用该插件（可选：老 preload 的 `plugin:list` 不带这个字段）。
   *
   * 只在 UI 侧用来隐藏"已停用插件的登录入口"，不参与执行判定 —— 那是主进程
   * `requirePlugin` 的事。写成可选是为了让旧通道继续可用（缺省按启用处理）。
   */
  enabled?: boolean
}
import { appTranslate } from '@/i18n'
import { renderErrorMessage } from '@/lib/utils'

// 重新导出：UI 层（SettingsPage）注册移动端文件夹选择器回调，
// 桌面端此函数为空操作（pickFolder 走 electronAPI 的原生对话框）；
// DEFAULT_MOBILE_DOWNLOAD_DIR 供设置页展示「未设置时的默认目录」文案
export { setFolderPickerHandler, DEFAULT_MOBILE_DOWNLOAD_DIR }

/**
 * 取音源配置与下载音质的信源（供惰性取址用）：渲染层各处的音源列表最终都来自
 * libraryStore 的持久化状态，这里惰性动态导入以避开「store ← platform」的
 * 初始化环（store 顶层 import platform）。
 */
async function loadLibraryState(): Promise<{
  sources: OnlineSourceConfig[]
  quality: DownloadQuality
}> {
  try {
    const mod = await import('@/stores/libraryStore')
    const state = mod.useLibraryStore?.getState?.()
    return {
      sources: Array.isArray(state?.onlineSources) ? state.onlineSources : [],
      // 与下载音质设置一致：脚本形态的源档位由脚本自己声明，用户设置的档位是唯一意图来源
      quality: state?.downloadQuality || 'flac',
    }
  } catch (err) {
    console.warn('[音源] 读取音源配置失败:', err)
    return { sources: [], quality: 'flac' }
  }
}

// 平台扩展能力：扫描事件订阅、媒体键、在线歌词搜索
// 桌面端通过 electronAPI 转发；移动端用回调机制
// 这些方法在两边都存在，统一通过 platform 调用，避免 App.tsx 直接访问 window.electronAPI
export interface PlatformExtension {
  /** 启动扫描（异步），完成后通过 onTracksScanned 通知 */
  scanFolder?: (folderPath: string) => Promise<Track[]>
  /** 获取所有已扫描曲目 */
  getAllTracks?: () => Promise<Track[]>
  /**
   * 按需补齐封面（两端都实现，语义一致）：扫描阶段跳过内嵌图片读取以提速，
   * 记录中无 coverPath 时由 UI 调用本方法单独提取并缓存，返回封面地址。
   * 曲目无内嵌封面时返回 null。
   *
   * - 桌面端：主进程按 Range 读远端文件头，或解析本地文件；返回**绝对路径**。
   * - 移动端：本机曲目读文件解析内嵌图、网络存储曲目 Range 读远端文件头，
   *   返回 `Capacitor.convertFileSrc` 之后的地址；读失败（远端不可达 / 文件暂时
   *   读不到）抛错让 UI 退避重试，只有"确认没有内嵌封面"才返回 null。
   *
   * fallback：尚未入库的曲目的元信息兜底（扫描窗口期的本机曲目带 path 才解析；
   * 在线快照没有本地文件，交给 `fetchOnlineCover`）。
   */
  ensureCover?: (trackId: string, fallback?: Partial<Track>) => Promise<string | null>
  /**
   * 在线补齐封面（两端都实现）：文件无内嵌封面时，按标题/艺术家搜索用户配置的
   * 在线歌源，下载匹配候选的封面并缓存，返回封面地址。无匹配返回 null。
   * options.sources 为渲染层持有的歌源配置（应用不内置源）——
   * 缺了这条链，本地文件不带内嵌封面的曲目在移动端会永久空图。
   * fallback：不在曲库的曲目（在线快照）的元信息兜底，主进程/渲染层仅取标题/
   * 艺术家/时长构造查询，地址类字段一律不信任。
   */
  fetchOnlineCover?: (
    trackId: string,
    options?: OnlineSearchOptions,
    fallback?: Partial<Track>
  ) => Promise<string | null>
  /**
   * 从曲库移除某个扫描目录：连该目录下的曲目记录一起删除，返回移除后的全库曲目。
   * 目录条目本身由调用方从 scanFolders 中删除（库数据与配置分离）。
   */
  removeFolder?: (folderPath: string) => Promise<Track[]>
  /**
   * 从曲库移除**单曲**：只删曲库记录与封面缓存，**磁盘上的音频文件原样保留**。
   * 返回移除后的全库曲目（调用方直接 setTracks 刷新，不必再拉一次）。
   *
   * 与 removeFolder 分开而不是合并进一个「按目录/按曲目」的重载：两者的确认文案、
   * 影响范围与用户心智完全不同（一个是「这个目录不再进曲库」，一个是「这首歌不再
   * 在我曲库里」），合并只会让 UI 侧每次都要多做一次判别。
   */
  removeTrack?: (trackId: string) => Promise<Track[]>
  /**
   * 在文件管理器中定位曲目。**刻意可选**：移动端没有文件管理器桥
   * （未安装 @capacitor/share 及同类插件，也不新增依赖），Web 端只有用户显式授权的
   * 目录句柄、拿不到可用于定位的系统路径，能力确实不存在。
   * 写成必选会逼这两端提供一个「假装成功」的空实现，而 UI 会因此显示一个
   * 点了没反应的菜单项（与 LoggingGateway.reveal 同一套判断）。
   *
   * 入参是**曲目 id**而不是路径：主进程按 id 反查曲目路径，渲染层因此无法用这条
   * 通道去定位曲库之外的任意本机文件。
   */
  revealTrack?: (trackId: string) => Promise<boolean>
  /** 扫描完成事件订阅 */
  onTracksScanned?: (cb: (tracks: Track[]) => void) => () => void
  /** 单曲扫描完成事件订阅（渐进式刷新：每解析完一首立即通知，UI 追加而非等全部完成） */
  onTrackScanned?: (cb: (track: Track) => void) => () => void
  /** 扫描失败事件订阅（静默扫描：仅用于记录日志） */
  onScanError?: (cb: (e: { folder: string; message: string }) => void) => () => void
  /** 扫描时发现目录已从磁盘删除（主进程/移动端已清理其曲目），UI 据此移除目录条目 */
  onFolderMissing?: (cb: (e: { folder: string; removed: number }) => void) => () => void
  /**
   * 扫描时发现的**加密音频**（QQ 音乐等平台下载落盘的密文，如 `.mflac0.flac`）。
   *
   * 这类文件的扩展名合法、内容不是音频容器，解析必失败 → 永远进不了曲库。
   * 旧行为是静默丢弃，用户只看到「扫了但一首没进来」。单独上报后，
   * UI 才能提供「用音源重下一份明文副本」的出路。
   *
   * Web 端不实现（File System Access 的目录扫描走另一条链路，没有解析失败上报点）。
   */
  onEncryptedAudioFound?: (cb: (file: EncryptedAudioFile) => void) => () => void
  /**
   * 把单个已落盘的音频文件解析并入库，返回曲目记录（解析失败返回 null）。
   *
   * 供「加密音频 → 按名重下」链路收尾：下载目录未必在用户的扫描目录里，
   * 没有这条通道就会出现「提示下载成功、曲库里却找不到」。
   * 桌面端主进程会校验绝对路径 + 音频扩展名；移动端走本地 scanner。
   */
  importAudioFile?: (filePath: string) => Promise<Track | null>
  /** 系统媒体键事件订阅（桌面端来自 globalShortcut/MPRIS，移动端来自 mediaSession） */
  onMediaControl?: (cb: (action: string) => void) => () => void
  /**
   * 桌面端「音频焦点 / 与其他播放器互斥」开关。
   *
   * 回执语义是**平台是否真的支持**：主进程返回 false 表示这一端没有可用的焦点
   * 实现（或在本机系统上接管失败），设置页据此提示「当前平台不支持」，
   * 而不是假装开成功了 —— 假开关比没有开关更糟，用户会以为已经生效。
   * Web / 移动端不实现（可选方法不存在 = 能力缺失），调用方走可选调用链降级。
   */
  setAudioFocusEnabled?: (enabled: boolean) => Promise<boolean>
  /**
   * 「其他应用播放声音时本应用怎么办」（'pause' 暂停 / 'continue' 继续播放）——
   * **移动端专用**（桌面端没有这个方法：桌面用上面的 setAudioFocusEnabled 表达同一件事，
   * 'continue' 即不启用互斥服务）。
   *
   * Android 的原生播放引擎始终持有系统音频焦点，只能选择「焦点丢失时要不要暂停」，
   * 所以这里下发的是行为取值而不是开关。Web 端不实现（方法不存在 = 能力缺失）。
   */
  setAudioFocusYieldBehavior?: (behavior: AudioFocusYieldBehavior) => Promise<boolean>
  /**
   * 上报本应用当前是否**真的在出声**（高频、不等待回执）。
   *
   * 主进程靠它判断「本应用正在播放」这一事实：UI 的 isPlaying 只是意图，
   * 加载失败 / 缓冲卡住 / 解码出错时与真正出声并不一致，拿意图当真相
   * 会让本应用在根本没出声的情况下把别人的播放器停掉。
   */
  reportPlaybackState?: (isPlaying: boolean) => void
  /** 在线歌词搜索（按用户配置的歌词源依次尝试） */
  searchLyrics?: (
    query: string,
    artist?: string,
    album?: string,
    duration?: number,
    options?: LyricsSearchOptions
  ) => Promise<LyricsSearchResult | null>
  /** 下载在线歌曲到本地，返回保存路径；headers 为歌源配置的附加请求头；
   *  downloadDir 为默认下载目录（桌面端传了则免保存对话框直存；
   *  移动端传的是手机存储内的相对路径，未传时用默认目录 Music/Aurora Music）；
   *  album/coverUrl 用于下载后把文本标签与封面嵌入文件（源直链的音频大多无内嵌封面） */
  downloadOnlineTrack?: (
    track: { audioUrl: string; title: string; artist?: string; album?: string; coverUrl?: string },
    headers?: Record<string, string>,
    downloadDir?: string
  ) => Promise<{ savedPath: string }>

  // ─── 媒体库来源（WebDAV 网络存储，目前仅桌面端实现）─────────────────
  // 与「在线歌源」不同：媒体库来源是持久曲库（入库、地址长期有效、需要鉴权），
  // 口令交由主进程保管，渲染层只持有 sourceId，播放走 aurora-remote:// 协议代理。
  /** 把来源配置同步给主进程（启动与配置变更时调用） */
  syncLibrarySources?: (sources: LibrarySourceConfig[]) => Promise<void>
  /** 扫描某个来源并入库；complete=false 表示有目录列举失败（调用方不应据此清库） */
  scanLibrarySource?: (
    sourceId: string
  ) => Promise<{ tracks: Track[]; complete: boolean; failedDirs: number }>
  /** 探测来源可用性（设置页「测试连接」） */
  probeLibrarySource?: (
    sourceId: string
  ) => Promise<{ ok: boolean; message: string; sample?: string[] }>
  /** 移除来源及其全部曲目，返回移除后的全库 */
  removeLibrarySource?: (sourceId: string) => Promise<Track[]>
  /**
   * 远端媒体库曲目 → **本机可播地址**（只移动端实现）。
   *
   * 桌面端不实现：那边播放走 `aurora-remote://` 协议代理（流式、Range 透传），
   * 曲目自带 `remoteUrl`，不需要先落成文件。移动端没有自定义协议、播放器也带不上
   * 鉴权头，所以只能把远端文件整首缓存到本地后再播 —— 判据见 `lib/storageTrack`。
   */
  resolveStorageAudio?: (track: {
    sourceId?: string
    path: string
  }) => Promise<{ src: string | null }>

  // ─── 存储协议与口令（能力缺失 = 该端不支持，调用方降级） ──────────
  // 口令的读写全部留在主进程（safeStorage 加密落盘），渲染层只拿「有没有」这类状态。
  // 与 syncLibrarySources 的分工：那个传的是**不含口令**的来源配置，
  // 口令单向往 saveStorageCredential 送，且永不回读。
  /** 可添加的存储协议（纯数据 meta + 声明式 fields）；缺失表示该端不支持插件化表单 */
  listStoragePlugins?: () => Promise<StoragePluginMeta[]>
  /** 保存某个来源的口令（按 sourceId 存，同一插件的多台设备互不覆盖） */
  saveStorageCredential?: (
    sourceId: string,
    payload: Record<string, string>
  ) => Promise<{ ok: boolean } & StorageCredentialState>
  /** 口令状态（**不含原文**）：是否已保存、本机能否加密 */
  storageCredentialState?: (sourceId: string) => Promise<StorageCredentialState>
  /** 清除口令 */
  clearStorageCredential?: (
    sourceId: string
  ) => Promise<{ ok: boolean } & StorageCredentialState>

  // ─── 媒体缓存：音频 / 封面 / 歌词（桌面端主进程、移动端 Filesystem）──
  // 三类内容共用一份容量配置，内部按比例分配。命中返回本地地址（桌面端
  // aurora-cache:// 协议、移动端 Capacitor 文件地址），未命中返回 null 并由
  // 平台在后台写入；本次仍用原始地址，下次即命中。
  /** 解析缓存播放地址；未命中返回 { src: null } */
  resolveCachedAudio?: (req: {
    url: string
    key: string
    headers?: Record<string, string>
  }) => Promise<{ src: string | null }>
  /** 解析远端封面的缓存地址；未命中返回 { src: null } */
  resolveCachedCover?: (req: {
    url: string
    key: string
    headers?: Record<string, string>
  }) => Promise<{ src: string | null }>
  /** 下发缓存容量配置（0 = 不限制容量：不驱逐、照常缓存） */
  configureAudioCache?: (opts: { limitMB: number }) => Promise<void>
  /** 当前缓存占用（三类内容合计） */
  getAudioCacheUsage?: () => Promise<{ usedBytes: number; count: number }>
  /** 清空全部缓存 */
  clearAudioCache?: () => Promise<void>

  // ─── 诊断日志（桌面端主进程落盘、移动端 Filesystem、Web 无落盘）──
  /**
   * 渲染层日志的落盘出口。
   *
   * 形状直接复用 shared 的 `LoggingRendererApi`（由 preload 与该契约共同定义），
   * 只多一个可选的 `flush`：桌面端每条记录经单向 IPC 异步写盘、不需要调用方等待；
   * 移动端是攒批写文件，导出前必须先把队列冲刷掉，否则用户刚遇到的那次失败
   * 恰好还在内存里、不在包里。
   *
   * 未定义即代表该端**没有落盘能力**（Web / 未知环境），UI 据此隐藏导出入口，
   * 而不是让用户点下去再看到失败。
   */
  logging?: LoggingGateway
  /**
   * 插件层：音源插件的能力调用与登录。
   *
   * 形态差异（协议源 / 洛雪脚本 / 汽水音乐）全部收在插件实现里，UI 只按**能力是否存在**
   * 调用（`plugin.search` 有就调、没有就跳过），不再出现 `kind === 'xxx'` 判断。
   *
   * 未定义即代表该端没有插件执行能力（Web / 未知环境）——插件需要主进程网络栈
   * 与 safEStorage 凭证存储，浏览器端两者都没有。
   */
  plugins?: PluginGateway

  // ─── 歌单同步（docs/playlist-sync.md §8：只做桌面端）───────────────
  /**
   * 本端是否具备歌单同步能力。
   *
   * **必填**而不是可选：这是引擎与 UI 唯一的分支判据（§8 明确「不按插件
   * available() 分散判断」），写成可选就会出现「undefined 算不算支持」的歧义。
   * 非桌面端一律 false，入口随之隐藏。
   */
  supportsPlaylistSync: boolean
  /**
   * 同步凭证网关：口令按 configId 存在主进程 safeStorage，渲染层只拿「有没有」。
   *
   * 与 storage 的同名能力分开（不是泛化成一个 KeyValue 网关）：同步配置的 id
   * 空间与媒体库来源互不相干，混用会让「删了来源顺带清掉同步口令」这类
   * 生命周期耦合变得可能。
   */
  sync?: SyncGateway
  /**
   * 局域网同步桥。非桌面端为 `null`（HTTP 服务、UDP 发现与配对鉴权都在主进程）。
   *
   * 方法名与 §15.3 的 IPC 通道名不同（`lan:pull`/`lan:push` 映射到
   * `pullPeer`/`pushPeer`），改名只在这一层做，引擎只见 shared 的 `LanSyncBridge`。
   */
  lanSync?: LanSyncBridge | null
  /**
   * 局域网收件箱事件订阅（对端推来的快照），返回退订函数。
   *
   * 不并进 `LanSyncBridge`：那个接口是 shared 给两端共用的「主动调用」面，
   * 而这是一条下行事件通道，只有宿主（preload）能提供。
   */
  onLanSyncInbox?: (cb: (snapshots: SyncSnapshot[]) => void) => () => void
  /**
   * 同步插件发 HTTP 用的 fetch 出口（可选）。
   *
   * 桌面端的 WebDAV 方案迟早需要「主进程代发」来绕开 CORS；在补出这条 IPC
   * 通道之前不实现，引擎按 `platform.syncFetch ?? globalThis.fetch` 退化。
   */
  syncFetch?: typeof globalThis.fetch
}

/**
 * 歌单同步的凭证网关。
 *
 * 与 `PluginGateway` 的 login/logout 分开：那边的凭证属于「插件会话」，
 * 这里的口令属于「某一条同步目标」（同一插件可以配多条，各用各的口令）。
 */
export interface SyncGateway {
  /** 本机设备身份（主进程首次调用时生成并持久化，渲染层只读） */
  device(): Promise<SyncDeviceIdentity>
  /** 保存某条同步目标的口令原文（**单向**，永不回读给 UI 渲染） */
  saveCredential(configId: string, payload: Record<string, string>): Promise<SyncCredentialResult>
  /** 口令状态（不含原文）：是否已保存、本机能否加密 */
  credentialState(configId: string): Promise<SyncCredentialState>
  /** 清除口令 */
  clearCredential(configId: string): Promise<SyncCredentialResult>
  /**
   * 取回口令原文，**只在一次同步调用内持有**：绝不写进 zustand / persist / 日志 /
   * lastError（§10）。没有可用口令时返回 null（而不是空对象），调用方据此区分
   * 「没配口令」与「配了口令但读不到」。
   */
  getCredential(configId: string): Promise<Readonly<Record<string, string>> | null>
}

export interface SyncDeviceIdentity {
  deviceId: string
  deviceName: string
}

export interface SyncCredentialState {
  saved: boolean
  /** 本机是否有 safeStorage（否则口令只能明文落盘，配置页必须如实提示） */
  encryptionAvailable: boolean
}

export type SyncCredentialResult = { ok: boolean } & SyncCredentialState

/**
 * 插件网关。
 *
 * 凭证类方法**只回状态、不回内容**：凭证的读写全部留在主进程
 * （`safeStorage` 加密落盘），渲染层拿不到 `sessionid` 这类秘密。
 */
export interface PluginGateway {
  /** 已注册插件的可展示元信息（不含实现，也不含凭证） */
  list(): Promise<PluginMetaInfo[]>
  probe(pluginId: string, config: OnlineSourceConfig): Promise<SourceProbeResult>
  search(
    pluginId: string,
    config: OnlineSourceConfig,
    query: string,
    quality?: DownloadQuality
  ): Promise<OnlineTrackSearchResult[]>
  resolveTrack(
    pluginId: string,
    config: OnlineSourceConfig,
    ref: SourceTrackRef,
    quality?: DownloadQuality
  ): Promise<ResolvedAudio | null>
  userPlaylists(pluginId: string, config: OnlineSourceConfig): Promise<PluginPlaylistInfo[]>
  playlistTracks(
    pluginId: string,
    config: OnlineSourceConfig,
    playlistId: string
  ): Promise<OnlineTrackSearchResult[]>
  /** 保存凭证（入参是用户粘贴的文本，解析与校验都在主进程完成） */
  login(pluginId: string, rawInput: string): Promise<{ ok: boolean }>
  /** 登录态（**不含凭证原文**） */
  authState(pluginId: string): Promise<PluginAuthStateInfo>
  logout(pluginId: string): Promise<{ ok: boolean }>

  // ─── 安装 / 卸载 / 目录（全部可选：老 preload 没有这组通道） ───
  // 每个方法都是**可选**而不是整块可选：缺了安装通道不该让搜索/登录一起失效。
  // UI 据方法是否存在决定是否显示对应入口（与全仓「能力缺失用方法不存在表达」一致）。

  /** 插件目录（内置 + 已安装 + 读不出来的文件），纯数据可安全展示 */
  catalog?(locale?: string): Promise<PluginCatalogSnapshot>
  /**
   * 本次启动的插件加载报告（挂载数 / 坏文件数 / 注册期失败清单）。
   *
   * 可选：老 preload 没有这条通道，渲染层据此跳过提示而不是报错。
   * 用它而不等主进程 push 的理由见 `pluginInstall.ts` 的同名通道注释。
   */
  startup?(): Promise<PluginStartupReportInfo>
  /** 打开系统文件选择框选清单，返回路径（取消为 null） */
  pickManifest?(): Promise<string | null>
  /** 从本地文件安装 */
  installFromFile?(filePath: string, locale?: string): Promise<PluginInstallResultInfo>
  /** 从网址安装（`expectedSha256` 给了就必须匹配） */
  installFromUrl?(
    url: string,
    expectedSha256?: string,
    locale?: string
  ): Promise<PluginInstallResultInfo>
  /** 卸载 */
  uninstall?(pluginId: string, locale?: string): Promise<PluginInstallResultInfo>
  /** 在文件管理器里打开插件目录 */
  openDir?(): Promise<{ ok: boolean }>
  /** 删除一个读不出来的插件目录 */
  removeBroken?(dirPath: string): Promise<{ ok: boolean; message?: string }>

  // ─── 插件启停（可选：老 preload 没有这组通道） ───
  /**
   * 开 / 关一个插件。
   *
   * 与卸载是两件事：卸载会删磁盘（连带凭证、脚本正文），启停只改运行期门禁。
   * 内置插件不可卸载，但**必须**能停用 —— 否则用户想临时只留一个音源时，
   * 除了逐条改源配置没有别的办法。
   *
   * 落盘在各自平台侧（桌面主进程 / 移动端 Filesystem）；返回的 `enabled`
   * 是**落盘之后**的真实状态，UI 据此渲染而不是乐观翻转 —— 写盘失败时
   * 乐观翻转会让开关停在一个并未生效的位置上。
   */
  setPluginEnabled?(pluginId: string, enabled: boolean): Promise<{ ok: boolean; enabled: boolean }>
  /** 全部已停用的插件 id（诊断与对账用；UI 的当前状态以目录条目的 enabled 为准） */
  listDisabledPlugins?(): Promise<string[]>
}

/** 插件目录快照（`plugin:catalog` 的返回形状） */
export interface PluginCatalogSnapshot {
  entries: PluginCatalogEntry[]
  /** 读不出来的插件文件（清单非法 / 哈希不符 / 记录损坏），供设置页逐条展示与删除 */
  broken: Array<{ path: string; message?: string }>
}

/**
 * 日志网关。
 *
 * 之所以不直接写成 `LoggingRendererApi`：移动端实现是自己拼包后写文件，
 * 多一个 flush 语义；桌面端则原样转发 preload 暴露的对象。
 * 两边对外必须是同一个形状，否则 logging.service 就得分支处理宿主差异 ——
 * 而那段差异本来就属于平台适配层。
 */
export interface LoggingGateway extends Omit<LoggingRendererApi, 'reveal'> {
  /** 把攒批中的记录冲刷到落盘层（无队列的端可以不实现） */
  flush?: () => Promise<void>
  /**
   * 在文件管理器中定位文件。**刻意可选**：移动端没有文件管理器桥
   * （未安装 @capacitor/share 及同类插件，也不新增依赖），能力确实不存在。
   * 写成必选会让移动端不得不提供一个「假装成功」的空实现，
   * 而 UI 会因此显示一个点了没反应的「打开日志目录」按钮。
   */
  reveal?: (filePath: string) => Promise<void>
}

class NoopDatabase implements DatabaseAdapter {
  async init() {}
  async insertTrack() {}
  async getAllTracks() { return [] }
  async getTrackById() { return null }
  async getTracksByAlbum() { return [] }
  async searchTracks() { return [] }
  async updateTrack() {}
  async deleteTrack() {}
  async insertAlbum() {}
  async getAllAlbums() { return [] }
  async getAlbumById() { return null }
  async insertPlaylist() {}
  async getAllPlaylists() { return [] }
  async getPlaylistById() { return null }
  async updatePlaylist() {}
  async deletePlaylist() {}
  async getLikedTracks() { return [] }
  async getRecentlyPlayed() { return [] }
  async getMostPlayed() { return [] }
}

class NoopWindowControls implements WindowControls {
  async minimize() {}
  async maximize() {}
  async close() {}
  async isMaximized() { return false }
}

/**
 * 在线音乐读取能力（可选）：三端实现见 services/platform/*
 * - 桌面端：转发到主进程执行（渲染进程 fetch 会被上游 CORS 拦截）
 * - 移动端：渲染层直调 shared（fetch 已换成 CapacitorHttp）
 * - Web / Noop：空实现（浏览器无该能力），在线音乐据此展示不可用空态
 *
 * 形状与 types/index.ts 的 MusicHallPlatform 一致；这里用可选声明接入 Platform，
 * 未实现该能力的端（web / Noop）也能被统一调用而不抛错。
 */
export interface MusicHallExtension {
  musicHall?: {
    recommendPlaylists(
      source: MusicHallSource,
      options?: MusicHallOptions
    ): Promise<RecommendPlaylist[]>
    toplistGroups(source: MusicHallSource, options?: MusicHallOptions): Promise<ToplistGroup[]>
    toplistSongs(source: MusicHallSource, options?: MusicHallOptions): Promise<ToplistDetail>
  }
}

export type Platform = PlatformInterface & PlatformExtension & MusicHallExtension

export function createDesktopPlatform(): Platform {
  const api = (window as any).electronAPI

  return {
    platform: 'desktop',

    async pickFolder(): Promise<string | null> {
      if (!api?.pickFolder) return null
      return api.pickFolder()
    },

    async readDir(path: string): Promise<FileInfo[]> {
      if (!api?.readDir) return []
      return api.readDir(path)
    },

    async readFile(path: string): Promise<ArrayBuffer> {
      if (!api?.readFile) return new ArrayBuffer(0)
      return api.readFile(path)
    },

    getAudioSrc(path: string): string {
      // 音频用 file://（Web Audio API 的 MediaElementSource 需要 crossOrigin，
      // 自定义协议的 CORS 支持不完整，会导致 analyser 输出全零）
      // 必须逐段 encode：裸拼 `file://${path}` 时文件名里的 `#` 会被 URL 当成
      // fragment 起点、`?` 会被当成 query 起点，`<audio>` 实际请求的路径被截断
      // 而加载失败；中文/空格/`%` 在部分 Electron 版本下也会解析异常。
      return encodeFilePathToUrl(path)
    },

    getCoverSrc(path: string): string {
      // 桌面端用自定义 cover-local 协议，绕过 webSecurity 对 file:// 的限制。
      // Windows 绝对路径（C:\...）需统一成 /C:/... 形式：直接拼接会让盘符被吞进
      // URL 的 host/port 部分，图片请求 404（Linux 路径以 / 开头不受影响）。
      // 逐段 encode 兼容中文用户名、空格、`#` 等特殊字符（`#` 不编码会被当成
      // fragment，主进程拿到的 pathname 就被截断）。
      // 编码逻辑统一收口到 shared 的 encodePathSegments，避免两处实现漂移。
      const normalized = path.replace(/\\/g, '/')
      const abs = normalized.startsWith('/') ? normalized : `/${normalized}`
      return `cover-local://localhost/${encodePathSegments(abs)}`
    },

    async getMetadata(path: string): Promise<AudioMetadata> {
      if (!api?.getMetadata) {
        return { title: path.split('/').pop() || 'Unknown', artist: 'Unknown', album: 'Unknown', duration: 0 }
      }
      return api.getMetadata(path)
    },

    async getUserDataPath(): Promise<string> {
      if (!api?.getUserDataPath) return ''
      return api.getUserDataPath()
    },

    async saveCover(coverData: Buffer, trackId: string): Promise<string> {
      if (!api?.saveCover) return ''
      return api.saveCover(coverData, trackId)
    },

    async saveLyrics(lyrics: string, trackId: string): Promise<string> {
      if (!api?.saveLyrics) return ''
      return api.saveLyrics(lyrics, trackId)
    },

    async readLyrics(trackId: string): Promise<string | null> {
      if (!api?.readLyrics) return null
      return api.readLyrics(trackId)
    },

    async searchOnlineTracks(query: string, options?: OnlineSearchOptions): Promise<OnlineTrackSearchResult[]> {
      if (!api?.searchOnlineTracks) return []
      return api.searchOnlineTracks(query, options)
    },

    // ─── 源探测与惰性取址：形态差异收在平台适配器内部 ───
    // 脚本形态的宿主实现里含函数（request / utils），无法经 IPC 序列化，因此宿主只在
    // 主进程装配；渲染层只传「源地址 + 查询词 + 定位令牌」这类纯数据。
    async probeSource(input: SourceProbeInput): Promise<SourceProbeResult> {
      // 形态判定统一走插件层：调用方给 pluginId（缺省按 kind 推导），这里只查表。
      // 探测实现全部在主进程插件执行器里（src/ipc/pluginHost.ts），
      // 渲染层不再持有任何形态私有逻辑。
      if (api?.plugins?.probe) {
        const config = {
          id: input.id || 'probe-draft',
          name: input.name || '',
          sourceUrl: input.sourceUrl,
          headers: input.headers,
          enabled: true,
          ...(input.pluginId ? { pluginId: input.pluginId } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
        }
        try {
          const result = (await api.plugins.probe(
            pluginIdOf(config),
            config
          )) as SourceProbeResult
          if (result && typeof result === 'object' && 'ok' in result) return result
        } catch (err) {
          // 探测失败不抛给 UI：结论直接上屏，文案按当前语言渲染
          return unavailableProbe(
            (input.kind || 'aurora') as SourceProbeResult['kind'],
            renderErrorMessage(err)
          )
        }
      }
      // 老版本 preload 没有插件通道时的降级：
      // - 脚本形态仍可走既有的 lxSource 通道（它就是这个形态的专用实现，
      //   在插件层存在之前一直是唯一路径，保留它等于保留对旧 preload 的兼容）
      // - 协议形态走下面的直连探测（它在任何端都能跑）
      if (pluginIdOf(input) === 'lx' && !api?.plugins) {
        if (!api?.lxSource?.fetchScript || !api?.lxSource?.inspect) {
          return unavailableProbe('lx', appTranslate()('runtime.platform.scriptUnsupportedDesktop'))
        }
        try {
          const script = input.script?.trim() || (await api.lxSource.fetchScript(input.sourceUrl))
          const inspection = await api.lxSource.inspect({
            id: input.id || 'probe-draft',
            name: input.name || '',
            kind: 'lx',
            sourceUrl: input.sourceUrl,
            headers: input.headers,
            enabled: true,
            script,
          })
          return lxInspectionToProbe(inspection)
        } catch (err) {
          return unavailableProbe('lx', renderErrorMessage(err))
        }
      }
      const parsed = parseSourceInput(input.sourceUrl)
      const result = await probeAuroraService(
        parsed?.baseUrl || input.sourceUrl,
        parsed?.apiKey || input.apiKey
      )
      return auroraProbeToResult(result)
    },

    async resolveTrackAudio(track: Track): Promise<Track | null> {
      // 定位凭据：曲目自带的脚本令牌（trackRef）或源内 id（onlineId）。
      // 都没有时这条路不适用，调用方回落按名搜索 —— 状态也就不必读。
      const ref = track?.trackRef
      const songId = sourceSongIdOf(track?.onlineSource, track?.onlineId)
      if (!ref && !songId) return null

      // 音源配置只在调用时读：用户可能在设置页刚改过脚本地址或删过源
      const { sources, quality } = await loadLibraryState()
      const source = sources.find((s) => s.id === (ref?.sourceId || track?.onlineSource))
      if (!source) return null

      // 走**插件门面**（与搜索同一条路），不再按 `kind === 'lx'` 分派两套通道。
      //
      // 改造前这里分两条分支：有 trackRef 只当脚本源、有 onlineId 只当 aurora。
      // 于是装来的声明式插件被两条分支同时排除，永远取不到址 —— 而它在清单里
      // 明明声明了 resolveTrack。现在凭据只是一个不透明令牌交给插件，
      // 由插件自己决定从哪个字段取值。
      //
      // 桌面端必须在**主进程**发请求（渲染进程直连会被上游 CORS 拦），
      // 所以走 `plugin:resolveTrack` 通道；插件实现与移动端完全同源。
      if (!api?.plugins?.resolveTrack) return null
      const token = trackRefFor(track)
      if (!token) return null
      try {
        const resolved = (await api.plugins.resolveTrack(
          pluginIdOf(source),
          source,
          token,
          quality
        )) as {
          url?: string
          quality?: string
          qualityUrls?: Record<string, string>
          coverUrl?: string
        } | null
        if (!resolved?.url || !/^https?:\/\//i.test(resolved.url)) return null
        // 只回填副本：直链会过期，不落盘、不写库（持久化时 onlineUrl 本就剥离）
        return {
          ...track,
          onlineUrl: resolved.url,
          // 插件自报的实际档位：请求 flac 却只拿到 m4a 时，这是「降级提示」的唯一依据
          ...(resolved.quality ? { onlineQuality: resolved.quality } : {}),
          ...(resolved.qualityUrls ? { onlineQualityUrls: resolved.qualityUrls } : {}),
          ...(resolved.coverUrl ? { coverUrl: resolved.coverUrl } : {}),
        }
      } catch (err) {
        // 取址失败要静默回落按名搜索，不打断播放
        console.warn('[音源] 取址失败:', source.id, err)
        return null
      }
    },

    /**
     * 跨源脚本取址：把其它源搜到的曲目交给「认领了该平台」的脚本源现取直链。
     *
     * 为什么需要：洛雪自定义脚本多数只实现 `musicUrl`、不实现 `search`（pdone 的 16 条
     * 里 15 条如此）。用户可以配一条 aurora 音源负责搜索、再配一条脚本并给它指定平台，
     * 搜到的曲目播放/下载时优先用脚本取址 —— 否则那条脚本在应用里永远没有用武之地。
     *
     * 与 `resolveTrackAudio` 的分工：那个只认曲目**自带的**凭据（它属于谁就找谁）；
     * 这里做的是**跨源**偏好，候选筛选与失败记忆都在 shared（两端同源），
     * 本方法只负责「怎么在桌面端执行插件」——渲染进程直连会被上游 CORS 拦，
     * 所以必须转发主进程的 `plugin:resolveTrack` 通道。
     */
    async resolveScriptTrackAudio(track: Track): Promise<Track | null> {
      const gateway = api?.plugins
      if (!gateway?.resolveTrack) return null

      const { sources, quality } = await loadLibraryState()
      const hit = await resolveTrackAudioAcrossScriptSources(
        sources,
        track,
        async (pick) => {
          const resolved = await gateway.resolveTrack(
            pluginIdOf(pick.source),
            pick.source,
            pick.ref,
            quality
          )
          if (!resolved?.url) return null
          return {
            url: resolved.url,
            ...(resolved.quality ? { quality: resolved.quality } : {}),
            ...(resolved.qualityUrls ? { qualityUrls: resolved.qualityUrls } : {}),
            ...(resolved.coverUrl ? { coverUrl: resolved.coverUrl } : {}),
          }
        },
        (message) => console.warn('[音源] 跨源取址:', message)
      )
      if (!hit) return null

      // 与 resolveTrackAudio 同一份回填口径：只改副本，不落盘、不写库
      return {
        ...track,
        onlineUrl: hit.resolution.url,
        ...(hit.resolution.quality ? { onlineQuality: hit.resolution.quality } : {}),
        ...(hit.resolution.qualityUrls ? { onlineQualityUrls: hit.resolution.qualityUrls } : {}),
        ...(hit.resolution.coverUrl ? { coverUrl: hit.resolution.coverUrl } : {}),
      }
    },

    // 在线音乐：桌面端转发主进程执行（渲染进程 fetch 会被上游 CORS 拦截）。
    // 未实现时返回空结果而不是抛错：调用方据空结果展示空态，不因平台差异崩
    musicHall: {
      async recommendPlaylists(source, options) {
        const r = await api?.musicHall?.recommendPlaylists(source, options)
        return (r as RecommendPlaylist[]) || []
      },
      async toplistGroups(source, options) {
        const r = await api?.musicHall?.toplistGroups(source, options)
        return (r as ToplistGroup[]) || []
      },
      async toplistSongs(source, options) {
        const r = await api?.musicHall?.toplistSongs(source, options)
        return (r as ToplistDetail) || { id: options?.id ?? '', name: '', total: 0, songs: [] }
      },
    },

    database: new NoopDatabase(),
    windowControls: api?.windowControls || new NoopWindowControls(),

    // 扩展能力：转发到 electronAPI
    async scanFolder(folderPath: string) {
      if (!api?.scanFolder) return []
      return api.scanFolder(folderPath)
    },
    async getAllTracks() {
      if (!api?.getAllTracks) return []
      return api.getAllTracks()
    },
    async ensureCover(trackId: string, fallback?: Partial<Track>) {
      if (!api?.ensureCover) return null
      return api.ensureCover(trackId, fallback)
    },
    async fetchOnlineCover(trackId: string, options?: OnlineSearchOptions, fallback?: Partial<Track>) {
      if (!api?.fetchOnlineCover) return null
      return api.fetchOnlineCover(trackId, options, fallback)
    },
    async removeFolder(folderPath: string) {
      if (!api?.removeFolder) return []
      return api.removeFolder(folderPath)
    },
    // 单曲移除与「在文件夹中显示」都按**方法是否存在**表达能力（全仓范式）：
    // 老版 preload 缺对应通道时保持 undefined，store 的 removeTrack 因此是 no-op
    // （不会把本地曲库清空），菜单项也不会渲染。
    // 注意不能写成「返回空数组表示失败」——移除最后一首歌时空数组是合法结果，
    // 两者无从区分，这正是能力缺失要用方法不存在表达的原因。
    removeTrack: typeof api?.removeTrack === 'function' ? (trackId: string) => api.removeTrack(trackId) : undefined,
    revealTrack:
      typeof api?.showItemInFolder === 'function'
        ? (trackId: string) => api.showItemInFolder(trackId)
        : undefined,
    onTracksScanned(cb: (tracks: Track[]) => void) {
      if (!api?.onTracksScanned) return () => {}
      return api.onTracksScanned(cb)
    },
    // 渐进式扫描：主进程每解析完一首就推 track:scanned，这里转发给 UI，
    // 让曲库边扫描边显示（此前只转发了 scan:complete，该能力在桌面端一直是失效的）
    onTrackScanned(cb: (track: Track) => void) {
      if (!api?.onTrackScanned) return () => {}
      return api.onTrackScanned(cb)
    },
    onScanError(cb: (e: { folder: string; message: string }) => void) {
      if (!api?.onScanError) return () => {}
      return api.onScanError(cb)
    },
    onFolderMissing(cb: (e: { folder: string; removed: number }) => void) {
      if (!api?.onFolderMissing) return () => {}
      return api.onFolderMissing(cb)
    },
    // 加密音频上报：主进程在解析失败处判定（文件名带平台标记）后推 scan:encrypted
    onEncryptedAudioFound(cb: (file: EncryptedAudioFile) => void) {
      if (!api?.onEncryptedFile) return () => {}
      return api.onEncryptedFile(cb)
    },
    async importAudioFile(filePath: string) {
      if (!api?.importAudioFile) return null
      return api.importAudioFile(filePath)
    },
    onMediaControl(cb: (action: string) => void) {
      if (!api?.onMediaControl) return () => {}
      return api.onMediaControl(cb)
    },
    // 音频焦点：开关与播放态上报都只转发，仲裁、让位与续播全在主进程做。
    // 两个方法**始终定义**（与上面的订阅方法同一写法）：preload 缺失时在这里
    // 就地降级——开关回执 false（设置页据此提示不支持）、上报直接丢弃，
    // 而不是让调用方每次先判 `typeof === 'function'` 再决定要不要相信结果。
    async setAudioFocusEnabled(enabled: boolean): Promise<boolean> {
      if (!api?.setAudioFocusEnabled) return false
      try {
        // 主进程的返回值就是「平台是否支持」，原样透传（只认严格 true）
        return (await api.setAudioFocusEnabled(enabled)) === true
      } catch {
        // IPC 异常等价于「这一端没接管成功」：宁可让设置页提示不支持，
        // 也不能让用户以为开关已经生效
        return false
      }
    },
    reportPlaybackState(isPlaying: boolean): void {
      if (!api?.reportPlaybackState) return
      try {
        api.reportPlaybackState(isPlaying)
      } catch {
        // 高频通道（每次播放/暂停都发），失败只静默：不能因为上报异常打断播放
      }
    },
    async searchLyrics(query, artist, album, duration, options) {
      if (!api?.searchLyrics) return null
      return api.searchLyrics(query, artist, album, duration, options)
    },
    async downloadOnlineTrack(track, headers, downloadDir) {
      if (!api?.downloadOnlineTrack) throw auroraError('runtime.error.downloadUnsupported')
      return api.downloadOnlineTrack(track, headers, downloadDir)
    },

    // ─── 媒体库来源（WebDAV）：配置与请求都在主进程，渲染层只传 sourceId ───
    async syncLibrarySources(sources: LibrarySourceConfig[]) {
      if (!api?.syncLibrarySources) return
      return api.syncLibrarySources(sources)
    },
    async scanLibrarySource(sourceId: string) {
      if (!api?.scanLibrarySource) throw auroraError('runtime.error.storageUnsupported')
      return api.scanLibrarySource(sourceId)
    },
    async probeLibrarySource(sourceId: string) {
      if (!api?.probeLibrarySource) {
        // 探测结论直接上屏：取值在调用时进行，跟随当前界面语言
        return { ok: false, message: appTranslate()('runtime.error.storageUnsupported') }
      }
      return api.probeLibrarySource(sourceId)
    },
    async removeLibrarySource(sourceId: string) {
      if (!api?.removeLibrarySource) return []
      return api.removeLibrarySource(sourceId)
    },

    // ─── 存储协议与口令：转发到主进程 ───
    // 能力缺失（旧版 preload / 非桌面端）时返回空列表与「不可用」状态，
    // 设置页据此隐藏插件选择与口令入口，而不是让用户点了再失败。
    async listStoragePlugins(): Promise<StoragePluginMeta[]> {
      if (!api?.listStoragePlugins) return []
      return api.listStoragePlugins()
    },
    async saveStorageCredential(sourceId: string, payload: Record<string, string>) {
      if (!api?.saveStorageCredential) {
        // 没有主进程凭证存储 = 本端无法安全保存口令，如实回报而不是假装成功
        return { ok: false, saved: false, encryptionAvailable: false }
      }
      return api.saveStorageCredential(sourceId, payload)
    },
    async storageCredentialState(sourceId: string): Promise<StorageCredentialState> {
      if (!api?.storageCredentialState) return { saved: false, encryptionAvailable: false }
      return api.storageCredentialState(sourceId)
    },
    async clearStorageCredential(sourceId: string) {
      if (!api?.clearStorageCredential) {
        return { ok: false, saved: false, encryptionAvailable: false }
      }
      return api.clearStorageCredential(sourceId)
    },

    // ─── 歌单同步：设备身份与口令转发到主进程，局域网桥原样装配 ───
    // 与存储口令同一套降级口径：缺通道时**如实回报不可用**，不假装成功。
    // 口令原文只在 getCredential 里回读一次（引擎持有到本次调用结束），
    // 这里不做任何缓存 —— 缓存就等于把明文留在渲染层。
    supportsPlaylistSync: true,
    sync: {
      async device() {
        if (!api?.sync?.device) return fallbackDeviceIdentity()
        const identity = await api.sync.device()
        return normalizeDeviceIdentity(identity)
      },
      async saveCredential(configId: string, payload: Record<string, string>) {
        if (!api?.sync?.saveCredential) {
          return { ok: false, saved: false, encryptionAvailable: false }
        }
        return api.sync.saveCredential(configId, payload)
      },
      async credentialState(configId: string): Promise<SyncCredentialState> {
        if (!api?.sync?.credentialState) return { saved: false, encryptionAvailable: false }
        return api.sync.credentialState(configId)
      },
      async clearCredential(configId: string) {
        if (!api?.sync?.clearCredential) {
          return { ok: false, saved: false, encryptionAvailable: false }
        }
        return api.sync.clearCredential(configId)
      },
      async getCredential(configId: string) {
        if (!api?.sync?.getCredential) return null
        const secrets = await api.sync.getCredential(configId)
        // 主进程回 null = 没有可用口令（未配置 / 解密失败），原样透传
        return secrets && typeof secrets === 'object' ? (secrets as Record<string, string>) : null
      },
    },
    lanSync: createLanSyncBridge(api),
    onLanSyncInbox(cb: (snapshots: SyncSnapshot[]) => void) {
      const lan = api?.lanSync
      if (!lan || typeof lan.onInbox !== 'function') return () => {}
      return lan.onInbox((payload: SyncSnapshot | SyncSnapshot[]) => {
        // 主进程推的可能是一份或一批：归一成数组，引擎只认一种形状
        if (Array.isArray(payload)) cb(payload)
        else if (payload) cb([payload])
      })
    },

    /**
     * 同步请求的 fetch 出口：桌面端由主进程代发。
     *
     * WebDAV 服务端给不给 CORS 头不由我们决定，渲染层直连在部分 NAS 上必被拦。
     * 主进程的 `sync:fetch` 通道（验证报告 B-2）把请求搬出渲染层，这里把它包成
     * 标准 `fetch` 形状 —— 插件侧只认 `ctx.fetch`，不需要知道传输在哪一层。
     */
    syncFetch: createSyncFetch(api),

    // ─── 媒体缓存：转发到主进程 ───
    async resolveCachedAudio(req) {
      if (!api?.audioCache?.resolve) return { src: null }
      return api.audioCache.resolve(req)
    },
    async resolveCachedCover(req) {
      if (!api?.audioCache?.resolveCover) return { src: null }
      return api.audioCache.resolveCover(req)
    },
    async configureAudioCache(opts) {
      if (!api?.audioCache?.configure) return
      return api.audioCache.configure(opts)
    },
    async getAudioCacheUsage() {
      if (!api?.audioCache?.usage) return { usedBytes: 0, count: 0 }
      return api.audioCache.usage()
    },
    async clearAudioCache() {
      if (!api?.audioCache?.clear) return
      return api.audioCache.clear()
    },

    // ─── 诊断日志：原样转发 preload 暴露的 window.electronAPI.logging ───
    // 不在这里吞异常：logging.service 的 transportSink 已经做了「出口故障只丢一条记录」
    // 的兜底，再包一层会让失败原因被吞掉、日志里查不到为什么没落盘。
    // 方法名与形状来自 shared 的 LOG_IPC / LoggingRendererApi，两侧靠同一份类型对齐。
    get logging(): LoggingGateway | undefined {
      const logging = api?.logging
      // 能力逐个判：老版本 preload 可能只暴露了 record，缺哪个就少哪个入口，
      // 不能让「导出」按钮因为 record 存在就以为整条链路可用
      if (!logging || typeof logging.record !== 'function') return undefined
      return {
        record: (payload) => logging.record(payload),
        bundle: () => logging.bundle(),
        exportFile: () => logging.exportFile(),
        reveal: (filePath: string) => logging.reveal(filePath),
        info: () => logging.info(),
        // 桌面端每条记录经单向 IPC 直接进主进程写盘队列，渲染层没有自己的队列可冲
        flush: async () => {},
      }
    },

    /**
     * 插件网关：所有能力转发到主进程。
     *
     * 为什么必须在主进程：插件要 Node 网络栈（渲染进程直连上游会被 CORS 拦；
     * 汽水上游对带 Origin 的请求直接 403），凭据也只能在主进程经 safeStorage 加密。
     * 渲染层只传配置与定位数据，拿不到凭证原文。
     */
    get plugins(): PluginGateway | undefined {
      const plugins = api?.plugins
      // 老版本 preload 没有这一组通道：整块降级，UI 隐藏插件入口而不是点了才失败
      if (!plugins || typeof plugins.list !== 'function') return undefined
      return {
        list: () => plugins.list(),
        probe: (pluginId, config) => plugins.probe(pluginId, config),
        search: (pluginId, config, query, quality) =>
          plugins.search(pluginId, config, query, quality),
        resolveTrack: (pluginId, config, ref, quality) =>
          plugins.resolveTrack(pluginId, config, ref, quality),
        userPlaylists: (pluginId, config) => plugins.userPlaylists(pluginId, config),
        playlistTracks: (pluginId, config, playlistId) =>
          plugins.playlistTracks(pluginId, config, playlistId),
        login: (pluginId, rawInput) => plugins.login(pluginId, rawInput),
        authState: (pluginId) => plugins.authState(pluginId),
        logout: (pluginId) => plugins.logout(pluginId),
        // 安装 / 卸载 / 目录：老 preload 可能没有这组通道。
        // **逐个判存在性**而不是整块判：缺了安装通道不该让搜索/登录一起失效，
        // 插件管理入口据 `installFromUrl === undefined` 自行隐藏。
        catalog: typeof plugins.catalog === 'function' ? (locale) => plugins.catalog(locale) : undefined,
        // 启动加载报告：老 preload 没有这条通道时保持 undefined（渲染层跳过提示）
        startup:
          typeof plugins.startup === 'function' ? () => plugins.startup() : undefined,
        pickManifest:
          typeof plugins.pickManifest === 'function' ? () => plugins.pickManifest() : undefined,
        installFromFile:
          typeof plugins.installFromFile === 'function'
            ? (filePath, locale) => plugins.installFromFile(filePath, locale)
            : undefined,
        installFromUrl:
          typeof plugins.installFromUrl === 'function'
            ? (url, sha, locale) => plugins.installFromUrl(url, sha, locale)
            : undefined,
        uninstall:
          typeof plugins.uninstall === 'function'
            ? (pluginId, locale) => plugins.uninstall(pluginId, locale)
            : undefined,
        openDir: typeof plugins.openDir === 'function' ? () => plugins.openDir() : undefined,
        removeBroken:
          typeof plugins.removeBroken === 'function'
            ? (dirPath) => plugins.removeBroken(dirPath)
            : undefined,
        // 插件启停：老 preload 没有这组通道时保持 undefined（UI 隐藏开关而不是显示后失败）
        //
        // 切换成功后**顺手把渲染层那份 shared 内存态刷新一遍**：桌面端有主进程与渲染进程
        // 两个 `@aurora/shared` 实例，权威状态在主进程。不刷新的话，界面层的
        // `canBrowseHall` / `isSearchableSource` 仍按"全部启用"判断，于是用户停用一个
        // 插件后还能看到它的入口，点进去才没结果。移动端刷新是幂等空操作
        // （同一个进程同一份状态），不额外分支。
        setPluginEnabled:
          typeof plugins.setPluginEnabled === 'function'
            ? async (pluginId, enabled) => {
                const result = await plugins.setPluginEnabled(pluginId, enabled)
                // 落盘失败时主进程会回滚，此时也必须以权威值为准重新同步
                const { syncPluginAvailability } = await import('../pluginAvailability')
                await syncPluginAvailability()
                return result
              }
            : undefined,
        listDisabledPlugins:
          typeof plugins.listDisabledPlugins === 'function'
            ? () => plugins.listDisabledPlugins()
            : undefined,
      }
    },
  }
}

export function createMobilePlatform(): Platform {
  // 静态导入：Capacitor 自带 platform guard，web 端调用是 no-op；
  // 此函数仅在 createPlatform 检测到 Capacitor 全局时调用，桌面端不会走到这里
  return createMobilePlatformImpl()
}

export function createPlatform(): Platform {
  if (typeof window !== 'undefined' && (window as any).electronAPI) {
    return createDesktopPlatform()
  }
  // 仅当运行在 Capacitor 原生容器（Android/iOS WebView）时才走移动端实现。
  // 注意：@capacitor/core 在普通浏览器里也会注入 window.Capacitor（platform: 'web'），
  // 不能只凭全局对象是否存在判断，必须用 isNativePlatform()，
  // 否则浏览器会误走移动端分支（如弹出 Android 存储路径输入框）。
  const cap = typeof window !== 'undefined' ? (window as any).Capacitor : null
  if (cap?.isNativePlatform?.()) {
    return createMobilePlatform()
  }
  // Web 浏览器：支持 File System Access API（Chrome/Edge）时走 Web 平台实现，
  // 可导入本地目录、解析元数据并播放；曲目与 objectURL 仅当前会话有效
  if (isFileSystemAccessSupported()) {
    return createWebPlatform()
  }
  // 其他未知环境：返回最小 Noop 实现，避免运行时崩
  return {
    platform: 'desktop' as const, // 占位类型，无 electronAPI 时无副作用
    async pickFolder() { return null },
    async readDir() { return [] },
    async readFile() { return new ArrayBuffer(0) },
    getAudioSrc(path: string) { return path },
    getCoverSrc(path: string) { return path },
    async getMetadata(path: string) {
      return { title: path.split('/').pop() || 'Unknown', artist: 'Unknown', album: 'Unknown', duration: 0 }
    },
    async getUserDataPath() { return '' },
    async saveCover() { return '' },
    async saveLyrics() { return '' },
    async readLyrics() { return null },
    async searchOnlineTracks() { return [] },
    // 未知环境没有脚本宿主能力：探测给可读结论、取址返回 null，
    // 调用方据此回落既有取址路径而不崩
    async probeSource(input: SourceProbeInput): Promise<SourceProbeResult> {
      return unavailableProbe(input.kind || 'aurora', appTranslate()('runtime.platform.scriptUnsupportedEnv'))
    },
    async resolveTrackAudio() { return null },
    // 未知环境没有主进程：同步与局域网能力一律关掉（入口随 supportsPlaylistSync 隐藏）
    supportsPlaylistSync: false,
    lanSync: null,
    database: new NoopDatabase(),
    windowControls: new NoopWindowControls(),
  }
}

/**
 * 在线音乐读取的统一入口：平台未实现该能力（web / Noop）时返回空结果，
 * 调用方据空结果展示空态 —— 浏览器里不因平台差异崩，也不出现半截内容。
 */
export async function hallRecommend(
  source: MusicHallSource,
  options?: MusicHallOptions
): Promise<RecommendPlaylist[]> {
  return (await platform.musicHall?.recommendPlaylists(source, options)) || []
}

export async function hallToplists(
  source: MusicHallSource,
  options?: MusicHallOptions
): Promise<ToplistGroup[]> {
  return (await platform.musicHall?.toplistGroups(source, options)) || []
}

export async function hallToplistSongs(
  source: MusicHallSource,
  options?: MusicHallOptions
): Promise<ToplistDetail> {
  return (
    (await platform.musicHall?.toplistSongs(source, options)) || {
      id: options?.id ?? '',
      name: '',
      total: 0,
      songs: [],
    }
  )
}

/** 当前端是否具备在线音乐能力（web 端为 false，UI 据此展示不可用提示） */
export function supportsMusicHall(): boolean {
  return Boolean(platform.musicHall)
}

/**
 * 把 preload 暴露的 `lanSync` 装配成 shared 的 `LanSyncBridge`。
 *
 * 两处差异只在这一层消化：
 * 1. 通道名不同（`lan:pull`/`lan:push` ↔ `pullPeer`/`pushPeer`）；
 * 2. 主进程可能只实现了部分通道（老版本 preload）。缺哪个就在调用时报
 *    `sync.error.lanDisabled`，而不是装配出一个「方法存在但发不出请求」的桥 ——
 *    UI 的可用性判断看的是桥是否为 null，半残的桥会让入口亮着却一直失败。
 */
function createLanSyncBridge(api: any): LanSyncBridge | null {
  const lan = api?.lanSync
  // 只有 status 在，才认为主进程真的装了局域网服务（其余通道同批上线）
  if (!lan || typeof lan.status !== 'function') return null
  return {
    status: () => lan.status(),
    setEnabled: (enabled: boolean) => lan.setEnabled(enabled),
    rotateCode: () => lan.rotateCode(),
    discover: (timeoutMs?: number) => lan.discover(timeoutMs),
    publish: (snapshot: SyncSnapshot) => lan.publish(snapshot),
    takeInbox: () => lan.takeInbox(),
    pullPeer: (target) => {
      if (typeof lan.pull !== 'function') return Promise.reject(unsupportedLanChannel())
      return lan.pull(target)
    },
    pushPeer: (target, snapshot) => {
      if (typeof lan.push !== 'function') return Promise.reject(unsupportedLanChannel())
      return lan.push(target, snapshot)
    },
  }
}

/** 主进程代发同步请求的超时（WebDAV 一次 PUT 可能要几十秒，别按浏览器的 8s 算） */
const SYNC_FETCH_TIMEOUT_MS = 60_000

function unsupportedLanChannel(): Error {
  return auroraError('sync.error.lanDisabled')
}

/**
 * 设备身份的兜底。
 *
 * 正常情况下 deviceId 来自主进程持久化（重启不变，LWW 并列判定要靠它稳定）。
 * 老版本 preload 没有该通道时给一个**本次会话内稳定**的随机身份：宁可让这台机器
 * 在本轮里被当成「新设备」，也不要因为拿不到身份就让整个同步不可用。
 */
let fallbackIdentity: SyncDeviceIdentity | null = null
function fallbackDeviceIdentity(): SyncDeviceIdentity {
  if (!fallbackIdentity) {
    const random =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36)
    fallbackIdentity = { deviceId: `renderer-${random}`, deviceName: 'Aurora Music' }
  }
  return fallbackIdentity
}

/** 主进程返回值可能缺字段（旧数据 / 空磁盘），补齐成引擎可用的形状 */
function normalizeDeviceIdentity(raw: any): SyncDeviceIdentity {
  const deviceId =
    raw && typeof raw.deviceId === 'string' && raw.deviceId ? raw.deviceId : fallbackIdentity0()
  const deviceName =
    raw && typeof raw.deviceName === 'string' && raw.deviceName ? raw.deviceName : 'Aurora Music'
  return { deviceId, deviceName }
}

function fallbackIdentity0(): string {
  return fallbackDeviceIdentity().deviceId
}

/**
 * `window.electronAPI.sync.fetch` → 标准 `fetch`。
 *
 * 入参形状是 `{url, method?, headers?, body?, timeoutMs?}`，回 `{status, statusText,
 * headers, bodyText}`（通道由主进程实现，签名已在 task-8 冻结）。这里只做「Request →
 * 扁平参数 → Response」的翻译，不掺业务。
 *
 * 注意两点：
 * - 主进程那条通道没有 AbortSignal 语义，取消靠 `timeoutMs` 超时；调用方的
 *   `init.signal` 在这里被忽略（插件侧超时仍生效，因为请求本身有 timeoutMs 兜底）。
 * - `status` 非法（缺字段 / 0）时抛错而不是伪造 200：让插件报「连不上」，
 *   好过拿一个空 200 去按「404 目录不存在」处理。
 */
function createSyncFetch(api: any): typeof globalThis.fetch | undefined {
  const send = api?.sync?.fetch
  if (typeof send !== 'function') return undefined
  const syncFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init)
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      headers[key] = value
    })
    const method = request.method.toUpperCase()
    const body = method === 'GET' || method === 'HEAD' ? undefined : await request.clone().text()
    let reply: any
    try {
      reply = await send({
        url: request.url,
        method,
        headers,
        body,
        timeoutMs: SYNC_FETCH_TIMEOUT_MS,
      })
    } catch (err) {
      // 主进程抛的是项目统一的 `AURORA_ERR:{...}` 信封（IPC 还会给 message 加前缀），
      // 这里把它还原成 `cause`：WebDAV 插件的错误码（sync.error.webdavConnect 等）
      // 必须原样到 translateError 手里，不能在这里被压成 unknown。
      throw syncFetchError(err)
    }
    const status = Number(reply?.status)
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      throw new TypeError('sync:fetch returned no usable status')
    }
    const bodyText = typeof reply?.bodyText === 'string' ? reply.bodyText : ''
    // 204/205/304 是「无实体」状态：手工构造 Response 时带 body 会直接抛 TypeError
    const nullBody = status === 204 || status === 205 || status === 304
    return new Response(nullBody ? null : bodyText, {
      status,
      statusText: reply?.statusText ?? '',
      headers: responseHeadersOf(reply?.headers),
    })
  }
  return syncFetch as typeof globalThis.fetch
}

/**
 * 把主进程抛回来的 IPC 错误还原成带 `cause` 的 Error。
 *
 * `parseErrorInfo` 认 `AURORA_ERR:{...}` 信封，`stripIpcPrefix` 先剥掉 Electron 加的
 * `Error invoking remote method 'sync:fetch': Error: ` 前缀；两步之后 `cause` 是结构化
 * 的 `{code,params,detail}`，`translateError` 就能还原文案。
 */
function syncFetchError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err)
  const payload = stripIpcPrefix(raw)
  const info = parseErrorInfo(payload)
  const wrapped: Error & { cause?: unknown } = new Error(raw)
  if (info) wrapped.cause = info
  return wrapped
}

/** 主进程回的头是普通对象；`Response` 会校验几个保留头，构造失败就退化成空头 */
function responseHeadersOf(raw: any): Headers {
  try {
    const headers = new Headers()
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string') headers.set(key, value)
      }
    }
    return headers
  } catch {
    return new Headers()
  }
}

export const platform = createPlatform()
