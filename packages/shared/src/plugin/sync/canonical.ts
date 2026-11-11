/**
 * 歌单/曲目引用的**规范化内容串**（纯函数，无副作用，供合并与内容哈希共用）。
 *
 * ## 为什么不用 `JSON.stringify(playlist)`
 *
 * 对象字面量的键顺序取决于构造它的代码路径：解析出来的快照（键顺序 = 文件里的顺序）
 * 与就地合并出来的快照（键顺序 = 构造代码）可能完全不同，直接序列化会把「内容一样」
 * 误判成「变了」。所以这里显式按固定顺序摊平成数组。
 *
 * ## 为什么它同时是合并的全序键
 *
 * 时间戳并列（同毫秒）时需要一条**与来源设备无关**的裁决依据。按内容串字典序取大
 * 满足这一点：它只取决于歌单自身，不取决于「这份记录来自哪台设备」，因此合并是
 * 真正的幂等 + 交换 + 结合运算（来源信息在合并后必然丢失，用它做 tiebreak 会破坏结合律）。
 */

import type { SyncTrackRef, SyncedLike, SyncedPlaylist } from './types'

/**
 * 曲目引用的身份字段。
 *
 * 只取**身份**，不取展示冗余：`kind` 决定用哪个定位字段，`title/artist/album/duration`
 * 是跨设备比对与占位展示都要用的元数据。`coverUrl` 也纳进来——它是 `meta` 档的展示
 * 身份之一，换封面算内容变化。
 */
export function canonicalTrackRef(ref: SyncTrackRef): readonly unknown[] {
  return [
    ref.kind,
    ref.title,
    ref.artist,
    ref.album ?? '',
    ref.duration,
    ref.kind === 'local' ? ref.path : '',
    ref.kind === 'storage' ? ref.pluginId : '',
    ref.kind === 'storage' ? ref.relPath : '',
    ref.kind === 'meta' ? ref.onlineId ?? '' : '',
    ref.kind === 'meta' ? ref.platform ?? '' : '',
    ref.kind === 'meta' ? ref.coverUrl ?? '' : '',
  ]
}

/**
 * 歌单的规范化内容串：字段顺序固定、可选字段用固定占位、曲目引用**保持顺序**。
 *
 * 曲目顺序是这个数据模型的一部分（用户会手动排序），所以不能排序后比较。
 */
export function canonicalPlaylist(playlist: SyncedPlaylist): string {
  return JSON.stringify([
    playlist.id,
    playlist.name,
    playlist.createdAt,
    playlist.updatedAt,
    playlist.deletedAt ?? 0,
    playlist.tracks.map(canonicalTrackRef),
  ])
}

/**
 * 歌名/歌手归一化：与 `trackIdentity.ts` 的私有 `normalizeText` 逐字一致
 * （去首尾空白 + 折叠连续空白 + 小写；**不**做去括号/去标点）。
 */
const normalizeText = (raw: string): string => (raw || '').trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * 「同一首歌」的跨设备身份（收藏记录的合并键）。
 *
 * 与展示去重（`dedupeTracksForDisplay`）**共用字段与归一化、但判据不同**：两者都用
 * 归一化「歌名 + 歌手 + 时长」；展示去重是「歌名+歌手分桶后与桶内代表值比 ±1s 容差聚类」，
 * 这里必须**严格相等**——合并键要是稳定、可逆的等价关系，容差聚类不传递（A≈B、B≈C
 * 推不出 A≈C），容差进不了键。代价见 `docs/playlist-sync.md` §5.1：两个副本时长相差 ≤1s
 * 但取整后落在相邻两秒时，展示去重合成 1 行、这里认为是 2 条记录（都指向这一行）。
 *
 * 时长取**整秒四舍五入**而不是原始浮点：同一份文件在本地是完整解析（213.47s），
 * 在远端媒体库是从文件头估算（213.0s），严格相等会让两台设备永远认不出同一首歌。
 * 不同录音版本（现场/重制）时长一般差 5s 以上，取整不会把它们并成一首。
 *
 * 不含 `kind` / 路径 / `sourceId` / `onlineId`：前三者都是设备相关的；`onlineId` 只在
 * 一侧存在（本机文件 vs 在线曲目），把它并进键会让同一首歌在两端得到不同的 id。
 * 代价是「同名同歌手且时长相同」的两条不同录音会撞成一个键。与展示去重**没有可靠的粗细
 * 关系**：展示行数不会多于同步记录数（两副本 100.4s / 101.3s → 展示 1 行、这里 2 条），
 * 但「哪些并成一组」两者互不包含——容差聚类按**组代表值**比较且不传递，三副本
 * 100.0 / 100.5 / 101.4 时展示并成 {100.0,100.5} + {101.4}，这里并成 {100.0} + {100.5,101.4}。
 * 判据不同，各自只保证自己的键稳定；这不是新引入的失真，是判据选择的必然结果。
 */
export function likeKeyOf(ref: SyncTrackRef): string {
  const seconds = Math.max(0, Math.round(Number(ref.duration) || 0))
  return JSON.stringify([normalizeText(ref.title), normalizeText(ref.artist), seconds])
}

/**
 * 收藏记录的内容串（固定字段顺序；供合并的比较、并列裁决与内容哈希共用）。
 *
 * 含两个时刻：它们一变就说明是「另一次收藏/取消动作」，必须算内容变化——
 * 否则两端各自记录的同一状态会因时刻不同反复被判成「没变」，时间戳永远收敛不了。
 */
export function canonicalLike(like: SyncedLike): string {
  return JSON.stringify([like.id, like.likedAt, like.removedAt ?? 0, canonicalTrackRef(like.ref)])
}
