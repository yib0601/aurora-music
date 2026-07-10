export interface Track {
  id: string
  path: string
  title: string
  artist: string
  album: string
  year?: number
  genre?: string
  duration: number
  trackNumber?: number
  coverPath?: string
  fileSize?: number
  addedAt: number
  lastPlayedAt?: number
  playCount: number
  liked: boolean
}

export interface Album {
  id: string
  name: string
  artist: string
  coverPath?: string
  year?: number
  trackCount: number
}

export interface Playlist {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  trackIds: string[]
}

export interface LyricLine {
  time: number
  text: string
}

export interface FileInfo {
  name: string
  path: string
  isDirectory: boolean
  size: number
  lastModified: number
}

export interface AudioMetadata {
  title: string
  artist: string
  album: string
  year?: number
  genre?: string
  duration: number
  trackNumber?: number
  cover?: {
    data: Buffer
    format: string
  }
}

export type RepeatMode = 'off' | 'all' | 'one'

export type ShuffleMode = 'off' | 'on'

export type ViewMode = 'list' | 'grid'

export type GlassMode = 'auto' | 'forced' | 'flat'

export interface SearchResult {
  title: string
  artist: string
  album: string
  duration?: number
  lyrics?: LyricLine[]
}

export interface DatabaseAdapter {
  init(): Promise<void>
  insertTrack(track: Track): Promise<void>
  getAllTracks(): Promise<Track[]>
  getTrackById(id: string): Promise<Track | null>
  getTracksByAlbum(album: string, artist: string): Promise<Track[]>
  searchTracks(query: string): Promise<Track[]>
  updateTrack(id: string, updates: Partial<Track>): Promise<void>
  deleteTrack(id: string): Promise<void>
  insertAlbum(album: Album): Promise<void>
  getAllAlbums(): Promise<Album[]>
  getAlbumById(id: string): Promise<Album | null>
  insertPlaylist(playlist: Playlist): Promise<void>
  getAllPlaylists(): Promise<Playlist[]>
  getPlaylistById(id: string): Promise<Playlist | null>
  updatePlaylist(id: string, updates: Partial<Playlist>): Promise<void>
  deletePlaylist(id: string): Promise<void>
  getLikedTracks(): Promise<Track[]>
  getRecentlyPlayed(limit?: number): Promise<Track[]>
  getMostPlayed(limit?: number): Promise<Track[]>
}

export interface WindowControls {
  minimize(): Promise<void>
  maximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
}

export interface PlatformInterface {
  platform: 'desktop' | 'mobile'
  pickFolder(): Promise<string | null>
  readDir(path: string): Promise<FileInfo[]>
  readFile(path: string): Promise<ArrayBuffer>
  getAudioSrc(path: string): string
  getMetadata(path: string): Promise<AudioMetadata>
  getUserDataPath(): Promise<string>
  saveCover(coverData: Buffer, trackId: string): Promise<string>
  saveLyrics(lyrics: string, trackId: string): Promise<string>
  readLyrics(trackId: string): Promise<string | null>
  database: DatabaseAdapter
  windowControls: WindowControls
}
