// 歌源协议执行器统一由 @aurora/shared 提供（桌面端 Electron 主进程与本文件共用同一实现）
export { searchOnlineTracks, searchMusicSource } from '@aurora/shared'
export type {
  OnlineSourceConfig,
  OnlineSearchOptions,
  OnlineTrackSearchResult,
  LyricsSourceConfig,
  LyricsSearchOptions,
  LyricsSearchResult,
} from '@aurora/shared'
export { searchLyrics, searchLyricsSource } from '@aurora/shared'
// 在线音乐（推荐歌单 / 榜单）与在线搜索同理：均由共享协议执行器提供
export { fetchRecommendPlaylists, fetchToplistGroups, fetchToplistSongs } from '@aurora/shared'
export type {
  RecommendPlaylist,
  ToplistGroup,
  ToplistDetail,
  MusicHallOptions,
  MusicHallSource,
} from '@aurora/shared'
