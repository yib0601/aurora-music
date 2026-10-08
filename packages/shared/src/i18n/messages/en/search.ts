import type search from '../zh-CN/search'
import type { LocalizedOf } from '../schema'

/**
 * English messages. 类型标注刻意写成 `typeof` 中文侧的形状：
 * 少键 / 多键 / 拼错键都会在 tsc 阶段直接报错，语言覆盖度由编译器守门。
 *
 * 只在**英文需要区分单复数**的地方补 `_one`（中文单复数同形，只留裸键）：
 * 裸键即 other 形态，`t('x', { count })` 由内核按 Intl.PluralRules 选。
 */
const en: LocalizedOf<typeof search> = {
  entry: {
    placeholder: 'Search songs, artists, albums',
  },
  overlay: {
    placeholder: 'Search songs, artists, albums...',
    emptyTitle: 'Start searching',
    emptyDesc: 'Type a keyword to search {library} and online sources',
    historyTitle: 'Recent searches',
    historyRemove: 'Remove this entry',
    localTruncated: 'Many local matches, showing the first {count}',
    noMatch: 'No songs found for "{query}"',
    noSource: 'The app ships with no music sources. Configure a protocol-compatible search endpoint in Settings first.',
    goSettings: 'Set up music sources',
    searching: 'Searching online music...',
    onlineEmpty: 'No matching results from online sources',
  },
  badge: {
    onlineFallback: 'Online music',
  },
  row: {
    viewDetail: 'View song details',
    like: 'Like',
    unlike: 'Unlike',
    download: 'Download song',
    playNow: 'Play now',
    playNext: 'Play next',
    addToQueue: 'Add to queue',
    addToPlaylist: 'Add to playlist',
    noPlaylist: 'No playlists yet',
  },
}

export default en
