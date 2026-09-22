import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Track, Album, Playlist, ViewMode, LibraryTab, SortField, SortOrder, OnlineSourceConfig, LyricsSourceConfig, DownloadQuality, PlaylistResolverConfig, LibrarySourceConfig } from '@/types'
import { audioEvents } from '@/services/audioEvents'
import { platform } from '@/services/platform'

/** 历史搜索记录最大保留条数 */
const MAX_SEARCH_HISTORY = 20

/** 最近播放记录最大保留条数（本地 + 在线统一记录在此，重启不丢） */
const MAX_RECENT_PLAYED = 100

interface LibraryState {
  tracks: Track[]
  /**
   * 最近播放记录（本地 + 在线统一记录，最新在前）：
   * 只存歌曲元数据快照（标题/艺术家/专辑/封面等），在线曲目不在本地曲库，
   * 也记录在此，重启后不丢。落盘时剥离会过期的播放地址（同 importedTracks 约定）
   */
  recentPlayedTracks: Track[]
  albums: Album[]
  playlists: Playlist[]
  scanFolders: string[]
  viewMode: ViewMode
  /** 音乐库浏览标签：全部歌曲 / 按专辑 / 按艺术家 */
  libraryTab: LibraryTab
  /** 音乐库歌曲排序字段与方向 */
  sortBy: SortField
  sortOrder: SortOrder
  theme: 'light' | 'dark' | 'system'
  currentView: 'library' | 'liked' | 'recent' | 'playlists' | 'search' | 'settings'
  searchQuery: string
  searchResults: Track[]
  /** 历史搜索记录（最新在前，最多保留 MAX_SEARCH_HISTORY 条） */
  searchHistory: string[]
  // 歌源配置（应用不内置任何源，全部由用户按协议配置）
  onlineSources: OnlineSourceConfig[]
  lyricsSources: LyricsSourceConfig[]
  /** 歌单解析源配置（应用不内置任何平台抓取器，全部由用户按协议配置） */
  playlistResolverSources: PlaylistResolverConfig[]
  /**
   * 媒体库来源（本机目录之外的持久曲库，目前支持 WebDAV 网络存储）。
   * 与 onlineSources（在线搜索歌源，地址易失、不入库）是两类东西：
   * 这里的来源会被扫描入库，曲目长期有效，播放走 aurora-remote:// 协议代理。
   */
  librarySources: LibrarySourceConfig[]
  /** 默认下载目录：null 表示每次下载都弹保存对话框询问 */
  downloadDir: string | null
  /** 默认下载音质：128 标准 / 320 高品质 / flac 无损（源不支持时按其默认地址下载） */
  downloadQuality: DownloadQuality

  setTracks: (tracks: Track[], version?: number) => void
  setAlbums: (albums: Album[]) => void
  addTracks: (tracks: Track[]) => void
  updateTrack: (id: string, updates: Partial<Track>) => void
  /** 登记一条最近播放记录（本地 + 在线统一入口，最新在前，最多保留 MAX_RECENT_PLAYED 条） */
  addRecentPlayed: (track: Track, lastPlayedAt: number, playCount: number) => void
  setPlaylists: (playlists: Playlist[]) => void
  addScanFolder: (path: string) => void
  removeScanFolder: (path: string) => void
  setViewMode: (mode: ViewMode) => void
  setLibraryTab: (tab: LibraryTab) => void
  setSortBy: (field: SortField) => void
  setSortOrder: (order: SortOrder) => void
  setTheme: (theme: 'light' | 'dark' | 'system') => void
  setCurrentView: (view: LibraryState['currentView']) => void
  setSearchQuery: (query: string) => void
  setSearchResults: (results: Track[]) => void
  // 历史搜索记录操作
  addSearchHistory: (query: string) => void
  removeSearchHistory: (query: string) => void
  clearSearchHistory: () => void
  toggleLiked: (trackId: string) => void
  toggleLike: (trackId: string) => void
  likedTracks: Set<string>
  likedTrackIds?: string[]
  // 音乐源配置操作
  addOnlineSource: (source: Omit<OnlineSourceConfig, 'id'>) => void
  updateOnlineSource: (id: string, updates: Partial<OnlineSourceConfig>) => void
  removeOnlineSource: (id: string) => void
  // 歌词源配置操作
  addLyricsSource: (source: Omit<LyricsSourceConfig, 'id'>) => void
  updateLyricsSource: (id: string, updates: Partial<LyricsSourceConfig>) => void
  removeLyricsSource: (id: string) => void
  // 歌单解析源配置操作
  addPlaylistResolverSource: (source: Omit<PlaylistResolverConfig, 'id'>) => void
  updatePlaylistResolverSource: (id: string, updates: Partial<PlaylistResolverConfig>) => void
  removePlaylistResolverSource: (id: string) => void
  // 媒体库来源操作（WebDAV 网络存储等持久曲库来源）
  addLibrarySource: (source: Omit<LibrarySourceConfig, 'id'>) => string
  updateLibrarySource: (id: string, updates: Partial<LibrarySourceConfig>) => void
  removeLibrarySource: (id: string) => void
  setDownloadDir: (dir: string | null) => void
  setDownloadQuality: (quality: DownloadQuality) => void
}

/** 递增版本号：防止 getAllTracks 的延迟响应用旧数据覆盖 scan:complete 的新数据 */
let tracksVersion = 0

export const useLibraryStore = create<LibraryState>()(
  persist(
    (set, get) => ({
      tracks: [],
      recentPlayedTracks: [],
      albums: [],
      playlists: [],
      scanFolders: [],
      viewMode: 'list',
      libraryTab: 'songs',
      sortBy: 'default',
      sortOrder: 'asc',
      theme: 'dark',
      currentView: 'library',
      searchQuery: '',
      searchResults: [],
      searchHistory: [],
      likedTracks: new Set<string>(),
      onlineSources: [],
      lyricsSources: [],
      playlistResolverSources: [],
      librarySources: [],
      downloadDir: null,
      downloadQuality: 'flac',

      setTracks: (tracks, version?: number) => {
        // 版本号保护：scan:complete 事件带的版本号比 getAllTracks 的大，
        // 如果 getAllTracks 的延迟响应（version 未传或更小）在 scan:complete 之后到达，
        // 跳过此次写入，避免旧数据覆盖新数据
        if (version !== undefined && version < tracksVersion) return
        // 内容指纹比较：扫描完成事件每次 IPC 传来的都是全新对象引用，
        // 若仅浅比较引用会认为变化了，导致订阅 tracks 的组件（如歌词/详情页）无谓重渲染。
        // 基于 id + 关键字段生成指纹，内容不变则跳过 set。
        const prev = get().tracks
        if (prev === tracks) return
        const fp = (t: Track) => `${t.id}|${t.title}|${t.artist}|${t.coverPath ?? ''}|${t.liked ? 1 : 0}|${t.playCount ?? 0}|${t.lastPlayedAt ?? ''}`
        if (prev.length === tracks.length && prev.map(fp).join('\n') === tracks.map(fp).join('\n')) return
        tracksVersion = version ?? tracksVersion + 1
        set({ tracks, likedTracks: new Set(tracks.filter((t) => t.liked).map((t) => t.id)) })
      },
      setAlbums: (albums) => set({ albums }),
      addTracks: (newTracks) => {
        const existing = get().tracks
        const existingIds = new Set(existing.map((t) => t.id))
        const unique = newTracks.filter((t) => !existingIds.has(t.id))
        if (unique.length === 0) return
        set({ tracks: [...existing, ...unique] })
      },
      updateTrack: (id, updates) => {
        set({
          tracks: get().tracks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
        })
      },
      addRecentPlayed: (track, lastPlayedAt, playCount) => {
        // 记录只留元数据快照：剥离会过期的在线播放地址，播放时按需重新取址
        const { onlineUrl: _omitUrl, onlineQualityUrls: _omitQuality, ...meta } = track
        const record: Track = { ...meta, lastPlayedAt, playCount } as Track
        const rest = get().recentPlayedTracks.filter((t) => t.id !== record.id)
        set({ recentPlayedTracks: [record, ...rest].slice(0, MAX_RECENT_PLAYED) })
      },
      setPlaylists: (playlists) => set({ playlists }),
      addScanFolder: (path) => {
        if (!get().scanFolders.includes(path)) {
          set({ scanFolders: [...get().scanFolders, path] })
        }
      },
      removeScanFolder: (path) => {
        set({ scanFolders: get().scanFolders.filter((p) => p !== path) })
      },
      setViewMode: (mode) => set({ viewMode: mode }),
      setLibraryTab: (tab) => set({ libraryTab: tab }),
      setSortBy: (field) => set({ sortBy: field }),
      setSortOrder: (order) => set({ sortOrder: order }),
      setTheme: (theme) => set({ theme }),
      setCurrentView: (view) => set({ currentView: view }),
      setSearchQuery: (query) => set({ searchQuery: query }),
      setSearchResults: (results) => set({ searchResults: results }),
      addSearchHistory: (query) => {
        const q = query.trim()
        if (!q) return
        // 去重并置顶：重复关键词移到最前（最近使用优先）
        const rest = get().searchHistory.filter((item) => item !== q)
        set({ searchHistory: [q, ...rest].slice(0, MAX_SEARCH_HISTORY) })
      },
      removeSearchHistory: (query) => {
        set({ searchHistory: get().searchHistory.filter((item) => item !== query) })
      },
      clearSearchHistory: () => set({ searchHistory: [] }),
      toggleLiked: (trackId) => {
        const tracks = get().tracks.map((t) =>
          t.id === trackId ? { ...t, liked: !t.liked } : t
        )
        const track = tracks.find((t) => t.id === trackId)
        const likedTracks = new Set(get().likedTracks)
        if (track?.liked) {
          likedTracks.add(trackId)
        } else {
          likedTracks.delete(trackId)
        }
        set({ tracks, likedTracks })
      },
      toggleLike: (trackId) => {
        get().toggleLiked(trackId)
      },

      addOnlineSource: (source) => {
        const id = `src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        set({ onlineSources: [...get().onlineSources, { ...source, id }] })
      },
      updateOnlineSource: (id, updates) => {
        set({
          onlineSources: get().onlineSources.map((s) =>
            s.id === id ? { ...s, ...updates } : s
          ),
        })
      },
      removeOnlineSource: (id) => {
        set({ onlineSources: get().onlineSources.filter((s) => s.id !== id) })
      },

      addLyricsSource: (source) => {
        const id = `lrc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        set({ lyricsSources: [...get().lyricsSources, { ...source, id }] })
      },
      updateLyricsSource: (id, updates) => {
        set({
          lyricsSources: get().lyricsSources.map((s) =>
            s.id === id ? { ...s, ...updates } : s
          ),
        })
      },
      removeLyricsSource: (id) => {
        set({ lyricsSources: get().lyricsSources.filter((s) => s.id !== id) })
      },
      addPlaylistResolverSource: (source) => {
        const id = `plr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        set({ playlistResolverSources: [...get().playlistResolverSources, { ...source, id }] })
      },
      updatePlaylistResolverSource: (id, updates) => {
        set({
          playlistResolverSources: get().playlistResolverSources.map((s) =>
            s.id === id ? { ...s, ...updates } : s
          ),
        })
      },
      removePlaylistResolverSource: (id) => {
        set({ playlistResolverSources: get().playlistResolverSources.filter((s) => s.id !== id) })
      },

      addLibrarySource: (source) => {
        // id 用作 aurora-remote:// 的 host，必须是小写字母/数字/连字符
        const id = `lib-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        set({ librarySources: [...get().librarySources, { ...source, id }] })
        return id
      },
      updateLibrarySource: (id, updates) => {
        set({
          librarySources: get().librarySources.map((s) => (s.id === id ? { ...s, ...updates } : s)),
        })
      },
      removeLibrarySource: (id) => {
        set({ librarySources: get().librarySources.filter((s) => s.id !== id) })
      },
      setDownloadDir: (dir) => set({ downloadDir: dir || null }),
      setDownloadQuality: (quality) => set({ downloadQuality: quality }),
    }),
    {
      name: 'aurora-library-state',
      partialize: (state) => ({
        recentPlayedTracks: state.recentPlayedTracks,
        scanFolders: state.scanFolders,
        viewMode: state.viewMode,
        libraryTab: state.libraryTab,
        sortBy: state.sortBy,
        sortOrder: state.sortOrder,
        theme: state.theme,
        likedTrackIds: Array.from(state.likedTracks),
        searchHistory: state.searchHistory,
        onlineSources: state.onlineSources,
        lyricsSources: state.lyricsSources,
        playlistResolverSources: state.playlistResolverSources,
        librarySources: state.librarySources,
        downloadDir: state.downloadDir,
        downloadQuality: state.downloadQuality,
      }),
      // v1 用合并的 useBuiltinSources 字段；v2 拆为两个独立开关；
      // v3 移除内置源概念（网易云/QQ 开关删除，歌源全部由用户按协议配置）
      // v4 默认下载音质改为无损 FLAC：清除旧持久值，让新默认值生效
      // v5 新增歌单解析源配置（歌单导入功能）
      // v6 新增媒体库来源配置（WebDAV 网络存储）
      // v7 移除扁平玻璃开关（glassMode 与 .glass-flat 规则已删除，代码里从无入口）
      migrate: (persisted: any, version: number) => {
        if (persisted) {
          if (version < 6) {
            if (!Array.isArray(persisted.librarySources)) persisted.librarySources = []
          }
          if (version < 5) {
            if (!Array.isArray(persisted.playlistResolverSources)) persisted.playlistResolverSources = []
          }
          if (version < 4) {
            delete persisted.downloadQuality
          }
          if (version < 3) {
            delete persisted.useNeteaseSources
            delete persisted.useQQSources
            if (!Array.isArray(persisted.lyricsSources)) persisted.lyricsSources = []
          }
          if (version < 2 && persisted.useBuiltinSources !== undefined) {
            delete persisted.useBuiltinSources
          }
          if (version < 7) {
            delete persisted.glassMode
          }
        }
        return persisted
      },
      version: 7,
      onRehydrateStorage: () => (state) => {
        if (state?.likedTrackIds) {
          state.likedTracks = new Set(state.likedTrackIds)
        }
      },
    }
  )
)

// 订阅播放统计事件，独立更新音乐库数据（解耦 playerStore 的跨Store副作用）
audioEvents.on('playStatsUpdate', ({ trackId, lastPlayedAt, playCount, track }) => {
  const library = useLibraryStore.getState()
  // 本地曲目同步曲库字段；在线曲目不在曲库，此调用空转
  library.updateTrack(trackId, {
    lastPlayedAt,
    playCount,
  })
  // 统一登记最近播放记录（本地 + 在线），最近播放页从这里取数
  library.addRecentPlayed(track, lastPlayedAt, playCount)
})

// ─── 媒体库来源配置 → 主进程 ──────────────────────────────────
// 远端的扫描与播放都在主进程执行（鉴权口令不出主进程），因此配置变更后必须
// 同步过去，否则 aurora-remote:// 找不到 sourceId 会直接 404。
// 注意 persist 是异步 hydrate 的：这里先推一次当前快照，再靠订阅捕获
// hydrate 完成后的那次 set，两种情况都能覆盖。
function pushLibrarySources(sources: LibrarySourceConfig[]): void {
  // Web / 移动端未实现该能力，静默跳过（可选方法直接短路）
  void platform.syncLibrarySources?.(sources)
}

pushLibrarySources(useLibraryStore.getState().librarySources)
useLibraryStore.subscribe((state, prev) => {
  if (state.librarySources !== prev.librarySources) pushLibrarySources(state.librarySources)
})
