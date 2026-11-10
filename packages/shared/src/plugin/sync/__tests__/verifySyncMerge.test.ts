/**
 * 对抗性验证（verifier 任务 task-4）用的**临时证据测试**，不属于实现方交付。
 *
 * 目的只有两个：
 *  1) 把 docs/playlist-sync.md §15.2 的「幂等 / 交换 / 结合」三条硬要求逐条复算，
 *     对照 `mergeSnapshots` 的实际行为；
 *  2) 复算墓碑 90 天边界，以及「解析失败的快照」是整份拒绝还是单条跳过。
 *
 * 第一轮（task-4）里用 `it.fails` 固化的两条缺陷（结合律、`deletedAt: 0` 边界）已在
 * task-6 修掉，本文件现在是**复验（task-9）**的常规证据：所有断言都要求契约行为成立。
 */
import { describe, expect, it } from 'vitest'
import {
  SYNC_TOMBSTONE_TTL_MS,
  mergeSnapshots,
  parseSnapshot,
  pruneSnapshot,
} from '../index'
import type { SyncSnapshot, SyncTrackRef } from '../index'

const NOW = 1_700_000_000_000

const ref = (over: Partial<SyncTrackRef> = {}): SyncTrackRef => ({
  kind: 'local',
  path: '/music/a.flac',
  title: 'A',
  artist: 'B',
  album: '',
  duration: 200,
  ...over,
})

const playlist = (over: Partial<SyncSnapshot['playlists'][number]> = {}) => ({
  id: 'pl-1',
  name: '歌单',
  createdAt: 1,
  updatedAt: 100,
  tracks: [ref()],
  ...over,
})

const snapshotOf = (
  deviceId: string,
  playlists: SyncSnapshot['playlists'],
  over: Partial<SyncSnapshot> = {}
): SyncSnapshot => ({
  format: 'aurora-playlist-sync/1',
  deviceId,
  deviceName: deviceId,
  revision: 1,
  updatedAt: NOW,
  playlists,
  ...over,
})

/** 只比歌单内容：输出快照头永远带本机 deviceId，不能拿来判等 */
const body = (snapshot: SyncSnapshot) => JSON.stringify(snapshot.playlists)

describe('mergeSnapshots：§15.2 三条代数性质', () => {
  it('幂等：merge(m, []) 不改内容、不抬 revision、changed=false', () => {
    const m = snapshotOf('dev-a', [playlist()], { revision: 4 })

    const out = mergeSnapshots(m, [])

    expect(out.changed).toBe(false)
    expect(out.snapshot.revision).toBe(4)
    expect(out.snapshot.updatedAt).toBe(NOW)
    expect(body(out.snapshot)).toBe(body(m))
  })

  it('交换：merge(a, [b]) 与 merge(b, [a]) 的歌单结果一致', () => {
    const a = snapshotOf('dev-a', [playlist({ name: '来自A', updatedAt: 100 })])
    const b = snapshotOf('dev-b', [playlist({ name: '来自B', updatedAt: 200 })])

    expect(body(mergeSnapshots(a, [b]).snapshot)).toBe(body(mergeSnapshots(b, [a]).snapshot))
  })

  it('并列（updatedAt 相同）按歌单内容字典序裁决，且与入参顺序、来源 deviceId 无关', () => {
    // 内容更大的那份放在 deviceId 更小的快照里：只有"看内容"才会恒选 '来自B'
    const a = snapshotOf('dev-a', [playlist({ name: '来自B', updatedAt: 100 })])
    const b = snapshotOf('dev-b', [playlist({ name: '来自A', updatedAt: 100 })])

    expect(mergeSnapshots(a, [b]).snapshot.playlists[0]?.name).toBe('来自B')
    expect(mergeSnapshots(b, [a]).snapshot.playlists[0]?.name).toBe('来自B')
  })

  /**
   * 结合律（三台设备，同一毫秒改同一个歌单）。
   *
   * T6 修复前：并列按**快照头 deviceId** 裁决，而合并输出的快照头只带本机 deviceId，
   * 来源信息在二次合并时丢失 → `(a∘b)∘c` 与 `a∘(b∘c)` 得到不同赢家（本条曾标 `it.fails`）。
   * 现在并列裁决只看歌单内容的规范化串，与来源设备无关，两种结合顺序必须一致。
   */
  it('结合：(a∘b)∘c 与 a∘(b∘c) 结果相同', () => {
    const a = snapshotOf('dev-a', [playlist({ name: '来自A', updatedAt: 100 })])
    const b = snapshotOf('dev-c', [playlist({ name: '来自B', updatedAt: 100 })])
    const c = snapshotOf('dev-b', [playlist({ name: '来自C', updatedAt: 100 })])

    const left = mergeSnapshots(mergeSnapshots(a, [b]).snapshot, [c]).snapshot
    const right = mergeSnapshots(a, [mergeSnapshots(b, [c]).snapshot]).snapshot

    expect(body(left)).toBe(body(right))
  })
})

describe('mergeSnapshots：墓碑 TTL 边界（90 天）', () => {
  const local = () => snapshotOf('dev-a', [playlist({ updatedAt: 1 })])

  it('墓碑 deletedAt 正好等于 90 天：仍算墓碑（TTL 内），会删掉活歌单', () => {
    const deletedAt = NOW - SYNC_TOMBSTONE_TTL_MS
    const remote = snapshotOf('dev-b', [
      playlist({ updatedAt: deletedAt, deletedAt }),
    ])

    const out = mergeSnapshots(local(), [remote], NOW)

    // 合并结果里保留墓碑（它要被继续传播、并由 apply 侧落成删除），但活跃集合为空
    expect(out.snapshot.playlists).toHaveLength(1)
    expect(out.snapshot.playlists[0]?.deletedAt).toBe(deletedAt)
    expect(out.changed).toBe(true)
    expect(out.removed).toBe(1)
  })

  it('墓碑 deletedAt 比 90 天多 1ms：算过期，不再传播删除', () => {
    const deletedAt = NOW - SYNC_TOMBSTONE_TTL_MS - 1
    const remote = snapshotOf('dev-b', [
      playlist({ updatedAt: deletedAt, deletedAt }),
    ])

    const out = mergeSnapshots(local(), [remote], NOW)

    expect(out.snapshot.playlists.map((p) => p.id)).toEqual(['pl-1'])
  })

  it('deletedAt 缺失的歌单不是墓碑，按活歌单参与 LWW', () => {
    const remote = snapshotOf('dev-b', [
      playlist({ name: '改名了', updatedAt: 500 }),
    ])

    const out = mergeSnapshots(local(), [remote], NOW)

    expect(out.snapshot.playlists[0]?.name).toBe('改名了')
  })

  /**
   * `deletedAt: 0` 边界。
   *
   * T6 修复前：`isTombstoneExpired` 用 `playlist.deletedAt || playlist.updatedAt` 取时间基准，
   * 只判 `typeof === 'number'`、不判 `> 0`，于是显式写 `deletedAt: 0`（「没删」的另一种
   * 常见 JSON 写法）会被当成墓碑并回落到 `updatedAt` 起算：一个 90 天没改的**活歌单**
   * 就会被整条丢弃。现在只有**正有限数**才算墓碑，因此该歌单按活歌单参与 LWW。
   */
  it('显式 deletedAt: 0 且 updatedAt 超过 90 天的活歌单不应被丢弃', () => {
    const staleActive = NOW - SYNC_TOMBSTONE_TTL_MS - 60_000
    const remote = snapshotOf('dev-b', [
      playlist({ name: '改名了', updatedAt: staleActive, deletedAt: 0 }),
    ])

    const out = mergeSnapshots(local(), [remote], NOW)

    expect(out.snapshot.playlists[0]?.name).toBe('改名了')
  })

  it('pruneSnapshot 幂等且不抬 updatedAt', () => {
    const snapshot = snapshotOf('dev-a', [
      playlist({ id: 'old', updatedAt: NOW - SYNC_TOMBSTONE_TTL_MS - 1, deletedAt: NOW - SYNC_TOMBSTONE_TTL_MS - 1 }),
    ], { updatedAt: 1234 })

    const once = pruneSnapshot(snapshot, NOW)
    const twice = pruneSnapshot(once, NOW)

    expect(once.playlists).toHaveLength(0)
    expect(twice).toBe(once)
    expect(once.updatedAt).toBe(1234)
  })
})

describe('parseSnapshot：坏快照的拒绝粒度', () => {
  it('缺 format / 旧 format / playlists 非数组：整份拒绝且错误码可区分', () => {
    const good = snapshotOf('dev-b', [playlist()])

    expect(() => parseSnapshot(JSON.stringify({ ...good, format: undefined }))).toThrow()
    expect(() => parseSnapshot(JSON.stringify({ ...good, format: 'aurora-playlist-sync/0' }))).toThrow(
      /snapshotVersion|version/i
    )
    expect(() => parseSnapshot(JSON.stringify({ ...good, playlists: {} }))).toThrow()
  })

  it('单条坏 playlist：整份拒绝（不是跳过该条）', () => {
    const good = snapshotOf('dev-b', [playlist()])
    const text = JSON.stringify({
      ...good,
      playlists: [playlist(), { id: 'broken', name: '坏', createdAt: 1, updatedAt: 0, tracks: [] }],
    })

    expect(() => parseSnapshot(text)).toThrow()
  })

  it('未经过 parseSnapshot 的快照（LAN 路径只过 isSyncSnapshot）会让 merge 抛 TypeError', () => {
    // lanSyncServer.isSyncSnapshot 只校验外层外壳，不校验单条 playlist。
    // 这条用例说明：对端发来 tracks 缺失的歌单时，mergeSnapshots 不是「跳过该条」而是抛错。
    const bad = snapshotOf('dev-b', [
      // 故意缺 tracks
      { id: 'pl-1', name: '坏', createdAt: 1, updatedAt: 500 } as unknown as SyncSnapshot['playlists'][number],
    ])

    expect(() => mergeSnapshots(snapshotOf('dev-a', [playlist({ updatedAt: 1 })]), [bad], NOW)).toThrow(TypeError)
  })
})
