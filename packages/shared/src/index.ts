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
  mediaProviderOf,
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
  openWebdavStream,
} from './webdav'
export { firstSuccess, mapWithConcurrency } from './concurrency'
export type { FirstSuccessOptions, FirstSuccessHit } from './concurrency'
export * from './i18n'
export * from './logging'

// ─── 插件层（音源形态的注册表与契约） ─────────────────────────────
// 上层按「能力是否存在」调用插件，不做 kind 判断。见 docs/plugins.md
export {
  registerPlugin,
  unregisterPlugin,
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
  resetBuiltinsRegistrationForTest,
  // 加载健康登记：插件出错只记账、不打断启动，UI 据此提示用户
  clearPluginFailuresForTest,
  isolatePluginStep,
  notePluginFailure,
  pluginFailures,
  pluginStartupReport,
  pluginIdOf,
  pluginFieldsOf,
  // 能力判定（取代各处 `kind === 'xxx'` 分支）
  pluginForSource,
  canSearchSource,
  canParsePlaylist,
  canResolveTrack,
  sourceHasLyrics,
  lyricsSourceViaPlugin,
  needsAuth,
  sourceCacheKeyOf,
  // 在线发现（推荐歌单 / 榜单）：与搜索 / 取址同属插件能力
  canBrowseHall,
  recommendViaPlugin,
  toplistsViaPlugin,
  toplistDetailViaPlugin,
  hostContextOf,
  // 单曲取址的统一编排（跨端共用）
  resolveTrackAudioViaPlugin,
  trackRefFor,
  // 宿主能力注册表：插件「需要宿主给什么」的登记与判定（与 health 的「坏没坏」是两件事）
  HOST_CAPABILITY_VERSION,
  clearHostCapabilitiesForTest,
  describeMissingCapabilities,
  getHostCapability,
  listHostCapabilities,
  registerHostCapability,
  requirementsOfManifest,
  resolveRequirements,
  unregisterHostCapability,
  degradedBuiltins,
} from './plugin'
export type {
  SourcePlugin,
  PluginCapability,
  PluginContext,
  PluginCredential,
  PluginAuthState,
  PluginPlaylist,
  ResolvedAudio,
  PluginFailure,
  PluginFailureStage,
  PluginStartupReport,
  // 依赖声明的形状（`SourcePlugin.requires` 用的是它）
  CapabilityGap,
  CapabilityRequirement,
  HostCapability,
  HostCapabilityId,
  ManifestDependencyInput,
  PluginAvailability,
} from './plugin'

// ─── 存储插件层（曲库来源形态的注册表与契约） ─────────────────────
// 上层按「能力是否存在」调用存储插件，不做 kind 判断；配置里用 pluginId。
export {
  BUILTIN_STORAGE_PLUGINS,
  DEFAULT_STORAGE_PLUGIN_ID,
  WEBDAV_STORAGE_FIELDS,
  clearStoragePluginsForTest,
  getStoragePlugin,
  isStorageTransportError,
  librarySourcePluginId,
  listStoragePluginMeta,
  listStoragePlugins,
  markTransportError,
  registerStoragePlugin,
  registeredStoragePluginIds,
  storageCapabilitiesOf,
  storageErrorStatus,
  storageFieldValue,
  storagePluginOf,
  storageStringField,
  webdavStoragePlugin,
  // SFTP / SMB：依赖只装在桌面端，故为注入式
  SFTP_STORAGE_FIELDS,
  SMB_STORAGE_FIELDS,
  sftpStoragePlugin,
  smbStoragePlugin,
  setSsh2Module,
  setSmb2Module,
  ssh2Available,
  smb2Available,
  parseRangeHeader,
  parseSmbRangeHeader,
  sftpRemotePathOf,
  smbPathOf,
} from './plugin/storage'
export type {
  StorageFieldDef,
  StorageFieldKind,
  StoragePlugin,
  StoragePluginCapability,
  StoragePluginMeta,
  StorageProbeResult,
} from './plugin/storage'

// ─── 声明式插件层（A 档：从 URL / 本地文件安装，不执行任何第三方代码） ───
// 清单格式、校验、清单→实现的构造、跨域目录投影、主机白名单 fetch。
// 设计边界见 docs/plugins.md「从 URL / GitHub 导入插件」。
export {
  PLUGIN_ID_PATTERN,
  PLUGIN_MANIFEST_FORMAT,
  SUPPORTED_MANIFEST_FORMATS,
  buildLyricsRunner,
  buildPluginCatalog,
  buildSourcePlugin,
  catalogByDomain,
  createGuardedFetch,
  declaredLocalesOf,
  entryHasCapability,
  entryUsableAsSource,
  fillLyricsUrl,
  hostAllowed,
  hostNotAllowedError,
  hostOf,
  isHostNotAllowedError,
  lyricsConfigOf,
  manifestDescription,
  manifestDisplayName,
  parsePath,
  readAtPath,
  readBoolean,
  readNumber,
  readString,
  resolveLocalized,
  supportedFormatsLabel,
  validatePluginManifest,
  valueAtPath,
  // 清单签名（Ed25519）
  PLUGIN_SIGNATURE_ALGORITHM,
  TRUSTED_PLUGIN_KEYS,
  bytesToHex,
  canonicalizeManifest,
  checkSignatureShape,
  hexToBytes,
  readSignature,
  signableBytes,
  signatureBadgeKey,
  verifyManifestSignature,
  // 信任表（签名信任根）的纯逻辑
  mergeTrustedKeys,
  parseTrustedKeys,
  removeTrustedKey,
  serializeTrustedKeys,
  validateTrustedKey,
} from './plugin/manifest'
export type {
  DeclarativeLyricsHit,
  DeclarativeLyricsSpec,
  DeclarativeResolveEndpoint,
  DeclarativeResolveFieldMap,
  DeclarativeSearchEndpoint,
  DeclarativeSourceSpec,
  DeclarativeTrackFieldMap,
  InstalledPlugin,
  InstalledPluginScan,
  LocalizedText,
  ManifestIssue,
  ManifestValidation,
  PathSegment,
  PluginCatalogEntry,
  PluginDomain,
  PluginInstallRecord,
  PluginInstallRequest,
  PluginInstallResult,
  PluginManifest,
  PluginPermission,
  PluginProvenance,
  PluginSignature,
  SignatureVerdict,
  TrustedKey,
  TrustedKeyIssueCode,
  TrustedKeyValidation,
} from './plugin/manifest'

// 已安装插件的运行期登记（注册 / 撤销 / 启动时挂载）
export {
  canInstall,
  clearInstalledForTest,
  guardedFetchOf,
  installManifestIntoRuntime,
  installedManifests,
  isInstalledPlugin,
  mountInstalled,
  pluginRegistered,
  registerInstalledPlugin,
  removeManifestFromRuntime,
  scriptBodyFor,
  unregisterInstalledPlugin,
} from './plugin/installed'
