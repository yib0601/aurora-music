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
  isTrackEndpointKnownMissing,
  lxInspectionToProbe,
  parseSourceInput,
  probeAuroraService,
  pluginIdOf,
  sourceSongIdOf,
  unavailableProbe,
} from '@aurora/shared'
import type {
  PluginAuthState as PluginAuthStateInfo,
  PluginPlaylist as PluginPlaylistInfo,
  ResolvedAudio,
  SourceTrackRef,
} from '@aurora/shared'

/** 插件元信息（渲染层只消费这些字段，拿不到插件实现） */
export interface PluginMetaInfo {
  id: string
  displayNameKey: string
  descriptionKey?: string
  version: string
  capabilities: readonly string[]
  hasCredential: boolean
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
   * 按需补齐封面（桌面端）：扫描阶段用 skipCovers 跳过内嵌图片读取以提速，
   * 记录中无 coverPath 时由 UI 调用本方法单独提取并缓存，返回封面绝对路径。
   * 曲目无内嵌封面时返回 null。移动端扫描阶段已内联提取，故不实现此方法。
   * fallback：不在曲库的曲目（在线快照）的元信息兜底，主进程据此判定形态。
   */
  ensureCover?: (trackId: string, fallback?: Partial<Track>) => Promise<string | null>
  /**
   * 在线补齐封面（桌面端）：文件无内嵌封面时，按标题/艺术家搜索用户配置的
   * 在线歌源，下载匹配候选的封面并缓存，返回封面绝对路径。无匹配返回 null。
   * options.sources 为渲染层持有的歌源配置（应用不内置源）。
   * fallback：不在曲库的曲目（在线快照）的元信息兜底，主进程仅取标题/艺术家/
   * 时长构造查询，地址类字段一律不信任。
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
  /** 扫描完成事件订阅 */
  onTracksScanned?: (cb: (tracks: Track[]) => void) => () => void
  /** 单曲扫描完成事件订阅（渐进式刷新：每解析完一首立即通知，UI 追加而非等全部完成） */
  onTrackScanned?: (cb: (track: Track) => void) => () => void
  /** 扫描失败事件订阅（静默扫描：仅用于记录日志） */
  onScanError?: (cb: (e: { folder: string; message: string }) => void) => () => void
  /** 扫描时发现目录已从磁盘删除（主进程/移动端已清理其曲目），UI 据此移除目录条目 */
  onFolderMissing?: (cb: (e: { folder: string; removed: number }) => void) => () => void
  /** 系统媒体键事件订阅（桌面端来自 globalShortcut/MPRIS，移动端来自 mediaSession） */
  onMediaControl?: (cb: (action: string) => void) => () => void
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
}

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
      // 两条定位凭据：脚本源的令牌（trackRef）与自有服务协议的源内 id（onlineId）。
      // 都没有时这条路不适用，调用方回落按名搜索 —— 状态也就不必读。
      const ref = track?.trackRef
      const songId = sourceSongIdOf(track?.onlineSource, track?.onlineId)
      if (!ref && !songId) return null
      // 音源配置只在调用时读：用户可能在设置页刚改过脚本地址或删过源
      const { sources, quality } = await loadLibraryState()

      if (ref) {
        if (!api?.lxSource?.resolveUrl) return null
        const source = sources.find((s) => s.id === ref.sourceId)
        // 找不到音源配置或形态对不上时同样返回 null：不猜、不拿别的源硬取
        if (!source || source.kind !== 'lx') return null
        try {
          const { url } = await api.lxSource.resolveUrl(ref, source, quality)
          if (!url || !/^https?:\/\//i.test(url)) return null
          // 只回填副本：直链会过期，不落盘、不写库（持久化时 onlineUrl 本就剥离）
          return { ...track, onlineUrl: url }
        } catch (err) {
          console.warn('[音源] 取址失败:', ref.sourceId, err)
          return null
        }
      }

      // 自有服务协议：按源内 id 取址（服务端 /aurora/track）。比「按歌名 + 歌手重搜」
      // 准得多 —— 同名不同版本（变速版 / 翻唱 / DJ 版）在按名匹配里与目标同分，
      // 会串到别人的录音（见 @aurora/shared 的 trackResolver）。
      const source = sources.find((s) => s.id === track.onlineSource)
      if (!source || source.kind === 'lx') return null
      // 老服务端没有这条端点：本进程已知就直接回落（移动端与执行器同进程时最有效）。
      // 桌面端取址在主进程执行，两边的「已知缺失」记忆各存一份 —— 不知道也只是多一次
      // IPC，主进程侧的执行器不会再打一次 404。
      if (isTrackEndpointKnownMissing(source)) return null
      if (!api?.onlineTrack?.resolveById) return null
      try {
        const resolved = await api.onlineTrack.resolveById(source, songId, quality)
        if (!resolved?.audioUrl || !/^https?:\/\//i.test(resolved.audioUrl)) {
          // 失败原因（无权益 / id 不存在 / 老服务端）在共享层已编码成可渲染文案，
          // 这里只落日志：取址失败要静默回落按名搜索，不打断播放
          console.warn('[音源] 按 id 取址未成功:', songId, resolved?.reason || '')
          return null
        }
        return {
          ...track,
          onlineUrl: resolved.audioUrl,
          ...(resolved.qualityUrls ? { onlineQualityUrls: resolved.qualityUrls } : {}),
          ...(resolved.coverUrl ? { coverUrl: resolved.coverUrl } : {}),
        }
      } catch (err) {
        console.warn('[音源] 按 id 取址失败:', songId, err)
        return null
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
    onMediaControl(cb: (action: string) => void) {
      if (!api?.onMediaControl) return () => {}
      return api.onMediaControl(cb)
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

export const platform = createPlatform()
