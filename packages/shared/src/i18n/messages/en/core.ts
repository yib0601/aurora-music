import type core from '../zh-CN/core'
import type { LocalizedOf } from '../schema'

/**
 * 英文底层文案。
 *
 * 中文是源语言（唯一真值形状），少键/拼错键会被 `tsc` 直接判红。
 * 计数类文案的复数：本域只有 WebDAV 探测结论带计数，而它一句里有多个数字，
 * 内核的复数选择器只认单个 `count` 参数，故这里**不写** `_one` 形态，
 * 改用对数量不敏感的英文写法（`{files} files` 在 1 的场合是可接受的诊断措辞）。
 */
const en: LocalizedOf<typeof core> = {
  platform: {
    kw: 'Kuwo',
    kg: 'Kugou',
    tx: 'QQ',
    wy: 'NetEase',
    mg: 'Migu',
    git: 'Git',
    local: 'Local',
  },

  probe: {
    endpoint: {
      search: 'Online search',
      playlist: 'Playlist parsing',
      recommend: 'Recommended playlists',
      toplists: 'Chart lists',
      toplist: 'Chart detail',
    },
    lxOk: 'Script is ready',
    serviceKeyOk: 'Connected, the API key is valid',
    serviceKeyUnverified: 'Service is online, but the API key could not be verified (/health unreachable)',
    serviceOnline: 'Service is online (no API key provided)',
    serviceOnlineNoSelfDescription:
      'Service is online, but no endpoint self-description was found; falling back to the default /aurora paths',
    webdavOk: 'Connected: {dirs} subfolders, {files} files under the root',
    webdavOkWithAudio: 'Connected: {dirs} subfolders, {files} files under the root, {audio} of them audio',
  },

  sourceName: {
    default: 'Source',
    lx: 'LX source',
    playlist: 'Playlist resolver',
  },

  error: {
    // ── 洛雪脚本宿主 ────────────────────────────────────────────────
    lxHostNotReady: 'The LX source host is not initialized (missing the lx.request implementation)',
    lxCallTimeout: 'Script "{source}" timed out handling {action} ({ms}ms)',
    lxNoRequestHandler: 'The script did not register the request event',
    lxNotInited: 'The script did not finish initializing (no inited event)',
    lxNoPlatforms: 'The script declared no usable platform',
    lxScriptEmpty: 'The script content is empty',
    lxInitFailed: 'The script failed to initialize',
    lxSourceNoScript: 'LX source "{name}" has no script content',
    lxSearchFailed: 'LX script search returned nothing (no results from {count} platforms)',
    lxPlatformUnsupported: 'Script "{name}" does not support the {platform} platform',
    lxUrlInvalid: 'The script returned an invalid URL',
    lxResolveFailed: 'Could not resolve the audio URL',
    lxScriptDownload: 'Failed to download the script: HTTP {status}',
    lxScriptTooLarge: 'The script is abnormally large (over {limit}MB); loading aborted',
    lxTrackRefMissing: 'The track has no LX resolution token (lx)',
    lxSourceNotFound: 'No LX source configuration found (id={id})',
    lxNotScriptSource: 'Source "{name}" is not an LX script source (kind={kind})',
    lxSourceDisabled: 'LX source "{name}" is disabled',
    lxScriptUnavailable: 'The script of LX source "{name}" is unavailable',
    lxMetaMissing: 'Resolving on platform {platform} is missing required fields: {fields}',

    // ── 在线搜索执行器 ──────────────────────────────────────────────
    sourceUrlNoQuery: 'Source "{name}" has an invalid endpoint: it must contain the {query} placeholder',
    sourceTimeout: 'Source "{name}" timed out ({ms}ms)',
    sourceRequestFailed: 'Source "{name}" request failed: {reason}',
    sourceHttpStatus: 'Source "{name}" returned HTTP {status}',
    sourceUnavailable: 'The source is unavailable',
    allSourcesFailed: 'Every music source failed; check the network connection or the source configuration',

    // ── 歌词执行器 ─────────────────────────────────────────────────
    lyricsUrlNoPlaceholder:
      'Lyrics source "{name}" has an invalid endpoint: it must contain the {track} or {query} placeholder',
    lyricsTimeout: 'Lyrics source "{name}" timed out ({ms}ms)',
    lyricsRequestFailed: 'Lyrics source "{name}" request failed: {reason}',
    lyricsHttpStatus: 'Lyrics source "{name}" returned HTTP {status}',

    // ── 在线音乐读取执行器 ──────────────────────────────────────────
    hallTimeout: 'Source "{name}" timed out ({ms}ms)',
    hallRequestFailed: 'Source "{name}" request failed: {reason}',
    hallHttpStatus: 'Source "{name}" returned HTTP {status}',
    hallNotJson: 'Source "{name}" did not return JSON',

    // ── 歌单解析执行器 ──────────────────────────────────────────────
    playlistUrlMissing: 'Source "{name}" has no playlist endpoint configured: it must contain the {url} placeholder',
    playlistTimeout: 'Source "{name}" timed out ({ms}ms)',
    playlistRequestFailed: 'Source "{name}" request failed: {reason}',
    playlistHttpStatus: 'Source "{name}" returned HTTP {status}',
    playlistEmpty: 'Source "{name}" returned no songs',
    playlistNoSource:
      'No playlist-capable source is configured; add one in Settings (a single source URL is enough), or paste the songs as plain text',
    playlistFailed: 'Playlist parsing failed',

    // ── WebDAV 媒体库 ──────────────────────────────────────────────
    webdavConnect: 'Could not connect to network storage "{name}": {reason}',
    webdavAuth: 'Network storage "{name}" rejected the credentials (HTTP {status}); check the username and password',
    webdavPathMissing: 'Network storage "{name}" has no such path: {path}',
    webdavStatus: 'Network storage "{name}" returned an unexpected status: HTTP {status}',
    webdavRead: 'Could not read from network storage "{name}": {reason}',

    // ── 设置页表单校验与服务探测 ────────────────────────────────────
    formLinkInvalid: 'Invalid address format; example: {example}',
    formLinkPlaceholder: 'The address must contain the placeholder(s): {placeholders}',
    serviceUrlInvalid: 'Invalid service URL',
    serviceUnreachable: 'Connection failed: the address is unreachable or the port is wrong',
    serviceStatus: 'The service returned {status}; check the service URL',
    serviceKeyRejected: 'Wrong API key (the server rejected it)',
  },
}

export default en
