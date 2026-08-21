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
