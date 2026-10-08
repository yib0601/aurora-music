import type nav from '../zh-CN/nav'
import type { LocalizedOf } from '../schema'

const en: LocalizedOf<typeof nav> = {
  brand: {
    name: 'Aurora',
    subtitle: 'Music Player',
  },
  item: {
    hall: 'Discover',
    library: 'My Music',
    recent: 'Recently Played',
    liked: 'Liked',
    settings: 'Settings',
    playlists: 'Playlists',
    queue: 'Queue',
  },
  group: {
    content: 'Content',
    collection: 'Collection',
    system: 'System',
  },
  source: {
    local: 'Local',
    online: 'Online',
    webdav: 'Network',
  },
}

export default en
