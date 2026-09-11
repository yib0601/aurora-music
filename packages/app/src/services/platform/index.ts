import type {
  PlatformInterface,
  FileInfo,
  AudioMetadata,
  DatabaseAdapter,
  WindowControls,
  OnlineTrackSearchResult,
  OnlineSearchOptions,
  LyricsSearchOptions,
  LyricsSearchResult,
  Track,
} from '@/types'
import { createMobilePlatform as createMobilePlatformImpl, setFolderPickerHandler } from './mobile'

// 重新导出：UI 层（SettingsPage）注册移动端文件夹选择器回调，
// 桌面端此函数为空操作（pickFolder 走 electronAPI 的原生对话框）
export { setFolderPickerHandler }

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
   */
  ensureCover?: (trackId: string) => Promise<string | null>
  /**
   * 在线补齐封面（桌面端）：文件无内嵌封面时，按标题/艺术家搜索用户配置的
   * 在线歌源，下载匹配候选的封面并缓存，返回封面绝对路径。无匹配返回 null。
   * options.sources 为渲染层持有的歌源配置（应用不内置源）。
   */
  fetchOnlineCover?: (trackId: string, options?: OnlineSearchOptions) => Promise<string | null>
  /**
   * 从音乐库移除某个扫描目录：连该目录下的曲目记录一起删除，返回移除后的全库曲目。
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
   *  downloadDir 为默认下载目录（桌面端传了则免保存对话框直存，移动端忽略）；
   *  album/coverUrl 用于下载后把文本标签与封面嵌入文件（源直链的音频大多无内嵌封面） */
  downloadOnlineTrack?: (
    track: { audioUrl: string; title: string; artist?: string; album?: string; coverUrl?: string },
    headers?: Record<string, string>,
    downloadDir?: string
  ) => Promise<{ savedPath: string }>
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

export type Platform = PlatformInterface & PlatformExtension

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
      return `file://${path}`
    },

    getCoverSrc(path: string): string {
      // 桌面端用自定义 cover-local 协议，绕过 webSecurity 对 file:// 的限制
      // 使用 localhost 作为 host，确保路径被正确解析为 pathname
      return `cover-local://localhost${path}`
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
    async ensureCover(trackId: string) {
      if (!api?.ensureCover) return null
      return api.ensureCover(trackId)
    },
    async fetchOnlineCover(trackId: string, options?: OnlineSearchOptions) {
      if (!api?.fetchOnlineCover) return null
      return api.fetchOnlineCover(trackId, options)
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
    // 让音乐库边扫描边显示（此前只转发了 scan:complete，该能力在桌面端一直是失效的）
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
      if (!api?.downloadOnlineTrack) throw new Error('当前版本不支持下载')
      return api.downloadOnlineTrack(track, headers, downloadDir)
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
  // 仅在 Capacitor 可用时才走移动端实现；否则降级为只读 Noop
  if (typeof window !== 'undefined' && (window as any).Capacitor) {
    return createMobilePlatform()
  }
  // Web 浏览器或未知环境：返回最小 Noop 实现，避免运行时崩
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
    database: new NoopDatabase(),
    windowControls: new NoopWindowControls(),
  }
}

export const platform = createPlatform()
