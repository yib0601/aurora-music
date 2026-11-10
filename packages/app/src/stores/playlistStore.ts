import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Playlist, Track } from '@/types'
import { generateId } from '@/lib/utils'

interface PlaylistState {
  playlists: Playlist[]
  currentPlaylistId: string | null
  showQueuePanel: boolean
  /** 移动端全屏 Now Playing 浮层开关（任何入口点封面/点播放条都可打开，不推进路由历史） */
  mobileNowPlayingOpen: boolean
  /**
   * 歌单导入的在线曲目：trackId → Track，与歌单同生命周期持久化。
   * 内存中保留播放地址（会话内可直接播）；持久化时剥离会过期的
   * onlineUrl，播放时按需重新搜索（见 playlistIO.service 的 ensurePlayableTrack）
   */
  importedTracks: Record<string, Track>
  /**
   * 歌单墓碑：id → 删除时刻（`docs/playlist-sync.md` §5）。
   *
   * 删除必须留下痕迹，否则「A 删了、B 还有」在下一轮 LWW 里会被 B 的旧副本复活。
   * 墓碑参与与普通歌单同一套 updatedAt 比较，90 天后自然过期（`SYNC_TOMBSTONE_TTL_MS`）。
   * 不进 `Playlist` 结构：歌单本身已从 `playlists` 移除，墓碑只是一张 id→时间表。
   */
  syncTombstones: Record<string, number>

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
  setMobileNowPlaying: (open: boolean) => void
  /**
   * 把远端合并结果写进本地（同步引擎专用，唯一允许**按外部时间戳**改歌单的入口）。
   *
   * 与 `addTracksToPlaylist` 等用户动作的区别：
   * - `updatedAt` 用快照里的值，**不**取 `Date.now()`（否则本机每轮同步都会把自己
   *   变成「最新版本」，LWW 立刻退化成「谁最后同步谁赢」）；
   * - 不做去重、不调整顺序，`trackIds` 原样落盘（顺序就是同步语义的一部分）；
   * - 只碰 `playlists` / `syncTombstones` / `currentPlaylistId`，不碰曲库、
   *   不碰 `importedTracks` 里已有曲目的播放统计。
   */
  applySyncChanges: (changes: PlaylistSyncChanges) => void
}

/** `applySyncChanges` 的入参：增改（upserts）+ 按墓碑删除（deletes） */
export interface PlaylistSyncChanges {
  /** 增/改的歌单（同 id 覆盖，updatedAt 来自快照） */
  upserts: Playlist[]
  /** 要删除的歌单 id（来自快照里的墓碑） */
  deletes: string[]
  /** 墓碑表增补（id → 删除时刻）；与本地已有墓碑取**较新**的那个 */
  tombstones: Record<string, number>
  /**
   * 复活用：这些 id 在快照里已有更新版本（`updatedAt` 晚于墓碑），
   * 本地相应墓碑必须撤掉，否则下一次快照又会把歌单写成「已删除」。
   */
  resurrected?: string[]
}

const defaultPlaylists: Playlist[] = []

export const usePlaylistStore = create<PlaylistState>()(
  persist(
    (set, get) => ({
      playlists: defaultPlaylists,
      currentPlaylistId: null,
      showQueuePanel: false,
      mobileNowPlayingOpen: false,
      importedTracks: {},
      syncTombstones: {},

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
        const exists = get().playlists.some((p) => p.id === id)
        set({
          playlists: get().playlists.filter((p) => p.id !== id),
          currentPlaylistId: get().currentPlaylistId === id ? null : get().currentPlaylistId,
          // 只有真的删掉了才留墓碑：对不存在的 id 反复 delete 不该制造一个
          // 「删除时间一直被刷新」的墓碑，那会让别的设备永远收不到干净的删除
          syncTombstones: exists
            ? { ...get().syncTombstones, [id]: Date.now() }
            : get().syncTombstones,
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
      setMobileNowPlaying: (open) => set({ mobileNowPlayingOpen: open }),

      applySyncChanges: ({ upserts, deletes, tombstones, resurrected = [] }) => {
        const state = get()
        const deleted = new Set(deletes)
        // 顺序：先按墓碑删，再把增改**原位替换**（不追加到尾部）——歌单的排列
        // 顺序在 UI 上是稳定的，同步一次就不该让整个列表重排
        const next = state.playlists.filter((p) => !deleted.has(p.id))
        const slots = new Map(next.map((p, i) => [p.id, i] as const))
        for (const upsert of upserts) {
          const at = slots.get(upsert.id)
          if (at === undefined) next.push(upsert)
          else next[at] = upsert
        }

        // 墓碑合并：本地已有的保留（较旧/较新都无所谓，取较新值），快照带来的补进来；
        // 在快照里已有更新版本（updatedAt 晚于墓碑）的 id 视为复活，撤掉墓碑。
        const cleared = new Set(resurrected)
        for (const upsert of upserts) {
          const tombstonedAt = state.syncTombstones[upsert.id]
          if (tombstonedAt !== undefined && upsert.updatedAt > tombstonedAt) cleared.add(upsert.id)
        }
        const nextTombstones: Record<string, number> = {}
        for (const [id, at] of Object.entries(state.syncTombstones)) {
          if (!cleared.has(id)) nextTombstones[id] = at
        }
        for (const [id, at] of Object.entries(tombstones)) {
          if (cleared.has(id)) continue
          const prev = nextTombstones[id]
          if (prev === undefined || at > prev) nextTombstones[id] = at
        }

        set({
          playlists: next,
          syncTombstones: nextTombstones,
          // 正在看的歌单被同步删掉了：退回列表页，而不是停在一个不存在的 id 上
          currentPlaylistId: deleted.has(state.currentPlaylistId ?? '')
            ? null
            : state.currentPlaylistId,
        })
      },
    }),
    {
      name: 'aurora-playlists-state',
      partialize: (state) => ({
        playlists: state.playlists,
        currentPlaylistId: state.currentPlaylistId,
        showQueuePanel: state.showQueuePanel,
        // 墓碑必须落盘：重启后若不记得「我删过它」，下一轮同步就会把那份歌单拉回来
        syncTombstones: state.syncTombstones,
        // 在线播放地址会过期：落盘时剥离，播放时按需重新搜索。
        // onlineQuality 描述的是「那一次取址拿到的档位」，地址剥了它就不成立（否则
        // 下次取址若源没回 quality，残留的旧档位会让降级判断按错误档位走）。
        importedTracks: Object.fromEntries(
          Object.entries(state.importedTracks).map(([id, t]) => {
            const { onlineUrl: _omit, onlineQuality: _omitQuality, ...rest } = t
            return [id, rest as Track]
          })
        ),
      }),
    }
  )
)
