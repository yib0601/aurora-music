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
export {
  searchOnlineTracks,
  searchMusicSource,
  isSuspiciousAudio,
  correctSuspiciousAudioSources,
} from './musicSource'
export { searchLyrics, searchLyricsSource, BUILTIN_LYRICS_SOURCE } from './lyricsSource'
export { sanitizeFileName, inferAudioExtFromUrl } from './downloadUtils'
export {
  encodeFilePathToUrl,
  decodeFileUrlToPath,
  encodePathSegments,
} from './fileUrl'
export { embedCoverIntoAudio, detectImageMime } from './embedCover'
export type { EmbedMeta, EmbedCover } from './embedCover'
export { fetchWithTimeout, setCustomFetch } from './fetchWithTimeout'
export {
  normalizeName,
  parsePlaylistText,
  titleScore,
  artistScore,
  scoreOnlineResult,
  matchTracksByNames,
  matchTracksByPaths,
  storageSourceKey,
  MAX_IMPORT_SONGS,
  TITLE_THRESHOLD,
} from './importMatch'
export {
  extractShareUrl,
  resolvePlaylistUrl,
  parsePlaylistLink,
} from './playlistResolver'
export type { PlaylistCapableSource } from './playlistResolver'
export { mergeLegacyPlaylistSources, migrateOnlineSources, migrateLyricsSources } from './sourceMigration'
export {
  AURORA_ENDPOINT_FALLBACK,
  normalizeSourceBase,
  apiKeyFromUrl,
  parseSourceInput,
  checkSourceForm,
  searchEndpointOf,
  playlistEndpointOf,
  buildAuroraEndpoints,
  parseAuroraEndpoints,
  probeAuroraService,
} from './auroraPreset'
export type {
  AuroraEndpoints,
  AuroraSourceKind,
  ParsedSourceInput,
  AuroraFormCheck,
  SourceEndpointInput,
  AuroraProbeResult,
} from './auroraPreset'
export type { TrackIdentityFields, DuplicateGroup } from './trackIdentity'
export {
  DURATION_MATCH_TOLERANCE,
  isLocalCopy,
  preferTrackCopy,
  dedupeTracksForDisplay,
} from './trackIdentity'
export type { MediaProvider } from './mediaProvider'
export {
  webdavMediaProvider,
  getMediaProvider,
  registerMediaProvider,
  registeredMediaProviderKinds,
} from './mediaProvider'
export type { LibrarySourceConfig, RemoteEntry, WalkOptions, ParsedAudioFormat } from './webdav'
export {
  REMOTE_SCHEME,
  WebdavError,
  METADATA_HEAD_BYTES,
  normalizeHeadParsedDuration,
  AUDIO_EXTENSIONS,
  isAudioFileName,
  shouldSkipDir,
  guessAudioMime,
  normalizeBaseUrl,
  joinUrl,
  buildAuthHeader,
  webdavHeaders,
  resolveRemoteUrl,
  buildRemoteAudioUrl,
  isRemoteAudioUrl,
  parseRemoteAudioUrl,
  storagePathFor,
  storagePathPrefix,
  parseMultiStatus,
  listWebdavDir,
  walkWebdavAudio,
  testWebdavConnection,
  openWebdavRange,
} from './webdav'
