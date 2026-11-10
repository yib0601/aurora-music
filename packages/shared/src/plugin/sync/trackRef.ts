/**
 * 曲目引用的双向转换：本机曲目 → 快照引用（`toSyncTrackRef`）、快照引用 → 本机 trackId
 * （`resolveSyncTrackRef`）。纯函数，双端共用，可单测。
 *
 * 解析顺序是 `docs/playlist-sync.md` §4 定下的**五档**，本文件严格按它执行：
 *   1. `kind:'local'` → 本机路径精确（原样 → 归一化：反斜杠转斜杠 + 小写）
 *   2. 同名 + 时长在容差内（`trackIdentity.ts` 的口径：三者同时成立才算同一首）
 *   3. `kind:'storage'` → 同 `pluginId` 的相对路径精确，再退后缀互含 / basename
 *   4. 在线身份（`onlineId` + `platform` 在本机已启用音源里的认领表）
 *   5. 全部落空 → `null`（**不丢条目**：占位曲目由调用方登记）
 *
 * ## 复用而非重写
 *
 * 第 2 档与第 3 档的口径分别来自 `trackIdentity.ts` 与 `importMatch.ts`：曲库去重、
 * M3U 导入、歌单同步三处判「同一首歌」必须是同一套规则，各写一份必然漂移
 * （典型后果：去重认为是一首、同步认为是两首，歌单里就出现凭空多出来的条目）。
 * 第 3 档直接调 `matchTracksByPaths`；第 2 档的时长比较用导出的
 * `DURATION_MATCH_TOLERANCE`，名称归一化则与 `trackIdentity.ts` 的私有
 * `normalizeText` 逐字一致（该函数未导出，故在本文件复写一份并注明来源）。
 *
 * ## 为什么第 4 档不在这里做在线搜索
 *
 * 本模块是纯函数（可单测、可在主进程与渲染层同时跑），而"按元数据在线搜一次"是网络
 * 行为。所以第 4 档只查调用方预先构造好的认领表（`buildMatchIndex` 的 `online`），
 * 真正的在线搜索由引擎（基础能力侧）在第 5 档之前兜底——顺序与职责都不变。
 */

import { matchTracksByPaths, storageSourceKey } from '../../importMatch'
import { DURATION_MATCH_TOLERANCE } from '../../trackIdentity'
import type { SyncTrackRef } from './types'

/**
 * 建立索引所需的曲目字段（docs §4 的最小集）。
 *
 * 前六个与 `docs/playlist-sync.md` §15.2 完全一致；后面几个是**可选**的扩展：
 * `SyncTrackRef` 的 meta 档要求 `album`，在线曲目还需要身份字段，而
 * app 侧的 `Track` 本来就有这些值——让调用方原样传 `Track` 比另建一份映射更可靠
 * （少一处"忘了搬某个字段"的坑）。多传字段不会有任何副作用。
 */
export interface SyncMatchTrack {
  readonly id: string
  readonly title: string
  readonly artist: string
  /** 秒；0 = 未知 */
  readonly duration: number
  /** 存储坐标（本机绝对路径 / `webdav:<sourceId>/…` / `web:<folderKey>/…`）；在线曲目为空串 */
  readonly path: string
  readonly sourceId?: string
  readonly album?: string
  readonly onlineId?: string
  readonly platform?: string
  readonly coverUrl?: string
}

/** `buildMatchIndex` 的可选输入 */
export interface SyncMatchIndexOptions {
  /**
   * 在线身份认领表：`onlineId`（或 `` `${platform}:${onlineId}` ``）→ 本机 trackId。
   *
   * 两种键都接受：带 `platform` 的键更准确（同一串 id 在不同平台可能撞车），
   * 但调用方若只拿得到裸 id 也能用。
   */
  readonly online?: ReadonlyMap<string, string>
  /**
   * 存储来源 id → 插件 id（复用 `librarySourcePluginId`）。
   *
   * 可选，但**强烈建议传**：第 3 档要「同 `pluginId` 的相对路径」，缺了它就只能跨所有
   * 远端来源按 basename 宽松匹配——多台 NAS 上有同名文件时可能绑错。
   */
  readonly storagePluginIdOf?: (sourceId: string) => string | undefined
}

/**
 * 曲目匹配索引（结构自定，只在内存里活一次同步，**不进** IPC / 快照）。
 *
 * 分桶在 `buildMatchIndex` 里一次做完：一次同步要解析几千条引用，逐条线性扫描曲库
 * 是 O(n·m)，在几千首歌的歌单上会明显卡住渲染层。
 */
export interface SyncMatchIndex {
  readonly tracks: readonly SyncMatchTrack[]
  /** 原样路径 → 曲目（第 1 档前半） */
  readonly byPath: ReadonlyMap<string, SyncMatchTrack>
  /** 归一化路径 → 曲目（第 1 档后半） */
  readonly byPathKey: ReadonlyMap<string, SyncMatchTrack>
  /** `归一化标题\0归一化歌手` → 候选（第 2 档） */
  readonly byName: ReadonlyMap<string, readonly SyncMatchTrack[]>
  /** 远端来源键（`webdav:<sourceId>` / `web:<folderKey>`） → 该来源的曲目（第 3 档） */
  readonly bySource: ReadonlyMap<string, readonly SyncMatchTrack[]>
  /** 来源键，按首次出现顺序（第 3 档遍历用，顺序稳定才可复现） */
  readonly sourceKeys: readonly string[]
  /** 第 3 档按 `pluginId` 收窄用；未提供时为 undefined */
  readonly storagePluginIdOf?: (sourceId: string) => string | undefined
  /** 第 4 档认领表 */
  readonly online: ReadonlyMap<string, string>
}

/* ------------------------------------------------------------------ *
 * 归一化（与既有模块逐字一致，来源见注释）
 * ------------------------------------------------------------------ */

/**
 * 歌名/歌手归一化：只处理空白与大小写，保留所有语义字符。
 *
 * 与 `trackIdentity.ts` 的私有 `normalizeText` **逐字一致**（不做去括号/去标点：
 * 「某歌 (Live)」与「某歌 (Remix)」是两首不同的歌，宽松归一化会把它们并成一首）。
 */
const normalizeText = (raw: string): string => (raw || '').trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * 存储路径归一化：反斜杠转斜杠 + 小写。
 *
 * 与 `importMatch.ts` 的私有 `normalizeStoragePath` 同一公式。之所以复写：该函数与
 * `baseNameOfPath` 都没有导出，而 `importMatch.ts` 不在本次改动的授权范围里
 * （见回报的偏差说明）。**口径仍只有一套**：第 3 档的实际匹配全部委托给
 * `matchTracksByPaths`，这里只用于第 1 档的本机路径比对与"这次命中的是精确轮吗"的判定。
 */
const normalizePathKey = (path: string): string => (path || '').replace(/\\/g, '/').toLowerCase()

/** 第 2 档的分桶键：`\u0000` 分隔，避免歌名/歌手里含分隔符时拼接键互相碰撞 */
const nameKeyOf = (title: string, artist: string): string => {
  const name = normalizeText(title)
  if (!name) return ''
  return `${name}\u0000${normalizeText(artist)}`
}

/* ------------------------------------------------------------------ *
 * 建索引
 * ------------------------------------------------------------------ */

/** 建匹配索引。曲目顺序即"同等条件下的先后"（第 1、2 档的兜底排序仍按口径显式定义） */
export function buildMatchIndex(
  tracks: readonly SyncMatchTrack[],
  opts: SyncMatchIndexOptions = {}
): SyncMatchIndex {
  const byPath = new Map<string, SyncMatchTrack>()
  const byPathKey = new Map<string, SyncMatchTrack>()
  const byName = new Map<string, SyncMatchTrack[]>()
  const bySource = new Map<string, SyncMatchTrack[]>()
  const sourceKeys: string[] = []

  for (const track of tracks) {
    const path = typeof track?.path === 'string' ? track.path : ''
    if (path) {
      // 先到先得：曲库里理论上不会有两条记录指向同一路径，真出现了也以先出现的为准
      // （与 matchTracksByPaths 的 exactIndex 同语义），保证结果与输入顺序一致
      if (!byPath.has(path)) byPath.set(path, track)
      const key = normalizePathKey(path)
      if (!byPathKey.has(key)) byPathKey.set(key, track)
    }
    const nameKey = nameKeyOf(track.title, track.artist)
    if (nameKey) {
      const list = byName.get(nameKey)
      if (list) list.push(track)
      else byName.set(nameKey, [track])
    }
    // 只有存储坐标才进来源分桶：在线曲目（path 为空或 http 地址）的
    // storageSourceKey 是空串，不该被当成「某个远端来源」
    const sourceKey = storageSourceKey(path)
    if (sourceKey) {
      const list = bySource.get(sourceKey)
      if (list) list.push(track)
      else {
        bySource.set(sourceKey, [track])
        sourceKeys.push(sourceKey)
      }
    }
  }

  return {
    tracks,
    byPath,
    byPathKey,
    byName,
    bySource,
    sourceKeys,
    ...(opts.storagePluginIdOf ? { storagePluginIdOf: opts.storagePluginIdOf } : {}),
    online: opts.online ?? new Map<string, string>(),
  }
}

/* ------------------------------------------------------------------ *
 * 本机曲目 → 快照引用
 * ------------------------------------------------------------------ */

/** `webdav:<sourceId>/<相对路径>` 与 `web:<folderKey>/<相对路径>` 的解析（与 importMatch 同正则） */
const STORAGE_PATH_RE = /^(webdav|web):([^/]+)\/(.+)$/i

/**
 * 本机曲目 → 快照引用。
 *
 * 判定顺序（docs §15.2 最后一段）：
 * 1. `path` 为空 → `meta`（在线曲目 / 导入占位曲目：它们本来就没有可搬的坐标）；
 * 2. `path` 命中 `webdav:` / `web:` 且能拆出 `sourceId` + 相对路径 → `storage`
 *    （`web:` 是 Web 端会话目录的坐标，跨设备时同样是"某来源 + 相对路径"，
 *    所以也走 storage 档；`pluginId` 由调用方注入，取不到时按 scheme 回落）；
 * 3. 其余非空 → `local`（本机绝对路径；对端只当第 1 档的线索用）。
 *
 * @param storagePluginIdOf 来源 id → 存储插件 id（复用 `librarySourcePluginId`）
 */
export function toSyncTrackRef(
  track: SyncMatchTrack,
  storagePluginIdOf?: (sourceId: string) => string | undefined
): SyncTrackRef {
  const meta = {
    title: typeof track.title === 'string' ? track.title : '',
    artist: typeof track.artist === 'string' ? track.artist : '',
    album: typeof track.album === 'string' ? track.album : '',
    duration: Number.isFinite(Number(track.duration)) ? Math.max(0, Number(track.duration)) : 0,
  }
  const path = typeof track.path === 'string' ? track.path : ''

  if (!path) {
    const onlineId = typeof track.onlineId === 'string' ? track.onlineId.trim() : ''
    const platform = typeof track.platform === 'string' ? track.platform.trim() : ''
    const coverUrl = typeof track.coverUrl === 'string' ? track.coverUrl.trim() : ''
    return {
      ...meta,
      kind: 'meta',
      ...(onlineId ? { onlineId } : {}),
      ...(platform ? { platform } : {}),
      ...(coverUrl ? { coverUrl } : {}),
    }
  }

  const match = STORAGE_PATH_RE.exec(path)
  if (match) {
    const scheme = match[1].toLowerCase()
    const sourceId = match[2]
    const relPath = match[3]
    const pluginId = storagePluginIdOf?.(sourceId) || (scheme === 'webdav' ? 'webdav' : 'web')
    if (relPath) return { ...meta, kind: 'storage', pluginId, relPath }
  }

  return { ...meta, kind: 'local', path }
}

/* ------------------------------------------------------------------ *
 * 快照引用 → 本机 trackId
 * ------------------------------------------------------------------ */

/** 在线身份只在 meta 档上：其它档位没有这两个字段 */
function onlineIdentityOf(ref: SyncTrackRef): { onlineId: string; platform: string } | null {
  if (ref.kind !== 'meta') return null
  const onlineId = typeof ref.onlineId === 'string' ? ref.onlineId.trim() : ''
  if (!onlineId) return null
  return { onlineId, platform: typeof ref.platform === 'string' ? ref.platform.trim() : '' }
}

/**
 * 同等命中的择优：**先贪"能直接播的"**，再按 id 字典序收尾。
 *
 * 第 2 档天然会命中"同一首歌的多份副本"（本机文件 / 某台 NAS / 在线条目）——
 * 选哪份决定用户点开歌单能不能直接播，所以本机文件优先、远端存储次之、纯在线最后。
 * 同档内按 id 排序是为了**结果可复现**：同一份快照在两台设备上必须解析出同样的绑定，
 * 否则两台机器会各自把"对端新增"又加一遍。
 */
function rankOf(track: SyncMatchTrack): number {
  const path = typeof track.path === 'string' ? track.path : ''
  if (!path) return 2
  return storageSourceKey(path) ? 1 : 0
}

function pickBest(candidates: readonly SyncMatchTrack[]): SyncMatchTrack | undefined {
  let best: SyncMatchTrack | undefined
  for (const candidate of candidates) {
    if (!best) {
      best = candidate
      continue
    }
    const rankDiff = rankOf(candidate) - rankOf(best)
    if (rankDiff < 0 || (rankDiff === 0 && candidate.id < best.id)) best = candidate
  }
  return best
}

/** 第 2 档：同名 + 时长在容差内（两侧都必须已知时长："缺证据≠相符"） */
function matchByMeta(ref: SyncTrackRef, index: SyncMatchIndex): SyncMatchTrack | undefined {
  const nameKey = nameKeyOf(ref.title, ref.artist)
  if (!nameKey) return undefined
  const duration = Number.isFinite(Number(ref.duration)) ? Math.max(0, Number(ref.duration)) : 0
  if (duration <= 0) return undefined
  const candidates = index.byName.get(nameKey)
  if (!candidates || candidates.length === 0) return undefined
  const hits = candidates.filter((track) => {
    const other = Number.isFinite(Number(track.duration)) ? Number(track.duration) : 0
    return other > 0 && Math.abs(other - duration) <= DURATION_MATCH_TOLERANCE
  })
  return hits.length ? pickBest(hits) : undefined
}

/**
 * 第 3 档的候选来源。
 *
 * 优先取 `storagePluginIdOf` 判定为同一插件的来源；一个都判不出来时退回
 * 「scheme 同名」（`webdav-sync` 时代的坐标就是 `webdav:`），最后退回全部远端来源——
 * 逐级退化而不是直接放弃：跨设备换挂载点的场景里，"同相对路径"仍然比"同名同长度"更可信。
 */
function candidateSourceKeys(pluginId: string, index: SyncMatchIndex): readonly string[] {
  const all = index.sourceKeys
  if (!all.length) return [] as readonly string[]
  const resolve = index.storagePluginIdOf
  if (!resolve) return all
  const matched = all.filter((key) => {
    const sourceId = key.slice(key.indexOf(':') + 1)
    return resolve(sourceId) === pluginId
  })
  if (matched.length) return matched
  const sameScheme = all.filter((key) => key.startsWith(`${pluginId.toLowerCase()}:`))
  return sameScheme.length ? sameScheme : all
}

/** 第 3 档：同来源内先精确坐标、再宽松（委托给 `matchTracksByPaths`，不另写一套宽松规则） */
function matchByStorage(
  ref: Extract<SyncTrackRef, { kind: 'storage' }>,
  index: SyncMatchIndex
): SyncMatchTrack | undefined {
  const relPath = (typeof ref.relPath === 'string' ? ref.relPath : '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  if (!relPath) return undefined
  const keys = candidateSourceKeys(typeof ref.pluginId === 'string' ? ref.pluginId : '', index)
  if (!keys.length) return undefined

  const lookup = (key: string): { track: SyncMatchTrack; exact: boolean } | null => {
    const tracks = index.bySource.get(key)
    if (!tracks || !tracks.length) return null
    const want = `${key}/${relPath}`
    const hit = matchTracksByPaths([want], [...tracks])[0]
    if (!hit) return null
    // matchTracksByPaths 内部会先后走精确轮与宽松轮；这里靠"整条坐标是否相等"
    // 还原它走的是哪一轮，好让**所有来源的精确轮**都排在**任何来源的宽松轮**之前
    // （否则排在前面的来源用 basename 蒙对一条，会盖掉后面来源的精确命中）
    return { track: hit, exact: normalizePathKey(hit.path) === normalizePathKey(want) }
  }

  for (const key of keys) {
    const hit = lookup(key)
    if (hit?.exact) return hit.track
  }
  for (const key of keys) {
    const hit = lookup(key)
    if (hit) return hit.track
  }
  return undefined
}

/** 第 4 档：在线身份认领（带 platform 的键优先，其次裸 onlineId） */
function matchOnline(ref: SyncTrackRef, index: SyncMatchIndex): string | null {
  const identity = onlineIdentityOf(ref)
  if (!identity) return null
  if (identity.platform) {
    const hit = index.online.get(`${identity.platform}:${identity.onlineId}`)
    if (hit) return hit
  }
  return index.online.get(identity.onlineId) ?? null
}

/**
 * 快照引用 → 本机 trackId；解析不到返回 `null`。
 *
 * 返回 `null` **不是错误**：调用方据此登记占位曲目（§4 第 5 档），条目留在歌单里照样可见。
 */
export function resolveSyncTrackRef(ref: SyncTrackRef, index: SyncMatchIndex): string | null {
  if (!ref) return null

  // 1 本机路径精确：先原样（大小写敏感的文件系统上是唯一正确的一轮），再归一化
  if (ref.kind === 'local') {
    const path = typeof ref.path === 'string' ? ref.path : ''
    if (path) {
      const exact = index.byPath.get(path)
      if (exact) return exact.id
      const normalized = index.byPathKey.get(normalizePathKey(path))
      if (normalized) return normalized.id
    }
  }

  // 2 同名 + 时长容差（对三种档位都适用：本地路径失配后，元数据是最强的跨设备线索）
  const byMeta = matchByMeta(ref, index)
  if (byMeta) return byMeta.id

  // 3 存储相对路径
  if (ref.kind === 'storage') {
    const byStorage = matchByStorage(ref, index)
    if (byStorage) return byStorage.id
  }

  // 4 在线身份
  const byOnline = matchOnline(ref, index)
  if (byOnline) return byOnline

  // 5 落空：占位由调用方登记
  return null
}
