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
  RecommendPlaylist,
  ToplistPreviewSong,
  ToplistBrief,
  ToplistGroup,
  ToplistSong,
  MusicHallOptions,
  MusicHallSource,
  MusicHallSourceInput,
  OnlineSourceKind,
  SourceTrackRef,
  SourceCapability,
  SourceProbeInput,
  SourceProbeResult,
} from './types'
export {
  LX_KNOWN_PLATFORMS,
  setLxHostDeps,
  getLxHostDeps,
  LX_PLATFORM_LABELS,
  LX_PLATFORM_LABEL_KEYS,
  clearLxSourceCache,
  fetchLxScript,
  inspectLxSource,
  lxQualityFor,
  normalizeLxQuality,
  resolveLxSourceUrl,
  searchLxSource,
} from './lxHost'
export {
  LX_SEARCH_LIMIT,
  setLxScriptProvider,
  getLxScriptProvider,
  resolveLxScript,
  asLxScriptSource,
  toLxMusicInfo,
  isUsableLxMeta,
  resolveLxTrack,
  resolveLxTrackUrl,
  searchLxSourceForAggregate,
} from './lxResolver'
export type {
  LxScriptProvider,
  LxMetaMapping,
  ResolveLxTrackInput,
  LxResolveOutcome,
} from './lxResolver'
export type {
  LxHostDeps,
  LxPlatformCapability,
  LxRequestFn,
  LxRequestOptions,
  LxResponse,
  LxScriptSource,
  LxSearchResult,
  LxSourceInspection,
  LxTrackRef,
} from './lxHost'
export { lxInspectionToProbe, auroraProbeToResult, unavailableProbe } from './sourceProbe'
export {
  searchOnlineTracks,
  searchMusicSource,
  isSuspiciousAudio,
  correctSuspiciousAudioSources,
  clearSearchCache,
} from './musicSource'
export {
  resolveAuroraTrack,
  resolveAuroraTrackUrl,
  isAuroraTrackSource,
  isTrackEndpointKnownMissing,
  clearTrackEndpointCache,
  sourceSongIdOf,
  TRACK_RESOLVE_TIMEOUT_MS,
} from './trackResolver'
export type {
  AuroraTrackResolve,
  ResolveAuroraTrackInput,
  TrackCapableSource,
} from './trackResolver'
export {
  searchLyrics,
  searchLyricsSource,
  BUILTIN_LYRICS_GET_SOURCE,
  BUILTIN_LYRICS_SOURCE,
} from './lyricsSource'
export {
  fetchRecommendPlaylists,
  fetchToplistGroups,
  fetchToplistSongs,
  musicHallSourceOf,
  musicHallEndpointOf,
} from './musicHall'
export type { ToplistDetail } from './musicHall'
export { sanitizeFileName, inferAudioExtFromUrl } from './downloadUtils'
export {
  encodeFilePathToUrl,
  decodeFileUrlToPath,
  encodePathSegments,
} from './fileUrl'
export { embedCoverIntoAudio, detectImageMime } from './embedCover'
export type { EmbedMeta, EmbedCover } from './embedCover'
export { fetchWithTimeout, setCustomFetch, TimeoutError, isTimeoutError } from './fetchWithTimeout'
export {
  normalizeName,
  parsePlaylistText,
  titleScore,
  artistScore,
  scoreOnlineResult,
  isDurationMismatch,
  DURATION_TOLERANCE_SECONDS,
  DURATION_TOLERANCE_RATIO,
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
export {
  tradToSimp,
  normalizeForMatch,
  firstArtistOf,
  hasKnownArtist,
  hasVersionMarker,
  hasVersionMarkerStrict,
  targetHasVersionMarker,
  isNonOriginalCandidate,
  cleanTitleForQuery,
  titleVariants,
  titleMatches,
  artistMatches,
  pickCoverCandidate,
} from './coverMatch'
export type { CoverMatchTarget } from './coverMatch'
export type { PlaylistCapableSource, ResolvePlaylistOptions } from './playlistResolver'
export { mergeLegacyPlaylistSources, migrateOnlineSources } from './sourceMigration'
export {
  AURORA_ENDPOINT_FALLBACK,
  normalizeSourceBase,
  apiKeyFromUrl,
  parseSourceInput,
  checkSourceForm,
  searchEndpointOf,
  trackEndpointOf,
  playlistEndpointOf,
  lyricEndpointOf,
  hallEndpointOf,
  fillEndpointTemplate,
  buildAuroraEndpoints,
  parseAuroraEndpoints,
  parseAuroraCapabilities,
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
export {
  CACHE_POOLS,
  CACHE_INDEX_VERSION,
  CACHE_FETCH_UA,
  CACHE_TOUCH_FLUSH_MS,
  POOL_RATIO,
  POOL_MIN_MB,
  poolLimitsMB,
  cacheBodyKey,
  cacheFileKey,
  sumSizes,
  selectEvictions,
  parseCacheIndex,
  serializeCacheIndex,
  audioExtFrom,
  imageExtFrom,
  hashCacheKey,
} from './mediaCacheCore'
export type { CachePool, CacheEntry } from './mediaCacheCore'
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
export { firstSuccess, mapWithConcurrency } from './concurrency'
export type { FirstSuccessOptions, FirstSuccessHit } from './concurrency'
export * from './i18n'
export * from './logging'

// ─── 插件层（音源形态的注册表与契约） ─────────────────────────────
// 上层按「能力是否存在」调用插件，不做 kind 判断。见 docs/plugins.md
export {
  registerPlugin,
  getPlugin,
  listPlugins,
  hasCapability,
  clearPluginsForTest,
  auroraPlugin,
  lxPlugin,
  qishuiPlugin,
  qishuiCoverUrl,
  extractSessionId,
  AURORA_PLUGIN_CAPABILITIES,
  LX_PLUGIN_CAPABILITIES,
  builtinPlugins,
  ensureBuiltinsRegistered,
  pluginIdOf,
  pluginFieldsOf,
  // 能力判定（取代各处 `kind === 'xxx'` 分支）
  pluginForSource,
  canSearchSource,
  canParsePlaylist,
  canResolveTrack,
  sourceHasLyrics,
  needsAuth,
  sourceCacheKeyOf,
} from './plugin'
export type {
  SourcePlugin,
  PluginCapability,
  PluginContext,
  PluginCredential,
  PluginAuthState,
  PluginPlaylist,
  ResolvedAudio,
} from './plugin'
