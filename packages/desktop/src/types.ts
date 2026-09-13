// 歌源协议规范（音乐源 / 歌词源）与执行器统一由 @aurora/shared 提供，双端共用
export type {
  OnlineSourceConfig,
  OnlineSearchOptions,
  OnlineTrackSearchResult,
  LyricsSourceConfig,
  LyricsSearchOptions,
  LyricsSearchResult,
  LibrarySourceConfig,
  RemoteEntry,
} from '@aurora/shared'

export interface Track {
  id: string
  /**
   * 存储坐标：
   * - 本机来源：绝对文件路径
   * - WebDAV 来源：`webdav:<sourceId>/<相对路径>`（来源编进 path，见数据库迁移说明）
   */
  path: string
  /** 所属媒体库来源 id（undefined = 本机目录） */
  sourceId?: string
  /**
   * 远端曲目的播放地址（aurora-remote://<sourceId>/<相对路径>），由 (sourceId, path)
   * 推导而来、不落库。主进程按 sourceId 找到来源配置后带鉴权转发 Range 请求，
   * 因此口令不会出现在渲染层或数据库里。
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
