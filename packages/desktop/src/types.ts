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
