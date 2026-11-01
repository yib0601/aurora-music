import { contextBridge, ipcRenderer } from 'electron'
import type {
  OnlineSearchOptions,
  OnlineTrackSearchResult,
  LyricsSearchOptions,
  LyricsSearchResult,
  LibrarySourceConfig,
  LoggingRendererApi,
  StoragePluginMeta,
} from '@aurora/shared'
// 纯类型位置：`import type` 在编译后完全擦除，不产生 require。
// 沙箱 preload 不能 require 相对路径模块，但类型导入是安全的（同下方 LOG_CHANNELS 的用法）。
import type { StorageCredentialState } from './ipc/storageCredentials'

/**
 * 日志通道名的本地副本 —— 只在这里存在，原因是**沙箱 preload 不能 require 共享包**。
 *
 * 本文件的唯一运行期依赖是 `electron`（见 createWindow 的 webPreferences 注释：
 * sandbox:true 下只保证 contextBridge + ipcRenderer 可用）。沙箱 preload 的
 * `require` 只认 electron 与 events/timers/url 这几个内建模块，也无法 require 相对
 * 路径的本地文件 —— 所以既不能 `import { LOG_IPC } from '@aurora/shared'`
 * （会编译成 require("@aurora/shared")，启动即抛错、整个 electronAPI 消失），
 * 也不能把这张表拆到另一个文件里。
 *
 * 防漂移靠两道机器检查，而不是靠人记住：
 * 1. `satisfies typeof import('@aurora/shared').LOG_IPC` —— 类型级，逐字比对。
 *    少写、多写、写错任何一个通道名都**编译失败**；`typeof import(...)` 是纯类型
 *    位置，会被完全擦除，不产生任何 require（已核对编译产物 dist-electron/preload.js）。
 * 2. `logging/__tests__/preloadChannels.test.ts` 扫描本文件源码，把这张表与
 *    `LOG_IPC` 逐字比对 —— 覆盖「类型断言被人顺手改成宽类型」这类回退。
 */
const LOG_CHANNELS = {
  bundle: 'logging:bundle',
  exportFile: 'logging:export',
  reveal: 'logging:reveal',
  info: 'logging:info',
  record: 'logging:record',
} as const satisfies typeof import('@aurora/shared').LOG_IPC

const electronAPI = {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
  readDir: (dirPath: string) => ipcRenderer.invoke('fs:readDir', dirPath),
  readFile: (filePath: string): Promise<ArrayBuffer> => ipcRenderer.invoke('fs:readFile', filePath),
  scanFolder: (folderPath: string): Promise<any[]> => ipcRenderer.invoke('scan:start', folderPath),
  getUserDataPath: (): Promise<string> => ipcRenderer.invoke('app:getUserDataPath'),
  // 系统环境：发行版包格式（rpm/deb）与当前安装形态（AppImage/系统包/便携），
  // 供渲染层在「检查更新」时挑选匹配当前系统的安装包
  getSystemInfo: (): Promise<{
    platform: string
    arch: string
    distroId: string | null
    distroName: string | null
    pkgFamily: 'rpm' | 'deb' | 'unknown'
    installKind: 'appimage' | 'system-package' | 'portable' | 'unknown'
  }> => ipcRenderer.invoke('system:getInfo'),
  // 内置软件更新：主进程流式下载安装包到「下载」目录（进度经事件推送），
  // 下载完成后可直接启动安装器（exe）/ 新版本（AppImage），或打开终端执行
  // sudo 覆盖安装命令（deb/rpm）。url/altUrls 只接受 GitHub release 资源直链
  // 与白名单加速链接；altUrls 为候选加速源，主进程在直连失败时依次降级重试；
  // expectedSize / expectedDigest 来自 release API（assets[].size / digest），
  // 由主进程在下载完成后校验安装包完整性与内容。
  updater: {
    download: (
      url: string,
      kind: string,
      altUrls?: string[],
      expectedSize?: number | null,
      expectedDigest?: string | null
    ): Promise<{ filePath: string }> =>
      ipcRenderer.invoke('updater:download', url, kind, altUrls ?? [], expectedSize ?? null, expectedDigest ?? null),
    cancel: (): Promise<void> => ipcRenderer.invoke('updater:cancel'),
    // 在文件管理器中定位安装包
    reveal: (filePath: string): Promise<void> => ipcRenderer.invoke('updater:reveal', filePath),
    install: (filePath: string, kind: string): Promise<{ action: 'launched' | 'terminal' | 'none'; command?: string }> =>
      ipcRenderer.invoke('updater:install', filePath, kind),
    onProgress: (
      callback: (payload: { received: number; total: number | null; speed: number | null }) => void
    ) => {
      const handler = (
        _event: unknown,
        payload: { received: number; total: number | null; speed: number | null }
      ) => callback(payload)
      ipcRenderer.on('updater:progress', handler)
      return () => ipcRenderer.removeListener('updater:progress', handler)
    },
    // 下载线路说明（系统代理 / 直连）：下载开始时推一次，供界面解释「为什么慢」
    onRoute: (callback: (payload: { label: string; proxy: string | null }) => void) => {
      const handler = (_event: unknown, payload: { label: string; proxy: string | null }) => callback(payload)
      ipcRenderer.on('updater:route', handler)
      return () => ipcRenderer.removeListener('updater:route', handler)
    },
    onDone: (callback: (payload: { filePath: string; kind: string }) => void) => {
      const handler = (_event: unknown, payload: { filePath: string; kind: string }) => callback(payload)
      ipcRenderer.on('updater:done', handler)
      return () => ipcRenderer.removeListener('updater:done', handler)
    },
    onError: (callback: (message: string) => void) => {
      const handler = (_event: unknown, message: string) => callback(message)
      ipcRenderer.on('updater:error', handler)
      return () => ipcRenderer.removeListener('updater:error', handler)
    },
  },
  getAllTracks: (): Promise<any[]> => ipcRenderer.invoke('db:getAllTracks'),
  // ─── 媒体库来源（WebDAV 网络存储）───
  // syncLibrarySources 把来源配置（含口令）交给主进程保管：播放时主进程按
  // sourceId 带鉴权代理远端请求，渲染层与数据库都不会出现远端口令
  syncLibrarySources: (sources: LibrarySourceConfig[]): Promise<void> =>
    ipcRenderer.invoke('library-source:sync', sources),
  probeLibrarySource: (sourceId: string): Promise<{ ok: boolean; message: string; sample?: string[] }> =>
    ipcRenderer.invoke('library-source:probe', sourceId),
  scanLibrarySource: (
    sourceId: string
  ): Promise<{ tracks: any[]; complete: boolean; failedDirs: number }> =>
    ipcRenderer.invoke('library-source:scan', sourceId),
  removeLibrarySource: (sourceId: string): Promise<any[]> =>
    ipcRenderer.invoke('library-source:remove', sourceId),
  // ─── 存储来源口令（主进程 safeStorage 加密落盘，渲染层永不拿原文）───
  // 只回「有没有」与「本机能否加密」这类状态；口令文本框的值单向往主进程送。
  saveStorageCredential: (
    sourceId: string,
    payload: Record<string, string>
  ): Promise<{ ok: boolean } & StorageCredentialState> =>
    ipcRenderer.invoke('library-source:credential:save', sourceId, payload),
  storageCredentialState: (sourceId: string): Promise<StorageCredentialState> =>
    ipcRenderer.invoke('library-source:credential:state', sourceId),
  clearStorageCredential: (sourceId: string): Promise<{ ok: boolean } & StorageCredentialState> =>
    ipcRenderer.invoke('library-source:credential:clear', sourceId),
  // 可添加的存储协议（纯数据 meta + 声明式 fields），供设置页通用渲染表单
  listStoragePlugins: (): Promise<StoragePluginMeta[]> =>
    ipcRenderer.invoke('storage-plugin:list'),
  // 从曲库移除扫描目录：主进程删除该目录下的曲目记录并返回移除后的全库列表
  removeFolder: (folderPath: string): Promise<any[]> => ipcRenderer.invoke('library:removeFolder', folderPath),
  // 从曲库移除单曲：只删记录与封面缓存，**不删磁盘上的音频文件**；返回移除后的全库
  removeTrack: (trackId: string): Promise<any[]> => ipcRenderer.invoke('library:removeTrack', trackId),
  // 在文件管理器中定位曲目：入参是**曲目 id**而不是路径 —— 主进程按 id 反查 path，
  // 渲染层因此拿不到「定位任意本机文件」的能力（理由见 ipc/libraryActions.ts）
  showItemInFolder: (trackId: string): Promise<boolean> =>
    ipcRenderer.invoke('shell:showItemInFolder', trackId),
  getTrack: (id: string): Promise<any | null> => ipcRenderer.invoke('tracks:get', id),
  // 按需补齐封面（扫描时为提速跳过了嵌入图片，UI 需要时单独提取）；
  // fallback 为不在曲库的曲目（在线快照）的元信息兜底，见主进程 covers:ensure
  ensureCover: (id: string, fallback?: unknown): Promise<string | null> =>
    ipcRenderer.invoke('covers:ensure', id, fallback),
  // 在线补齐封面（文件无内嵌封面时按标题/艺术家搜索在线歌源）
  fetchOnlineCover: (id: string, options?: OnlineSearchOptions, fallback?: unknown): Promise<string | null> =>
    ipcRenderer.invoke('covers:fetchOnline', id, options, fallback),
  saveCover: async (coverData: ArrayBuffer, trackId: string): Promise<string> => {
    return ''
  },
  saveLyrics: async (lyrics: string, trackId: string): Promise<string> => {
    return ipcRenderer.invoke('lyrics:save', lyrics, trackId)
  },
  readLyrics: async (trackId: string): Promise<string | null> => {
    return ipcRenderer.invoke('lyrics:read', trackId)
  },
  searchLyrics: async (
    query: string,
    artist?: string,
    album?: string,
    duration?: number,
    options?: LyricsSearchOptions
  ): Promise<LyricsSearchResult | null> => {
    return ipcRenderer.invoke('lyrics:search', query, artist, album, duration, options)
  },
  searchOnlineTracks: async (
    query: string,
    options?: OnlineSearchOptions
  ): Promise<OnlineTrackSearchResult[]> => {
    return ipcRenderer.invoke('tracks:searchOnline', query, options)
  },
  // 洛雪音源（kind='lx'）：脚本宿主在主进程执行（宿主依赖含函数、且渲染进程直连上游会被 CORS 拦）。
  // source 为渲染层持有的音源配置（含 sourceUrl 与可选的 script 源码）；
  // resolveUrl 回喂脚本返回的定位信息（lx: { sourceId, platform, meta }）取直链。
  lxSource: {
    fetchScript: (url: string, force?: boolean): Promise<string> =>
      ipcRenderer.invoke('lx:fetchScript', url, force),
    inspect: (source: unknown, force?: boolean): Promise<unknown> =>
      ipcRenderer.invoke('lx:inspect', source, force),
    search: (source: unknown, query: string, limit?: number): Promise<unknown[]> =>
      ipcRenderer.invoke('lx:search', source, query, limit),
    resolveUrl: (ref: unknown, source: unknown, quality?: string): Promise<{ url: string; quality: string }> =>
      ipcRenderer.invoke('lx:resolveUrl', ref, source, quality),
    clearCache: (): Promise<void> => ipcRenderer.invoke('lx:clearCache'),
  },
  // 插件层：音源插件（协议源 / 洛雪脚本 / 汽水音乐…）的能力调用与登录凭证。
  // 凭证类通道只回状态、不回内容 —— 凭证的读写全部留在主进程（safeStorage 加密）。
  // 主进程执行的理由与 lxSource 一致，另加一条：汽水上游对带 Origin 的请求返回 403，
  // 而渲染进程的 fetch 必带 Origin。
  plugins: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('plugin:list'),
    probe: (pluginId: string, config: unknown): Promise<unknown> =>
      ipcRenderer.invoke('plugin:probe', pluginId, config),
    search: (
      pluginId: string,
      config: unknown,
      query: string,
      quality?: string
    ): Promise<unknown[]> => ipcRenderer.invoke('plugin:search', pluginId, config, query, quality),
    resolveTrack: (
      pluginId: string,
      config: unknown,
      ref: unknown,
      quality?: string
    ): Promise<unknown> => ipcRenderer.invoke('plugin:resolveTrack', pluginId, config, ref, quality),
    userPlaylists: (pluginId: string, config: unknown): Promise<unknown[]> =>
      ipcRenderer.invoke('plugin:userPlaylists', pluginId, config),
    playlistTracks: (pluginId: string, config: unknown, playlistId: string): Promise<unknown[]> =>
      ipcRenderer.invoke('plugin:playlistTracks', pluginId, config, playlistId),
    login: (pluginId: string, rawInput: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('plugin:login', pluginId, rawInput),
    authState: (pluginId: string): Promise<unknown> =>
      ipcRenderer.invoke('plugin:authState', pluginId),
    logout: (pluginId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('plugin:logout', pluginId),

    // ─── 插件的安装 / 卸载 / 目录（声明式插件） ───
    // 与上面的「执行」通道分开：这一组会改动磁盘，入参含文件路径与 URL。
    // 校验（清单结构、id 冲突、权限、主机白名单）全部在主进程完成，
    // 渲染层只负责展示与确认（见 ipc/pluginInstall.ts）。
    catalog: (locale?: string): Promise<unknown> => ipcRenderer.invoke('plugin:catalog', locale),
    // 本次启动的插件加载报告：渲染层启动后拉一次，据此提示"有插件没加载起来"。
    // 用拉取而不是主进程 push —— 窗口与 React 挂载都晚于挂载插件，push 会丢。
    startup: (): Promise<unknown> => ipcRenderer.invoke('plugin:startup'),
    pickManifest: (): Promise<string | null> => ipcRenderer.invoke('plugin:pickManifest'),
    installFromFile: (filePath: string, locale?: string): Promise<unknown> =>
      ipcRenderer.invoke('plugin:installFromFile', filePath, locale),
    installFromUrl: (url: string, expectedSha256?: string, locale?: string): Promise<unknown> =>
      ipcRenderer.invoke('plugin:installFromUrl', url, expectedSha256, locale),
    uninstall: (pluginId: string, locale?: string): Promise<unknown> =>
      ipcRenderer.invoke('plugin:uninstall', pluginId, locale),
    openDir: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('plugin:openDir'),
    removeBroken: (dirPath: string): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke('plugin:removeBroken', dirPath),

    // ─── 插件启停 ───
    // 与卸载分开：卸载删磁盘（连带凭证与脚本正文），启停只改运行期门禁，
    // 内置插件也能停用。返回的是**落盘之后**的真实状态，UI 不乐观翻转。
    setPluginEnabled: (pluginId: string, enabled: boolean): Promise<unknown> =>
      ipcRenderer.invoke('plugin:setEnabled', pluginId, enabled),
    listDisabledPlugins: (): Promise<unknown> => ipcRenderer.invoke('plugin:disabled'),
  },
  // 自有服务协议的单曲取址（按源内 id 取直链）：与在线搜索同理在主进程执行
  // （渲染进程直连上游会被 CORS 拦），渲染层只拿结果；失败时返回带原因的结果，
  // 由调用方回落按名搜索，不抛错。
  onlineTrack: {
    resolveById: (source: unknown, songId: string, quality?: string): Promise<unknown> =>
      ipcRenderer.invoke('tracks:resolveById', source, songId, quality),
  },
  // 在线音乐（推荐歌单 / 榜单）：与在线搜索同理，主进程执行、渲染层只拿结果。
  // source 为渲染层选定的音源（应用不内置源，配置由用户持有）
  musicHall: {
    recommendPlaylists: (source: unknown, options?: unknown): Promise<unknown[]> =>
      ipcRenderer.invoke('hall:recommend', source, options),
    toplistGroups: (source: unknown, options?: unknown): Promise<unknown[]> =>
      ipcRenderer.invoke('hall:toplists', source, options),
    toplistSongs: (source: unknown, options?: unknown): Promise<unknown> =>
      ipcRenderer.invoke('hall:toplistSongs', source, options),
  },
  // 下载在线歌曲：主进程拉流写盘（渲染进程 fetch 会被歌源 CORS 拦截），
  // headers 来自歌源配置的附加请求头，保证下载请求与搜索请求一致；
  // downloadDir 为用户配置的默认下载目录，传了则免保存对话框直存；
  // album/coverUrl 由主进程在下载后嵌入文件（文本标签 + 封面）
  downloadOnlineTrack: async (
    track: { audioUrl: string; title: string; artist?: string; album?: string; coverUrl?: string },
    headers?: Record<string, string>,
    downloadDir?: string
  ): Promise<{ savedPath: string }> => {
    return ipcRenderer.invoke('tracks:download', track, headers, downloadDir)
  },
  // 媒体缓存（音频 + 封面 + 歌词共用一份容量）：命中返回 aurora-cache:// 地址；
  // 未命中返回 null 并由主进程后台拉流写缓存（本次仍用原始地址，下次即命中）
  audioCache: {
    resolve: (req: { url: string; key: string; headers?: Record<string, string> }): Promise<{ src: string | null }> =>
      ipcRenderer.invoke('cache:resolve', req),
    resolveCover: (req: { url: string; key: string; headers?: Record<string, string> }): Promise<{ src: string | null }> =>
      ipcRenderer.invoke('cache:resolveCover', req),
    configure: (opts: { limitMB: number }): Promise<void> => ipcRenderer.invoke('cache:configure', opts),
    usage: (): Promise<{ usedBytes: number; count: number }> => ipcRenderer.invoke('cache:usage'),
    clear: (): Promise<void> => ipcRenderer.invoke('cache:clear'),
  },
  getMetadata: async (filePath: string) => {
    return ipcRenderer.invoke('fs:readFile', filePath)
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
  },
  // 语言同步：渲染层是语言的权威来源（用户可选「跟随系统」或指定语言，只有它知道最终结果）。
  // I18nProvider 在语言确定后单向推给主进程，主进程据此渲染托盘菜单、原生对话框标题、
  // 通知正文与错误文案。用单向 send 而非 invoke：主进程没有回执需求，也不需要渲染层
  // 去处理一个可能被拒绝的 Promise。
  i18n: {
    setLocale: (locale: string): void => {
      ipcRenderer.send('i18n:set-locale', locale)
    },
  },
  // 日志：读全量包 / 导出到下载目录 / 在文件管理器中定位 / 目录状态，
  // 外加一条单向的「渲染层记录 → 主进程落盘」通道。
  //
  // 形状不在这里手写：`satisfies LoggingRendererApi` 让 shared 的契约类型成为唯一真源。
  // preload 在主进程侧编译（CJS）、调用方在渲染层编译（ESM），两边不共享类型推导链，
  // 一旦这里手抄一份，字段漂移只会在运行期炸 —— 而这条路径只在「用户来要日志」
  // 的那一刻被走到，静默失败等于整套日志系统白做。
  //
  // 通道名取自文件顶部的 LOG_CHANNELS（类型级钉死等于 shared 的 LOG_IPC）。
  // 渲染层的 `LoggingRendererApi` 形状由 import type 约束，不产生运行期依赖。
  logging: {
    bundle: () => ipcRenderer.invoke(LOG_CHANNELS.bundle),
    exportFile: () => ipcRenderer.invoke(LOG_CHANNELS.exportFile),
    reveal: (filePath: string): Promise<void> => ipcRenderer.invoke(LOG_CHANNELS.reveal, filePath),
    info: () => ipcRenderer.invoke(LOG_CHANNELS.info),
    // 记录通道用 send：渲染层每条 console 都会走它，等回执只会在高频路径上堆 Promise。
    // 主进程侧同样不回执（见 ipc/logging.ts 的 ipcMain.on），语义一致。
    record: (payload) => {
      ipcRenderer.send(LOG_CHANNELS.record, payload)
    },
  } satisfies LoggingRendererApi,
  getBounds: (): Promise<{ x: number; y: number; width: number; height: number } | null> =>
    ipcRenderer.invoke('window:getBounds'),
  setBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('window:setBounds', bounds),
  onTracksScanned: (callback: (tracks: any[]) => void) => {
    const handler = (_event: unknown, tracks: any[]) => callback(tracks)
    ipcRenderer.on('scan:complete', handler)
    return () => ipcRenderer.removeListener('scan:complete', handler)
  },
  onTrackScanned: (callback: (track: any) => void) => {
    const handler = (_event: unknown, track: any) => callback(track)
    ipcRenderer.on('track:scanned', handler)
    return () => ipcRenderer.removeListener('track:scanned', handler)
  },
  onScanError: (callback: (error: { folder: string; message: string }) => void) => {
    const handler = (_event: unknown, error: { folder: string; message: string }) => callback(error)
    ipcRenderer.on('scan:error', handler)
    return () => ipcRenderer.removeListener('scan:error', handler)
  },
  // 扫描时发现目录已从磁盘删除：主进程已清理其曲目，渲染进程据此移除该扫描目录条目
  onFolderMissing: (callback: (payload: { folder: string; removed: number }) => void) => {
    const handler = (_event: unknown, payload: { folder: string; removed: number }) => callback(payload)
    ipcRenderer.on('scan:folder-missing', handler)
    return () => ipcRenderer.removeListener('scan:folder-missing', handler)
  },
  onMediaControl: (callback: (action: string) => void) => {
    const handler = (_event: unknown, action: string) => callback(action)
    ipcRenderer.on('media-control', handler)
    return () => ipcRenderer.removeListener('media-control', handler)
  },
  updateMprisMetadata: (track: any, isPlaying: boolean) => {
    ipcRenderer.send('mpris:updateMetadata', track, isPlaying)
  },
  isMaximized: false,
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
