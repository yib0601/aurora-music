import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Playlist, Track } from '@/types'
import { generateId } from '@/lib/utils'

interface PlaylistState {
  playlists: Playlist[]
  currentPlaylistId: string | null
  showQueuePanel: boolean
  /**
   * 歌单导入的在线曲目：trackId → Track，与歌单同生命周期持久化。
   * 内存中保留播放地址（会话内可直接播）；持久化时剥离会过期的
   * onlineUrl，播放时按需重新搜索（见 playlistIO.service 的 ensurePlayableTrack）
   */
  importedTracks: Record<string, Track>

  createPlaylist: (name: string) => Playlist
  renamePlaylist: (id: string, name: string) => void
  deletePlaylist: (id: string) => void
  addTracksToPlaylist: (playlistId: string, trackIds: string[]) => void
  removeTrackFromPlaylist: (playlistId: string, trackId: string) => void
  reorderTracks: (playlistId: string, fromIndex: number, toIndex: number) => void
  setCurrentPlaylist: (id: string | null) => void
  /** 登记歌单导入的在线曲目（同 id 覆盖更新） */
  addImportedTracks: (tracks: Track[]) => void
  toggleQueuePanel: () => void
  setQueuePanel: (show: boolean) => void
}

const defaultPlaylists: Playlist[] = []

export const usePlaylistStore = create<PlaylistState>()(
  persist(
    (set, get) => ({
      playlists: defaultPlaylists,
      currentPlaylistId: null,
      showQueuePanel: false,
      importedTracks: {},

      createPlaylist: (name) => {
        const now = Date.now()
        const playlist: Playlist = {
          id: generateId(),
          name,
          createdAt: now,
          updatedAt: now,
          trackIds: [],
        }
        set({ playlists: [...get().playlists, playlist] })
        return playlist
      },

      renamePlaylist: (id, name) => {
        set({
          playlists: get().playlists.map((p) =>
            p.id === id ? { ...p, name, updatedAt: Date.now() } : p
          ),
        })
      },

      deletePlaylist: (id) => {
        set({
          playlists: get().playlists.filter((p) => p.id !== id),
          currentPlaylistId: get().currentPlaylistId === id ? null : get().currentPlaylistId,
        })
      },

      addTracksToPlaylist: (playlistId, trackIds) => {
        set({
          playlists: get().playlists.map((p) => {
            if (p.id !== playlistId) return p
            const existing = new Set(p.trackIds)
            const newIds = trackIds.filter((id) => !existing.has(id))
            return { ...p, trackIds: [...p.trackIds, ...newIds], updatedAt: Date.now() }
          }),
        })
      },

      removeTrackFromPlaylist: (playlistId, trackId) => {
        set({
          playlists: get().playlists.map((p) => {
            if (p.id !== playlistId) return p
            return { ...p, trackIds: p.trackIds.filter((id) => id !== trackId), updatedAt: Date.now() }
          }),
        })
      },

      reorderTracks: (playlistId, fromIndex, toIndex) => {
        set({
          playlists: get().playlists.map((p) => {
            if (p.id !== playlistId) return p
            const newIds = [...p.trackIds]
            const [moved] = newIds.splice(fromIndex, 1)
            newIds.splice(toIndex, 0, moved)
            return { ...p, trackIds: newIds, updatedAt: Date.now() }
          }),
        })
      },

      setCurrentPlaylist: (id) => set({ currentPlaylistId: id }),
      addImportedTracks: (tracks) => {
        if (tracks.length === 0) return
        const next = { ...get().importedTracks }
        for (const t of tracks) next[t.id] = t
        set({ importedTracks: next })
      },
      toggleQueuePanel: () => set({ showQueuePanel: !get().showQueuePanel }),
      setQueuePanel: (show) => set({ showQueuePanel: show }),
    }),
    {
      name: 'aurora-playlists-state',
      partialize: (state) => ({
        playlists: state.playlists,
        currentPlaylistId: state.currentPlaylistId,
        showQueuePanel: state.showQueuePanel,
        // 在线播放地址会过期：落盘时剥离，播放时按需重新搜索
        importedTracks: Object.fromEntries(
          Object.entries(state.importedTracks).map(([id, t]) => {
            const { onlineUrl: _omit, ...rest } = t
            return [id, rest as Track]
          })
        ),
      }),
    }
  )
)
