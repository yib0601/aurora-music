import { contextBridge, ipcRenderer } from 'electron'
import type { OnlineSearchOptions, OnlineTrackSearchResult, LyricsSearchOptions, LyricsSearchResult, LibrarySourceConfig } from '@aurora/shared'

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
  // 从曲库移除扫描目录：主进程删除该目录下的曲目记录并返回移除后的全库列表
  removeFolder: (folderPath: string): Promise<any[]> => ipcRenderer.invoke('library:removeFolder', folderPath),
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
