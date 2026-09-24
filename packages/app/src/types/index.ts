// 歌源协议规范（音乐源 / 歌词源）与执行器统一由 @aurora/shared 提供，双端共用
import type {
  OnlineSourceConfig,
  OnlineSearchOptions,
  OnlineTrackSearchResult,
  DownloadQuality,
  LyricsSourceConfig,
  LyricsSearchOptions,
  LyricsSearchResult,
  PlaylistResolverConfig,
  ParsedSong,
  PlaylistParseResult,
  LibrarySourceConfig,
  RemoteEntry,
} from '@aurora/shared'

export type {
  OnlineSourceConfig,
  OnlineSearchOptions,
  OnlineTrackSearchResult,
  DownloadQuality,
  LyricsSourceConfig,
  LyricsSearchOptions,
  LyricsSearchResult,
  PlaylistResolverConfig,
  ParsedSong,
  PlaylistParseResult,
  LibrarySourceConfig,
  RemoteEntry,
}

export interface Track {
  id: string
  /**
   * 存储坐标：
   * - 本机来源：绝对文件路径
   * - WebDAV 来源：`webdav:<sourceId>/<相对路径>`（来源编进 path，天然按来源隔离）
   */
  path: string
  /** 所属媒体库来源 id（undefined = 本机目录） */
  sourceId?: string
  /**
   * 远端曲目播放地址（aurora-remote://<sourceId>/<相对路径>）。
   * 由主进程注册的自定义协议代理到 WebDAV 并附带鉴权，因此地址里不含口令，
   * 也不会过期——这一点与在线歌源的 onlineUrl 有本质区别，持久化时不可剥离。
   */
  remoteUrl?: string
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
  /** 在线封面地址（源提供时才有），下载时随文件嵌入 */
  coverUrl?: string
  /** 多音质地址（源提供时才有；键为音质档位 128 / 320 / flac），下载时按音质设置挑选 */
  onlineQualityUrls?: Partial<Record<DownloadQuality, string>>
  /** 来源标识（源配置的 id） */
  onlineSource?: string
  /** 来源展示名（源配置的 name） */
  onlineSourceName?: string
  /** 音频实际来源后端标识（源提供 qualitySource 字段时才有），行内展示 */
  onlineAudioSource?: string
  onlineId?: string
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

/** 音乐库浏览标签：全部歌曲 / 按专辑 / 按艺术家 */
export type LibraryTab = 'songs' | 'albums' | 'artists'

/** 音乐库排序字段；default 为数据库默认顺序（艺术家 → 专辑 → 曲号 → 标题） */
export type SortField = 'default' | 'title' | 'artist' | 'album' | 'duration' | 'addedAt'

export type SortOrder = 'asc' | 'desc'

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

/**
 * 目录选择器的展示文案：同一个选择器被「扫描目录」「下载目录」复用，
 * 由调用方指定标题与说明，避免出现「选下载目录」却写着「选择扫描目录」的错位。
 * 桌面端走系统原生对话框，忽略该参数。
 */
export interface FolderPickerOptions {
  title?: string
  description?: string
  confirmLabel?: string
}

export interface PlatformInterface {
  platform: 'desktop' | 'mobile'
  pickFolder(options?: FolderPickerOptions): Promise<string | null>
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
