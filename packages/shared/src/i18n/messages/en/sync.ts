/**
 * Playlist sync (plugin domain `sync`).
 *
 * Single-owner file: whoever edits `zh-CN/sync.ts` edits this one in the same change.
 * Keys and `{placeholder}` sets must stay identical to the Chinese source of truth.
 */
const sync = {
  capability: 'Playlist sync',

  plugin: {
    webdav: {
      name: 'WebDAV sync',
      description: 'Sync playlists through your own WebDAV storage: Jianguo Cloud, Nextcloud, Alist, Synology…',
    },
    lan: {
      name: 'LAN sync',
      description: 'Sync directly between devices on the same network, no server required',
    },
  },

  webdav: {
    baseUrlLabel: 'Server URL',
    baseUrlPlaceholder: 'https://dav.example.com/dav',
    baseUrlHint: 'WebDAV root URL without a sub-directory. Jianguo Cloud uses https://dav.jianguoyun.com/dav',
    rootLabel: 'Folder',
    rootPlaceholder: '/aurora-music',
    rootHint: 'Snapshots are written to an aurora-sync sub-folder, created when missing',
    usernameLabel: 'Account',
    passwordLabel: 'App password',
    passwordHint: 'The password is encrypted by the main process via safeStorage and never written to config',
  },

  lan: {
    hostLabel: 'Peer address',
    hostPlaceholder: '192.168.1.20',
    portLabel: 'Port',
    portHint: 'Use the listening port shown in the peer “LAN sync” panel',
    codeLabel: 'Pairing code',
    codePlaceholder: "The peer's 10-character code",
    codeHint: 'Copy the code from the peer device by hand; it is never broadcast',
  },

  panel: {
    title: 'Playlist sync',
    description:
      'Keep playlists (names, order and tracks) in sync with other devices. Tracks are re-matched against the local library; missing ones are shown as placeholders.',
    unsupported: 'Playlist sync requires the desktop app.',
    privacyNote:
      'Snapshots contain playlist names, track metadata and local file paths. LAN transfers are unencrypted — use them on trusted networks only.',
    conflictNote: 'When the same playlist changed on both sides, the more recent change wins.',
    emptyTitle: 'No sync target yet',
    emptyDesc: 'Add a network storage, or another device on the same network.',
    add: 'Add sync target',
    addTitle: 'Add sync target',
    editTitle: 'Edit sync target',
  },

  config: {
    nameLabel: 'Name',
    namePlaceholder: 'e.g. Jianguo Cloud / Study desktop',
    directionLabel: 'Direction',
    directionBidirectional: 'Two-way',
    directionBidirectionalHint: 'Changes on either side sync to the other',
    directionPullOnly: 'Pull only',
    directionPullOnlyHint: 'Only take playlists from the peer; never change them',
    directionPushOnly: 'Push only',
    directionPushOnlyHint: 'Only send your playlists (good for a backup machine)',
    autoSync: 'Automatic sync',
    autoSyncHint: 'Sync at startup, after playlist changes, and every 5 minutes',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    deleteTitle: 'Delete this sync target?',
    deleteDesc: 'Only this device’s config and password are removed; playlists on the peer are not deleted.',
    deleted: 'Sync target deleted',
  },

  card: {
    syncNow: 'Sync now',
    test: 'Test connection',
    testing: 'Connecting…',
    testOk: 'Connection OK',
    lastSyncNever: 'Never synced',
    lastSyncAt: 'Last synced: {time}',
    lastError: 'Last failure: {reason}',
    direction: 'Direction: {direction}',
    autoSyncOn: 'Auto sync on',
    autoSyncOff: 'Auto sync off',
  },

  state: {
    idle: 'Idle',
    running: 'Syncing',
    ok: 'Done',
    failed: 'Failed',
  },

  toast: {
    applied: '{count} playlists updated',
    upToDate: 'Playlists already up to date',
    failed: 'Sync failed: {reason}',
  },

  server: {
    title: 'This device',
    enable: 'Enable LAN sync',
    enableHint: 'Listen on a port and announce this device so peers on the same network can find it',
    running: 'Listening on port {port}',
    stopped: 'Off',
    codeLabel: 'Pairing code',
    codeHidden: 'Click to reveal',
    codeHint: 'Type this code on the peer device so it can write to your playlists',
    copy: 'Copy',
    copied: 'Pairing code copied',
    rotate: 'New pairing code',
    rotated: 'Pairing code updated; the old one no longer works',
    rotateWarn: 'After rotating, paired devices must enter the new code again.',
    plaintextNote:
      'LAN snapshots travel unencrypted: the pairing code only decides who may write your playlists.',
  },

  discover: {
    scan: 'Scan for devices',
    scanning: 'Scanning…',
    title: 'Devices found',
    empty:
      'No device found. Make sure the peer enabled LAN sync, is on the same network, and UDP 45872 is allowed.',
    online: 'Online',
    offline: 'Offline',
    add: 'Add as sync target',
    added: 'Added device {name}',
  },

  error: {
    webdavAuth: 'Network storage “{name}” rejected the credentials: check account and app password',
    webdavStatus: 'Network storage “{name}” returned HTTP {status}',
    webdavConnect: 'Cannot reach network storage “{name}”: {reason}',
    webdavPath: 'The folder on network storage “{name}” does not exist and could not be created',
    snapshotInvalid: 'A sync file is malformed ({file}) and was skipped',
    snapshotVersion: 'Unsupported sync file version ({format}); it may come from a newer app version',
    lanDisabled: 'LAN sync is not enabled on this device',
    lanUnreachable: 'Cannot reach device {host}:{port}',
    lanAuth: 'The peer refused access: wrong pairing code, or the peer rotated its code',
    lanProtocol: 'Incompatible protocol version ({protocol}); update both devices',
    missingSecret: 'Missing password: this device cannot store it securely, configure it on desktop',
    unknown: 'Sync failed: {reason}',
  },
}

export default sync
