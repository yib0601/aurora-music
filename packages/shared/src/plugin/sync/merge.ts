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
 */

import { canonicalPlaylist } from './canonical'
import { isTombstoneExpired } from './snapshot'
import { SYNC_SNAPSHOT_FORMAT, type SyncSnapshot, type SyncedPlaylist } from './types'

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

  const changed = added > 0 || updated > 0 || removed > 0
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
    },
    changed,
    added,
    updated,
    removed,
  }
}
