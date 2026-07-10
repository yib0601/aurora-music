import type { PlatformInterface, FileInfo, AudioMetadata, DatabaseAdapter, WindowControls } from '@/types'

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

export function createDesktopPlatform(): PlatformInterface {
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
      return `file://${path}`
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

    database: new NoopDatabase(),
    windowControls: api?.windowControls || new NoopWindowControls(),
  }
}

export function createMobilePlatform(): PlatformInterface {
  return {
    platform: 'mobile',
    async pickFolder(): Promise<string | null> { return null },
    async readDir(): Promise<FileInfo[]> { return [] },
    async readFile(): Promise<ArrayBuffer> { return new ArrayBuffer(0) },
    getAudioSrc(path: string): string {
      const cap = (window as any).Capacitor
      return cap ? cap.convertFileSrc(path) : path
    },
    async getMetadata(): Promise<AudioMetadata> {
      return { title: 'Unknown', artist: 'Unknown', album: 'Unknown', duration: 0 }
    },
    async getUserDataPath(): Promise<string> { return '' },
    async saveCover(): Promise<string> { return '' },
    async saveLyrics(): Promise<string> { return '' },
    async readLyrics(): Promise<string | null> { return null },
    database: new NoopDatabase(),
    windowControls: new NoopWindowControls(),
  }
}

export function createPlatform(): PlatformInterface {
  if (typeof window !== 'undefined' && (window as any).electronAPI) {
    return createDesktopPlatform()
  }
  return createMobilePlatform()
}

export const platform = createPlatform()
