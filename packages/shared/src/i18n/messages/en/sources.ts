import type sources from '../zh-CN/sources'
import type { LocalizedOf } from '../schema'

/**
 * English messages. 类型标注刻意写成 `typeof` 中文侧的形状：
 * 少键 / 多键 / 拼错键都会在 tsc 阶段直接报错，语言覆盖度由编译器守门。
 */
const en: LocalizedOf<typeof sources> = {
  capability: {
    search: 'Search',
    lyrics: 'Lyrics',
    playlist: 'Playlists',
    lxScript: 'LX script',
  },
  probe: {
    test: 'Test',
    testing: 'Testing…',
    testConnection: 'Test connection',
    scriptOk: 'Script is usable',
    scriptFailed: 'Script failed to load: {reason}',
    noPlatform: 'the script declared no usable platform',
    unnamedScript: 'Unnamed script',
    scriptName: '{name}',
    scriptNameWithVersion: '{name} · v{version}',
    packed: 'Wrapped by liscript and unpacked automatically',
    qualityCount: '{count} quality tiers',
    qualityCount_one: '{count} quality tier',
    searchAndResolve: 'Search + resolve',
    resolveOnly: 'Resolve only',
  },
  form: {
    title: 'Add source',
    titleLx: 'Add LX script source',
    desc: 'A service address generates both endpoints automatically; an endpoint template is used as-is',
    descLx: 'Paste the script link. The script resolves track URLs.',
    kindLabel: 'Source type',
    kindAurora: 'Aurora protocol source',
    kindAuroraHint: 'Service address / endpoint template',
    kindLx: 'LX script source',
    kindLxHint: 'Script link (URL resolution)',
    kindLxHintUnsupported: 'Desktop and mobile only',
    kindLxDisabledTitle:
      'LX script sources need script execution, which the browser build does not provide. Use the desktop or mobile app.',
    nameLabel: 'Name (optional)',
    namePlaceholder: 'e.g. My source',
    namePlaceholderLx: 'e.g. My LX source',
    nameDraftPlaceholder: 'Source name',
    unnamed: 'Unnamed source',
    defaultName: 'New source',
    defaultNameLx: 'New LX source',
    scriptLabel: 'Script link',
    scriptHint:
      'The script resolves track URLs. A script without a search API needs a separate Aurora source for searching.',
    sourceLabel: 'Source address',
    apiLabel: 'Endpoint address',
    sourceDetectedWithKey:
      'Recognized as a service address; the key was extracted and the search and playlist endpoints are generated automatically',
    sourceDetected:
      'Recognized as a service address; the search and playlist endpoints are generated automatically. The key can be part of the link.',
    templateDetected: 'Used as an endpoint template; placeholders are filled in by the app',
    sourceHint: 'A service address or a full endpoint address both work. Put the key in the link, e.g. https://host?key=xxx',
    playlistLabel: 'Playlist resolver endpoint (optional)',
    playlistLabelRequired: 'Playlist resolver endpoint (optional, must contain {placeholder})',
    playlistHint: 'Leave empty to keep this source out of playlist imports',
    playlistHintDialog:
      'Once set, playlist share links from QQ Music, NetEase Cloud Music and others can be resolved directly on import',
    headersLabel: 'Request headers (optional, JSON object)',
    sourceRowLabel: 'Sources',
    sourceRowHint: 'Online search and playlist imports share this source',
    sourceRowEmpty: 'Nothing configured yet. Online search and playlist imports are unavailable.',
    previewService: 'Service {url}',
    previewSearch: 'Search {url}',
    previewPlaylist: 'Playlist {url}',
    savedDisabled:
      'The script did not pass the test, so the source was saved as disabled. Enable it in the list once the test passes.',
  },
  webdav: {
    title: 'Add network storage',
    desc: 'Standard WebDAV is supported: Synology, QNAP, Nextcloud, rclone serve webdav and others. Add it, test the connection, then scan it into your library.',
    nameLabel: 'Name (optional)',
    namePlaceholder: 'e.g. NAS at home',
    nameDraftPlaceholder: 'Name',
    defaultName: 'Network storage',
    baseUrlLabel: 'Server address',
    baseUrlPlaceholder: 'e.g. https://nas.example.com:5006/dav',
    baseUrlPlaceholderDraft: 'Server address, e.g. https://nas.example.com:5006/dav',
    baseUrlHint: 'Synology: http(s)://host:5006/shared-folder; Nextcloud: https://host/remote.php/dav/files/username',
    rootLabel: 'Library root folder (optional)',
    rootPlaceholder: 'e.g. Music. Leave empty to use the server address itself',
    rootPlaceholderDraft: 'Library root folder (optional), e.g. Music',
    usernameLabel: 'Username (optional)',
    passwordLabel: 'Password (optional)',
    passwordHint:
      'The password is stored only in the local configuration. It is never written to your library and never appears in playback URLs (remote requests are proxied by the main process).',
    enabledTitle: 'Enabled (scanned automatically at startup)',
    disabledTitle: 'Disabled (not scanned at startup; you can still scan manually)',
    removeTitle: 'Remove source (also removes its songs from {library})',
    removeConfirm: 'Remove network storage "{name}"?',
    removeConfirmWithCount:
      'Remove network storage "{name}"?\nIts {count} songs will also be removed from {library} (files on the server are kept).',
    removeConfirmWithCount_one:
      'Remove network storage "{name}"?\nIts {count} song will also be removed from {library} (files on the server are kept).',
    testConnection: 'Test connection',
    scan: 'Scan into library',
    scanComplete: 'Scan complete, {count} songs in your library',
    scanComplete_one: 'Scan complete, {count} song in your library',
    scanIncomplete: 'Scan complete, but {count} folders were unreachable; existing records were kept',
    scanIncomplete_one: 'Scan complete, but {count} folder was unreachable; existing records were kept',
  },
  error: {
    scriptUrlRequired: 'Enter a script link',
    scriptUrlScheme: 'The script link must start with http:// or https://',
    headersJson: 'Invalid JSON: expected an object such as {example}',
  },
}

export default en
