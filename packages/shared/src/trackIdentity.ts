/**
 * 「同一首歌」的判定与多来源副本择优（纯函数，可单测）。
 *
 * 背景：接入 WebDAV 媒体库后，同一首歌很可能同时存在于本机目录和 NAS 上
 * （甚至是两台 NAS 上），曲库列表会出现重复条目。本模块决定「哪些是同一首歌」
 * 与「留下哪一份」。
 *
 * 判定刻意从严——**歌名 + 歌手 + 时长三者同时相同**才算同一首：
 * - 歌名/歌手只做「去首尾空白 + 折叠连续空白 + 统一小写」，
 *   不做去括号、去标点（normalizeName 那套），否则「某歌 (Live)」「某歌 (Remix)」
 *   这类真实不同版本会被判成同一首，用户会在毫无提示的情况下发现歌少了；
 * - 时长必须有值且相差不超过 1 秒。若任一侧时长为 0（标签解析失败，属于
 *   "不知道时长"），不算作"时长相同"——缺少证据不等于证据相符。
 *
 * 为什么时长用容差而不是严格浮点相等：远端曲目的时长是从文件头 Range 估算的
 * （截断缓冲区下的 CBR 时长需按真实/已读长度等比还原），与本机对同一文件做
 * 完整解析得到的浮点值不会逐位相等，只有小于 1MB 无需截断的文件才恰好一致。
 * 严格相等会让真实曲库里绝大多数（>1MB 的）曲目无法去重，即功能形同失效。
 */

/** 判定为同一首歌的时长容差（秒） */
export const DURATION_MATCH_TOLERANCE = 1

/**
 * 一组被判定为「同一首歌」的副本明细，供 UI 明示「哪首重复了、
 * 留了哪份、藏了哪份」——只给隐藏条数而不给名单，用户无从核对。
 */
export interface DuplicateGroup<T = TrackIdentityFields> {
  /** 展示保留的副本（择优规则见 preferTrackCopy） */
  kept: T
  /** 被隐藏的副本（保持传入顺序） */
  hiddenCopies: T[]
}

/** 判定与择优所需的最小字段集 */
export interface TrackIdentityFields {
  id: string
  title: string
  artist: string
  duration: number
  /** 所属媒体库来源 id（undefined / 空字符串 = 本机文件） */
  sourceId?: string
  /** 入库时间（"第一次扫描到的"就是它最早） */
  addedAt?: number
}

/** 歌名/歌手的归一化：只处理空白与大小写，保留所有语义字符 */
function normalizeText(raw: string): string {
  return (raw || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 是否本机副本（本机文件不依赖网络，且是用户自己的文件） */
export function isLocalCopy(track: TrackIdentityFields): boolean {
  return !track.sourceId
}

/**
 * 两份副本谁更该被展示：
 *   1. 本机副本优先（不论入库早晚）
 *   2. 都是远端时，取入库时间更早的，即"第一次扫描到的"
 *   3. 入库时间相同或都缺失时按 id 排序，保证结果稳定可复现
 */
export function preferTrackCopy<T extends TrackIdentityFields>(a: T, b: T): T {
  const aLocal = isLocalCopy(a)
  const bLocal = isLocalCopy(b)
  if (aLocal !== bLocal) return aLocal ? a : b
  const aAt = a.addedAt ?? Number.MAX_SAFE_INTEGER
  const bAt = b.addedAt ?? Number.MAX_SAFE_INTEGER
  if (aAt !== bAt) return aAt < bAt ? a : b
  return a.id <= b.id ? a : b
}

/**
 * 曲库展示去重：同一首歌只保留一份（择优顺序见 preferTrackCopy）。
 *
 * 只影响"展示"，不删除任何记录：被隐藏的副本仍留在曲库里，歌单、收藏、
 * 播放历史对它的引用全部照常有效；即使本机副本后来被删掉，远端副本也还在。
 *
 * 同时返回隐藏条数与逐组明细（groups：留了哪份、藏了哪份），供 UI 明示
 * "已隐藏 N 首重复曲目"并支持悬停查看具体名单——静默藏歌是不可接受的，
 * 用户必须能看见发生了什么、也才有办法去核对。
 */
export function dedupeTracksForDisplay<T extends TrackIdentityFields>(
  tracks: T[]
): { tracks: T[]; hidden: number; groups: DuplicateGroup<T>[] } {
  if (tracks.length < 2) return { tracks, hidden: 0, groups: [] }

  // 两段式：先按「歌名 + 歌手」分桶，再在桶内按时长归组。
  // 时长是带容差的数值比较，无法直接进字符串键，只能先分桶。
  // 容差不满足传递性（100/101/102 两两相邻都算相同），所以组内统一与
  // 「组代表值」比较而不是与任意成员比较——结果确定、可解释、可复现。
  const buckets = new Map<string, Array<{ duration: number; track: T }>>()
  for (const track of tracks) {
    // \u0000 分隔，避免歌名/歌手里含分隔符时拼接键互相碰撞
    const key = `${normalizeText(track.title)}\u0000${normalizeText(track.artist)}`
    const item = { duration: track.duration || 0, track }
    const list = buckets.get(key)
    if (list) list.push(item)
    else buckets.set(key, [item])
  }

  const hiddenIds = new Set<string>()
  const dupGroups: DuplicateGroup<T>[] = []
  for (const list of buckets.values()) {
    if (list.length < 2) continue
    const durGroups: Array<{ rep: number; members: T[] }> = []
    for (const { duration, track } of list) {
      const group = durGroups.find((g) => Math.abs(g.rep - duration) <= DURATION_MATCH_TOLERANCE)
      if (group) group.members.push(track)
      else durGroups.push({ rep: duration, members: [track] })
    }
    for (const group of durGroups) {
      if (group.members.length < 2) continue
      const winner = group.members.reduce((best, cur) => preferTrackCopy(cur, best))
      const hiddenCopies = group.members.filter((m) => m.id !== winner.id)
      for (const member of hiddenCopies) hiddenIds.add(member.id)
      dupGroups.push({ kept: winner, hiddenCopies })
    }
  }

  if (hiddenIds.size === 0) return { tracks, hidden: 0, groups: [] }
  // 保持原有顺序（数据库顺序 / 用户排序），只是把落选副本摘掉
  return {
    tracks: tracks.filter((t) => !hiddenIds.has(t.id)),
    hidden: hiddenIds.size,
    groups: dupGroups,
  }
}
