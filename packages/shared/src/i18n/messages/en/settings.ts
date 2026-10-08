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
    sources: 'Online Sources',
    about: 'About',
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
  },
  library: {
    scanDirs: {
      label: 'Scan folders',
      hint: 'Music files in these folders are scanned automatically',
      empty: 'No folder added yet',
      removeTitle: 'Remove folder (also removes its songs from {library})',
      removeConfirm: 'Remove scan folder "{folder}"?',
      removeConfirmWithCount:
        'Remove scan folder "{folder}"?\nIts {count} songs will also be removed from {library} (files on disk are kept).',
      removeConfirmWithCount_one:
        'Remove scan folder "{folder}"?\nIts {count} song will also be removed from {library} (files on disk are kept).',
      pickFailed: 'Failed to scan folder "{folder}". Check that it exists and is accessible.',
    },
    storage: {
      label: 'Network storage',
      hint: 'Music on a NAS or WebDAV server is scanned into your library and kept',
      empty: 'Nothing added yet. Standard WebDAV such as Synology, QNAP or Nextcloud is supported.',
    },
  },
  storage: {
    downloadQuality: {
      label: 'Download quality',
      standard: 'Standard 128k',
      high: 'High 320k',
      lossless: 'Lossless FLAC',
    },
    downloadDir: {
      label: 'Download folder',
      desktopHint: 'Skips the save dialog once set',
      mobileHint: 'Downloads are saved straight into this folder',
      clear: 'Clear',
      change: 'Change',
      desktopUnset: 'Not set (you are asked where to save on every download)',
      mobilePath: 'Phone storage/{path}',
      mobileUnset: 'Not set (saved to Phone storage/{path} by default)',
      pickerTitle: 'Choose download folder',
      pickerDescription: 'Online songs are saved directly here instead of the default {path}',
    },
    cache: {
      label: 'Cache limit',
      hintUnlimited: 'No size limit, bounded only by free disk space · {used} in use',
      hintLimited: 'Least recently used entries are evicted past the limit · Default {default} · {used} in use',
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
    repoTitle: 'View the source and license (noncommercial use only)',
    checkUpdate: 'Check for updates',
    checking: 'Checking…',
    newVersion: 'New version available',
    downloading: 'The installer is downloading. You can close this window and keep downloading in the background.',
    ready: 'The installer is ready. Continue on the right to install.',
    assetHint: 'The installer for your system ({label}) will be downloaded',
    downloadHint: 'Download the installer for your platform',
    continueInstall: 'Continue install',
    downloadingButton: 'Downloading…',
    downloadUpdate: 'Download update',
    latest: 'You are on the latest version',
    checkFailed: 'Update check failed: {reason}',
    checkFailedFallback: 'Update check failed. Check your network and try again.',
  },
}

export default en
