import type shell from '../zh-CN/shell'
import type { LocalizedOf } from '../schema'

/**
 * 英文外壳文案。
 *
 * 类型标注写成 `typeof` 中文侧的形状是刻意的：中文是源语言、是唯一真值形状，
 * 英文少一个键、多一个键、拼错一个键都会在 tsc 阶段直接报错。
 * 复数键（`_one` / `_other`）在中文侧也存在（值相同），因此两边键集天然对齐。
 */
const en: LocalizedOf<typeof shell> = {
  brand: {
    full: 'Aurora Music',
  },
  nav: {
    topBar: 'Top navigation',
    openMenu: 'Open menu',
    closeMenu: 'Close menu',
  },
  playlist: {
    importLink: 'Import playlist',
    importLinkText: 'Import playlist (link/text)',
    importFile: 'Import M3U file',
    create: 'New playlist',
    submit: 'Create',
    namePlaceholder: 'Playlist name',
    empty: 'Click + to create your first playlist',
    importNoPath: 'No valid music paths found in the file',
    importNoMatch: 'No songs from {library} matched — scan the folder that contains them first',
    importedName: 'Imported playlist',
    imported: '{count} songs imported',
    imported_one: '{count} song imported',
  },
  chrome: {
    minimize: 'Minimize',
    maximize: 'Maximize',
    restore: 'Restore',
    closeToTray: 'Close (minimize to tray)',
    songDetail: 'View song details',
    nowPlayingEmpty: 'Nothing playing',
    nowPlayingHint: 'Pick a song to start',
  },
  permission: {
    title: 'Storage permission needed',
    description:
      'Without storage permission the app cannot read local music, so the scan comes back empty. Grant the "Music and audio" permission; if the system no longer shows the prompt, enable "All files access" in Settings. Scanning starts automatically when you return to the app.',
    grant: 'Grant permission',
    later: 'Not now',
  },
  back: {
    pressAgainToExit: 'Press back again to exit',
  },
}

export default en
