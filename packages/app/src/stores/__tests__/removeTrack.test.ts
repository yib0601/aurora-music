/**
 * 「从曲库移除单曲」的 store 层语义锁（libraryStore.removeTrack）。
 *
 * 这条路径有三处极易写错、且错了用户看得出来但查不出来：
 *   1. 移除后**必须**以平台返回的全库为准，不能本地 splice ——
 *      本地过滤掉一首但库里还在，下次扫描会把歌写回来，用户看到「移除了又自己回来」；
 *   2. 平台**没有该能力**时是 no-op，不能把本地列表清空（本地删了库里没删，
 *      是比「移除失败」更糟的不一致）；
 *   3. 收藏集合与最近播放要一起收敛，否则收藏页/最近播放会指向一首已不在曲库的歌。
 *
 * 平台层与持久化全部打桩：本文件只锁 store 的判断逻辑。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 最小 localStorage 实现：zustand persist 在 node 环境下没有 localStorage */
function stubLocalStorage() {
  const map = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    },
  })
}

const h = vi.hoisted(() => ({
  removeTrack: undefined as undefined | ((id: string) => Promise<unknown[]>),
  /** 平台返回的「移除后全库」 */
  remaining: [] as unknown[],
  calls: [] as string[],
}))

vi.mock('@/services/platform', () => ({
  platform: {
    platform: 'desktop',
    // 用 getter 让 replace 有效：用例按需增删这个能力（模拟老 preload / 移动端）
    get removeTrack() {
      return h.removeTrack
    },
    get revealTrack() {
      return undefined
    },
    getAllTracks: async () => [],
    syncLibrarySources: async () => {},
  },
}))

vi.mock('@/services/audioCache.service', () => ({
  configureAudioCache: () => {},
}))

/** 一眼可辨的假 id：uuid 全零 + 递增后缀 */
const track = (n: number) => ({
  id: `00000000-0000-0000-0000-00000000000${n}`,
  path: `/tmp/aurora-test-fixture/track-${n}.mp3`,
  title: `fixture ${n}`,
  artist: 'fixture artist',
  album: 'fixture album',
  duration: 100,
  addedAt: 0,
  playCount: 0,
  liked: n === 2,
})

let useLibraryStore: typeof import('@/stores/libraryStore').useLibraryStore

beforeEach(async () => {
  vi.resetModules()
  vi.unstubAllGlobals()
  stubLocalStorage()
  h.calls = []
  h.remaining = []
  h.removeTrack = async (id: string) => {
    h.calls.push(id)
    return h.remaining
  }
  ;({ useLibraryStore } = await import('@/stores/libraryStore'))
  useLibraryStore.getState().setTracks([track(1), track(2), track(3)] as never)
})

describe('libraryStore.removeTrack', () => {
  it('移除成功后以平台返回的全库为准，记录从列表消失', async () => {
    h.remaining = [track(1), track(3)]

    await useLibraryStore.getState().removeTrack(track(2).id)

    expect(h.calls).toEqual([track(2).id])
    expect(useLibraryStore.getState().tracks.map((t) => t.id)).toEqual([track(1).id, track(3).id])
  })

  it('**不会删除磁盘文件的语义**由平台层保证，store 只更新记录', async () => {
    h.remaining = [track(1), track(2)]

    await useLibraryStore.getState().removeTrack(track(3).id)

    // store 侧不做任何文件操作，也不从 path 推导任何东西：唯一副作用是调平台
    expect(h.calls).toEqual([track(3).id])
    expect(useLibraryStore.getState().tracks.map((t) => t.path)).toEqual([
      track(1).path,
      track(2).path,
    ])
  })

  it('同步收敛收藏集合与最近播放，避免指向已不在曲库的歌', async () => {
    useLibraryStore.getState().addRecentPlayed(track(2) as never, Date.now(), 1)
    expect(useLibraryStore.getState().likedTracks.has(track(2).id)).toBe(true)
    expect(useLibraryStore.getState().recentPlayedTracks.some((t) => t.id === track(2).id)).toBe(true)

    h.remaining = [track(1), track(3)]
    await useLibraryStore.getState().removeTrack(track(2).id)

    expect(useLibraryStore.getState().likedTracks.has(track(2).id)).toBe(false)
    expect(useLibraryStore.getState().recentPlayedTracks.some((t) => t.id === track(2).id)).toBe(false)
  })

  it('平台无该能力（方法不存在）时是 no-op，不清空本地列表', async () => {
    h.removeTrack = undefined

    await useLibraryStore.getState().removeTrack(track(2).id)

    expect(h.calls).toEqual([])
    expect(useLibraryStore.getState().tracks.map((t) => t.id)).toEqual([
      track(1).id,
      track(2).id,
      track(3).id,
    ])
  })

  it('移除最后一首歌时接受空结果（空数组不等于失败）', async () => {
    useLibraryStore.getState().setTracks([track(1)] as never)
    h.remaining = []

    await useLibraryStore.getState().removeTrack(track(1).id)

    expect(useLibraryStore.getState().tracks).toEqual([])
  })

  it('平台抛错时保留原列表（不能把失败当成功）', async () => {
    h.removeTrack = async () => {
      throw new Error('fixture failure')
    }

    await useLibraryStore.getState().removeTrack(track(2).id)

    expect(useLibraryStore.getState().tracks.map((t) => t.id)).toEqual([
      track(1).id,
      track(2).id,
      track(3).id,
    ])
  })

  it('不在库里的 id 直接返回，不打平台（重复点击不产生多余 IPC）', async () => {
    await useLibraryStore.getState().removeTrack('00000000-0000-0000-0000-00000000dead')

    expect(h.calls).toEqual([])
  })
})
