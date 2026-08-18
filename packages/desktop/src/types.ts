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
  onlineSource?: 'netease' | 'qq' | 'kugou'
  onlineId?: string
}

export interface OnlineTrackSearchResult {
  id: string
  title: string
  artist: string
  album: string
  duration: number
  coverUrl?: string
  audioUrl: string
  source: 'netease' | 'qq' | 'kugou'
}

export interface Album {
  id: string
  name: string
  artist: string
  coverPath?: string
  year?: number
  trackCount: number
}
