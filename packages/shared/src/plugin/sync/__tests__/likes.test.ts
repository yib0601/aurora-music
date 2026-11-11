/**
 * 收藏（`snapshot.likes`）的合并语义、解析与内容哈希（`docs/playlist-sync.md` §5.1）。
 *
 * 这份测试钉的是「收藏不能整片丢」这件事本身：整条集合 LWW 会让「手机上连点 20 首、
 * 电脑上点了 3 首」以一侧为准、另一侧整片消失。所以下面每一条代数性质都单独立用例——
 * 收藏是高频、跨设备、互相独立的小编辑，合并算法一旦不满足幂等/交换/结合，
 * 用户看到的就是「收藏随机多几首、少几首」。
 */
import { describe, expect, it } from 'vitest'
import { likeKeyOf } from '../canonical'
import { mergeSnapshots } from '../merge'
import {
  SYNC_TOMBSTONE_TTL_MS,
  isLikeTombstoneExpired,
  likeActionAt,
  likeIsActive,
  parseSnapshot,
  pruneSnapshot,
  snapshotContentHash,
} from '../snapshot'
import { SYNC_SNAPSHOT_FORMAT, type SyncSnapshot, type SyncTrackRef, type SyncedLike } from '../types'

const NOW = 1_760_000_000_000
const DAY = 24 * 60 * 60 * 1000

const refOf = (title: string, over: Partial<SyncTrackRef> = {}): SyncTrackRef =>
  ({
    kind: 'local',
    path: `/music/${title}.flac`,
    title,
    artist: '同一位歌手',
    album: '同一张专辑',
    duration: 200,
    ...over,
  }) as SyncTrackRef

/** 一条「收藏」记录：id 一律按引用派生，与 `parseSnapshot` 的净化口径一致 */
const like = (title: string, likedAt: number, over: Partial<SyncedLike> = {}): SyncedLike => {
  const ref = refOf(title)
  return { id: likeKeyOf(ref), likedAt, ref, ...over }
}

/** 一条「取消收藏」的墓碑 */
const unlike = (title: string, at: number, likedAt = 0): SyncedLike => ({
  ...like(title, likedAt),
  removedAt: at,
})

const snapshot = (
  deviceId: string,
  likes: readonly SyncedLike[],
  over: Partial<SyncSnapshot> = {}
): SyncSnapshot => ({
  format: SYNC_SNAPSHOT_FORMAT,
  deviceId,
  deviceName: `${deviceId}-name`,
  revision: 1,
  updatedAt: 5_000,
  playlists: [],
  likes,
  ...over,
})

const idsOf = (outcome: { snapshot: SyncSnapshot }): string[] =>
  (outcome.snapshot.likes ?? []).map((entry) => entry.id).sort()

const activeIdsOf = (outcome: { snapshot: SyncSnapshot }): string[] =>
  (outcome.snapshot.likes ?? []).filter(likeIsActive).map((entry) => entry.id).sort()

describe('likeKeyOf：跨设备的「同一首歌」身份', () => {
  it('与定位方式无关：本机路径 / 存储相对路径 / 在线身份算出同一个键', () => {
    const a = refOf('夜曲')
    const b: SyncTrackRef = { ...refOf('夜曲'), kind: 'storage', pluginId: 'webdav', relPath: 'a/夜曲.flac' } as SyncTrackRef
    const c: SyncTrackRef = { ...refOf('夜曲'), kind: 'meta', onlineId: '003abc', platform: 'qq' } as SyncTrackRef
    expect(likeKeyOf(b)).toBe(likeKeyOf(a))
    expect(likeKeyOf(c)).toBe(likeKeyOf(a))
  })

  it('时长按整秒取整：本地完整解析与远端概算都能认出同一首', () => {
    expect(likeKeyOf(refOf('x', { duration: 213.47 }))).toBe(likeKeyOf(refOf('x', { duration: 213 })))
  })

  it('歌名/歌手只做空白与大小写归一，不同录音版本不会合并', () => {
    expect(likeKeyOf(refOf('NIGHT  song'))).toBe(likeKeyOf(refOf('night song')))
    expect(likeKeyOf(refOf('夜曲', { duration: 200 }))).not.toBe(likeKeyOf(refOf('夜曲 (Live)', { duration: 260 })))
  })
})

describe('mergeSnapshots：收藏逐条裁决', () => {
  it('两端各收藏不同的歌，合并后两首都在（整条集合 LWW 会丢掉一侧）', () => {
    const a = snapshot('dev-a', [like('甲', 100), like('乙', 150)])
    const b = snapshot('dev-b', [like('丙', 120)])

    const outcome = mergeSnapshots(a, [b], NOW)

    expect(activeIdsOf(outcome)).toHaveLength(3)
    expect(outcome.likesAdded).toBe(1)
    expect(outcome.likesRemoved).toBe(0)
    expect(outcome.changed).toBe(true)
  })

  it('同一首：较晚的取消胜过较早的收藏，反之亦然', () => {
    // 时刻必须落在 TTL 内：更早的「取消」会按墓碑过期处理（那是另一条用例的口径）
    const liked = snapshot('dev-a', [like('甲', NOW - 2_000)])
    const removedLater = snapshot('dev-b', [unlike('甲', NOW - 1_000, NOW - 2_000)])
    expect(activeIdsOf(mergeSnapshots(liked, [removedLater], NOW))).toEqual([])

    const reLiked = snapshot('dev-c', [like('甲', NOW - 500, { removedAt: NOW - 1_000 })])
    expect(activeIdsOf(mergeSnapshots(removedLater, [reLiked], NOW))).toHaveLength(1)
  })

  it('同一毫秒的「收藏 vs 取消」判为取消（宁可少显示，也不让已取消的收藏复活）', () => {
    const liked = snapshot('dev-a', [like('甲', NOW - 1_000)])
    const removed = snapshot('dev-b', [unlike('甲', NOW - 1_000, NOW - 1_000)])

    expect(activeIdsOf(mergeSnapshots(liked, [removed], NOW))).toEqual([])
    expect(activeIdsOf(mergeSnapshots(removed, [liked], NOW))).toEqual([])
  })

  it('幂等：同一份远端再合并一次不产生新变化', () => {
    const local = snapshot('dev-a', [like('甲', 100)])
    const remote = snapshot('dev-b', [like('乙', 200)])

    const first = mergeSnapshots(local, [remote], NOW)
    const again = mergeSnapshots(first.snapshot, [remote], NOW + 1)

    expect(idsOf(again)).toEqual(idsOf(first))
    expect(again.likesAdded).toBe(0)
    expect(again.changed).toBe(false)
  })

  it('交换律：两端的收藏集合与胜负一致', () => {
    const a = snapshot('dev-a', [like('甲', NOW - 2_000), unlike('乙', NOW - 500, NOW - 2_000)])
    const b = snapshot('dev-b', [like('乙', NOW - 1_000), like('丙', NOW - 1_500)])

    const ab = mergeSnapshots(a, [b], NOW)
    const ba = mergeSnapshots(b, [a], NOW)

    expect(idsOf(ba)).toEqual(idsOf(ab))
    expect(activeIdsOf(ba)).toEqual(activeIdsOf(ab))
    expect(ba.changed).toBe(true)
  })

  it('结合律在时间戳完全并列时也成立（并列裁决只看内容，不看来源设备）', () => {
    const a = snapshot('dev-a', [like('甲', NOW - 1_000)])
    const b = snapshot('dev-c', [unlike('甲', NOW - 1_000, NOW - 1_000)])
    const c = snapshot('dev-b', [like('甲', NOW - 1_000, { ref: refOf('甲', { album: '另一个专辑' }) })])

    const left = mergeSnapshots(mergeSnapshots(a, [b], NOW).snapshot, [c], NOW).snapshot
    const right = mergeSnapshots(a, [mergeSnapshots(b, [c], NOW).snapshot], NOW).snapshot

    expect(idsOf({ snapshot: left })).toEqual(idsOf({ snapshot: right }))
    expect(left.likes).toEqual(right.likes)
  })

  it('输出按 id 排序：集合的插入顺序不影响序列化字节', () => {
    const one = snapshot('dev-a', [like('丙', 1), like('甲', 2), like('乙', 3)])
    const two = snapshot('dev-a', [like('乙', 3), like('丙', 1), like('甲', 2)])
    expect(mergeSnapshots(one, [], NOW).snapshot.likes).toEqual(mergeSnapshots(two, [], NOW).snapshot.likes)
  })

  it('过期墓碑不参与裁决，也不会把对端仍在收藏的歌删掉', () => {
    const local = snapshot('dev-a', [like('甲', 100, { removedAt: 0 })])
    const stale = snapshot('dev-b', [unlike('甲', NOW - SYNC_TOMBSTONE_TTL_MS - DAY, 100)])

    const outcome = mergeSnapshots(local, [stale], NOW)

    expect(activeIdsOf(outcome)).toHaveLength(1)
    expect(outcome.changed).toBe(false)
  })

  it('TTL 内的墓碑保留在输出里并参与裁决（后续同步还能继续传播这次取消）', () => {
    const local = snapshot('dev-a', [like('甲', 100)])
    const remote = snapshot('dev-b', [unlike('甲', NOW - DAY, 100)])

    const outcome = mergeSnapshots(local, [remote], NOW)

    expect(outcome.snapshot.likes?.[0]?.removedAt).toBe(NOW - DAY)
    expect(outcome.likesRemoved).toBe(1)
    expect(outcome.changed).toBe(true)
  })

  it('changed 只相对 local：采纳更晚的时刻算变化，第二轮收敛', () => {
    const local = snapshot('dev-a', [like('甲', 100)])
    const remote = snapshot('dev-b', [like('甲', 900)])

    const first = mergeSnapshots(local, [remote], NOW)
    expect(first.changed).toBe(true)
    // 只是时刻变了、可见状态没变：不算「多了一首收藏」
    expect(first.likesAdded).toBe(0)

    const second = mergeSnapshots(first.snapshot, [remote], NOW + 1)
    expect(second.changed).toBe(false)
  })

  it('本机没有对端带来的墓碑：内容要落盘（学下来才能压住第三台设备的旧收藏）', () => {
    const local = snapshot('dev-a', [])
    const remote = snapshot('dev-b', [unlike('甲', NOW - DAY, 50)])

    const outcome = mergeSnapshots(local, [remote], NOW)

    expect(outcome.changed).toBe(true)
    expect(outcome.likesRemoved).toBe(0)
    expect(outcome.likesAdded).toBe(0)
  })

  it('缺 likes 字段的旧快照 = 没有意见，不会删掉本机记录', () => {
    const local = snapshot('dev-a', [like('甲', 100)])
    const oldPeer: SyncSnapshot = {
      format: SYNC_SNAPSHOT_FORMAT,
      deviceId: 'dev-old',
      deviceName: '旧版本',
      revision: 2,
      updatedAt: 1,
      playlists: [],
    }

    const outcome = mergeSnapshots(local, [oldPeer], NOW)
    expect(activeIdsOf(outcome)).toHaveLength(1)
    expect(outcome.changed).toBe(false)
  })
})

describe('parseSnapshot / pruneSnapshot：收藏记录的净化与清理', () => {
  const parse = (likes: unknown): SyncSnapshot =>
    parseSnapshot(
      JSON.stringify({ format: SYNC_SNAPSHOT_FORMAT, deviceId: 'd', playlists: [], likes })
    )

  it('缺失 likes 时保持缺失（旧快照的「没有意见」不能被补成 []）', () => {
    expect(parseSnapshot(JSON.stringify({ format: SYNC_SNAPSHOT_FORMAT, deviceId: 'd', playlists: [] })).likes).toBeUndefined()
    expect(parse(undefined).likes).toBeUndefined()
  })

  it('坏条目逐条丢弃：坏引用 / 未来档位 / 非对象，都不该让整份快照失败', () => {
    const parsed = parse([
      { id: 'x', likedAt: 5, ref: refOf('好歌') },
      { id: 'y', likedAt: 5, ref: { kind: 'future', title: 't' } },
      { id: 'z', likedAt: 5, ref: { kind: 'local', title: '空路径', path: '  ' } },
      'junk',
      null,
    ])
    expect(parsed.likes).toHaveLength(1)
    expect(parsed.likes?.[0]?.ref).toMatchObject({ kind: 'local', title: '好歌' })
  })

  it('id 按引用重算：文件里写错的 id 不参与合并键', () => {
    const parsed = parse([{ id: '手改过的 id', likedAt: 5, ref: refOf('甲') }])
    expect(parsed.likes?.[0]?.id).toBe(likeKeyOf(refOf('甲')))
  })

  it('likes 不是数组 → 整份按损坏拒绝（结构不明不能当成「没有收藏」）', () => {
    expect(() => parse({})).toThrow()
  })

  it('pruneSnapshot 只丢过期墓碑；活跃记录与新鲜墓碑都留下', () => {
    const snap = snapshot('dev-a', [
      like('在', 10),
      unlike('刚取消', NOW - DAY, 10),
      unlike('很久前取消', NOW - SYNC_TOMBSTONE_TTL_MS - DAY, 10),
    ])

    const pruned = pruneSnapshot(snap, NOW)
    expect((pruned.likes ?? []).map((entry) => entry.ref.title)).toEqual(['在', '刚取消'])
    // 清理不是"用户改了收藏"，不能刷新快照头
    expect(pruned.revision).toBe(snap.revision)
    expect(pruned.updatedAt).toBe(snap.updatedAt)
  })

  it('没有可清理内容时返回同一引用（上层据此跳过写盘）', () => {
    const snap = snapshot('dev-a', [like('在', 10), unlike('刚取消', NOW - DAY, 10)])
    expect(pruneSnapshot(snap, NOW)).toBe(snap)
  })
})

describe('likeActionAt / likeIsActive：时刻口径', () => {
  it('最近一次动作是收藏还是取消，取两个时刻的较大者', () => {
    expect(likeActionAt(like('甲', 100))).toBe(100)
    expect(likeActionAt(like('甲', 100, { removedAt: 300 }))).toBe(300)
    expect(likeIsActive(like('甲', 100, { removedAt: 300 }))).toBe(false)
    expect(likeIsActive(like('甲', 300, { removedAt: 100 }))).toBe(true)
  })

  it('并列判为未收藏；墓碑过期边界用严格大于', () => {
    expect(likeIsActive(like('甲', 100, { removedAt: 100 }))).toBe(false)
    expect(isLikeTombstoneExpired(like('甲', 10, { removedAt: NOW - SYNC_TOMBSTONE_TTL_MS }), NOW)).toBe(false)
    expect(isLikeTombstoneExpired(like('甲', 10, { removedAt: NOW - SYNC_TOMBSTONE_TTL_MS - 1 }), NOW)).toBe(true)
    // 活跃记录永远不算墓碑，再老也不会被清理
    expect(isLikeTombstoneExpired(like('甲', 1), NOW)).toBe(false)
  })
})

describe('snapshotContentHash：收藏也参与内容哈希', () => {
  const hashOf = (likes: readonly SyncedLike[]) => snapshotContentHash(snapshot('dev-a', likes))

  it('点赞 / 取消 / 动作时刻变化都会改变哈希（否则只改了收藏的那轮不会被推给对端）', () => {
    const base = hashOf([like('甲', 100)])
    expect(hashOf([like('甲', 100), like('乙', 200)])).not.toBe(base)
    expect(hashOf([like('甲', 100, { removedAt: 150 })])).not.toBe(base)
    expect(hashOf([like('甲', 101)])).not.toBe(base)
  })

  it('集合顺序不参与（按内容排序后再哈希）；缺 likes 与空数组同哈希', () => {
    expect(hashOf([like('甲', 1), like('乙', 2)])).toBe(hashOf([like('乙', 2), like('甲', 1)]))
    expect(snapshotContentHash(snapshot('dev-a', []))).toBe(
      snapshotContentHash({ ...snapshot('dev-b', []), likes: undefined })
    )
  })
})
