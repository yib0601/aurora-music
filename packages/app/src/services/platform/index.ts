import type {
  PlatformInterface,
  FileInfo,
  AudioMetadata,
  DatabaseAdapter,
  WindowControls,
  OnlineTrackSearchResult,
  Track,
} from '@/types'
import { createMobilePlatform as createMobilePlatformImpl } from './mobile'

// 平台扩展能力：扫描事件订阅、媒体键、在线歌词搜索
// 桌面端通过 electronAPI 转发；移动端用回调机制
// 这些方法在两边都存在，统一通过 platform 调用，避免 App.tsx 直接访问 window.electronAPI
export interface PlatformExtension {
  /** 启动扫描（异步），完成后通过 onTracksScanned 通知 */
  scanFolder?: (folderPath: string) => Promise<Track[]>
  /** 获取所有已扫描曲目 */
  getAllTracks?: () => Promise<Track[]>
  /** 扫描完成事件订阅 */
  onTracksScanned?: (cb: (tracks: Track[]) => void) => () => void
  /** 扫描失败事件订阅（静默扫描：仅用于记录日志） */
  onScanError?: (cb: (e: { folder: string; message: string }) => void) => () => void
  /** 系统媒体键事件订阅（桌面端来自 globalShortcut/MPRIS，移动端来自 mediaSession） */
  onMediaControl?: (cb: (action: string) => void) => () => void
  /** 在线歌词搜索（LRCLIB API） */
  searchLyrics?: (
    query: string,
    artist?: string,
    album?: string,
    duration?: number
  ) => Promise<{ lrc: string | null; name: string; artist: string } | null>
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

    async searchOnlineTracks(query: string): Promise<OnlineTrackSearchResult[]> {
      if (!api?.searchOnlineTracks) return []
      return api.searchOnlineTracks(query)
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
    onTracksScanned(cb: (tracks: Track[]) => void) {
      if (!api?.onTracksScanned) return () => {}
      return api.onTracksScanned(cb)
    },
    onScanError(cb: (e: { folder: string; message: string }) => void) {
      if (!api?.onScanError) return () => {}
      return api.onScanError(cb)
    },
    onMediaControl(cb: (action: string) => void) {
      if (!api?.onMediaControl) return () => {}
      return api.onMediaControl(cb)
    },
    async searchLyrics(query, artist, album, duration) {
      if (!api?.searchLyrics) return null
      return api.searchLyrics(query, artist, album, duration)
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
