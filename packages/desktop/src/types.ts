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

export interface ScanProgress {
  current: number
  total: number
  file: string
}
