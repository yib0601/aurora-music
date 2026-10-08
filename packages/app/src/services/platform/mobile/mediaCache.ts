/**
 * 媒体缓存（移动端）
 *
 * 与桌面端（desktop/src/ipc/mediaCache.ts）同构：音频 / 封面 / 歌词三类内容共用
 * 一份容量配置，按固定比例切给三个池、池内各自按 lastUsed 做 LRU 驱逐；配额分配、
 * 驱逐选择、索引格式与稳定文件名都取自 @aurora/shared 的 mediaCacheCore，两端
 * 口径一致，只有落盘方式不同（这里是 Capacitor Filesystem，桌面端是 node:fs）。
 *
 * 落盘位置（均为应用专属目录 Directory.Data，不需要任何存储权限、卸载随应用清除）：
 *   aurora-music/media-cache/audio/<sha1(键)><ext>   在线播放音频
 *   aurora-music/media-cache/cover/<sha1(键)><ext>   在线曲目的远端封面
 *   aurora-music/lyrics/<trackId>.lrc                在线搜索到的歌词（曲库歌词目录）
 *   aurora-music/media-cache/index.json              索引
 *
 * 与桌面端的一处有意差异：曲库内嵌封面（扫描时从音频文件里提取、写在
 * aurora-music/covers）不纳入配额，也不算缓存——移动端曲目记录里的 coverPath
 * 存的是 convertFileSrc 之后的 URL，驱逐时无法安全回填成文件路径，误删会让封面
 * 永久消失；它属于用户的曲库资产，不该被「清空缓存」波及。歌词目录则纳入配额：
 * 移动端的歌词只有一个来源（在线歌词源搜索后落盘），本身就是缓存。
 *
 * 命中返回 Capacitor.convertFileSrc 生成的可被 <audio>/<img> 直接加载的地址；
 * 未命中返回 null（本次仍走原始远端地址），后台用原生 HTTP 下载，下次即命中。
 * 该地址与本地曲目播放走的是同一条拦截路径（WebViewLocalServer 的
 * `_capacitor_file_` 处理器），播放器行为随之一致，不额外引入差异。
 * limitMB 为 0 表示不限制容量：不驱逐、照常新增，占用无上限（腾空间走「清空缓存」）。
 */
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Capacitor } from '@capacitor/core'
import {
  CACHE_FETCH_UA,
  CACHE_POOLS,
  CACHE_TOUCH_FLUSH_MS,
  audioExtFrom,
  cacheBodyKey,
  cacheFileKey,
  hashCacheKey,
  imageExtFrom,
  parseCacheIndex,
  poolLimitsMB,
  selectEvictions,
  serializeCacheIndex,
  sumSizes,
  type CacheEntry,
  type CachePool,
} from '@aurora/shared'

/** 缓存根目录（应用专属存储下） */
const CACHE_ROOT = 'aurora-music/media-cache'
const INDEX_FILE = `${CACHE_ROOT}/index.json`

/**
 * 各池目录。歌词复用曲库歌词目录（aurora-music/lyrics），与桌面端同一语义：
 * 该目录里的文件全部来自在线歌词源的搜索结果，纳入配额与「清空缓存」不丢资产。
 */
const POOL_DIR: Record<CachePool, string> = {
  audio: `${CACHE_ROOT}/audio`,
  cover: `${CACHE_ROOT}/cover`,
  lyrics: 'aurora-music/lyrics',
}

/**
 * 需要「收编」未登记文件的池：歌词目录在缓存实现之前就存在（旧版本写下的 .lrc），
 * 不接管就永远不受配额约束。audio / cover 两个目录是纯粹的缓存目录，未登记的
 * 文件一律视为残留清掉（半截 .part 同理）。
 */
const ADOPT_POOLS: readonly CachePool[] = ['lyrics']

/** 拉流缓存用的 UA，与桌面端同一份（见 shared 的 CACHE_FETCH_UA） */
const UA = CACHE_FETCH_UA

/** 命中只改内存里的 lastUsed，攒一会儿再落盘：播放中的命中很频繁 */
const TOUCH_FLUSH_MS = CACHE_TOUCH_FLUSH_MS

let initialized = false
let initPromise: Promise<void> | null = null
/** 容量档位：> 0 按配额驱逐；为 0 表示不限制容量（不驱逐、照常新增） */
let limitMB = 1024
/** 索引键（`<pool>:<stem>`）→ 条目 */
const entries = new Map<string, CacheEntry>()
/** `<pool>:<文件名>` → 索引键：命中时按文件名反查，兼作路径白名单 */
const fileToKey = new Map<string, string>()
/** 同一目标的并发下载去重 */
const inflight = new Set<string>()
/** 池目录的绝对 URI（file:// 形式），命中时据此拼 convertFileSrc 地址 */
const poolUriCache = new Map<CachePool, string>()
let touchedDirty = false
let flushTimer: ReturnType<typeof setInterval> | null = null
/** 清空代数：下载期间被清空则丢弃结果，避免「清空后占用又涨回去」 */
let cacheEpoch = 0

// ─── 平台适配（全部失败静默：缓存不可用不该影响播放与渲染）────────

function base64ToUtf8(b64: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

async function mkdirQuiet(path: string): Promise<void> {
  try {
    await Filesystem.mkdir({ path, directory: Directory.Data, recursive: true })
  } catch (err: any) {
    // 目录已存在不算错误
    if (err?.message && !/exist/i.test(err.message)) throw err
  }
}

async function deleteQuiet(path: string): Promise<void> {
  try {
    await Filesystem.deleteFile({ path, directory: Directory.Data })
  } catch {
    // 文件本就不存在
  }
}

async function statQuiet(path: string): Promise<{ size: number; mtime: number } | null> {
  try {
    const info = await Filesystem.stat({ path, directory: Directory.Data })
    return { size: info.size || 0, mtime: info.mtime || Date.now() }
  } catch {
    return null
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const result = await Filesystem.readdir({ path: dir, directory: Directory.Data })
    return result.files.filter((f) => f.type === 'file').map((f) => f.name)
  } catch {
    return []
  }
}

/** 池目录的绝对 URI（缓存一份，命中路径上不再走异步桥） */
async function poolUriOf(pool: CachePool): Promise<string> {
  const cached = poolUriCache.get(pool)
  if (cached) return cached
  const { uri } = await Filesystem.getUri({ path: POOL_DIR[pool], directory: Directory.Data })
  const normalized = uri.replace(/\/+$/, '')
  poolUriCache.set(pool, normalized)
  return normalized
}

/** 索引键 → 可直接喂给 <audio>/<img> 的地址 */
function toLoadableSrc(uri: string): string {
  return Capacitor.convertFileSrc(uri)
}

function pathOf(entry: CacheEntry): string {
  return `${POOL_DIR[entry.pool]}/${entry.file}`
}

// ─── 索引 ────────────────────────────────────────────────────

async function saveIndex(): Promise<void> {
  if (!initialized) return
  touchedDirty = false
  try {
    await mkdirQuiet(CACHE_ROOT)
    await Filesystem.writeFile({
      path: INDEX_FILE,
      directory: Directory.Data,
      data: utf8ToBase64(serializeCacheIndex(entries)),
      recursive: true,
    })
  } catch (err) {
    console.warn('[MediaCache] 索引写入失败:', err)
  }
}

function touchEntry(entry: CacheEntry): void {
  entry.lastUsed = Date.now()
  touchedDirty = true
}

function startFlushTimer(): void {
  if (flushTimer) return
  flushTimer = setInterval(() => {
    if (touchedDirty) void saveIndex()
  }, TOUCH_FLUSH_MS)
}

async function loadIndex(): Promise<void> {
  entries.clear()
  fileToKey.clear()
  try {
    const result = await Filesystem.readFile({ path: INDEX_FILE, directory: Directory.Data })
    const parsed = parseCacheIndex(JSON.parse(base64ToUtf8(result.data as string)))
    // 按池目录做一次真实文件清单比对：索引里指向已删文件的条目直接剔除
    const present = new Map<CachePool, Set<string>>()
    for (const pool of CACHE_POOLS) present.set(pool, new Set(await listFiles(POOL_DIR[pool])))
    for (const [key, entry] of parsed) {
      if (!present.get(entry.pool)?.has(entry.file)) continue
      entries.set(key, entry)
      fileToKey.set(cacheFileKey(entry.pool, entry.file), key)
    }
  } catch {
    // 首次启动或索引损坏：空索引重来
  }
}

/**
 * 与磁盘状态对齐：清掉残留的 .part 与未登记的孤儿文件，收编历史歌词文件。
 * audio / cover 目录是我们的专属缓存目录，孤儿文件没有任何引用，留着只占额度。
 */
/**
 * 与磁盘状态对齐：清掉未登记的孤儿文件，收编历史歌词文件。
 * audio / cover 目录是我们的专属缓存目录，孤儿文件没有任何引用，留着只占额度。
 *
 * 这里**不碰** `.part`：进程存活期内半截文件只可能是正在下载的那一个，删掉它会让
 * 在途下载在 rename 时报错、白拉一遍流量。陈旧 `.part` 只可能来自上次进程被杀，
 * 清理交给 initInternal 走 cleanStaleParts 做一次即可。
 */
async function reconcilePoolDirs(): Promise<void> {
  for (const pool of CACHE_POOLS) {
    const dir = POOL_DIR[pool]
    const names = await listFiles(dir)
    if (names.length === 0) continue
    const known = new Set<string>()
    for (const entry of entries.values()) if (entry.pool === pool) known.add(entry.file)
    for (const name of names) {
      if (known.has(name)) continue
      if (name.endsWith('.part')) continue
      const full = `${dir}/${name}`
      if (!ADOPT_POOLS.includes(pool)) {
        await deleteQuiet(full)
        continue
      }
      const stat = await statQuiet(full)
      if (!stat) continue
      const stem = name.replace(/\.[^.]+$/, '')
      const indexKey = cacheBodyKey(pool, stem)
      if (entries.has(indexKey)) continue
      entries.set(indexKey, {
        pool,
        file: name,
        size: stat.size,
        // 没有原始记录，只能拿文件修改时间当最近使用时间
        lastUsed: stat.mtime,
        trackId: stem,
      })
      fileToKey.set(cacheFileKey(pool, name), indexKey)
    }
  }
}

// ─── 驱逐与登记 ──────────────────────────────────────────────

async function dropEntry(key: string, entry: CacheEntry): Promise<void> {
  await deleteQuiet(pathOf(entry))
  entries.delete(key)
  const fk = cacheFileKey(entry.pool, entry.file)
  if (fileToKey.get(fk) === key) fileToKey.delete(fk)
}

/** 超限时从最久未用的开始删，直到回到该池配额内；不限制档（0）无配额，不驱逐 */
async function evictPool(pool: CachePool): Promise<void> {
  if (limitMB <= 0) return
  const limitBytes = Math.floor(poolLimitsMB(limitMB)[pool] * 1024 * 1024)
  const doomed = selectEvictions(entries, pool, limitBytes)
  for (const key of doomed) {
    const entry = entries.get(key)
    if (entry) await dropEntry(key, entry)
  }
}

async function evictAllPools(): Promise<void> {
  for (const pool of CACHE_POOLS) await evictPool(pool)
}

async function putEntry(key: string, entry: CacheEntry): Promise<void> {
  const prev = entries.get(key)
  if (prev && prev.file !== entry.file) {
    await deleteQuiet(pathOf(prev))
    const fk = cacheFileKey(prev.pool, prev.file)
    if (fileToKey.get(fk) === key) fileToKey.delete(fk)
  }
  entries.set(key, entry)
  fileToKey.set(cacheFileKey(entry.pool, entry.file), key)
  await evictPool(entry.pool)
  await saveIndex()
}

// ─── 生命周期 ────────────────────────────────────────────────

/**
 * 清掉上次进程被杀留下的半截文件（.part）。
 * 只在初始化时调用一次：进程活着时 `.part` 必然对应一个正在进行的下载（下载器
 * 无论成功失败都会自己收拾，见 downloadToCache），此时删它只会让在途下载失败。
 */
async function cleanStaleParts(): Promise<void> {
  for (const pool of CACHE_POOLS) {
    const dir = POOL_DIR[pool]
    for (const name of await listFiles(dir)) {
      if (name.endsWith('.part')) await deleteQuiet(`${dir}/${name}`)
    }
  }
}

async function initInternal(): Promise<void> {
  for (const pool of CACHE_POOLS) await mkdirQuiet(POOL_DIR[pool])
  await mkdirQuiet(CACHE_ROOT)
  initialized = true
  // 残留 .part 先清（上次进程被杀的产物），再对齐目录，避免把半截文件当历史文件接管
  await cleanStaleParts()
  await loadIndex()
  await reconcilePoolDirs()
  // 历史文件纳入统计后可能已经超限，启动就收敛一次，而不是等下次写入
  await evictAllPools()
  await saveIndex()
  startFlushTimer()
}

/** 首次调用时加载索引（并发调用共享同一次初始化） */
async function ensureInit(): Promise<void> {
  if (initialized) return
  if (!initPromise) {
    initPromise = initInternal().catch((err) => {
      // 初始化失败不应让缓存永久失效：下次调用重试
      initPromise = null
      initialized = false
      throw err
    })
  }
  await initPromise
}

/** 下发容量档位（0 = 不限制容量，不驱逐、照常新增；已缓存内容保留） */
export async function configureMobileMediaCache(nextLimitMB: number): Promise<void> {
  const next = Number(nextLimitMB)
  limitMB = Number.isFinite(next) && next >= 0 ? Math.floor(next) : 1024
  try {
    await ensureInit()
  } catch {
    return
  }
  // 索引之外的文件（旧版本写下的歌词、半截文件）任何档位下都要对齐一次；
  // 不限制档下 evictAllPools 因配额为 0 自然不删任何东西，索引仍要落盘
  await reconcilePoolDirs()
  await evictAllPools()
  await saveIndex()
}

/** 当前占用：三类内容合计（容量是统一配额，不按类拆分） */
export async function getMobileCacheUsage(): Promise<{ usedBytes: number; count: number }> {
  try {
    await ensureInit()
  } catch {
    return { usedBytes: 0, count: 0 }
  }
  return { usedBytes: sumSizes(entries.values()), count: entries.size }
}

/** 清空全部缓存：删掉索引登记的文件，audio / cover 目录整目录重置 */
export async function clearMobileMediaCache(): Promise<void> {
  try {
    await ensureInit()
  } catch {
    return
  }
  cacheEpoch++
  for (const [key, entry] of [...entries]) {
    await deleteQuiet(pathOf(entry))
    entries.delete(key)
  }
  fileToKey.clear()
  // 专属缓存目录整目录重置，确保没有索引之外的残留（歌词目录不能整删：
  // 那里是曲库的歌词目录，只删本次登记的条目）
  for (const pool of ['audio', 'cover'] as const) {
    try {
      await Filesystem.rmdir({ path: POOL_DIR[pool], directory: Directory.Data, recursive: true })
    } catch {
      // 目录本就不存在
    }
    await mkdirQuiet(POOL_DIR[pool])
  }
  await saveIndex()
}

// ─── 下载与命中 ──────────────────────────────────────────────

/**
 * 后台下载写缓存：先写 .part 再改名，避免半截文件进索引被当成命中。
 * 走 Filesystem.downloadFile（原生 HTTP：不受 WebView CORS 限制，也不像
 * readFile 那样把整个文件转 base64 撑爆内存；缓存目录在应用专属存储，无需任何权限）。
 */
async function downloadToCache(
  pool: CachePool,
  indexKey: string,
  stem: string,
  url: string,
  headers: Record<string, string> | undefined,
  extOf: (contentType?: string | null, url?: string) => string
): Promise<void> {
  if (inflight.has(indexKey)) return
  inflight.add(indexKey)
  const epoch = cacheEpoch
  const dir = POOL_DIR[pool]
  const finalFile = `${stem}${extOf(null, url)}`
  const partPath = `${dir}/${finalFile}.part`
  const finalPath = `${dir}/${finalFile}`
  try {
    await mkdirQuiet(dir)
    await deleteQuiet(partPath)
    await Filesystem.downloadFile({
      url,
      path: partPath,
      directory: Directory.Data,
      headers: { 'User-Agent': UA, ...(headers || {}) },
      recursive: true,
    })
    const stat = await statQuiet(partPath)
    if (!stat || stat.size <= 0) {
      await deleteQuiet(partPath)
      return
    }
    // 下载期间缓存可能被整体清空：写完直接丢弃，不进索引
    if (epoch !== cacheEpoch) {
      await deleteQuiet(partPath)
      return
    }
    // 目标文件可能已存在（同一首歌换源重下）：rename 前先清掉，避免部分设备上改名失败
    await deleteQuiet(finalPath)
    await Filesystem.rename({
      from: partPath,
      to: finalPath,
      directory: Directory.Data,
      toDirectory: Directory.Data,
    })
    await putEntry(indexKey, { pool, file: finalFile, size: stat.size, lastUsed: Date.now(), url })
  } catch (err) {
    console.warn('[MediaCache] 后台缓存失败:', (err as Error)?.message || err)
    await deleteQuiet(partPath)
  } finally {
    inflight.delete(indexKey)
  }
}

/**
 * 命中解析：命中返回可直接加载的本地地址；未命中返回 null 并触发后台下载。
 * 文件名主体用 sha1(缓存键)——直链会变，只有稳定键的哈希能当文件名。
 */
async function resolveCachedMedia(
  pool: CachePool,
  req: { url: string; key: string; headers?: Record<string, string> }
): Promise<{ src: string | null }> {
  if (!req || typeof req.url !== 'string' || !/^https?:\/\//i.test(req.url) || !req.key) {
    return { src: null }
  }
  try {
    await ensureInit()
  } catch {
    return { src: null }
  }
  const stem = hashCacheKey(req.key)
  const indexKey = cacheBodyKey(pool, stem)
  const entry = entries.get(indexKey)
  if (entry) {
    // 文件可能被外部清理（系统清理应用缓存、用户清空数据）：查一次真实存在性
    const stat = await statQuiet(pathOf(entry))
    if (stat && stat.size > 0) {
      entry.size = stat.size
      touchEntry(entry)
      try {
        const uri = await poolUriOf(pool)
        return { src: toLoadableSrc(`${uri}/${entry.file}`) }
      } catch {
        // getUri 失败不影响本次播放：退回远端地址
        return { src: null }
      }
    }
    await dropEntry(indexKey, entry)
  }
  // 未命中就后台拉一份：任何档位都缓存，不限制档只是不做驱逐
  void downloadToCache(pool, indexKey, stem, req.url, req.headers, pool === 'audio' ? audioExtFrom : imageExtFrom)
  return { src: null }
}

/** 音频命中解析（渲染层播放前调用） */
export function resolveMobileCachedAudio(req: {
  url: string
  key: string
  headers?: Record<string, string>
}): Promise<{ src: string | null }> {
  return resolveCachedMedia('audio', req)
}

/** 远端封面命中解析，语义与音频一致 */
export function resolveMobileCachedCover(req: {
  url: string
  key: string
  headers?: Record<string, string>
}): Promise<{ src: string | null }> {
  return resolveCachedMedia('cover', req)
}

// ─── 歌词登记（scanner 读写曲库歌词时调用）─────────────────────

/** 歌词落盘后登记，使其计入占用并受歌词池配额约束 */
export async function registerLyricsFile(trackId: string, size: number): Promise<void> {
  if (!trackId || !Number.isFinite(size) || size <= 0) return
  try {
    await ensureInit()
  } catch {
    return
  }
  await putEntry(cacheBodyKey('lyrics', trackId), {
    pool: 'lyrics',
    file: `${trackId}.lrc`,
    size,
    lastUsed: Date.now(),
    trackId,
  })
}

/** 歌词命中即刷新最近使用时间；未登记的历史文件顺带补登记 */
export async function touchLyricsFile(trackId: string, size: number): Promise<void> {
  if (!trackId) return
  try {
    await ensureInit()
  } catch {
    return
  }
  const indexKey = cacheBodyKey('lyrics', trackId)
  const entry = entries.get(indexKey)
  if (!entry) {
    await registerLyricsFile(trackId, size)
    return
  }
  if (Number.isFinite(size) && size > 0) entry.size = size
  touchEntry(entry)
}
