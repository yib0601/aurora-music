import type player from '../zh-CN/player'
import type { LocalizedOf } from '../schema'

/**
 * English messages. 类型标注刻意写成 `typeof` 中文侧的形状：
 * 少键 / 多键 / 拼错键都会在 tsc 阶段直接报错，语言覆盖度由编译器守门。
 *
 * 英文按英文语序整句写，不做中文逐字直译：
 *   - 「选择一首歌曲开始」→ "Choose a song to start"（不是 "Select one song start"）；
 *   - 「来自专辑「X」」→ 'From the album "X"'（引号随英文习惯，占位符集合不变）；
 *   - 「展开播放器」→ "Expand player"（aria-label 用名词短语，与英文 a11y 惯例一致）。
 */
const en: LocalizedOf<typeof player> = {
  bar: {
    expand: 'Expand player',
  },
  queue: {
    title: 'Play queue',
    toggle: 'Queue',
    empty: 'Queue is empty',
  },
  nowPlaying: {
    collapse: 'Collapse player',
    progress: 'Playback progress',
  },
  state: {
    notPlaying: 'Not playing',
    idle: 'Pick a song',
    idleHint: 'Choose a song to start',
  },
  mode: {
    label: 'Playback mode',
    shuffle: 'Shuffle',
    repeatOne: 'Repeat one',
    repeatAll: 'Repeat all',
  },
  volume: {
    mute: 'Mute',
    unmute: 'Unmute',
  },
  like: {
    add: 'Like',
    remove: 'Unlike',
  },
  track: {
    viewDetail: 'View song details',
  },
  lyrics: {
    searching: 'Searching for lyrics…',
    empty: 'No lyrics',
  },
  source: {
    onlineMusic: 'Online music',
    netease: 'NetEase Cloud Music',
    qqMusic: 'QQ Music',
    kugou: 'Kugou',
  },
  detail: {
    tagline: '{source} · Song details',
    loading: 'Loading songs…',
    notFound: 'Song not found',
    loadingHint: 'Please wait while {library} loads',
    removed: 'This song may have been removed',
    goBack: 'Go back',
    moreActions: 'More actions',
    playNext: 'Play next',
    addToQueue: 'Add to queue',
    download: 'Download song',
    newPlaylist: 'New Playlist',
    newPlaylistAndAdd: 'Add to new playlist',
    newPlaylistPlaceholder: 'Playlist name',
    createAndAdd: 'Create and add',
    moreInfo: 'More info',
    fromAlbum: 'From the album "{album}"',
  },
  facts: {
    year: 'Year',
    genre: 'Genre',
    trackNumber: 'Track',
    playCount: '{count} plays',
    playCount_one: '{count} play',
    fileSize: 'File size',
    addedAt: 'Date added',
    lastPlayed: 'Last played',
    neverPlayed: 'Never played',
  },
  device: {
    fallbackLabel: 'Output device {index}',
  },
}

export default en
