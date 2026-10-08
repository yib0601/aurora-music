import type library from '../zh-CN/library'
import type { LocalizedOf } from '../schema'

/**
 * English messages. 类型标注刻意写成 `typeof` 中文侧的形状：
 * 少键 / 多键 / 拼错键都会在 tsc 阶段直接报错，语言覆盖度由编译器守门。
 *
 * 英文不逐字直译中文：句子按英文语序整句重写，`{count}` 之类的占位符位置
 * 可以自由调整，但**占位符集合必须与中文完全一致**（一致性测试判红）。
 * 复数只补 `_one`：裸键即 other 形态（见 core.ts 的复数选择规则）。
 */
const en: LocalizedOf<typeof library> = {
  action: {
    importMusic: 'Import music',
    goToLibrary: 'Go to {label}',
    backToLibrary: 'Back to {label}',
    playAll: 'Play all',
    viewDetails: 'View song details',
    playNext: 'Play next',
    addToQueue: 'Add to queue',
    addToPlaylist: 'Add to playlist',
    like: 'Like',
    unlike: 'Unlike',
    sortBy: 'Sort by',
    moreActions: 'More actions',
  },
  tab: {
    songs: 'Songs',
  },
  sort: {
    default: 'Default order',
    addedAt: 'Date added',
    asc: 'Ascending',
    desc: 'Descending',
  },
  rescan: {
    tooltip: 'Rescan to sync deleted songs',
  },
  source: {
    localFile: 'Local file',
    quoted: '"{name}"',
    fromNetworkStorage: 'Stored on "{name}"',
  },
  empty: {
    title: 'No music yet',
    hint: 'Import your music folder to start building your library',
  },
  group: {
    albumSubtitle: '{subtitle} · {count} songs',
    albumSubtitle_one: '{subtitle} · {count} song',
  },
  recent: {
    title: 'Recently Played',
    empty: {
      title: 'No play history yet',
      hint: 'Once you import music, everything you play shows up here',
    },
  },
  liked: {
    title: 'Liked Songs',
    empty: {
      title: 'No liked songs yet',
      hint: 'Tap the heart on a song and it will show up here',
    },
  },
  playlist: {
    title: 'Playlist',
    new: 'New playlist',
    newMenu: 'New playlist…',
    namePlaceholder: 'Playlist name',
    createAndAdd: 'Create and add',
    defaultImportName: 'Imported playlist',
    notFound: 'Playlist not found',
    empty: 'No playlists yet',
    exportM3u: 'Export as M3U',
    importM3u: 'Import M3U file',
    importLink: 'Import playlist (link or text)',
    delete: 'Delete playlist',
    removeTrack: 'Remove from playlist',
    importInvalidFile: 'No valid music paths were found in this file',
    importNoMatch: 'No matching songs in {label} — scan a folder that contains them first',
    emptyTitle: 'This playlist is empty',
    emptyHint: 'Add songs from {label}',
  },
  import: {
    title: 'Import playlist',
    description:
      'Paste a playlist share link or plain text (one song per line, as title - artist). The app ships no platform scraper: link parsing is provided by the sources you configure (just fill in their service URL and key in Settings), while plain-text import needs no setup at all.',
    textPlaceholder:
      'Paste a playlist share link, or one song per line:\nShape of You - Ed Sheeran\nBlinding Lights - The Weeknd',
    namePlaceholder: 'Playlist name (optional, defaults to "{name}")',
    notice: 'Only metadata such as title and artist is imported. Online songs are streamed for playback only — nothing is downloaded.',
    parsing: 'Parsing…',
    parse: 'Parse and preview',
    summary: '{total} songs · {local} local',
    summary_one: '{total} song · {local} local',
    summaryPending: '{total} songs · {local} local · {pending} to match online',
    summaryPending_one: '{total} song · {local} local · {pending} to match online',
    matching: 'Matching…',
    progress: 'Matching online {done}/{total}…',
    repaste: 'Paste again',
    create: 'Create playlist',
    emptyResult: 'No songs were parsed. Check what you pasted — one song per line, as "title - artist".',
    nothingMatched: 'Nothing to import: no matches in your library and no results online',
    toast: {
      resultLocal: 'Imported {count} songs ({local} local)',
      resultLocal_one: 'Imported {count} song ({local} local)',
      resultMixed: 'Imported {count} songs ({local} local, {online} online)',
      resultMixed_one: 'Imported {count} song ({local} local, {online} online)',
      resultLocalSkipped: 'Imported {count} songs ({local} local)\nNot found, skipped: {skipped}',
      resultLocalSkipped_one: 'Imported {count} song ({local} local)\nNot found, skipped: {skipped}',
      resultMixedSkipped: 'Imported {count} songs ({local} local, {online} online)\nNot found, skipped: {skipped}',
      resultMixedSkipped_one: 'Imported {count} song ({local} local, {online} online)\nNot found, skipped: {skipped}',
    },
  },
  folderPicker: {
    title: 'Choose a folder to scan',
    description: 'Browse and pick the folder that holds your music files',
    confirm: 'Use this folder',
    storage: 'Storage',
    noSubfolders: 'No subfolders here',
    emptyHint: 'Tap "{label}" below to use the current folder',
    up: 'Up one level',
    current: 'Current: {path}',
  },
  duplicate: {
    badge: 'Duplicate',
    summary: '· {count} duplicate tracks hidden',
    summary_one: '· {count} duplicate track hidden',
    keptHidden: 'Kept: {kept} · Hidden: {hidden}',
    introSummary:
      'These songs exist in more than one source, so the list shows a single copy (local files first). Nothing was deleted — playlists and likes still reference every copy:',
    introBadge: 'This song exists in more than one copy, so the list shows a single one. Nothing was deleted:',
  },
  error: {
    parseFailed: 'Could not parse the playlist: {reason}',
    readDirFailed: 'Could not read this folder — check storage permissions',
    scanPartialFailed: 'Some folders could not be scanned — check that they exist and are readable',
    scanUnsupported: 'This browser cannot access local files. Use Chrome/Edge, or the desktop or Android app.',
  },
}

export default en
