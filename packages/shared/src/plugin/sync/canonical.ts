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

import type { SyncTrackRef, SyncedPlaylist } from './types'

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
