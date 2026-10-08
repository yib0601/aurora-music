import type desktop from '../zh-CN/desktop'
import type { LocalizedOf } from '../schema'

/**
 * English messages. 类型标注刻意写成 `typeof` 中文侧的形状：
 * 少键 / 多键 / 拼错键都会在 tsc 阶段直接报错，语言覆盖度由编译器守门。
 */
const en: LocalizedOf<typeof desktop> = {
  tray: {
    appName: '{brand} Music',
    show: 'Show Main Window',
    quit: 'Quit {appName}',
  },
  dialog: {
    pickMusicFolder: 'Choose Music Folder',
    saveSong: 'Save Song',
  },
  updater: {
    routeProxy: 'System proxy {proxy}',
    routeDirect: 'Direct (no system proxy)',
  },
  error: {
    common: {
      windowUnavailable: 'The window is not available',
      databaseUnavailable: 'The database is not initialized',
      trackIdInvalid: 'Invalid track ID',
      urlInvalid: 'Invalid download URL',
    },
    scan: {
      noFolder: 'Scan failed: no folder specified',
      noSource: 'Scan failed: no library source specified',
      folderUnavailable: 'The folder does not exist or is not accessible',
      folderUnreadable: 'Scan failed: the folder "{folder}" does not exist or cannot be read',
    },
    download: {
      dirInvalid: 'The default download folder is invalid, choose it again in Settings',
      dirUnusable: 'The default download folder is unusable (cannot be created or is not writable), choose it again in Settings',
      dirNotWritable: 'The default download folder is not writable, choose it again in Settings',
      canceled: 'Save canceled',
      networkFailed: 'Download failed, check your network connection or try again later',
      httpStatus: 'Download failed: the server returned HTTP {status}',
      writeFailed: 'Download failed: error while writing the file',
    },
    source: {
      invalid: 'Invalid source',
      notFound: 'Source configuration not found',
      unknown: 'Unknown library source: {id}',
      kindUnsupported: 'Unsupported library source type: {kind}',
      remoteReadFailed: 'Failed to read the remote file: HTTP {status}',
      coverHttpStatus: 'Cover download failed: HTTP {status}',
      coverInvalid: 'Cover download failed: the content is not a valid image',
    },
    lx: {
      scriptUrlMissing: 'The source has no script URL',
      scriptUrlInvalid: 'Invalid script URL',
      sourceInvalid: 'Invalid source configuration',
      refMissing: 'The track is missing its LX locator',
      notScriptSource: 'The source "{name}" is not an LX script source',
      sourceDisabled: 'The LX source "{name}" is disabled',
      binaryUnsupported: 'Unsupported binary input',
      requestTimeout: 'Request timed out ({ms}ms)',
      requestFailed: 'Network request failed',
      directAttempt: 'Direct resolve: {reason}',
      mappedAttempt: 'Mapped resolve: {reason}',
      resolveFailed: 'Failed to resolve the URL: {reasons}',
    },
    updater: {
      kindInvalid: 'Invalid installer type',
      busy: 'An update download is already in progress',
      canceled: 'Download canceled',
      installerMissing: 'The installer file does not exist',
      httpStatus: 'The server returned HTTP {status}',
      integrityUnknown: 'Cannot verify installer integrity (the server gave no length and the official size is unknown)',
      incomplete: 'Incomplete installer ({received} of {expected} bytes downloaded)',
      diskWriteFailed: 'Failed to write to disk',
      stalled: 'The connection sent no data for too long',
      rangeUnknown: 'Cannot determine where the response data starts',
      digestMismatch: 'Installer verification failed (content does not match the official digest)',
      interrupted: 'Download interrupted',
      downloadFailed: 'Download failed: {detail}',
      downloadFailedGeneric: 'Download failed, try again later',
      launchFailed: 'Failed to launch the new version: {detail}',
      terminalFailed: 'Could not open a terminal; run this manually: {command}',
      openFailed: 'Failed to open the installer: {detail}',
    },
  },
}

export default en
