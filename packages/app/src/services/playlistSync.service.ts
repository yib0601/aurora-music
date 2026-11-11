/**
 * 歌单同步引擎（docs/playlist-sync.md §15.4）。
 *
 * 这一层只做「编排」，不做协议、不做合并算法：
 * - 协议（WebDAV / 局域网）在 `@aurora/shared` 的同步插件里，通过注册表取；
 * - 合并（LWW + 墓碑 + TTL）在 `mergeSnapshots`；
 * - 曲目引用解析在 `resolveSyncTrackRef`。
 *
 * 引擎自己负责的四件事，正好是「必须知道本机状态」的那部分：
 * 1. 采集快照（`snapshotFromStores`，含收藏记录）与落盘合并结果
 *    （`applySyncedPlaylists` + `applySyncedLikes`）；
 * 2. 调度（启动 / 变更防抖 / 定时 / 局域网收件箱 / 手动）与失败退避；
 * 3. 口令的生命周期（**只在一次调用内持有**，绝不进 store / persist / 日志 / lastError）；
 * 4. 同 config 互斥（不同 config 可并行）。
 *
 * 平台判据只有一条：`platform.supportsPlaylistSync`（§8）。非桌面端整条链路不启动。
 */
import {
  LAN_SYNC_PLUGIN_ID,
  SYNC_SNAPSHOT_FORMAT,
  SYNC_TOMBSTONE_TTL_MS,
  auroraError,
  buildMatchIndex,
  encodeErrorInfo,
  getLanSyncBridge,
  getSyncPlugin,
  isLikeTombstoneExpired,
  isSnapshotOfDevice,
  librarySourcePluginId,
  likeIsActive,
  likeKeyOf,
  mergeSnapshots,
  pruneSnapshot,
  resolveSyncTrackRef,
  setLanSyncBridge,
  setWebdavFetch,
  snapshotContentHash,
  toErrorInfo,
} from '@aurora/shared'
import type {
  LanPairFailureReason,
  LanPairPeer,
  LanPeerInfo,
  LanSyncStatus,
  SyncConfig,
  SyncContext,
  SyncMatchIndex,
  SyncMatchTrack,
  SyncProbeResult,
  SyncPlugin,
  SyncSecrets,
  SyncSnapshot,
  SyncedLike,
  SyncedPlaylist,
  SyncTrackRef,
} from '@aurora/shared'
import type { Playlist, Track } from '@/types'
import { platform } from './platform'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { takePendingSecretMigrations, useSyncStore } from '@/stores/syncStore'
import { toSyncMatchTrack, toSyncRefOf } from '@/lib/syncTrack'
import { generateId } from '@/lib/utils'

/** 启动后首次自动同步的延迟（§15.4 覆盖 §9 的旧值 10s） */
const STARTUP_SYNC_DELAY_MS = 3_000
/** 歌单变更后的防抖窗口 */
const CHANGE_DEBOUNCE_MS = 2_000
/**
 * 同一配置被「收件箱到达」触发自动同步的最小间隔。
 *
 * 对端一次 push 可能连发多份快照（甚至同一份重复发）；没有冷却的话每份都跑一轮
 * 完整同步，网络与磁盘都被自己打满。5s 足够覆盖一次往返，又不会让实时性变差。
 */
const INBOX_SYNC_COOLDOWN_MS = 5_000
/** 定时同步周期 */
const PERIODIC_SYNC_MS = 5 * 60_000
/** 失败退避阶梯：30s → 2min → 10min（到顶后固定 10min） */
const BACKOFF_STEPS_MS = [30_000, 120_000, 600_000] as const

/** 占位曲目 id 前缀：`sync:` + 稳定 hash（同一引用在任何设备上派生出同一个 id） */
export const SYNC_PLACEHOLDER_PREFIX = 'sync:'

/** 一次同步的结果（**不抛错**：失败信息写进 syncStore，调用方按 ok 分支） */
export interface SyncOutcome {
  readonly configId: string
  readonly ok: boolean
  readonly changed: boolean
  readonly added: number
  readonly updated: number
  readonly removed: number
  /** 合并结果里的曲目总数（含占位） */
  readonly trackCount: number
  readonly at: number
}

/** `applySyncedPlaylists` 的落盘摘要 */
export interface ApplyOutcome {
  readonly added: number
  readonly updated: number
  readonly removed: number
  /** 本次新登记的占位曲目数（已在本地的不重复登记，避免覆盖播放统计） */
  readonly placeholders: number
}

/** `applySyncedLikes` 的落盘摘要 */
export interface LikeApplyOutcome {
  /** 本次被**设为已收藏**的曲目数 */
  readonly liked: number
  /** 本次被**取消收藏**的曲目数 */
  readonly unliked: number
  /** 落盘后的收藏记录条数（含墓碑；仅供日志与诊断） */
  readonly records: number
}

interface SyncDevice {
  deviceId: string
  deviceName: string
}

/* ------------------------------------------------------------------ *
 * 设备身份
 * ------------------------------------------------------------------ */

let deviceCache: SyncDevice | null = null

/**
 * 取本机设备身份（主进程持久化，进程内缓存）。
 *
 * 没有身份就没有快照归属：合并时的并列裁决、以及「别把本机自己的快照当对端」
 * 都要靠它。所以拿不到就**当失败**，而不是生成一个随机 id 蒙过去。
 */
export async function ensureDevice(): Promise<SyncDevice> {
  if (deviceCache) return deviceCache
  const gateway = platform.sync
  if (!gateway) throw auroraError('sync.error.unknown', { reason: 'device' })
  const identity = await gateway.device()
  if (!identity?.deviceId) throw auroraError('sync.error.unknown', { reason: 'device' })
  deviceCache = { deviceId: identity.deviceId, deviceName: identity.deviceName || 'Aurora Music' }
  useSyncStore.getState().setDevice(deviceCache)
  return deviceCache
}

/* ------------------------------------------------------------------ *
 * 快照采集
 * ------------------------------------------------------------------ */

let revisionCounter = 0

/** 来源 id → 存储插件 id（跨设备认「同一份文件」要靠它，见 §4 第 3 档） */
function storagePluginIdOf(): (sourceId: string) => string | undefined {
  const sources = useLibraryStore.getState().librarySources
  return (sourceId: string) => {
    const source = sources.find((s) => s.id === sourceId)
    // 查不到来源就不能冒充默认插件：那会让「别的 webdav 库里的同名文件」被误认
    return source ? librarySourcePluginId(source) : undefined
  }
}

/** 本机全部曲目（曲库 + 歌单导入的在线/占位曲目），id 去重 */
function allLocalTracks(): Map<string, Track> {
  const map = new Map<string, Track>()
  for (const t of useLibraryStore.getState().tracks) map.set(t.id, t)
  for (const t of Object.values(usePlaylistStore.getState().importedTracks)) map.set(t.id, t)
  return map
}

/**
 * 在线身份认领表：`` `${platform}:${onlineId}` `` 与裸 `onlineId` 两种键都填。
 *
 * 带 platform 的键更准确（同一串 id 在不同平台可能撞车），裸键是给「对端没写
 * platform」的旧快照兜底；同一裸键只认第一个来源，不覆盖。
 */
function onlineClaimMap(tracks: Iterable<SyncMatchTrack>): ReadonlyMap<string, string> {
  const map = new Map<string, string>()
  for (const t of tracks) {
    if (!t.onlineId) continue
    const platform = t.platform || ''
    if (platform) map.set(`${platform}:${t.onlineId}`, t.id)
    if (!map.has(t.onlineId)) map.set(t.onlineId, t.id)
  }
  return map
}

/** 建一次匹配索引（一次同步只建一次：解析几千条引用不该每条都扫全库） */
function buildLocalMatchIndex(): SyncMatchIndex {
  const tracks = [...allLocalTracks().values()].map(toSyncMatchTrack)
  return buildMatchIndex(tracks, {
    online: onlineClaimMap(tracks),
    storagePluginIdOf: storagePluginIdOf(),
  })
}

/**
 * 采集本机的收藏记录（`docs/playlist-sync.md` §5.1）。
 *
 * 三路来料，缺一条就会出真问题：
 * 1. **当前收藏着的本机曲目**：一条记录一首歌。引用优先沿用记录里那份——合并已经裁决过
 *    它，每轮都按本机副本重新生成会让两台机器对同一首歌给出不同引用，内容哈希随之每轮
 *    都"变了"，同步永远收敛不了；只有本机从来没有记录（历史数据 / 首次同步）才现算一份。
 * 2. **取消收藏的墓碑（TTL 内）**：不带上它们，对端那份更旧的「已收藏」下一轮就会复活。
 * 3. **曲目已不在本机的已收藏记录**：照样带出去。删掉本地文件不等于不喜欢这首歌；
 *    而且本机是真删了，对端那台还有这份文件，收藏应该在那边继续有效。
 *
 * 第 3 路要排除「本机其实还有同一首歌，只是换了副本/改了名」的情况（`liveKeys`）：
 * 那种情况由第 1 路按身份重新表达，再带上旧引用只会让对端多出一条指向旧元数据的收藏。
 */
function collectSnapshotLikes(now: number): SyncedLike[] {
  const library = useLibraryStore.getState()
  const records = library.likeRecords ?? {}
  const likedIds = library.likedTracks ?? new Set<string>()
  const tracks = allLocalTracks()
  const pluginIdOf = storagePluginIdOf()

  const byKey = new Map<string, SyncedLike>()
  const liveKeys = new Set<string>()

  for (const track of tracks.values()) {
    const ref = toSyncRefOf(track, pluginIdOf)
    const key = likeKeyOf(ref)
    liveKeys.add(key)
    if (!likedIds.has(track.id)) continue
    const record = records[key]
    byKey.set(key, {
      id: key,
      // 没有记录 = 这次收藏发生在「收藏参与同步」之前，时刻无从得知，按 0 算：
      // 它会被对端任何一个更晚的取消压下去，而不会反过来抹掉对端的改动
      likedAt: record ? record.likedAt : 0,
      ...(record?.removedAt ? { removedAt: record.removedAt } : {}),
      ref: record ? record.ref : ref,
    })
  }

  for (const record of Object.values(records)) {
    if (!record) continue
    if (likeIsActive(record)) continue
    if (isLikeTombstoneExpired(record, now)) continue
    if (byKey.has(record.id)) continue
    byKey.set(record.id, record)
  }

  for (const record of Object.values(records)) {
    if (!record) continue
    if (!likeIsActive(record)) continue
    if (byKey.has(record.id) || liveKeys.has(record.id)) continue
    byKey.set(record.id, record)
  }

  return [...byKey.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * 从 store 采集本机快照。
 *
 * 墓碑也进快照（否则「我删过」这件事传不出去），过期的交给 `pruneSnapshot` 清掉。
 * 歌单里指向已不存在曲目的 trackId **直接丢弃**：那个 id 在本机已经无法描述成引用，
 * 硬塞一条空元数据会让对端凭空多出一首无名曲目。
 */
export function snapshotFromStores(device: SyncDevice): SyncSnapshot {
  const playlistState = usePlaylistStore.getState()
  const tracks = allLocalTracks()
  const pluginIdOf = storagePluginIdOf()
  const now = Date.now()

  const playlists: SyncedPlaylist[] = []
  for (const playlist of playlistState.playlists) {
    const refs: SyncTrackRef[] = []
    for (const trackId of playlist.trackIds) {
      const track = tracks.get(trackId)
      if (!track) continue
      refs.push(toSyncRefOf(track, pluginIdOf))
    }
    playlists.push({
      id: playlist.id,
      name: playlist.name,
      createdAt: playlist.createdAt,
      updatedAt: playlist.updatedAt,
      tracks: refs,
    })
  }

  const existing = new Set(playlists.map((p) => p.id))
  for (const [id, deletedAt] of Object.entries(playlistState.syncTombstones ?? {})) {
    if (now - deletedAt > SYNC_TOMBSTONE_TTL_MS) continue
    // 同 id 的歌单还在（删完又新建/被复活）：以还在的那份为准，不重复写墓碑
    if (existing.has(id)) continue
    playlists.push({
      id,
      name: '',
      createdAt: deletedAt,
      updatedAt: deletedAt,
      deletedAt,
      tracks: [],
    })
  }

  revisionCounter += 1
  return pruneSnapshot(
    {
      format: SYNC_SNAPSHOT_FORMAT,
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      revision: revisionCounter,
      updatedAt: now,
      playlists,
      likes: collectSnapshotLikes(now),
    },
    now
  )
}

/* ------------------------------------------------------------------ *
 * 合并结果落盘
 * ------------------------------------------------------------------ */

/** 引用的稳定文本（用于派生占位曲目 id；跨设备必须一致，故不掺本机信息） */
function refIdentity(ref: SyncTrackRef): string {
  const meta = `${ref.title}\u0000${ref.artist}\u0000${ref.album ?? ''}\u0000${ref.duration}`
  if (ref.kind === 'local') return `l\u0000${ref.path}\u0000${meta}`
  if (ref.kind === 'storage') return `s\u0000${ref.pluginId}\u0000${ref.relPath}\u0000${meta}`
  return `m\u0000${ref.platform ?? ''}\u0000${ref.onlineId ?? ''}\u0000${meta}`
}

/** 一段 FNV-1a（32 位），`basis`/`prime` 不同即得到互不相关的两段 */
function fnv1a32(input: string, basis: number, prime: number): number {
  let hash = basis >>> 0
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, prime) >>> 0
  }
  return hash >>> 0
}

/**
 * 64 位稳定 hash（两段 FNV-1a 拼接）→ base36。
 *
 * 只用于生成本地占位曲目 id，**不做安全用途**（可碰撞、可预测都无所谓）；
 * 之所以要 64 位：32 位只有 40 亿个值，曲库上万首歌时生日碰撞已不可忽略，
 * 两首不同的歌撞成同一个 `sync:` id 会在列表里显示成同一首。
 */
function stableHash(input: string): string {
  const high = fnv1a32(input, 0x811c9dc5, 0x01000193)
  // 第二段用另一组 basis/prime，避免与第一段线性相关（同一个输入不会两段都相同）
  const low = fnv1a32(`\u0001${input}`, 0x7f4a7c15, 0x85ebca6b)
  return `${high.toString(36).padStart(7, '0')}${low.toString(36).padStart(7, '0')}`
}

/** 快照引用 → 占位曲目 id（稳定：同一引用永远同一个 id，反复同步不会堆孤儿） */
export function syncPlaceholderId(ref: SyncTrackRef): string {
  return `${SYNC_PLACEHOLDER_PREFIX}${stableHash(refIdentity(ref))}`
}

/**
 * 未解析出的引用 → 占位曲目。
 *
 * `path: ''`、`onlineUrl` 留空：播放时由 `ensurePlayableTrack` 按需取址（§4 第 5 档）。
 * 元数据必须带全，否则列表上就是一条「未知曲目」，用户无从判断是哪首歌。
 */
function placeholderTrack(ref: SyncTrackRef): Track {
  const track: Track = {
    id: syncPlaceholderId(ref),
    path: '',
    title: ref.title,
    artist: ref.artist,
    album: ref.album,
    duration: ref.duration,
    addedAt: Date.now(),
    playCount: 0,
    liked: false,
  }
  if (ref.kind === 'meta') {
    if (ref.coverUrl) track.coverUrl = ref.coverUrl
    if (ref.onlineId) track.onlineId = ref.onlineId
    if (ref.platform) track.onlineSource = ref.platform
  }
  return track
}

/** 两个歌单是否等价（名称 + 顺序 + 成员；时间戳不参与「要不要写」的判断） */
function samePlaylist(a: Playlist | undefined, b: Playlist): boolean {
  if (!a) return false
  if (a.name !== b.name) return false
  if (a.trackIds.length !== b.trackIds.length) return false
  for (let i = 0; i < a.trackIds.length; i += 1) {
    if (a.trackIds[i] !== b.trackIds[i]) return false
  }
  return true
}

/**
 * 把合并后的快照写回本地（§15.4）。
 *
 * 边界（这三条是数据安全的核心，改动前先读 §6）：
 * - **只**增改删 `playlists`，不碰曲库曲目；
 * - 成员一律换成**本机 trackId**，解析不出的登记占位曲目；
 * - 绝不改 `playCount` / `liked` / `lastPlayedAt`：占位曲目只补新 id，
 *   已存在的一律不覆盖（覆盖会把用户在别的设备上的播放统计冲成 0/false）。
 */
export function applySyncedPlaylists(snapshot: SyncSnapshot): ApplyOutcome {
  const store = usePlaylistStore.getState()
  const index = buildLocalMatchIndex()
  const now = Date.now()

  const upserts: Playlist[] = []
  const placeholders: Track[] = []
  const tombstones: Record<string, number> = {}

  for (const synced of snapshot.playlists) {
    if (synced.deletedAt) {
      // 过期墓碑不再传播：留着它只会让这首歌单在 90 天后依旧无法被重建
      if (now - synced.deletedAt <= SYNC_TOMBSTONE_TTL_MS) tombstones[synced.id] = synced.deletedAt
      continue
    }
    const trackIds: string[] = []
    for (const ref of synced.tracks) {
      const hit = resolveSyncTrackRef(ref, index)
      if (hit) {
        trackIds.push(hit)
        continue
      }
      const placeholder = placeholderTrack(ref)
      trackIds.push(placeholder.id)
      placeholders.push(placeholder)
    }
    upserts.push({
      id: synced.id,
      name: synced.name,
      createdAt: synced.createdAt,
      updatedAt: synced.updatedAt,
      trackIds,
    })
  }

  const current = new Map(store.playlists.map((p) => [p.id, p]))
  const deletes = Object.keys(tombstones).filter((id) => current.has(id))

  /**
   * 分成两类写：
   * - **内容变了**（名称 / 成员 / 顺序）：整条按快照落盘；
   * - **只有时间戳变了**（内容一致、快照的 `updatedAt`/`createdAt` 更新）：只采纳时间戳。
   *
   * 第二类是收敛性的关键（验证报告 S-1）：`mergeSnapshots` 的 `changed` 用含 `updatedAt`
   * 的 canonical 比较，如果本机不采纳对端的时间戳，两端时间戳不同这一**常态**会让每轮
   * 同步都判 `changed=true` —— 于是每轮都写对端、每轮都改 store，永远收敛不了。
   * 采纳之后第二轮 canonical 相同 → `changed=false`。
   */
  const changedUpserts: Playlist[] = []
  const restampedUpserts: Playlist[] = []
  for (const upsert of upserts) {
    const existing = current.get(upsert.id)
    if (!samePlaylist(existing, upsert)) {
      changedUpserts.push(upsert)
      continue
    }
    if (existing && (existing.updatedAt !== upsert.updatedAt || existing.createdAt !== upsert.createdAt)) {
      restampedUpserts.push(upsert)
    }
  }

  // 占位曲目：已有的不覆盖（见函数头注释第三条）
  const freshPlaceholders: Track[] = []
  const seenPlaceholder = new Set<string>()
  for (const placeholder of placeholders) {
    if (store.importedTracks[placeholder.id]) continue
    if (seenPlaceholder.has(placeholder.id)) continue
    seenPlaceholder.add(placeholder.id)
    freshPlaceholders.push(placeholder)
  }
  if (freshPlaceholders.length > 0) store.addImportedTracks(freshPlaceholders)

  const resurrected = changedUpserts
    .filter((p) => store.syncTombstones[p.id] !== undefined && p.updatedAt > store.syncTombstones[p.id])
    .map((p) => p.id)

  if (
    changedUpserts.length > 0 ||
    restampedUpserts.length > 0 ||
    deletes.length > 0 ||
    Object.keys(tombstones).length > 0
  ) {
    store.applySyncChanges({
      upserts: [...changedUpserts, ...restampedUpserts],
      deletes,
      tombstones,
      resurrected,
    })
  }

  let added = 0
  let updated = 0
  for (const playlist of changedUpserts) {
    if (current.has(playlist.id)) updated += 1
    else added += 1
  }
  return { added, updated, removed: deletes.length, placeholders: freshPlaceholders.length }
}

/**
 * 把合并后的收藏记录写回本地（§5.1）。
 *
 * 与 `applySyncedPlaylists` 的分工：那个只碰歌单，这个只碰收藏，**互不回退**——
 * 一次同步里两者都可能是「变了」，混在一个函数里会让「只改了收藏」的那轮
 * 多写一遍歌单 store（进而触发它自己的变更订阅，白跑一轮同步）。
 *
 * 三条边界：
 * - 记录**整体采用**合并结果（不是增量）：合并输出必然包含本机那份的赢家，
 *   整体替换才能让「本机记录 == 快照内容」，第二轮才有 `changed=false`；
 * - 找不到本机曲目的引用**只留记录、不造占位曲目**：收藏页只展示曲库里的歌，
 *   造一条空路径的占位曲目在收藏页里看不见，却会污染歌单占位登记；
 * - 真正的写入走 `setLiked`（幂等 set），**不**走 `toggleLiked`——后者会以「现在」
 *   记一次动作，时间戳被单方面推进，两端永远收敛不了。
 */
export function applySyncedLikes(snapshot: SyncSnapshot): LikeApplyOutcome {
  const likes = snapshot.likes
  if (!Array.isArray(likes)) return { liked: 0, unliked: 0, records: 0 }

  const library = useLibraryStore.getState()
  const index = buildLocalMatchIndex()
  const now = Date.now()
  const next: Record<string, SyncedLike> = {}
  let liked = 0
  let unliked = 0

  for (const like of likes) {
    if (!like || typeof like.id !== 'string' || !like.id) continue
    // 过期墓碑不再传播：留着它只会让一首歌在 90 天后依旧无法被重新收藏
    if (isLikeTombstoneExpired(like, now)) continue
    next[like.id] = like

    const trackId = resolveSyncTrackRef(like.ref, index)
    // 本机没有这首歌：记录留着（它可能稍后才被扫进来），这次不产生可见变化
    if (!trackId) continue
    const active = likeIsActive(like)
    // 每轮都取最新状态：同一首歌可能有多条记录（本机副本 / NAS 副本）指到同一个 trackId
    if (useLibraryStore.getState().likedTracks.has(trackId) === active) continue
    library.setLiked(trackId, active)
    if (active) liked += 1
    else unliked += 1
  }

  library.applyLikeRecords(next)
  return { liked, unliked, records: Object.keys(next).length }
}

/* ------------------------------------------------------------------ *
 * 单次同步
 * ------------------------------------------------------------------ */

/** 同 config 的串行锁：撞车时**复用进行中的那一轮**，不排队（§9） */
const running = new Map<string, Promise<SyncOutcome>>()
/** 每条 config 当前的重试阶梯位置 */
const retryAttempts = new Map<string, number>()
/** 退避计时器 */
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** 只有在 dev 下才输出；且**只输出元信息**（口令永远不进日志，§10） */
function debugLog(message: string, detail?: unknown): void {
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env
  if (!env?.DEV) return
  if (detail === undefined) console.debug('[playlistSync]', message)
  else console.debug('[playlistSync]', message, detail)
}

/**
 * 把口令原文从任何要持久化/显示的错误载荷里抹掉（纵深防御，不依赖插件自觉）。
 *
 * **不按长度设阈值**：3 字符的 NAS 口令、4 位配对码比长口令更需要抹——它们出现在
 * `lastError` 里会被写进 localStorage（`syncStore` 的 persist 白名单含 configs）。
 * 代价是极短口令可能误伤错误文本里的普通字符，这个方向（多抹）才是安全的一侧。
 */
function redactSecrets(payload: string, secrets: SyncSecrets): string {
  let out = payload
  for (const value of Object.values(secrets)) {
    if (!value) continue
    out = out.split(value).join('***')
  }
  return out
}

function syncContext(secrets: SyncSecrets, device: SyncDevice): SyncContext {
  const lan = getLanSyncBridge() ?? undefined
  return {
    // 宿主若提供了 fetch 出口就走它（桌面端将来由主进程代发），否则用渲染层 fetch
    fetch: platform.syncFetch ?? globalThis.fetch.bind(globalThis),
    secrets,
    device,
    log: debugLog,
    ...(lan ? { lan } : {}),
  }
}

/**
 * 口令自检：插件声明了口令字段，凭证网关却给不出任何一个值 → 明确报「缺少口令」。
 *
 * 笼统的 `unknown` 会让用户在设置页找不到该改哪儿；这一条只在**确实配了口令字段**
 * 时才抛，所以「匿名可读的 WebDAV」这类不需要口令的实现不会被误伤。
 */
function ensureSecrets(plugin: SyncPlugin, secrets: SyncSecrets): void {
  const passwordFields = plugin.fields.filter((field) => field.kind === 'password')
  if (passwordFields.length === 0) return
  if (passwordFields.some((field) => Boolean(secrets[field.key]))) return
  throw auroraError('sync.error.missingSecret')
}

function clearRetryTimer(configId: string): void {
  const timer = retryTimers.get(configId)
  if (timer !== undefined) {
    clearTimeout(timer)
    retryTimers.delete(configId)
  }
}

function scheduleRetry(configId: string, delayMs: number): void {
  clearRetryTimer(configId)
  retryTimers.set(
    configId,
    setTimeout(() => {
      retryTimers.delete(configId)
      const config = useSyncStore.getState().configs.find((c) => c.id === configId)
      // 用户可能已经删掉/关掉这条配置：退避不该把它拉起来
      if (!config || !config.enabled || !config.autoSync) return
      void syncOnce(config)
    }, delayMs)
  )
}

/**
 * 同步一条配置（§15.4 的编排顺序，逐条照做）。
 *
 * 同一 config 并发调用返回**同一个** Promise；不同 config 互不阻塞。
 * 任何失败都不抛：结构化载荷写进 `syncStore`（`lastError` 与 `config.lastError`），
 * 调用方按返回值的 `ok` 分支即可。
 */
export function syncOnce(config: SyncConfig): Promise<SyncOutcome> {
  const inFlight = running.get(config.id)
  if (inFlight) return inFlight
  const run = runSync(config).finally(() => {
    if (running.get(config.id) === run) running.delete(config.id)
  })
  running.set(config.id, run)
  return run
}

async function runSync(config: SyncConfig): Promise<SyncOutcome> {
  const store = useSyncStore.getState()
  store.setRuntime(config.id, { state: 'running', nextRetryAt: null })

  let secrets: SyncSecrets = {}
  const startedAt = Date.now()
  try {
    const plugin = getSyncPlugin(config.pluginId)
    if (!plugin) throw auroraError('sync.error.unknown', { reason: config.pluginId })
    if (plugin.available && !plugin.available()) {
      throw auroraError('sync.error.unknown', { reason: config.pluginId })
    }

    const device = await ensureDevice()
    // 口令只在本次调用内持有：不进 store、不进闭包外的引用（§10）
    secrets = (await platform.sync?.getCredential(config.id)) ?? {}
    ensureSecrets(plugin, secrets)
    const ctx = syncContext(secrets, device)

    const remotes: SyncSnapshot[] =
      config.direction === 'pushOnly' || !plugin.pull ? [] : await plugin.pull(config, ctx)

    const local = snapshotFromStores(device)
    // 对端可能把自己那份也返回（WebDAV 目录里就有本机文件）：按 deviceId 过滤掉
    const others = remotes.filter((snap) => !isSnapshotOfDevice(snap, device.deviceId))
    const merged = mergeSnapshots(local, others)

    const applied = merged.changed
      ? applySyncedPlaylists(merged.snapshot)
      : { added: 0, updated: 0, removed: 0, placeholders: 0 }
    // 收藏与歌单分别落盘：合并只要「哪边有变化」就是同一个 changed，
    // 但写回是两个独立的 store（互不牵连，也不会互相触发对方的变更订阅）
    const appliedLikes = merged.changed
      ? applySyncedLikes(merged.snapshot)
      : { liked: 0, unliked: 0, records: 0 }

    // ── 不动点：只有「内容真的变了」才写对端（验证报告 B-1 / N-1）──
    //
    // 一次内容未变的同步如果照样 push + publish，两台互相配置的设备就会以
    // 「一次 HTTP 往返」为周期无限互推：每次写入都会让对方收到 inbox、再触发一轮。
    // 判据用内容哈希（排除 deviceId/revision/快照级 updatedAt）而不是 `merged.changed`：
    // 首轮/重启后 `lastPushedHash` 为空，必须无条件写一次，否则第一份永远出不去。
    const contentHash = snapshotContentHash(merged.snapshot)
    const lastPushedHash = useSyncStore.getState().runtime[config.id]?.lastPushedHash ?? null
    const shouldWrite = merged.changed || lastPushedHash !== contentHash

    let wrotePeer = false
    if (shouldWrite && config.direction !== 'pullOnly' && plugin.push) {
      await plugin.push(config, merged.snapshot, ctx)
      wrotePeer = true
    }

    // 局域网缓存：服务没开时不 publish 是常态，不该让整轮同步因此算失败。
    // 同样受 hash 门控 —— 这里是互推环的另一半入口。
    const lan = getLanSyncBridge()
    if (shouldWrite && lan) {
      await lan.publish(merged.snapshot).catch(() => {})
      wrotePeer = true
    }
    if (wrotePeer) useSyncStore.getState().markPushed(config.id, contentHash)

    retryAttempts.delete(config.id)
    clearRetryTimer(config.id)

    const at = Date.now()
    const trackCount = merged.snapshot.playlists.reduce((n, p) => n + p.tracks.length, 0)
    const result = {
      at,
      added: applied.added,
      updated: applied.updated,
      removed: applied.removed,
      trackCount,
    }
    useSyncStore.getState().markSyncOk(config.id, result)
    debugLog('sync ok', {
      configId: config.id,
      durationMs: at - startedAt,
      ...result,
      likes: { ...appliedLikes, total: merged.snapshot.likes?.length ?? 0 },
    })
    return { configId: config.id, ok: true, changed: merged.changed, ...result }
  } catch (err) {
    const payload = redactSecrets(encodeErrorInfo(toErrorInfo(err)), secrets)
    const attempt = retryAttempts.get(config.id) ?? 0
    const delay = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)]
    retryAttempts.set(config.id, attempt + 1)
    scheduleRetry(config.id, delay)
    const at = Date.now()
    useSyncStore.getState().markSyncFailed(config.id, payload, at + delay)
    debugLog('sync failed', { configId: config.id, payload })
    return {
      configId: config.id,
      ok: false,
      changed: false,
      added: 0,
      updated: 0,
      removed: 0,
      trackCount: 0,
      at,
    }
  } finally {
    // 口令引用立刻丢弃（不清空的话它会随闭包多活一段时间）。
    // Lint 认为这是一次无用赋值：它只看得见「后面没人读」，看不见「少留一份引用」。
    // eslint-disable-next-line no-useless-assignment -- §10 要求口令只在本次调用内持有
    secrets = {}
  }
}

/** 连接自检（不落 lastError：探测失败不算「上次同步失败」） */
export async function testConnection(config: SyncConfig): Promise<SyncProbeResult> {
  let secrets: SyncSecrets = {}
  try {
    const plugin = getSyncPlugin(config.pluginId)
    if (!plugin) throw auroraError('sync.error.unknown', { reason: config.pluginId })
    const device = await ensureDevice()
    secrets = (await platform.sync?.getCredential(config.id)) ?? {}
    if (!plugin.probe) {
      // 不实现 probe 视为「无法预检」，不算失败（§15.2）
      return { ok: true, message: encodeErrorInfo({ code: 'sync.card.testOk' }) }
    }
    return await plugin.probe(config, syncContext(secrets, device))
  } catch (err) {
    return {
      ok: false,
      message: redactSecrets(encodeErrorInfo(toErrorInfo(err)), secrets),
    }
  } finally {
    // eslint-disable-next-line no-useless-assignment -- §10：口令不留在任何闭包里
    secrets = {}
  }
}

/* ------------------------------------------------------------------ *
 * 批量与调度
 * ------------------------------------------------------------------ */

/** 立即同步全部**已启用**的配置（手动入口；不受 autoSync 限制） */
export async function syncAllNow(): Promise<SyncOutcome[]> {
  const configs = useSyncStore.getState().configs.filter((c) => c.enabled)
  const outcomes: SyncOutcome[] = []
  for (const config of configs) outcomes.push(await syncOnce(config))
  return outcomes
}

/** 自动同步：只挑 enabled + autoSync + 不在退避窗口里的配置 */
async function syncAllAuto(): Promise<void> {
  const store = useSyncStore.getState()
  const now = Date.now()
  const configs = store.configs.filter((config) => {
    if (!config.enabled || !config.autoSync) return false
    const nextRetryAt = store.runtime[config.id]?.nextRetryAt ?? null
    return nextRetryAt === null || now >= nextRetryAt
  })
  for (const config of configs) await syncOnce(config)
}

/* ------------------------------------------------------------------ *
 * 局域网
 * ------------------------------------------------------------------ */

/**
 * 把落盘迁移时剥出来的秘密补写进凭证网关（验证报告 S-3）。
 *
 * 只在启动跑一次：成功则历史配对码/口令从 localStorage 消失、功能不受影响；
 * 失败（网关不可用、加密不可用）就丢弃 —— 用户下次同步会看到「缺少口令」并重输，
 * 好过让明文永远躺在 localStorage 里。日志只记条数，**绝不记值**。
 */
async function flushSecretMigrations(): Promise<void> {
  const pending = takePendingSecretMigrations()
  if (pending.length === 0) return
  const gateway = platform.sync
  if (!gateway) {
    debugLog('secret migration dropped', { count: pending.length, reason: 'no-gateway' })
    return
  }
  for (const { configId, secrets } of pending) {
    try {
      const result = await gateway.saveCredential(configId, secrets)
      if (!result?.saved) debugLog('secret migration not saved', { configId })
    } catch (err) {
      debugLog('secret migration failed', { configId, err: String(err) })
    }
  }
}

/** 刷新本机局域网服务状态到 store（面板首次打开 / 开关后调用） */
export async function refreshLanStatus(): Promise<LanSyncStatus | null> {
  const bridge = getLanSyncBridge()
  if (!bridge) return null
  try {
    const status = await bridge.status()
    useSyncStore.getState().setLanStatus(status)
    return status
  } catch (err) {
    debugLog('lan status failed', err)
    return null
  }
}

/** 开/关本机局域网服务 */
export async function setLanSyncEnabled(enabled: boolean): Promise<LanSyncStatus | null> {
  const bridge = getLanSyncBridge()
  if (!bridge) return null
  const status = await bridge.setEnabled(enabled)
  useSyncStore.getState().setLanStatus(status)
  return status
}

/** 轮换配对码（旧码立即失效） */
export async function rotateLanCode(): Promise<LanSyncStatus | null> {
  const bridge = getLanSyncBridge()
  if (!bridge) return null
  const status = await bridge.rotateCode()
  useSyncStore.getState().setLanStatus(status)
  return status
}

/* ------------------------------------------------------------------ *
 * 一键配对（docs/playlist-sync.md §16）
 * ------------------------------------------------------------------ */

/** 配对结果：失败原因直接给 UI 查 i18n（`sync.pair.*`），不做字符串判断 */
export type LanPairOutcome =
  | { readonly ok: true; readonly config: SyncConfig }
  | { readonly ok: false; readonly reason: LanPairFailureReason }

/**
 * 配对成功后自动建的那条配置：双向、自动同步、名称取对端设备名。
 *
 * 为什么两端都建：单向建一份只能保证「一轮」双向收敛——对端自己的改动要等下一次
 * 反向拉取才回得来，而它没有配置就不会反向拉（§7「方向」）。所以发起方与应答方
 * 走**同一个** `materializePairedConfig`，行为对称。
 */
function pairedConfigOf(peer: LanPairPeer, id: string): SyncConfig {
  return {
    id,
    pluginId: LAN_SYNC_PLUGIN_ID,
    name: peer.deviceName || peer.host,
    // peerDeviceId 记进 settings：对端身份稳定，排查「同一台设备反复被当成新设备」时要看它
    settings: { host: peer.host, port: peer.port, peerDeviceId: peer.deviceId },
    direction: 'bidirectional',
    autoSync: true,
    enabled: true,
  }
}

/**
 * 把「刚配对换来的对端配对码」落进一条新配置，并把配置写进 store。
 *
 * 顺序不能反：先 `adoptPairedCode` 再 `addConfig`。反过来的话，卡片会先出现在界面上，
 * 用户在码落地之前点「立即同步」就会因为缺凭据失败——「配对成功却同步失败」是最容易
 * 被理解成「配对没成」的一种状态。返回 null 表示码没落住（配对已过期/被取走）。
 */
async function materializePairedConfig(peer: LanPairPeer): Promise<SyncConfig | null> {
  const bridge = getLanSyncBridge()
  if (!bridge) return null
  const id = generateId()
  const adopted = await bridge.adoptPairedCode(id, peer.deviceId).catch(() => false)
  if (!adopted) return null
  const config = pairedConfigOf(peer, id)
  useSyncStore.getState().addConfig(config)
  return config
}

/**
 * 发起一键配对：等对端用户确认 → 换到对端配对码 → 建配置 → 立刻跑一轮同步。
 *
 * 立刻同步一轮是刻意的：它把「配对码对不对、端口通不通」在一个用户还在看屏幕的
 * 时刻验证掉；失败会落在卡片的状态行上，比让用户等到 5 分钟后的定时同步才发现好。
 */
export async function pairWithLanPeer(peer: LanPeerInfo): Promise<LanPairOutcome> {
  const bridge = getLanSyncBridge()
  if (!bridge) return { ok: false, reason: 'unsupported' }
  let result
  try {
    result = await bridge.pairStart({
      deviceId: peer.deviceId,
      deviceName: peer.deviceName,
      host: peer.host,
      port: peer.port,
    })
  } catch (err) {
    debugLog('lan pair start failed', err)
    return { ok: false, reason: 'unreachable' }
  }
  if (!result.ok) return { ok: false, reason: result.reason }
  const config = await materializePairedConfig(result.peer)
  if (!config) return { ok: false, reason: 'auth' }
  void syncOnce(config)
  return { ok: true, config }
}

/** 应答对端发来的配对请求（确认框的两个按钮） */
export async function respondLanPairRequest(pairId: string, accept: boolean): Promise<boolean> {
  const bridge = getLanSyncBridge()
  if (!bridge) return false
  try {
    const result = await bridge.pairRespond(pairId, accept)
    return result.accepted === true
  } catch (err) {
    debugLog('lan pair respond failed', err)
    return false
  }
}

/**
 * 配对完成（本机作为**应答方**）：建配置 + 落码 + 跑一轮。
 *
 * 与 `pairWithLanPeer` 共用 `materializePairedConfig`，差别只在码从哪来：
 * 发起方的码是 `pairStart()` 换回来的，应答方的码是主进程在 reply 里解出来的。
 */
export async function completeLanPairing(peer: LanPairPeer): Promise<SyncConfig | null> {
  const config = await materializePairedConfig(peer)
  if (config) void syncOnce(config)
  return config
}

/** 扫描附近设备（UDP 广播收集） */
export async function scanLanPeers(timeoutMs?: number): Promise<LanPeerInfo[]> {
  const bridge = getLanSyncBridge()
  if (!bridge) return []
  const store = useSyncStore.getState()
  store.setLanScanning(true)
  try {
    const peers = await bridge.discover(timeoutMs)
    store.setLanPeers(peers)
    return peers
  } finally {
    store.setLanScanning(false)
  }
}

/**
 * 对端推来的快照（`lan:inbox`）。
 *
 * 与 WebDAV 走同一套合并与落盘。**这里曾经无条件 publish 再无条件 syncAllAuto**，
 * 那正是互推环的起点（验证报告 B-1）：对端推到本机 → 本机原样推回 → 对端再推…
 * 现在的规则是两条：
 *
 * 1. 只有当「合并结果」既不是本机上次推出去的内容、也不等于对端刚发来的内容时，
 *    才回推一次 —— 学到的东西对方已经有了，回推没有信息量；
 * 2. 收件箱只当作「对端有变化」的信号，按 config 触发一轮同步，且同一条配置
 *    在 `INBOX_SYNC_COOLDOWN_MS` 内不重复触发（一次连推 20 份快照不该变成 20 轮同步）。
 * 3. 合并结果**当场落盘**：歌单与收藏是两个独立 store，这里两份都要写。不能只写歌单、
 *    指望随后那轮 `syncOnce` 补上——配置没开自动同步、是 `pushOnly`、或插件 pull 不可用时
 *    那轮同步根本不会跑，对端推来的收藏就永远不落盘（收藏页看不到、按钮不点亮），
 *    而下面 publish 出去的却是「含收藏」的内容：本地与刚推出去的内容不一致。
 *
 * 写入本身还有 `syncOnce` 里的 hash 门控兜底，即使这里判断失误也只多一次写。
 */
async function handleLanInbox(snapshots: SyncSnapshot[]): Promise<void> {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return
  try {
    const device = await ensureDevice()
    const others = snapshots.filter((snap) => !isSnapshotOfDevice(snap, device.deviceId))
    if (others.length === 0) return

    const merged = mergeSnapshots(snapshotFromStores(device), others)
    if (merged.changed) {
      // 收藏与歌单各写各的 store（与 runSync 同一分工）。这里少写一份，下面拿来算哈希
      // 并 publish 的合并结果就与本地状态不一致：推出去的是「含收藏」的内容，本地却没有；
      // 而补写只发生在随后那轮 syncOnce 里，它可能根本不会跑（见函数头第 3 条）。
      applySyncedPlaylists(merged.snapshot)
      applySyncedLikes(merged.snapshot)
    }

    const mergedHash = snapshotContentHash(merged.snapshot)
    const incomingHashes = new Set(others.map((snap) => snapshotContentHash(snap)))
    const bridge = getLanSyncBridge()
    // 对方刚发来的就是我们现在的全部内容 → 回推没有信息量，记账后就此打住
    if (incomingHashes.has(mergedHash)) {
      lastInboxPublishHash = mergedHash
    } else if (bridge && mergedHash !== lastInboxPublishHash) {
      await bridge.publish(merged.snapshot).catch(() => {})
      lastInboxPublishHash = mergedHash
    }

    await syncConfigsAfterInbox()
  } catch (err) {
    debugLog('lan inbox failed', err)
  }
}

/**
 * 收件箱触发的自动同步：同一配置两次触发至少间隔 `INBOX_SYNC_COOLDOWN_MS`。
 *
 * 冷却记在模块级（不落盘）：重启后的第一次 inbox 值得同步一轮，之后按节奏来。
 */
async function syncConfigsAfterInbox(): Promise<void> {
  const store = useSyncStore.getState()
  const now = Date.now()
  const due = store.configs.filter((config) => {
    if (!config.enabled || !config.autoSync) return false
    if (now - (lastInboxSyncAt.get(config.id) ?? 0) < INBOX_SYNC_COOLDOWN_MS) return false
    const nextRetryAt = store.runtime[config.id]?.nextRetryAt ?? null
    return nextRetryAt === null || now >= nextRetryAt
  })
  // 先统一记账再逐个跑：跑第一轮时可能又收到 inbox，别让它把第二批也放进来
  for (const config of due) lastInboxSyncAt.set(config.id, now)
  for (const config of due) await syncOnce(config)
}

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */

let initialized = false
/** 上次因为收件箱而 publish 出去的内容哈希（回推去重，B-1） */
let lastInboxPublishHash: string | null = null
/** 每条配置上次被收件箱触发同步的时间（冷却用，B-1） */
const lastInboxSyncAt = new Map<string, number>()
let startupTimer: ReturnType<typeof setTimeout> | null = null
let periodicTimer: ReturnType<typeof setInterval> | null = null
let changeTimer: ReturnType<typeof setTimeout> | null = null
const disposers: Array<() => void> = []

/** 歌单变更 → 防抖 2s 后自动同步（避免一次导入/批量编辑触发多轮） */
function scheduleChangeSync(): void {
  if (changeTimer !== null) clearTimeout(changeTimer)
  changeTimer = setTimeout(() => {
    changeTimer = null
    void syncAllAuto()
  }, CHANGE_DEBOUNCE_MS)
}

/**
 * 注册局域网桥并启动调度（**幂等**，App.tsx 里调一次即可）。
 *
 * 非桌面端直接返回：不注册桥、不起定时器、不订阅（§8 只做桌面端，
 * 入口由 `platform.supportsPlaylistSync` 决定，这里不重复判断平台差异）。
 */
export function initPlaylistSync(): void {
  if (initialized) return
  initialized = true
  if (!platform.supportsPlaylistSync) return

  // 桥必须在启动调度之前注册：插件 `available()` 和引擎的 publish 都要用它
  setLanSyncBridge(platform.lanSync ?? null)

  // WebDAV 的传输接缝（B-2）：桌面端渲染进程直连会被 CORS 拦，必须走主进程的
  // `sync:fetch`；注入后 shared 的 webdav 模块全部改走这条通道，非桌面传 null 回落全局 fetch。
  setWebdavFetch(platform.syncFetch ?? null)

  // 历史配置里的明文配对码/口令 → 凭证网关（S-3 的迁移收尾）
  void flushSecretMigrations()

  void ensureDevice().catch((err) => debugLog('device identity failed', err))
  void refreshLanStatus().catch(() => {})

  startupTimer = setTimeout(() => {
    startupTimer = null
    void syncAllAuto()
  }, STARTUP_SYNC_DELAY_MS)

  periodicTimer = setInterval(() => void syncAllAuto(), PERIODIC_SYNC_MS)

  // 只关心歌单本身的变化：importedTracks 的增删（占位曲目登记）不该触发同步
  disposers.push(
    usePlaylistStore.subscribe((state, prev) => {
      if (state.playlists !== prev.playlists || state.syncTombstones !== prev.syncTombstones) {
        scheduleChangeSync()
      }
    })
  )

  // 收藏也是同步内容：用户点一下爱心/取消，就要在防抖窗口后跑一轮。
  // 盯 `likeRecords` 而不是 `likedTracks`：后者在每次曲库刷新（setTracks）时都会换新引用，
  // 启动扫描会因此触发一轮冤枉的同步；前者只在「收藏/取消」与「应用快照」时变化。
  disposers.push(
    useLibraryStore.subscribe((state, prev) => {
      if (state.likeRecords !== prev.likeRecords) scheduleChangeSync()
    })
  )

  const offInbox = platform.onLanSyncInbox?.((snapshots) => void handleLanInbox(snapshots))
  if (offInbox) disposers.push(offInbox)

  // 启动即主动消费一次收件箱（验证报告 N-3）：窗口未创建/刷新期间到达的快照只躺在
  // 主进程的 20 条环形缓冲里，等 `lan:inbox` 事件是等不到的（事件发生在还没有监听者时）。
  const bridge = getLanSyncBridge()
  if (bridge) {
    void bridge
      .takeInbox()
      .then((snapshots) => handleLanInbox(snapshots))
      .catch((err) => debugLog('startup inbox failed', err))
  }
}

/** 停掉调度并卸载桥（测试与「关闭同步」用；生产里 App 生命周期内不需要） */
export function disposePlaylistSync(): void {
  if (startupTimer !== null) clearTimeout(startupTimer)
  if (periodicTimer !== null) clearInterval(periodicTimer)
  if (changeTimer !== null) clearTimeout(changeTimer)
  startupTimer = null
  periodicTimer = null
  changeTimer = null
  for (const id of [...retryTimers.keys()]) clearRetryTimer(id)
  for (const dispose of disposers.splice(0)) dispose()
  setLanSyncBridge(null)
  setWebdavFetch(null)
  initialized = false
}

/** 测试用：清掉模块级缓存（设备身份 / 重试阶梯 / 串行锁） */
export function resetPlaylistSyncForTest(): void {
  disposePlaylistSync()
  deviceCache = null
  revisionCounter = 0
  running.clear()
  retryAttempts.clear()
  lastInboxPublishHash = null
  lastInboxSyncAt.clear()
}
