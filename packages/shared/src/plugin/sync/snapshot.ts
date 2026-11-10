/**
 * 快照的序列化 / 解析 / 墓碑清理（纯函数，双端共用，可单测）。
 *
 * ## 为什么解析要"偏执"
 *
 * 快照来自**别的设备**、经过远端存储，可能是：被手工改过的文件、旧版本写的结构、
 * 上传中断留下的半截 JSON、甚至同步目录里用户自己放的同名文件。把它当成可信输入
 * 直接灌进 zustand 是数据丢失的最短路径（一次错误覆盖就能清掉用户的歌单）。
 *
 * 所以解析分两道闸：
 * 1. **整份拒绝**（throw）：不是 JSON、`format` 不是本版本 → 这份文件整份跳过
 *    （调用方按 `parseSnapshot` 的抛出处理：日志 + 跳过，不影响其它文件）；
 * 2. **逐条净化**（不 throw）：歌单级别字段缺失/类型不对 → 整份仍算损坏；
 *    曲目引用逐条校验，坏条目**丢弃**——少一条引用只是「这首歌对端没带过来」，
 *    而整份失败会让这台设备的全部歌单都同步不了。
 */

import { auroraError } from '../../i18n/errors'
import { canonicalPlaylist } from './canonical'
import {
  SYNC_SNAPSHOT_FORMAT,
  type SyncSnapshot,
  type SyncTrackRef,
  type SyncedPlaylist,
} from './types'

/**
 * 墓碑保留期：90 天。
 *
 * 为什么不是永久：墓碑是"删除"这个事实的载体，只需活到「所有设备都至少同步过一次」。
 * 用户可能出差一个月才打开另一台机器，90 天给了足够余量；再长的墓碑会让快照膨胀，
 * 也会让「很久以前删掉的歌单」在换了新设备后莫名其妙地阻止用户重建同名歌单。
 *
 * 为什么不是更短：短于「设备离线时长」就可能出现"复活"——离线设备带着旧歌单回来，
 * 墓碑已过期被清理，于是那份歌单被当成新增重新出现。
 */
export const SYNC_TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

const numberOf = (value: unknown): number => {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : 0
}

/** 可选字符串字段：空串按"没有"处理，避免快照里出现一堆 `onlineId: ''` */
function optionalText(value: unknown): string | undefined {
  const text = textOf(value).trim()
  return text ? text : undefined
}

/** 快照文件名（错误信息里要能指出是哪一份文件坏了） */
function fileLabelOf(file: string | undefined): string {
  const label = textOf(file).trim()
  return label || '?'
}

/** 逐条净化一份曲目引用；结构不可用返回 null（调用方丢弃该条，不整份失败） */
function normalizeTrackRef(raw: unknown): SyncTrackRef | null {
  if (!isRecord(raw)) return null
  const meta = {
    title: textOf(raw.title),
    artist: textOf(raw.artist),
    album: textOf(raw.album),
    duration: Math.max(0, numberOf(raw.duration)),
  }
  switch (raw.kind) {
    case 'local': {
      const path = optionalText(raw.path)
      // 空路径的 local 引用没有任何解析价值（§4 第 1 档按路径比对，空串会命中一切空路径）
      return path ? { ...meta, kind: 'local', path } : null
    }
    case 'storage': {
      const pluginId = optionalText(raw.pluginId)
      const relPath = optionalText(raw.relPath)
      if (!pluginId || !relPath) return null
      return { ...meta, kind: 'storage', pluginId, relPath }
    }
    case 'meta': {
      const onlineId = optionalText(raw.onlineId)
      const platform = optionalText(raw.platform)
      const coverUrl = optionalText(raw.coverUrl)
      return {
        ...meta,
        kind: 'meta',
        ...(onlineId ? { onlineId } : {}),
        ...(platform ? { platform } : {}),
        ...(coverUrl ? { coverUrl } : {}),
      }
    }
    default:
      // 未来版本可能加新档位；老客户端读到未知 kind 时丢这一条，而不是丢整份快照
      return null
  }
}

/** 净化一份歌单；缺 id / updatedAt 视为**文件损坏**（throw，由 parseSnapshot 整份拒绝） */
function normalizePlaylist(raw: unknown, file: string | undefined): SyncedPlaylist {
  if (!isRecord(raw)) {
    throw auroraError('sync.error.snapshotInvalid', { file: fileLabelOf(file) })
  }
  const id = textOf(raw.id).trim()
  const updatedAt = numberOf(raw.updatedAt)
  if (!id || !Number.isFinite(Number(raw.updatedAt)) || updatedAt <= 0) {
    // 没有 id / updatedAt 的歌单无法参与 LWW 裁决；放它进去会让合并结果不可重现
    throw auroraError('sync.error.snapshotInvalid', { file: fileLabelOf(file) })
  }
  const createdAt = numberOf(raw.createdAt) || updatedAt
  const deletedAt = numberOf(raw.deletedAt)
  const rawTracks: unknown = raw.tracks
  if (rawTracks !== undefined && !Array.isArray(rawTracks)) {
    throw auroraError('sync.error.snapshotInvalid', { file: fileLabelOf(file) })
  }
  const tracks = (Array.isArray(rawTracks) ? rawTracks : [])
    .map(normalizeTrackRef)
    .filter((ref): ref is SyncTrackRef => ref !== null)
  return {
    id,
    name: textOf(raw.name),
    createdAt,
    updatedAt,
    ...(deletedAt > 0 ? { deletedAt } : {}),
    tracks,
  }
}

/**
 * 序列化快照（写向远端 / 落本地备份用）。
 *
 * 只做 JSON.stringify，**不**做任何裁剪：插件的 push 必须原样写引擎算出来的那份快照
 * （裁剪/合并只允许发生在引擎里，两处各算一遍必然不一致）。墓碑由引擎在合并时按 TTL 清理。
 */
export function serializeSnapshot(snapshot: SyncSnapshot): string {
  return JSON.stringify(snapshot)
}

/**
 * 解析快照。
 *
 * 两类整份失败，都抛结构化错误（调用方日志 + 跳过该文件即可）：
 * - 不是 JSON / 结构不可用 → `sync.error.snapshotInvalid`
 * - `format` 不是本版本 → `sync.error.snapshotVersion`（**优先于**结构校验：
 *   版本不支持时连字段名都可能不同，继续校验只会报出误导性的"格式不正确"）
 *
 * @param text 文件原文
 * @param file 文件名（只用于错误信息，可为相对路径）
 */
export function parseSnapshot(text: string, file?: string): SyncSnapshot {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw auroraError('sync.error.snapshotInvalid', { file: fileLabelOf(file) })
  }
  if (!isRecord(raw)) {
    throw auroraError('sync.error.snapshotInvalid', { file: fileLabelOf(file) })
  }
  const format = textOf(raw.format)
  if (format !== SYNC_SNAPSHOT_FORMAT) {
    // 只带 {format}：这条文案的定义里没有 {file}（多传无用参数会让字典与调用点各说一套）
    throw auroraError('sync.error.snapshotVersion', { format: format || '?' })
  }
  const deviceId = textOf(raw.deviceId).trim()
  if (!deviceId || !Array.isArray(raw.playlists)) {
    throw auroraError('sync.error.snapshotInvalid', { file: fileLabelOf(file) })
  }
  return {
    format: SYNC_SNAPSHOT_FORMAT,
    deviceId,
    deviceName: textOf(raw.deviceName),
    revision: Math.max(0, numberOf(raw.revision)),
    updatedAt: Math.max(0, numberOf(raw.updatedAt)),
    playlists: raw.playlists.map((playlist) => normalizePlaylist(playlist, file)),
  }
}

/** 这份快照是不是某台设备写的（`deviceId` 为空视为"不是"，空串不该匹配任何设备） */
export function isSnapshotOfDevice(snapshot: SyncSnapshot, deviceId: string): boolean {
  const mine = textOf(deviceId).trim()
  const theirs = textOf(snapshot?.deviceId).trim()
  return Boolean(mine) && mine === theirs
}

/**
 * 墓碑是否已过保留期（`deletedAt` 是**正有限数**即墓碑；计时从删除时刻起算）。
 *
 * 供 `pruneSnapshot` 与合并共用：两处判定必须是同一口径，否则会出现
 * 「合并认为该留、清理认为该删」的抖动（`merge.ts` 的 `tombstoneAtOf`）。
 *
 * `deletedAt` 为 `0` / `undefined` / `NaN` / `Infinity` 时**不是墓碑**，因此也谈不上过期：
 * `0` 是「没删」的另一种常见 JSON 写法（第三方/旧版写出的快照），若把它当墓碑并回落到
 * `updatedAt` 起算，一个 90 天没改过的**活歌单**就会被整条丢弃。
 */
export function isTombstoneExpired(playlist: SyncedPlaylist, now: number = Date.now()): boolean {
  const deletedAt = playlist.deletedAt
  if (typeof deletedAt !== 'number' || !Number.isFinite(deletedAt) || deletedAt <= 0) return false
  return now - deletedAt > SYNC_TOMBSTONE_TTL_MS
}

/**
 * FNV-1a 64 位 → base36（16 字符以内）。
 *
 * 为什么手写而不引 `node:crypto`：这段代码要在渲染层（无 Node 模块）、移动端 WebView
 * 与主进程同一份实现里跑，`node:crypto` 会把 shared 包变成「只能在 Node 里 import」。
 * FNV-1a 不是密码学哈希，但这里只用它回答「这份内容和上次推的那份一样吗」——
 * 碰撞的代价是少推一次（下一轮内容变了自然会重新推），不涉及安全判定。
 *
 * 用 64 位而不是仓库里占位 id 用的 32 位：快照内容上千字节，32 位在长期多设备使用下
 * 「恰好撞上」的概率不再可忽略，而撞上意味着漏一次同步。
 */
function fnv1a64(input: string): string {
  const OFFSET = 0xcbf29ce484222325n
  const PRIME = 0x100000001b3n
  const MASK = 0xffffffffffffffffn
  let hash = OFFSET
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i))
    hash = (hash * PRIME) & MASK
  }
  return hash.toString(36).padStart(13, '0')
}

/**
 * 快照**内容**哈希：跨设备可比值（`deviceId` 不同的两台机器，只要歌单内容一样，哈希就一样）。
 *
 * ## 为什么要有它
 *
 * 引擎需要回答「这份内容我上次是不是已经推过了」。没有这个判断，局域网双向同步会形成
 * **互推环**：A 收到 B 的快照 → 合并（即使 `changed=false`）→ 推回 B → B 收到 → 又推回 A …
 * 两侧都是合法快照、`revision` 各不相同，光靠快照头判不出「其实什么都没变」。
 *
 * ## 排除了什么
 *
 * - 快照头 `deviceId` / `deviceName` / `revision` / `updatedAt`：前两个是本机身份，
 *   后两个每次采集/合并都会变，纳入就永远"不一样"；
 * - 歌单的**顺序**不参与：歌单集合按 `id` 排序后再哈希，两台机器只是插入顺序不同时
 *   不该被判定为内容不同（曲目**内部**顺序参与——它是用户手动排的）。
 *
 * 纳入的是每个歌单的 `id` / `name` / `createdAt` / `updatedAt` / `deletedAt` 与曲目引用的
 * 全部身份字段：改名、加曲、删曲、重排、删除（墓碑时间变化）都会改变哈希。
 */
export function snapshotContentHash(snapshot: SyncSnapshot): string {
  const playlists = (snapshot?.playlists ?? [])
    .filter((playlist): playlist is SyncedPlaylist => Boolean(playlist) && typeof playlist.id === 'string' && Boolean(playlist.id))
    .map((playlist) => ({ id: playlist.id, key: canonicalPlaylist(playlist) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.key)
  return fnv1a64(JSON.stringify(playlists))
}

/**
 * 清掉过期的墓碑，其余原样保留（顺序不变）。
 *
 * 不刷新 `updatedAt`：清理墓碑不是"用户改了歌单"，若借此抬高时间戳，会在下一轮合并里
 * 把这份快照变成 LWW 的赢家——凭空覆盖对端更新的内容。
 */
export function pruneSnapshot(snapshot: SyncSnapshot, now: number = Date.now()): SyncSnapshot {
  const playlists = snapshot.playlists.filter((playlist) => !isTombstoneExpired(playlist, now))
  if (playlists.length === snapshot.playlists.length) return snapshot
  return { ...snapshot, playlists }
}
