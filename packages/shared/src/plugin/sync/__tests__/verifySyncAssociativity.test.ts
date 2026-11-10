/**
 * 对抗性复验（task-9，S-2）的**结合律对拍**证据。
 *
 * 旧实现的时间戳并列裁决用「快照 header 的 deviceId」——而 header 只在**输入**里存在，
 * 合并输出只会保留本机 deviceId，于是 `(a∘b)∘c` 与 `a∘(b∘c)` 在「同毫秒并列」时会取到
 * 不同的赢家（我第一轮报告里的反例即由此构造）。
 *
 * 现在的裁决是「歌单规范化串字典序」（`canonical.ts`，与来源设备无关）。这里只做一件事：
 * 用三份**时间戳完全并列、内容不同**的快照，直接对拍两种结合顺序，要求逐字段相等。
 * 不依赖任何单测里的既有期望，避免「作者按自己的修法写期望」。
 */
import { describe, expect, it } from 'vitest'
import type { SyncedPlaylist, SyncSnapshot, SyncTrackRef } from '../types'
import { mergeSnapshots } from '../merge'

const device = (id: string) => ({ deviceId: id, deviceName: `设备 ${id}` })

const snapshotOf = (deviceId: string, playlists: SyncedPlaylist[]): SyncSnapshot => ({
  format: 'aurora-playlist-sync/1',
  deviceId,
  deviceName: `设备 ${deviceId}`,
  revision: 1,
  updatedAt: 1_700_000_000_000,
  playlists,
})

const trackRef = (over: Partial<SyncTrackRef> = {}): SyncTrackRef =>
  ({
    kind: 'local',
    path: '/music/a.flac',
    title: '曲目',
    artist: '歌手',
    album: '',
    duration: 200,
    ...over,
  }) as SyncTrackRef

const playlistOf = (over: Partial<SyncedPlaylist> = {}): SyncedPlaylist => ({
  id: 'pl-tie',
  name: '甲',
  createdAt: 100,
  updatedAt: 500,
  tracks: [trackRef()],
  ...over,
})

/** 同一 id、同一 updatedAt、内容互不相同的三份歌单（旧实现唯一会露馅的输入） */
const variantA = playlistOf({ name: '甲', createdAt: 100, tracks: [trackRef({ path: '/music/a.flac' })] })
const variantB = playlistOf({ name: '乙', createdAt: 200, tracks: [trackRef({ path: '/music/b.flac' })] })
const variantC = playlistOf({ name: '丙', createdAt: 300, tracks: [trackRef({ path: '/music/c.flac' })] })

const asLocal = (snapshot: SyncSnapshot): SyncSnapshot => snapshot

describe('S-2：时间戳完全并列时的结合律（对拍）', () => {
  it('(a∘b)∘c 与 a∘(b∘c) 的合并结果逐字段相等', () => {
    const a = snapshotOf('dev-a', [variantA])
    const b = snapshotOf('dev-b', [variantB])
    const c = snapshotOf('dev-c', [variantC])

    // 左结合：(a∘b)∘c
    const ab = mergeSnapshots(asLocal(a), [b]).snapshot
    const left = mergeSnapshots(asLocal(ab), [c]).snapshot

    // 右结合：a∘(b∘c)
    const bc = mergeSnapshots(asLocal(b), [c]).snapshot
    const right = mergeSnapshots(asLocal(a), [bc]).snapshot

    // 歌单内容逐字段相等（header 的 deviceId/updatedAt 本来就取「本地」那一侧，不参与比较）
    expect(left.playlists).toEqual(right.playlists)
    // 三条候选里只该留下一个赢家
    expect(left.playlists).toHaveLength(1)
    expect(left.playlists[0]!.id).toBe('pl-tie')
    // 交换：a∘b 与 b∘a 结果也一致
    expect(mergeSnapshots(asLocal(a), [b]).snapshot.playlists).toEqual(
      mergeSnapshots(asLocal(b), [a]).snapshot.playlists
    )
  })

  it('并列裁决与设备给出顺序无关：三份同时间戳快照的 6 种排列结果一致', () => {
    const variants = [variantA, variantB, variantC]
    const devices = ['dev-a', 'dev-b', 'dev-c']
    const inputs = variants.map((playlist, index) => snapshotOf(devices[index]!, [playlist]))

    const permutations: Array<[number, number, number]> = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]

    const results = permutations.map(([i, j, k]) => {
      const first = inputs[i]!
      const second = inputs[j]!
      const third = inputs[k]!
      return mergeSnapshots(asLocal(first), [second, third]).snapshot.playlists
    })

    for (const result of results) expect(result).toEqual(results[0])
  })

  it('并列 + 墓碑混合：墓碑在任意结合顺序下都胜出且结果一致', () => {
    const live = playlistOf({ name: '活', createdAt: 100 })
    // deletedAt 用「现在」，保证不会因 90 天 TTL 被当成过期墓碑丢弃
    const tombstone = playlistOf({ name: '墓碑', createdAt: 200, deletedAt: Date.now() })

    const a = snapshotOf('dev-a', [live])
    const b = snapshotOf('dev-b', [tombstone])
    const c = snapshotOf('dev-c', [variantC])

    const left = mergeSnapshots(asLocal(mergeSnapshots(asLocal(a), [b]).snapshot), [c]).snapshot
    const right = mergeSnapshots(asLocal(a), [mergeSnapshots(asLocal(b), [c]).snapshot]).snapshot

    expect(left.playlists).toEqual(right.playlists)
    expect(left.playlists[0]!.deletedAt).toBe(tombstone.deletedAt)
  })
})
