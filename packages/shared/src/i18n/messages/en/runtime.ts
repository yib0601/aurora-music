import type runtime from '../zh-CN/runtime'
import type { LocalizedOf } from '../schema'

const en: LocalizedOf<typeof runtime> = {
  cache: {
    unlimited: 'Unlimited',
  },
  scan: {
    folderUnreadable:
      'Scan failed: the folder "{folder}" does not exist or cannot be read (storage permission may not be granted)',
    folderUnspecified: 'Scan failed: no folder was specified',
    permissionMissing: 'Folder access permission is not held',
    permissionDenied: 'Folder read permission was not granted',
  },
  download: {
    unknownArtist: 'Unknown artist',
    unknownTitle: 'Unknown title',
  },
  platform: {
    scriptUnsupportedDesktop: 'Script sources are not supported in this version; update the desktop app',
    scriptUnsupportedBrowser: 'Script sources are not supported in the browser; use the desktop or mobile app',
    scriptUnsupportedEnv: 'Script sources are not supported in this environment',
  },
  permission: {
    mediaDenied: 'Storage permission was not granted, so local folders cannot be browsed.\nGrant the "Music and audio" permission and try again; if the system no longer shows the prompt, enable it manually in Settings → Apps → Aurora Music → Permissions.',
    folderUnreachable: 'Cannot access the folder "{path}"\nCheck that the path is correct, or make sure storage permission is granted.',
    allFilesRequired: 'Downloading songs to phone storage requires the "All files access" permission.\nGrant it in system settings and try again.',
    dirPathHint: 'Enter the music folder path relative to storage/emulated/0.\nCommon folders:\n  Music\n  Download/Music\n  Documents/Music\n  DCIM/Music',
  },
  player: {
    resolveFailed: 'Cannot play this online song: no source is configured or the search returned no results',
  },
  error: {
    scanFolderMissing: 'The folder does not exist or cannot be accessed',
    fileReadFailed: 'Failed to read the file: HTTP {status}',
    downloadFileReadFailed: 'Failed to read the downloaded file: HTTP {status}',
    downloadUrlInvalid: 'Invalid download URL',
    downloadUnsupported: 'Downloading is not supported in this version',
    storageUnsupported: 'Network storage is not supported on this platform',
    storagePermissionMissing: 'Storage permission is missing',
    downloadDirCreateFailed:
      'Cannot create the download folder (storage unavailable or permission missing); check storage permission and try again',
    downloadFailed: 'Download failed; check your network connection or try again later',
    databaseNotInited: 'The database is not initialized',
    scriptSourceUrlMissing: 'The source has no script URL',
  },
}

export default en
