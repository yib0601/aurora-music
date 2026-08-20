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
  // 在线歌曲扩展字段（本地歌曲为 undefined）
  onlineUrl?: string
  onlineSource?: 'netease' | 'qq' | 'kugou' | 'custom'
  onlineId?: string
}

/**
 * 自定义在线音乐源配置（用户可在设置页自主配置搜索接口）
 * - apiUrl 需包含 {query} 占位符，调用时替换为 URL 编码后的搜索词
 * - 接口响应需为 JSON，支持以下任一结构（容错）：
 *   1) 数组：[{...}]
 *   2) { results: [{...}] } / { data: [{...}] } / { songs: [{...}] }
 *   每项字段：id、title、artist、album、duration（秒）、coverUrl、audioUrl（必填）
 */
export interface OnlineSourceConfig {
  id: string
  name: string
  apiUrl: string
  enabled: boolean
}

export interface OnlineSearchOptions {
  /** 用户自定义源列表（仅 enabled=true 的会被调用） */
  customSources?: OnlineSourceConfig[]
  /** 是否启用网易云内置源，默认 true */
  useNetease?: boolean
  /** 是否启用 QQ 音乐内置源，默认 true */
  useQQ?: boolean
}

export interface OnlineTrackSearchResult {
  id: string
  title: string
  artist: string
  album: string
  duration: number
  coverUrl?: string
  audioUrl: string
  source: 'netease' | 'qq' | 'kugou' | 'custom'
  /** 自定义源的显示名称（source='custom' 时携带，用于分组展示） */
  sourceName?: string
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

export type GlassMode = 'auto' | 'forced'

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
  getCoverSrc(path: string): string
  getMetadata(path: string): Promise<AudioMetadata>
  getUserDataPath(): Promise<string>
  saveCover(coverData: Buffer, trackId: string): Promise<string>
  saveLyrics(lyrics: string, trackId: string): Promise<string>
  readLyrics(trackId: string): Promise<string | null>
  searchOnlineTracks(query: string, options?: OnlineSearchOptions): Promise<OnlineTrackSearchResult[]>
  database: DatabaseAdapter
  windowControls: WindowControls
}
