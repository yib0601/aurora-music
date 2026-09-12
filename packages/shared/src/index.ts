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
} from './types'
export { searchOnlineTracks, searchMusicSource } from './musicSource'
export { searchLyrics, searchLyricsSource, BUILTIN_LYRICS_SOURCE } from './lyricsSource'
export { sanitizeFileName, inferAudioExtFromUrl } from './downloadUtils'
export { embedCoverIntoAudio, detectImageMime } from './embedCover'
export type { EmbedMeta, EmbedCover } from './embedCover'
export { fetchWithTimeout } from './fetchWithTimeout'
export {
  normalizeName,
  parsePlaylistText,
  titleScore,
  artistScore,
  scoreOnlineResult,
  matchTracksByNames,
  MAX_IMPORT_SONGS,
  TITLE_THRESHOLD,
} from './importMatch'
