import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Track, Album, Playlist, ViewMode, GlassMode } from '@/types'
import { audioEvents } from '@/services/audioEvents'

interface LibraryState {
  tracks: Track[]
  albums: Album[]
  playlists: Playlist[]
  scanFolders: string[]
  viewMode: ViewMode
  glassMode: GlassMode
  theme: 'light' | 'dark' | 'system'
  currentView: 'library' | 'liked' | 'recent' | 'playlists' | 'search' | 'settings'
  searchQuery: string
  searchResults: Track[]

  setTracks: (tracks: Track[]) => void
  setAlbums: (albums: Album[]) => void
  addTracks: (tracks: Track[]) => void
  updateTrack: (id: string, updates: Partial<Track>) => void
  setPlaylists: (playlists: Playlist[]) => void
  addScanFolder: (path: string) => void
  removeScanFolder: (path: string) => void
  setViewMode: (mode: ViewMode) => void
  setGlassMode: (mode: GlassMode) => void
  setTheme: (theme: 'light' | 'dark' | 'system') => void
  setCurrentView: (view: LibraryState['currentView']) => void
  setSearchQuery: (query: string) => void
  setSearchResults: (results: Track[]) => void
  toggleLiked: (trackId: string) => void
  toggleLike: (trackId: string) => void
  likedTracks: Set<string>
  likedTrackIds?: string[]
}

export const useLibraryStore = create<LibraryState>()(
  persist(
    (set, get) => ({
      tracks: [],
      albums: [],
      playlists: [],
      scanFolders: [],
      viewMode: 'list',
      glassMode: 'auto',
      theme: 'dark',
      currentView: 'library',
      searchQuery: '',
      searchResults: [],
      likedTracks: new Set<string>(),

      setTracks: (tracks) => {
        // 内容指纹比较：扫描完成事件每次 IPC 传来的都是全新对象引用，
        // 若仅浅比较引用会认为变化了，导致订阅 tracks 的组件（如歌词/详情页）无谓重渲染。
        // 基于 id + 关键字段生成指纹，内容不变则跳过 set。
        const prev = get().tracks
        if (prev === tracks) return
        const fp = (t: Track) => `${t.id}|${t.title}|${t.artist}|${t.coverPath ?? ''}|${t.liked ? 1 : 0}|${t.playCount ?? 0}|${t.lastPlayedAt ?? ''}`
        if (prev.length === tracks.length && prev.map(fp).join('\n') === tracks.map(fp).join('\n')) return
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
      setGlassMode: (mode) => set({ glassMode: mode }),
      setTheme: (theme) => set({ theme }),
      setCurrentView: (view) => set({ currentView: view }),
      setSearchQuery: (query) => set({ searchQuery: query }),
      setSearchResults: (results) => set({ searchResults: results }),
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
    }),
    {
      name: 'aurora-library-state',
      partialize: (state) => ({
        scanFolders: state.scanFolders,
        viewMode: state.viewMode,
        glassMode: state.glassMode,
        theme: state.theme,
        likedTrackIds: Array.from(state.likedTracks),
      }),
      onRehydrateStorage: () => (state) => {
        if (state?.likedTrackIds) {
          state.likedTracks = new Set(state.likedTrackIds)
        }
      },
    }
  )
)

// 订阅播放统计事件，独立更新音乐库数据（解耦 playerStore 的跨Store副作用）
audioEvents.on('playStatsUpdate', ({ trackId, lastPlayedAt, playCount }) => {
  useLibraryStore.getState().updateTrack(trackId, {
    lastPlayedAt,
    playCount,
  })
})
