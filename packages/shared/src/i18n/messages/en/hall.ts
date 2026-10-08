import type hall from '../zh-CN/hall'
import type { LocalizedOf } from '../schema'

/**
 * English messages. 类型标注刻意写成 `typeof` 中文侧的形状：
 * 少键 / 多键 / 拼错键都会在 tsc 阶段直接报错，语言覆盖度由编译器守门。
 *
 * 只在**英文需要区分单复数**的地方补 `_one`（中文单复数同形，只留裸键）：
 * 裸键即 other 形态，`t('x', { count })` 由内核按 Intl.PluralRules 选。
 */
const en: LocalizedOf<typeof hall> = {
  unavailable: {
    unsupportedEnv:
      '{hall} is not available in this environment (the browser build has no online access). You can still listen to your local library in "{library}".',
    noSource:
      'Playlists and charts in {hall} are provided by music sources, and none is configured yet. Your local library is not affected.',
    allDisabled: 'All sources are disabled. Enable a music source on the Settings page.',
    sourceUnsupported: 'The current sources do not support {hall} (this needs a source with a service address).',
  },
  empty: {
    title: '{hall} is unavailable',
    configureSource: 'Set up a music source',
    goLibrary: 'Go to {library}',
  },
  recommend: {
    title: 'Recommended Playlists',
    count: '{count} playlists',
    count_one: '{count} playlist',
    empty: 'No recommended playlists yet',
    plays: '{plays} plays',
    plays_one: '{plays} play',
  },
  toplist: {
    title: 'Charts',
    count: '{count} charts',
    count_one: '{count} chart',
    empty: 'No charts yet',
    viewFull: 'Open the full chart',
    fallbackName: 'Chart',
  },
  detail: {
    reload: 'Reload',
    playAll: 'Play all',
    shuffle: 'Shuffle',
    empty: {
      playlist: 'This playlist has no tracks',
      toplist: 'This chart has no tracks',
    },
    column: {
      song: 'Song',
    },
    meta: {
      songs: '{count} songs',
      songs_one: '{count} song',
      songsOfTotal: '{shown} of {total} songs',
      hoursMinutes: '{hours}h {minutes}m',
      updated: 'Updated {time}',
    },
  },
  download: {
    starting: 'Downloading "{title}"…',
    noSource: 'Cannot download: no usable music source is configured, or this song was not found',
    saved: 'Download complete\nSaved to: {path}',
    savedWithSource: 'Download complete\nSaved to: {path}\nSource: {name}',
    setDefaultDir: 'Set as default download folder',
    defaultDirSaved:
      'Future downloads will be saved directly to "{dir}". You can change this in Settings → Downloads.',
  },
}

export default en
