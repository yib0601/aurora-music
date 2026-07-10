import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Track, Album, Playlist, ViewMode, GlassMode } from '@/types'

interface LibraryState {
  tracks: Track[]
  albums: Album[]
  playlists: Playlist[]
  scanFolders: string[]
  isScanning: boolean
  scanProgress: { current: number; total: number; file: string }
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
  setIsScanning: (scanning: boolean) => void
  setScanProgress: (progress: { current: number; total: number; file: string }) => void
  setViewMode: (mode: ViewMode) => void
  setGlassMode: (mode: GlassMode) => void
  setTheme: (theme: 'light' | 'dark' | 'system') => void
  setCurrentView: (view: LibraryState['currentView']) => void
  setSearchQuery: (query: string) => void
  setSearchResults: (results: Track[]) => void
  toggleLiked: (trackId: string) => void
  toggleLike: (trackId: string) => void
  likedTracks: Set<string>
}

export const useLibraryStore = create<LibraryState>()(
  persist(
    (set, get) => ({
      tracks: [],
      albums: [],
      playlists: [],
      scanFolders: [],
      isScanning: false,
      scanProgress: { current: 0, total: 0, file: '' },
      viewMode: 'list',
      glassMode: 'auto',
      theme: 'dark',
      currentView: 'library',
      searchQuery: '',
      searchResults: [],
      likedTracks: new Set<string>(),

      setTracks: (tracks) => set({ tracks, likedTracks: new Set(tracks.filter((t) => t.liked).map((t) => t.id)) }),
      setAlbums: (albums) => set({ albums }),
      addTracks: (newTracks) => {
        const existing = get().tracks
        const existingIds = new Set(existing.map((t) => t.id))
        const unique = newTracks.filter((t) => !existingIds.has(t.id))
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
      setIsScanning: (scanning) => set({ isScanning: scanning }),
      setScanProgress: (progress) => set({ scanProgress: progress }),
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
      }),
    }
  )
)
