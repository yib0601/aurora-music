/**
 * 合并语义（`docs/playlist-sync.md` §5）：幂等 / 交换 / 结合 / 墓碑 / 并列 / `changed`。
 *
 * 这份测试是"多设备不会丢歌单"的最后一道闸：合并结果一旦依赖输入顺序，
 * 三台设备就会各自收敛到不同状态，而用户看到的症状是"歌单反复复活、反复消失"，
 * 很难从现象倒推到算法。所以每条代数性质都单独立用例，不做"综合用例顺带覆盖"。
 */
import { describe, expect, it } from 'vitest'
import { mergeSnapshots } from '../merge'
import { SYNC_TOMBSTONE_TTL_MS } from '../snapshot'
import { SYNC_SNAPSHOT_FORMAT, type SyncSnapshot, type SyncTrackRef, type SyncedPlaylist } from '../types'

const NOW = 1_760_000_000_000

function snapshot(
  deviceId: string,
  playlists: readonly SyncedPlaylist[],
  over: Partial<SyncSnapshot> = {}
): SyncSnapshot {
  return {
    format: SYNC_SNAPSHOT_FORMAT,
    deviceId,
    deviceName: `${deviceId}-name`,
    revision: 3,
    updatedAt: 5_000,
    playlists,
    ...over
  }
}

function playlist(
  id: string,
  updatedAt: number,
  over: Partial<SyncedPlaylist> = {}
): SyncedPlaylist {
  return { id, name: `name-${id}`, createdAt: 1_000, updatedAt, tracks: [], ...over }
}

const ref = (title: string): SyncTrackRef => ({
  kind: 'meta',
  title,
  artist: 'artist',
  album: 'album',
  duration: 200,
})

/** 只比较歌单内容（快照头里的 deviceId / revision / updatedAt 是"本机所有"的诊断字段） */
const playlistsOf = (outcome: { snapshot: SyncSnapshot }): readonly SyncedPlaylist[] =>
  outcome.snapshot.playlists

describe('mergeSnapshots', () => {
  it('幂等：重复合并同一份远端不产生新变化', () => {
    const local = snapshot('dev-a', [playlist('p1', 100)])
    const remote = snapshot('dev-b', [playlist('p1', 200, { name: '远端改过' }), playlist('p2', 150)])

    const first = mergeSnapshots(local, [remote], NOW)
    const again = mergeSnapshots(first.snapshot, [remote], NOW + 1)

    expect(playlistsOf(again)).toEqual(playlistsOf(first))
    expect(again.changed).toBe(false)
    expect(again.added).toBe(0)
    expect(again.updated).toBe(0)
    expect(again.removed).toBe(0)
    // 没变化就必须原样保留 local 的计数与时间戳，否则"没变"看起来也像被写过
    expect(again.snapshot.revision).toBe(first.snapshot.revision)
    expect(again.snapshot.updatedAt).toBe(NOW)
  })

  it('交换律：a 与 b 互换后歌单集合与每个歌单的胜负一致', () => {
    const a = snapshot('dev-a', [playlist('p1', 100), playlist('p2', 300)])
    const b = snapshot('dev-b', [playlist('p1', 200), playlist('p3', 50)])

    const ab = mergeSnapshots(a, [b], NOW)
    const ba = mergeSnapshots(b, [a], NOW)

    expect(playlistsOf(ba)).toEqual(playlistsOf(ab))
    // 计数是**相对 local** 的，换边后自然不同（ab 里 p1 是"改了"，ba 里它是"本机原样"）；
    // 能要求交换不变的是"最终歌单集合"与"到底有没有变"
    expect(ba.changed).toBe(ab.changed)
    expect(ab.changed).toBe(true)
  })

  it('交换律：同一毫秒并列时按歌单内容字典序裁决，与输入顺序和来源设备无关', () => {
    // 故意让"内容更大"的那份放在 **deviceId 更小** 的快照里：若 tiebreak 看 deviceId，
    // 这断言会挂；只看内容时赢家恒为 'from-b'（'from-b' > 'from-a'）
    const a = snapshot('dev-a', [playlist('p1', 500, { name: 'from-b' })])
    const b = snapshot('dev-b', [playlist('p1', 500, { name: 'from-a' })])

    expect(mergeSnapshots(a, [b], NOW).snapshot.playlists[0].name).toBe('from-b')
    expect(mergeSnapshots(b, [a], NOW).snapshot.playlists[0].name).toBe('from-b')
  })

  it('结合律在时间戳完全并列时也成立（tiebreak 不含 deviceId）', () => {
    // 三台设备同一毫秒改同一个歌单；若并列裁决看快照头 deviceId，合并一次后来源信息丢失
    // → (a∘b)∘c 与 a∘(b∘c) 会得到不同赢家（§15.2 硬要求曾经的反例）
    const a = snapshot('dev-a', [playlist('p1', 500, { name: 'aaa' })])
    const b = snapshot('dev-c', [playlist('p1', 500, { name: 'zzz' })])
    const c = snapshot('dev-b', [playlist('p1', 500, { name: 'mmm' })])

    const left = mergeSnapshots(mergeSnapshots(a, [b], NOW).snapshot, [c], NOW).snapshot
    const right = mergeSnapshots(a, [mergeSnapshots(b, [c], NOW).snapshot], NOW).snapshot

    expect(playlistsOf({ snapshot: left })).toEqual(playlistsOf({ snapshot: right }))
    expect(left.playlists[0].name).toBe('zzz')
  })

  it('结合律：(a⊕b)⊕c 与 a⊕(b⊕c) 收敛到同一歌单集合', () => {
    const a = snapshot('dev-a', [playlist('p1', 100, { name: 'a' }), playlist('p2', 900)])
    const b = snapshot('dev-b', [playlist('p1', 200, { name: 'b' })])
    const c = snapshot('dev-c', [playlist('p1', 300, { name: 'c' }), playlist('p3', 400)])

    const left = mergeSnapshots(mergeSnapshots(a, [b], NOW).snapshot, [c], NOW)
    const right = mergeSnapshots(a, [mergeSnapshots(b, [c], NOW).snapshot], NOW)

    expect(playlistsOf(left)).toEqual(playlistsOf(right))
  })

  it('三台设备两两同步两轮后状态一致', () => {
    const a0 = snapshot('dev-a', [playlist('p1', 100, { name: 'a' })])
    const b0 = snapshot('dev-b', [playlist('p1', 200, { name: 'b' }), playlist('p2', 150)])
    const c0 = snapshot('dev-c', [playlist('p1', 300, { name: 'c' })])

    // 第一轮：每人拿到另外两份
    let a = mergeSnapshots(a0, [b0, c0], NOW).snapshot
    let b = mergeSnapshots(b0, [a0, c0], NOW).snapshot
    let c = mergeSnapshots(c0, [a0, b0], NOW).snapshot
    // 第二轮：用上一轮结果再次互相同步（现实中就是"下一次同步"）
    a = mergeSnapshots(a, [b, c], NOW + 1).snapshot
    b = mergeSnapshots(b, [a, c], NOW + 1).snapshot
    c = mergeSnapshots(c, [a, b], NOW + 1).snapshot

    expect(b.playlists).toEqual(a.playlists)
    expect(c.playlists).toEqual(a.playlists)
  })

  it('TTL 内的墓碑保留在输出里，并参与裁决（更新更晚的删除胜出）', () => {
    const local = snapshot('dev-a', [playlist('p1', 100)])
    const remote = snapshot('dev-b', [
      playlist('p1', NOW - 1000, { deletedAt: NOW - 1000 })
    ])

    const outcome = mergeSnapshots(local, [remote], NOW)

    expect(outcome.snapshot.playlists).toHaveLength(1)
    expect(outcome.snapshot.playlists[0].deletedAt).toBe(NOW - 1000)
    // p1 在 local 是活跃歌单，合并后变成墓碑 → 对用户可见的集合少了一项
    expect(outcome.removed).toBe(1)
    expect(outcome.added).toBe(0)
    expect(outcome.changed).toBe(true)
  })

  it('超过 TTL 的墓碑被丢弃，且不会把对端仍在用的歌单删掉', () => {
    const local = snapshot('dev-a', [playlist('p1', 100)])
    const remote = snapshot('dev-b', [
      playlist('p1', NOW - SYNC_TOMBSTONE_TTL_MS - 5_000, {
        deletedAt: NOW - SYNC_TOMBSTONE_TTL_MS - 5_000
      })
    ])

    const outcome = mergeSnapshots(local, [remote], NOW)

    expect(outcome.snapshot.playlists.map((p) => p.id)).toEqual(['p1'])
    expect(outcome.snapshot.playlists[0].deletedAt).toBeUndefined()
    expect(outcome.changed).toBe(false)
    expect(outcome.removed).toBe(0)
  })

  it('changed 只相对 local 计算：更旧的远端不改变任何东西', () => {
    const local = snapshot('dev-a', [playlist('p1', 200)])
    const stale = snapshot('dev-b', [playlist('p1', 100)])

    const outcome = mergeSnapshots(local, [stale], NOW)

    expect(outcome.changed).toBe(false)
    expect(outcome.snapshot.updatedAt).toBe(local.updatedAt)
    expect(outcome.snapshot.revision).toBe(local.revision)
    expect(outcome.snapshot.deviceId).toBe('dev-a')
  })

  it('changed 不被"本机从未见过的墓碑"触发', () => {
    const local = snapshot('dev-a', [playlist('p1', 200)])
    // TTL 内、但本机从来没有这个歌单：它进不了用户视野，不该算"变了"
    const remote = snapshot('dev-b', [playlist('ghost', NOW - 1_000, { deletedAt: NOW - 1_000 })])

    const outcome = mergeSnapshots(local, [remote], NOW)

    expect(outcome.changed).toBe(false)
    // 但墓碑本身要留下来参与后续合并（否则同一份删除会在下次又被学一遍）
    expect(outcome.snapshot.playlists.map((p) => p.id).sort()).toEqual(['ghost', 'p1'])
  })

  it('added / updated / removed 是计数而非 id 列表（§15.2）', () => {
    const local = snapshot('dev-a', [playlist('p1', 100), playlist('p2', 100)])
    const remote = snapshot('dev-b', [
      playlist('p1', 200, { tracks: [ref('新歌')] }), // updated
      playlist('p3', 200), // added
      // p2 在远端被删除（更新时间更晚）→ removed
      playlist('p2', NOW - 500, { deletedAt: NOW - 500 })
    ])

    const outcome = mergeSnapshots(local, [remote], NOW)

    expect(outcome.added).toBe(1)
    expect(outcome.updated).toBe(1)
    expect(outcome.removed).toBe(1)
    expect(outcome.changed).toBe(true)
    // 有变化时 revision 自增、updatedAt 用本次时刻
    expect(outcome.snapshot.revision).toBe(local.revision + 1)
    expect(outcome.snapshot.updatedAt).toBe(NOW)
  })

  it('输出顺序稳定：按 createdAt 再 id 排序', () => {
    const local = snapshot('dev-a', [playlist('b', 100, { createdAt: 20 }), playlist('z', 100, { createdAt: 10 })])
    const remote = snapshot('dev-b', [playlist('a', 100, { createdAt: 20 })])

    const ids = mergeSnapshots(local, [remote], NOW).snapshot.playlists.map((p) => p.id)
    expect(ids).toEqual(['z', 'a', 'b'])

    // 输入顺序换一遍，输出顺序不变
    const reordered = snapshot('dev-a', [playlist('z', 100, { createdAt: 10 }), playlist('b', 100, { createdAt: 20 })])
    expect(mergeSnapshots(reordered, [remote], NOW).snapshot.playlists.map((p) => p.id)).toEqual(ids)
  })

  it('坏输入不炸：空 remotes、重复 id、缺 playlists 都按最小可信集处理', () => {
    const local = snapshot('dev-a', [playlist('p1', 100)])
    expect(mergeSnapshots(local, [], NOW).changed).toBe(false)
    expect(mergeSnapshots(local, [], NOW).snapshot.playlists).toHaveLength(1)

    // 同一份快照里出现重复 id（文件被手工改过）：取较新的那条，且不抛
    const dup = snapshot('dev-b', [playlist('p1', 100, { name: '旧' }), playlist('p1', 200, { name: '新' })])
    expect(mergeSnapshots(local, [dup], NOW).snapshot.playlists[0].name).toBe('新')

    // 结构不全的远端快照直接跳过
    const broken = { deviceId: 'dev-x' } as unknown as SyncSnapshot
    expect(() => mergeSnapshots(local, [broken], NOW)).not.toThrow()
  })
})
