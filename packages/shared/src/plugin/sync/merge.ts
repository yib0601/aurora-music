/**
 * 多设备快照合并：以歌单为最小冲突单元的 LWW（`docs/playlist-sync.md` §5）。
 *
 * ## 为什么是 LWW 而不是并集
 *
 * 曲目顺序是这个数据模型的一部分（`trackIds` 有序，用户会手动排序），"曲目并集"
 * 无法回答「两边顺序都变了听谁的」，也无法回答「A 删了、B 又加回来」。代价明确：
 * 两端同时改同一个歌单会丢一侧的改动——这个代价在 UI 上说清楚（`sync.conflict.note`），
 * 而不是靠算法偷偷选一个。
 *
 * ## 判定顺序（逐级、全序，**全部只取决于歌单自身**）
 *
 * 1. `updatedAt` 大者胜（时间戳是删除/编辑发生的时刻）；
 * 2. 同毫秒 → `deletedAt` 大者胜（删除是更晚的意图；`deletedAt` 缺省/0/非有限数按 0 算）；
 * 3. 再同 → 按歌单内容的规范化串（`canonicalPlaylist`，字段顺序固定）字典序取大。
 *
 * 第 2、3 级是**为了得到全序**：没有它们，"同一毫秒"这种并列输入会让结果依赖数组顺序，
 * 幂等与交换律当场失效。
 *
 * ## 为什么 tiebreak 里**不能**用快照的 `deviceId`
 *
 * 曾经的做法是「同毫秒按快照头的 `deviceId` 字典序取大」。它在单次合并里是确定性的，
 * 但合并输出的快照头只带**本机** `deviceId`：一条来自别台设备的记录被合并进来后，
 * 它的「来源设备」就丢了，于是
 *
 * ```text
 * (a ∘ b) ∘ c  ≠  a ∘ (b ∘ c)
 * ```
 *
 * ——这正是 §15.2 要求的结合律反例（多设备/重放场景会真的踩到）。把 tiebreak 换成
 * **纯内容比较**后，胜者只由歌单内容决定，合并即成为「在内容全序上取最大」的
 * 幂等 + 交换 + 结合运算，与合并顺序、与哪台设备写的都无关。
 *
 * ## `changed` 的口径
 *
 * 只按**非墓碑歌单**相对 `local` 比较：新增 / 内容变化 / 消失各算一类。
 * 仅掉落过期墓碑、或学到一个本机从未有过的陈旧墓碑，都不算"变了"——它们不影响用户
 * 看到的歌单，若算作变化会让引擎白写一遍 store、抬高 `updatedAt`，进而诱发下一轮虚假变更
 * （§5「写入策略」）。
 *
 * ## 收藏（`snapshot.likes`）是另一套裁决单元
 *
 * 歌单是**一条有序记录**，整体 LWW；收藏是**集合**，每首歌一条记录、逐条 LWW。
 * 若收藏也按整条集合 LWW，「手机上连点 20 首 + 电脑上点了 3 首」会整片吞掉一侧的收藏。
 * 并列裁决与 `changed` 口径见 `compareLikeCandidates` / `mergeSnapshots` 内的注释。
 */

import { canonicalLike, canonicalPlaylist } from './canonical'
import { isLikeTombstoneExpired, isTombstoneExpired, likeActionAt, likeIsActive } from './snapshot'
import {
  SYNC_SNAPSHOT_FORMAT,
  type SyncSnapshot,
  type SyncedLike,
  type SyncedPlaylist,
} from './types'

/**
 * 合并结果。
 *
 * `added` / `updated` / `removed` 是**计数**（§15.2）：引擎只需要知道"变了几处"来决定
 * 是否写 store、以及给用户一句「已应用 3 个歌单」，不需要 id 列表；返回 id 数组会让
 * 「计数」这种最常见的用法多写一次 `.length`，也会让 IPC 日志变大。
 */
export interface MergeOutcome {
  snapshot: SyncSnapshot
  changed: boolean
  added: number
  updated: number
  removed: number
  /** 本次合并让「已收藏集合」多出来的歌数（只算用户能看见的状态变化，不算时间戳采纳） */
  likesAdded: number
  /** 本次合并让「已收藏集合」少掉的歌数 */
  likesRemoved: number
}

/**
 * 墓碑时刻：只认**正有限数**。
 *
 * `deletedAt` 缺省、`0`、`NaN`、`Infinity` 都等价于「不是墓碑」——这条与
 * `snapshot.ts` 的 `isTombstoneExpired` 必须完全同口径，否则会出现
 * 「合并当成活歌单、清理当成墓碑」的抖动（`deletedAt: 0` 这种「没删」的 JSON 写法
 * 曾被误判成墓碑，导致 90 天没改的活歌单被整条丢弃）。
 */
function tombstoneAtOf(playlist: SyncedPlaylist): number {
  const deletedAt = playlist.deletedAt
  return typeof deletedAt === 'number' && Number.isFinite(deletedAt) && deletedAt > 0 ? deletedAt : 0
}

const isTombstone = (playlist: SyncedPlaylist): boolean => tombstoneAtOf(playlist) > 0

/** 全序比较：返回 `> 0` 表示 `a` 胜出 */
function compareCandidates(a: SyncedPlaylist, b: SyncedPlaylist): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt
  // 墓碑时间只在「同毫秒」时参与：删除是比编辑更晚的意图
  const aDeleted = tombstoneAtOf(a)
  const bDeleted = tombstoneAtOf(b)
  if (aDeleted !== bDeleted) return aDeleted - bDeleted
  const aKey = canonicalPlaylist(a)
  const bKey = canonicalPlaylist(b)
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
}

/** 输出顺序：`createdAt` 再 `id`，与设备无关，保证同一个集合序列化出的字节一致 */
function comparePlaylistOrder(a: SyncedPlaylist, b: SyncedPlaylist): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/* ------------------------------------------------------------------ *
 * 收藏：每条记录一首歌，**逐条** LWW
 *
 * 与歌单的「整条记录 LWW」刻意不同：歌单是一条有序记录，改一个字就该整条替换；
 * 收藏是集合，每次点赞都是独立编辑。若也按整条集合 LWW，「手机上连点 20 首、
 * 电脑上点了 3 首」会以较晚的那次为准，另一端的 20 首整片消失（见 `SyncedLike`）。
 * ------------------------------------------------------------------ */

/** 取消时刻（非墓碑按 0 算） */
function removedRankOf(like: SyncedLike): number {
  const removedAt = Number(like.removedAt)
  return Number.isFinite(removedAt) && removedAt > 0 ? removedAt : 0
}

/** 全序：最近一次动作时刻 → 更晚的是取消 → 内容串。三级都不含设备身份（理由同歌单） */
function compareLikeCandidates(a: SyncedLike, b: SyncedLike): number {
  const aAt = likeActionAt(a)
  const bAt = likeActionAt(b)
  if (aAt !== bAt) return aAt - bAt
  // 同一毫秒的「收藏 vs 取消」：取消胜。宁可少显示一首，也不让已取消的收藏复活
  const aRemoved = removedRankOf(a)
  const bRemoved = removedRankOf(b)
  if (aRemoved !== bRemoved) return aRemoved - bRemoved
  const aKey = canonicalLike(a)
  const bKey = canonicalLike(b)
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
}

/** 按 id 收拢（同一份快照里出现重复 id 时取该快照内较新的那条） */
function likeMapOf(likes: readonly SyncedLike[] | undefined): Map<string, SyncedLike> {
  const map = new Map<string, SyncedLike>()
  for (const like of likes ?? []) {
    if (!like || typeof like.id !== 'string' || !like.id) continue
    const current = map.get(like.id)
    if (!current || compareLikeCandidates(like, current) > 0) map.set(like.id, like)
  }
  return map
}

/**
 * 合并本机快照与若干远端快照。
 *
 * @param local 本机快照（结果的设备身份、`revision` 都取自它）
 * @param remotes 本次拉到的远端快照；调用方应已滤掉自己写的那份（§15.4）
 * @param now 当前时刻（`now?` 只为测试可注入）
 */
export function mergeSnapshots(
  local: SyncSnapshot,
  remotes: readonly SyncSnapshot[],
  now: number = Date.now()
): MergeOutcome {
  const winners = new Map<string, SyncedPlaylist>()

  const consider = (snapshot: SyncSnapshot | null | undefined): void => {
    if (!snapshot || !Array.isArray(snapshot.playlists)) return
    for (const playlist of snapshot.playlists) {
      if (!playlist || typeof playlist.id !== 'string' || !playlist.id) continue
      // 超 TTL 的墓碑不参与裁决：让它参与只会把"很久以前删掉的歌单"重新拉回用户视野
      if (isTombstoneExpired(playlist, now)) continue
      const current = winners.get(playlist.id)
      if (!current || compareCandidates(playlist, current) > 0) winners.set(playlist.id, playlist)
    }
  }

  consider(local)
  for (const remote of remotes) consider(remote)

  // ---- 收藏：每首歌独立裁决（与歌单互不影响） ----
  const likeWinners = new Map<string, SyncedLike>()
  const liveLikesOf = (snapshot: SyncSnapshot | null | undefined): Map<string, SyncedLike> =>
    // 先滤掉过期墓碑**再**按 id 收拢：同一份快照里万一出现同 id 的「活跃收藏 + 过期墓碑」，
    // 先收拢会把活跃那条挑剩或挑掉，顺序反过来才是「过期的不参与任何裁决」
    likeMapOf((snapshot?.likes ?? []).filter((like) => !isLikeTombstoneExpired(like, now)))

  const considerLikes = (snapshot: SyncSnapshot | null | undefined): void => {
    for (const [id, like] of liveLikesOf(snapshot)) {
      const current = likeWinners.get(id)
      if (!current || compareLikeCandidates(like, current) > 0) likeWinners.set(id, like)
    }
  }
  considerLikes(local)
  for (const remote of remotes) considerLikes(remote)

  const likes = [...likeWinners.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const playlists = [...winners.values()].sort(comparePlaylistOrder)

  // ---- 与 local 的活跃集合比较（墓碑不参与：它不改变用户看到的歌单） ----
  const localActive = new Map<string, SyncedPlaylist>()
  for (const playlist of local?.playlists ?? []) {
    if (!playlist || !playlist.id || isTombstone(playlist)) continue
    localActive.set(playlist.id, playlist)
  }

  let added = 0
  let updated = 0
  let removed = 0
  const resultActive = new Set<string>()
  for (const playlist of playlists) {
    if (isTombstone(playlist)) continue
    resultActive.add(playlist.id)
    const before = localActive.get(playlist.id)
    if (!before) {
      added += 1
      continue
    }
    if (canonicalPlaylist(before) !== canonicalPlaylist(playlist)) updated += 1
  }
  for (const id of localActive.keys()) {
    if (!resultActive.has(id)) removed += 1
  }

  // ---- 收藏的变化计数：**可见状态**（收藏/未收藏）变了才算，纯时间戳采纳不算 ----
  const localLikes = liveLikesOf(local)
  let likesChanged = false
  let likesAdded = 0
  let likesRemoved = 0
  for (const like of likes) {
    const before = localLikes.get(like.id)
    if (!before) {
      // 本机没有这条记录（含「本机从未见过的墓碑」）：内容确实变了，要落盘。
      // 与歌单不同，这里**不能**把幽灵墓碑算成"没变"：收藏的墓碑是逐首歌的，
      // 学下来才能压住第三台设备上那份更旧的收藏；代价只是多一轮无可见变化的写盘。
      likesChanged = true
      if (likeIsActive(like)) likesAdded += 1
      continue
    }
    if (canonicalLike(before) !== canonicalLike(like)) likesChanged = true
    const wasActive = likeIsActive(before)
    const active = likeIsActive(like)
    if (wasActive !== active) {
      if (active) likesAdded += 1
      else likesRemoved += 1
    }
  }
  for (const [id, like] of localLikes) {
    if (likeWinners.has(id)) continue
    likesChanged = true
    if (likeIsActive(like)) likesRemoved += 1
  }

  const changed = added > 0 || updated > 0 || removed > 0 || likesChanged
  const localRevision = Math.max(0, Number(local?.revision) || 0)

  return {
    snapshot: {
      format: SYNC_SNAPSHOT_FORMAT,
      deviceId: local?.deviceId ?? '',
      deviceName: local?.deviceName ?? '',
      // 只在真有变化时自增：`changed = false` 必须原样带出 local 的计数与时间戳，
      // 否则"没变化"也会让快照看起来被写过（诊断日志里全是噪声，且破坏幂等性）
      revision: changed ? localRevision + 1 : localRevision,
      updatedAt: changed ? now : Math.max(0, Number(local?.updatedAt) || 0),
      playlists,
      likes,
    },
    changed,
    added,
    updated,
    removed,
    likesAdded,
    likesRemoved,
  }
}
