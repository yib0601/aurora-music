// 歌源协议规范（音乐源 / 歌词源）与执行器统一由 @aurora/shared 提供，双端共用
export type {
  OnlineSourceConfig,
  OnlineSearchOptions,
  OnlineTrackSearchResult,
  LyricsSourceConfig,
  LyricsSearchOptions,
  LyricsSearchResult,
} from '@aurora/shared'

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
  /** 来源标识（源配置的 id） */
  onlineSource?: string
  /** 来源展示名（源配置的 name） */
  onlineSourceName?: string
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
