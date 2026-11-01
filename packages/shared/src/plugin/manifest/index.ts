/**
 * 声明式插件层出口。
 *
 * 上层（主进程插件宿主、设置页插件管理面板）只从这里取东西：
 * 校验器、清单→实现的构造器、目录投影、主机限制的 fetch。
 *
 * **不要**从这里 import 任何「已安装目录的读写」：本层全是纯函数，落盘与网络在
 * `packages/desktop/src/ipc/pluginStore.ts`（渲染层与移动端没有文件系统，
 * 把 I/O 混进来会让这一层无法被两端共用）。
 */

export type {
  DeclarativeLyricsSpec,
  DeclarativeRecommendEndpoint,
  DeclarativeRecommendFieldMap,
  DeclarativeResolveEndpoint,
  DeclarativeResolveFieldMap,
  DeclarativeScriptSpec,
  DeclarativeSearchEndpoint,
  DeclarativeSourceSpec,
  DeclarativeToplistBriefFieldMap,
  DeclarativeToplistDetailEndpoint,
  DeclarativeToplistGroupFieldMap,
  DeclarativeToplistPreviewFieldMap,
  DeclarativeToplistSongFieldMap,
  DeclarativeToplistsEndpoint,
  DeclarativeTrackFieldMap,
  InstalledPlugin,
  InstalledPluginScan,
  LocalizedText,
  ManifestIssue,
  ManifestValidation,
  PluginCatalogEntry,
  PluginDomain,
  PluginInstallRecord,
  PluginInstallRequest,
  PluginInstallResult,
  PluginManifest,
  PluginPermission,
  PluginProvenance,
} from './types'
export {
  PLUGIN_ID_PATTERN,
  PLUGIN_MANIFEST_FORMAT,
  SUPPORTED_MANIFEST_FORMATS,
} from './types'

export { parsePath, readAtPath, valueAtPath, readString, readNumber, readBoolean } from './path'
export type { PathSegment } from './path'

export { validatePluginManifest, supportedFormatsLabel } from './validate'

export { resolveLocalized, declaredLocalesOf } from './localize'

export {
  HOST_NOT_ALLOWED,
  createGuardedFetch,
  hostAllowed,
  hostNotAllowedError,
  hostOf,
  isHostNotAllowedError,
} from './host'

export {
  buildSourcePlugin,
  extractItems,
  manifestDescription,
  manifestDisplayName,
} from './source'

export { buildLyricsRunner, fillLyricsUrl, lyricsConfigOf } from './lyrics'

// 清单签名（Ed25519）：防"下载链路被中间人替换"。信任根是内置公钥表，不是清单自带的公钥。
export {
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
} from './signature'
export type { PluginSignature, SignatureVerdict } from './signature'

// 信任表的纯逻辑（校验 / 合并 / 增删 / 容错解析）。落盘由两端各自负责。
export {
  mergeTrustedKeys,
  parseTrustedKeys,
  removeTrustedKey,
  serializeTrustedKeys,
  validateTrustedKey,
} from './trust'
export type { TrustedKey, TrustedKeyIssueCode, TrustedKeyValidation } from './trust'

// B 档：受限脚本（洛雪格式）。脚本正文由安装器落盘，运行期只读本地副本。
export {
  buildScriptPlugin,
  scriptBodyOf,
  scriptPluginName,
  scriptSha256Of,
  scriptUrlOf,
} from './script'
export type { ScriptSourceConfig } from './script'
export type { DeclarativeLyricsHit } from './lyrics'

export {
  buildPluginCatalog,
  catalogByDomain,
  entryHasCapability,
  entryUsableAsSource,
} from './catalog'
