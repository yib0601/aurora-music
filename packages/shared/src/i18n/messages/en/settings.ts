import type settings from '../zh-CN/settings'
import type { LocalizedOf } from '../schema'

/**
 * English messages. 类型标注刻意写成 `typeof` 中文侧的形状：
 * 少键 / 多键 / 拼错键都会在 tsc 阶段直接报错，语言覆盖度由编译器守门。
 */
const en: LocalizedOf<typeof settings> = {
  page: {
    title: 'Settings',
  },
  nav: {
    general: 'General',
    storage: 'Downloads & Cache',
    plugins: 'Plugins',
    about: 'About',
    diagnostics: 'Diagnostic Logs',
  },
  general: {
    theme: {
      label: 'Theme',
      dark: 'Dark',
      light: 'Light',
      system: 'System',
    },
    language: {
      label: 'Language',
    },
    outputDevice: {
      label: 'Output device',
      empty: 'No output device detected',
      system: 'System default',
    },
    audioFocus: {
      unsupported: 'Not supported on this platform',
      behavior: {
        label: 'When another app plays',
        hint: '“Pause playback”: apps take turns; “Keep playing”: both play',
        hintMobile:
          '“Pause playback”: pauses and usually resumes; “Keep playing”: sounds overlap',
        pause: 'Pause playback',
        continue: 'Keep playing',
      },
    },
  },
  library: {
    scanDirs: {
      label: 'Scan folders',
      hint: 'These folders are scanned for music',
      empty: 'No folder added yet',
      removeTitle: 'Remove folder (also removes its songs from {library})',
      removeConfirm: 'Remove folder "{folder}"?',
      removeConfirmWithCount:
        'Remove folder "{folder}"?\nIts {count} songs are removed from {library} too (disk files kept).',
      removeConfirmWithCount_one:
        'Remove folder "{folder}"?\nIts {count} song is removed from {library} too (disk files kept).',
      pickFailed: 'Failed to scan folder "{folder}". Check that it exists and is accessible.',
    },
  },
  storage: {
    downloadQuality: {
      label: 'Download quality',
      standard: 'Standard 128k',
      high: 'High 320k',
      lossless: 'Lossless FLAC',
      /** Display name for a lossy tier whose bitrate cannot be inferred */
      lossy: 'Lossy (unknown bitrate)',
    },
    downloadDir: {
      label: 'Download folder',
      desktopHint: 'Skips the save dialog once set',
      mobileHint: 'Downloads are saved straight into this folder',
      clear: 'Clear',
      change: 'Change',
      desktopUnset: 'Not set (asked on every download)',
      mobilePath: 'Phone storage/{path}',
      mobileUnset: 'Not set (defaults to Phone storage/{path})',
      pickerTitle: 'Choose download folder',
      pickerDescription: 'Online songs are saved here, not in {path}',
    },
    cache: {
      label: 'Cache limit',
      hintUnlimited: 'No limit; bounded by free disk space · {used} in use',
      hintLimited: 'Evicts least-recently-used entries past the limit · Default {default} · {used} in use',
      unlimited: 'Unlimited',
      gb: '{value} GB',
      custom: 'Custom {value}',
      defaultPill: 'Default {value}',
      customPlaceholder: 'Custom GB',
      unit: 'GB',
      clearTitle: 'Clear all cached audio',
      clearConfirm: 'Clear all cached audio?',
      cleared: 'Cache cleared',
      invalid: 'Enter {min} – {max} GB',
    },
  },
  about: {
    version: 'Version',
    repo: 'Project repository',
    repoTitle: 'Source and license',
    checkUpdate: 'Check for updates',
    checking: 'Checking…',
    newVersion: 'New version available',
    downloading: 'Downloading in the background. You can close this window.',
    ready: 'Installer ready. Continue on the right.',
    assetHint: 'Will download the {label}',
    downloadHint: 'Download the installer for your platform',
    continueInstall: 'Continue install',
    downloadingButton: 'Downloading…',
    downloadUpdate: 'Download update',
    latest: 'Already up to date',
    checkFailed: 'Update check failed: {reason}',
    checkFailedFallback: 'Update check failed. Check your network.',
  },
  diagnostics: {
    export: {
      label: 'Export logs',
      hint: 'Export a log file to report a problem',
      button: 'Export logs',
      exporting: 'Exporting…',
      done: 'Exported to {path}',
      copyPath: 'Copy path',
      copied: 'Path copied',
      failed: 'Export failed. Try again.',
      unsupported: 'This platform cannot export logs',
    },
    reveal: {
      label: 'Log folder',
      hint: 'Show the log files in your file manager',
      button: 'Open folder',
      failed: 'Could not open the log folder',
    },
  },
}

export default en
