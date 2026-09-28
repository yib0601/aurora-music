/**
 * 媒体缓存（桌面端主进程）
 *
 * 三类内容共用一份磁盘配额：在线播放音频、曲目封面、歌词文本。总量由渲染层
 * 设置页下发（持久化在 libraryStore），内部按固定比例切给三个池——音频 80%、
 * 封面 15%、歌词 5%——池内各自按 lastUsed 做 LRU 驱逐，某类内容暴涨（例如一次
 * 扫进几千张封面）不会把另一类挤到不可用。
 *
 * 在线歌源直链有效期通常只有几十分钟，URL 本身不能当缓存键：音频按「来源 id +
 * 歌曲 id」推导稳定键，封面按远端地址或曲目 id 推导。命中时地址换成
 * aurora-cache://<pool>/<file> 自定义协议（支持 Range，seek 可用）；未命中不阻塞
 * 播放与渲染——先用原始地址，主进程在后台拉进缓存，下次即命中。
 *
 * 封面与歌词沿用既有落盘目录（<userData>/aurora-music/covers|lyrics，路径已写进
 * 曲库记录），只是同时登记进索引参与配额统计与驱逐；封面被驱逐时通过 evict
 * 通知回调清理曲库里的 coverPath，下次显示封面会按需重新提取，不留悬空路径。
 *
 * limitMB 为 0 表示关闭缓存：不再新增缓存，磁盘上已有的文件保留（要腾空间
 * 走显式的「清空缓存」，见 configureMediaCache）。
 */
import { app, ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

export const CACHE_SCHEME = 'aurora-cache'

/** 缓存池：三类内容各自独立配额与 LRU，共享同一份总量配置 */
export type CachePool = 'audio' | 'cover' | 'lyrics'

const POOLS: readonly CachePool[] = ['audio', 'cover', 'lyrics']

/** 总量切给各池的比例（音频占大头，封面次之，歌词文本极小） */
const POOL_RATIO: Record<CachePool, number> = { audio: 0.8, cover: 0.15, lyrics: 0.05 }

/**
 * 各池最低配额（MB）：容量档位很小时按比例切出的额度放不下基本用量，
 * 这里兜底，避免某一类内容被压成 0 而完全失去缓存意义。
 */
const POOL_MIN_MB: Record<CachePool, number> = { audio: 16, cover: 8, lyrics: 4 }

/**
 * 各池落盘目录（相对 userData）。
 * 封面与歌词沿用原目录：路径已写进曲库记录与渲染层，迁目录只会平添一次性重写
 * 风险；这里仅把文件登记进统一索引，参与配额统计与驱逐。
 */
const POOL_SUBDIR: Record<CachePool, string> = {
  audio: 'audio-cache',
  cover: path.join('aurora-music', 'covers'),
  lyrics: path.join('aurora-music', 'lyrics'),
}

interface CacheEntry {
  pool: CachePool
  /** 所在池目录内的文件名（含扩展名） */
  file: string
  size: number
  lastUsed: number
  /** 来源直链，仅用于排查，不参与命中判断 */
  url?: string
  /** 关联曲目 id（封面、歌词）：驱逐时据此回填曲库 */
  trackId?: string
}

interface CacheIndex {
  version: number
  entries: Record<string, CacheEntry>
}

const INDEX_FILE = 'index.json'
const INDEX_VERSION = 2
/** 命中只改内存的 lastUsed，攒一会儿再落盘：播放中的 Range 请求会高频命中 */
const TOUCH_FLUSH_MS = 60000

export interface CacheEvictPayload {
  pool: CachePool
  trackId?: string
  filePath: string
}

let userDataDir = ''
let initialized = false
let limitMB = 1024
/** 索引键（`<pool>:<stem>`）→ 条目 */
const entries = new Map<string, CacheEntry>()
/** `<pool>:<文件名>` → 索引键：协议请求只带 pool 与文件名，据此 O(1) 反查（兼作路径白名单） */
const fileToKey = new Map<string, string>()
/** 同一目标的并发下载去重：直链失效/网络慢时避免重复拉流 */
const inflight = new Set<string>()
/** 命中改过 lastUsed 但还没落盘的标记 */
let touchedDirty = false
let flushTimer: ReturnType<typeof setInterval> | null = null
/**
 * 清空代数：清空会把索引整体抹掉，而此刻可能还有下载卡在 await 上。
 * 下载完成时比对代数，发现期间被清空就直接丢弃，不重新登记（否则用户点了
 * 「清空缓存」却看到占用又涨回去，且那个文件没有任何曲目引用它）。
 */
let cacheEpoch = 0
let evictListener: ((payload: CacheEvictPayload) => void) | null = null
let clearListener: ((removedCoverFiles: string[]) => void) | null = null

/** 注册驱逐通知：封面被清出缓存时由调用方（handlers）清理曲库里的 coverPath */
export function setCacheEvictListener(fn: ((payload: CacheEvictPayload) => void) | null): void {
  evictListener = fn
}

/** 注册清空通知：带上被删掉的封面文件清单，调用方据此精确回填曲库 */
export function setCacheClearListener(fn: ((removedCoverFiles: string[]) => void) | null): void {
  clearListener = fn
}

// ─── 容量分配 ────────────────────────────────────────────────

/**
 * 把总容量按比例切给各池（MB）。比例切完不足最低配额的按最低配额补；
 * 补完若超过总量（容量档位很小时会发生）再等比缩回，保证各池之和不超过总量。
 */
export function poolLimitsMB(totalMB: number): Record<CachePool, number> {
  const zero: Record<CachePool, number> = { audio: 0, cover: 0, lyrics: 0 }
  if (!Number.isFinite(totalMB) || totalMB <= 0) return zero
  const raw = {} as Record<CachePool, number>
  let sum = 0
  for (const pool of POOLS) {
    raw[pool] = Math.max(totalMB * POOL_RATIO[pool], POOL_MIN_MB[pool])
    sum += raw[pool]
  }
  if (sum <= totalMB) return raw
  const scale = totalMB / sum
  for (const pool of POOLS) raw[pool] *= scale
  return raw
}

function poolLimitBytes(pool: CachePool): number {
  return Math.floor(poolLimitsMB(limitMB)[pool] * 1024 * 1024)
}

function poolUsedBytes(pool: CachePool): number {
  let sum = 0
  for (const entry of entries.values()) if (entry.pool === pool) sum += entry.size
  return sum
}

function totalUsedBytes(): number {
  let sum = 0
  for (const entry of entries.values()) sum += entry.size
  return sum
}

// ─── 索引 ────────────────────────────────────────────────────

function poolDirOf(pool: CachePool): string {
  return path.join(userDataDir, POOL_SUBDIR[pool])
}

function bodyKey(pool: CachePool, stem: string): string {
  return `${pool}:${stem}`
}

function fileKey(pool: CachePool, file: string): string {
  return `${pool}:${file}`
}

function indexPath(): string {
  return path.join(poolDirOf('audio'), INDEX_FILE)
}

function hashKey(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex')
}

function saveIndex(): void {
  if (!initialized) return
  touchedDirty = false
  try {
    // 目录可能被手动删除，写索引前自愈
    fs.mkdirSync(poolDirOf('audio'), { recursive: true })
    const payload: CacheIndex = { version: INDEX_VERSION, entries: Object.fromEntries(entries) }
    fs.writeFileSync(indexPath(), JSON.stringify(payload), 'utf-8')
  } catch (err) {
    console.warn('[MediaCache] 索引写入失败:', err)
  }
}

/**
 * 刷新条目的最近使用时间。
 * 只改内存并置脏标记：命中发生在播放热路径上（一次播放会发很多 Range 请求），
 * 每次都同步重写整份索引会让主进程在拖动进度条时卡顿。定时 flush + 结构性
 * 变更时立即落盘，崩溃最多丢一个刷新周期的 LRU 精度。
 */
function touchEntry(entry: CacheEntry): void {
  entry.lastUsed = Date.now()
  touchedDirty = true
}

function flushTouched(): void {
  if (touchedDirty) saveIndex()
}

/** 加载索引并校验文件完整性：索引存在但文件丢失的条目直接剔除 */
function loadIndex(): void {
  entries.clear()
  fileToKey.clear()
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(), 'utf-8')) as {
      version?: number
      entries?: Record<string, CacheEntry>
    }
    if (!parsed || !parsed.entries || typeof parsed.entries !== 'object') return
    // 旧版索引只有音频一类，键即 sha1(缓存键)，与现音频键同构，补上池前缀即可直接沿用
    const current = parsed.version === INDEX_VERSION
    for (const [key, raw] of Object.entries(parsed.entries)) {
      if (!raw || typeof raw.file !== 'string' || typeof raw.size !== 'number') continue
      const pool: CachePool = current ? raw.pool : 'audio'
      if (!POOLS.includes(pool)) continue
      const indexKey = current ? key : bodyKey('audio', key)
      const entry: CacheEntry = {
        pool,
        file: raw.file,
        size: raw.size,
        lastUsed: Number(raw.lastUsed) || Date.now(),
        url: typeof raw.url === 'string' ? raw.url : undefined,
        trackId: typeof raw.trackId === 'string' ? raw.trackId : undefined,
      }
      if (!fs.existsSync(path.join(poolDirOf(pool), entry.file))) continue
      entries.set(indexKey, entry)
      fileToKey.set(fileKey(pool, entry.file), indexKey)
    }
  } catch {
    // 首次启动或索引损坏：空索引重来
  }
}

/**
 * 收编目录里未登记的文件：老版本的音频缓存、历史封面与歌词文件都没进过索引，
 * 不接管就永远不受配额约束，磁盘占用只涨不降。半截临时文件（.part）永远无法
 * 命中，直接清掉。
 */
function adoptExistingFiles(): void {
  for (const pool of POOLS) {
    const dir = poolDirOf(pool)
    let names: string[] = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (name === INDEX_FILE) continue
      if (name.endsWith('.part')) {
        try {
          fs.unlinkSync(path.join(dir, name))
        } catch {
          // 忽略
        }
        continue
      }
      const fk = fileKey(pool, name)
      if (fileToKey.has(fk)) continue
      let stat: fs.Stats
      try {
        stat = fs.statSync(path.join(dir, name))
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      const stem = name.replace(/\.[^.]+$/, '')
      const indexKey = bodyKey(pool, stem)
      if (entries.has(indexKey)) continue
      // 没有原始记录，只能拿文件修改时间当最近使用时间
      entries.set(indexKey, {
        pool,
        file: name,
        size: stat.size,
        lastUsed: stat.mtimeMs || Date.now(),
        trackId: pool === 'audio' ? undefined : stem,
      })
      fileToKey.set(fk, indexKey)
    }
  }
}

// ─── 驱逐 ────────────────────────────────────────────────────

/**
 * 删除条目：文件、索引、反查表一起清，并通知调用方（曲库里的悬空引用由它回填）。
 * 池超限驱逐走这里；整池清空批量处理，逐条通知反而拖慢（见 clearMediaCache）。
 */
function dropEntry(key: string, entry: CacheEntry, notify = true): void {
  const abs = path.join(poolDirOf(entry.pool), entry.file)
  try {
    fs.unlinkSync(abs)
  } catch {
    // 文件已不在，只清索引
  }
  entries.delete(key)
  const fk = fileKey(entry.pool, entry.file)
  if (fileToKey.get(fk) === key) fileToKey.delete(fk)
  if (notify && evictListener) {
    try {
      evictListener({ pool: entry.pool, trackId: entry.trackId, filePath: abs })
    } catch (err) {
      console.warn('[MediaCache] 驱逐回调失败:', (err as Error).message)
    }
  }
}

/** 超限时从最久未用的开始删，直到回到该池配额内 */
function evictPool(pool: CachePool): void {
  // 关闭档位（0）视为「冻结」：不再新增也不再淘汰，磁盘上已有的文件保持原样。
  // 配置项被重新解释就静默删掉用户已有的歌词与封面，是没人能预料到的行为；
  // 腾空间由用户显式按「清空缓存」完成。
  if (limitMB <= 0) return
  const limitBytes = poolLimitBytes(pool)
  let used = poolUsedBytes(pool)
  if (used <= limitBytes) return
  const candidates = [...entries.entries()]
    .filter(([, entry]) => entry.pool === pool)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  for (const [key, entry] of candidates) {
    if (used <= limitBytes) break
    dropEntry(key, entry)
    used -= entry.size
  }
}

function evictAllPools(): void {
  for (const pool of POOLS) evictPool(pool)
}

/** 登记条目并按池配额驱逐，最后落盘索引 */
function putEntry(key: string, entry: CacheEntry): void {
  const prev = entries.get(key)
  if (prev && prev.file !== entry.file) {
    try {
      fs.unlinkSync(path.join(poolDirOf(prev.pool), prev.file))
    } catch {
      // 忽略
    }
    const fk = fileKey(prev.pool, prev.file)
    if (fileToKey.get(fk) === key) fileToKey.delete(fk)
  }
  entries.set(key, entry)
  fileToKey.set(fileKey(entry.pool, entry.file), key)
  evictPool(entry.pool)
  saveIndex()
}

// ─── 生命周期 ────────────────────────────────────────────────

/** 启动时加载索引、接管历史文件并做一次容量收敛 */
export function initMediaCache(): void {
  try {
    userDataDir = app.getPath('userData')
    for (const pool of POOLS) fs.mkdirSync(poolDirOf(pool), { recursive: true })
    initialized = true
    loadIndex()
    adoptExistingFiles()
    // 历史文件纳入统计后可能已经超限，启动就收敛一次，而不是等下次写入
    evictAllPools()
    saveIndex()
    // 命中只改内存里的 lastUsed（见 touchEntry），定时落盘即可：播放中的
    // Range 请求会高频命中，每次同步重写整份索引会把主进程卡住
    if (!flushTimer) {
      flushTimer = setInterval(flushTouched, TOUCH_FLUSH_MS)
      flushTimer.unref?.()
    }
  } catch (err) {
    console.warn('[MediaCache] 初始化失败:', err)
  }
}

function configureMediaCache(nextLimitMB: number): void {
  const next = Number(nextLimitMB)
  limitMB = Number.isFinite(next) && next >= 0 ? Math.floor(next) : 1024
  if (!initialized) return
  if (limitMB <= 0) return
  // 关闭档位期间写下的封面不会进索引，从关闭改回有容量时先收编一次，
  // 否则这批文件既不计入占用也不受配额约束
  adoptExistingFiles()
  evictAllPools()
  saveIndex()
}

function clearMediaCache(): void {
  // 整池清空：逐条通知会让调用方对着几百上千条记录各写一次库，这里把被删的
  // 封面文件收集起来一次性通知；不能按目录整片清库——同目录里还有没纳入缓存的
  // 曲库封面，那部分记录必须原样保留
  cacheEpoch++
  const removedCovers: string[] = []
  for (const [key, entry] of [...entries.entries()]) {
    if (entry.pool === 'cover') removedCovers.push(path.join(poolDirOf('cover'), entry.file))
    dropEntry(key, entry, false)
  }
  entries.clear()
  fileToKey.clear()
  saveIndex()
  if (clearListener && removedCovers.length > 0) {
    try {
      clearListener(removedCovers)
    } catch (err) {
      console.warn('[MediaCache] 清空回调失败:', (err as Error).message)
    }
  }
}

/** 当前占用：三类内容合计，不再按类拆分（容量是统一配额） */
export function getCacheUsage(): { usedBytes: number; count: number } {
  return { usedBytes: totalUsedBytes(), count: entries.size }
}

// ─── 下载 ────────────────────────────────────────────────────

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** Content-Type → 扩展名（与 handlers.ts 的 inferAudioExtension 同源逻辑） */
function audioExtFrom(contentType?: string | null, fallbackUrl?: string): string {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase()
  const ctMap: Record<string, string> = {
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/flac': '.flac',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/aac': '.aac',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
  }
  if (ctMap[ct]) return ctMap[ct]
  try {
    if (fallbackUrl) {
      const pathname = new URL(fallbackUrl).pathname
      const ext = pathname.slice(pathname.lastIndexOf('.')).toLowerCase()
      if (['.mp3', '.flac', '.ogg', '.wav', '.aac', '.m4a', '.opus'].includes(ext)) return ext
    }
  } catch {
    // 忽略
  }
  return '.mp3'
}

/** Content-Type → 扩展名（图片）；歌源封面多为 jpeg，判不出来时按 jpg 存 */
function imageExtFrom(contentType?: string | null, fallbackUrl?: string): string {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase()
  const ctMap: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
  }
  if (ctMap[ct]) return ctMap[ct]
  try {
    if (fallbackUrl) {
      const pathname = new URL(fallbackUrl).pathname
      const ext = pathname.slice(pathname.lastIndexOf('.')).toLowerCase()
      if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext)) return ext === '.jpeg' ? '.jpg' : ext
    }
  } catch {
    // 忽略
  }
  return '.jpg'
}

/** 后台拉流写缓存：先写临时文件再原子改名，避免半截文件进索引 */
async function downloadToCache(
  pool: CachePool,
  indexKey: string,
  stem: string,
  url: string,
  headers: Record<string, string> | undefined,
  extOf: (contentType: string | null, url: string) => string
): Promise<void> {
  if (inflight.has(indexKey)) return
  inflight.add(indexKey)
  const epoch = cacheEpoch
  try {
    const dir = poolDirOf(pool)
    // 目录可能被用户手动删除，写入前自愈
    fs.mkdirSync(dir, { recursive: true })
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, ...(headers || {}) },
      // 与歌曲下载同口径：10 分钟上限
      signal: AbortSignal.timeout(600000),
    })
    if (!resp.ok || !resp.body) {
      console.warn(`[MediaCache] 下载失败：HTTP ${resp.status}`, url)
      return
    }
    const ext = extOf(resp.headers.get('content-type'), url)
    const finalFile = `${stem}${ext}`
    const tmpPath = path.join(dir, `${finalFile}.part`)
    const finalPath = path.join(dir, finalFile)
    await pipeline(Readable.fromWeb(resp.body as any), fs.createWriteStream(tmpPath))

    // 下载期间缓存可能被关闭或整体清空：写完直接丢弃，不进索引
    // （清空场景若照常登记，用户会看到「清空缓存」后占用又涨回去）
    if (limitMB <= 0 || epoch !== cacheEpoch) {
      fs.unlinkSync(tmpPath)
      return
    }
    fs.renameSync(tmpPath, finalPath)
    const size = fs.statSync(finalPath).size
    putEntry(indexKey, { pool, file: finalFile, size, lastUsed: Date.now(), url })
  } catch (err) {
    console.warn('[MediaCache] 后台缓存失败:', (err as Error).message)
  } finally {
    inflight.delete(indexKey)
  }
}

// ─── 命中解析 ────────────────────────────────────────────────

function cacheUrlFor(pool: CachePool, file: string): string {
  return `${CACHE_SCHEME}://localhost/${pool}/${encodeURIComponent(file)}`
}

/**
 * 命中返回缓存协议地址；未命中返回 null。
 * 文件名主体用 sha1(缓存键)：原键（直链、地址）随时会变，只有稳定键的哈希能当文件名。
 * 关闭档位（0）视为「冻结」：已有内容照常命中，但不再拉取新内容。
 */
function resolveCachedAsset(
  pool: CachePool,
  rawKey: string,
  url: string,
  headers: Record<string, string> | undefined,
  extOf: (contentType: string | null, url: string) => string
): { src: string | null } {
  if (!initialized) return { src: null }
  const stem = hashKey(rawKey)
  const indexKey = bodyKey(pool, stem)
  const entry = entries.get(indexKey)
  if (entry && fs.existsSync(path.join(poolDirOf(pool), entry.file))) {
    touchEntry(entry)
    return { src: cacheUrlFor(pool, entry.file) }
  }
  // 索引有但文件没了：清掉脏条目（顺带让调用方回填曲库里的悬空引用）
  if (entry) dropEntry(indexKey, entry)
  // 关闭档位只冻结已有内容，不再拉新的
  if (limitMB > 0) void downloadToCache(pool, indexKey, stem, url, headers, extOf)
  return { src: null }
}

/** 渲染层播放前调用：命中返回缓存协议地址；未命中返回 null 并触发后台下载 */
export function resolveCachedAudio(
  key: string,
  url: string,
  headers?: Record<string, string>
): { src: string | null } {
  return resolveCachedAsset('audio', key, url, headers, audioExtFrom)
}

/** 远端封面（在线曲目的 coverUrl）命中解析，语义与音频一致 */
export function resolveCachedCover(
  key: string,
  url: string,
  headers?: Record<string, string>
): { src: string | null } {
  return resolveCachedAsset('cover', key, url, headers, imageExtFrom)
}

// ─── 封面 / 歌词登记 ────────────────────────────────────────

/**
 * 忘记某个文件：文件被外部删除时由调用方通知（删曲目会清理其封面文件）。
 * 不通知的话索引里会留下一个永远命不中却一直占额度的僵尸条目，占用只涨不降。
 */
export function forgetCachedFile(filePath: string): void {
  forgetCachedFiles([filePath])
}

/** 批量版：移除整个扫描目录时逐条落盘会写出大量无效 IO，这里共用一次索引写入 */
export function forgetCachedFiles(filePaths: readonly string[]): void {
  if (!initialized || filePaths.length === 0) return
  let changed = false
  for (const filePath of filePaths) {
    if (!filePath) continue
    const abs = path.resolve(filePath)
    const dir = path.dirname(abs)
    const name = path.basename(abs)
    for (const [key, entry] of entries) {
      if (entry.file !== name || path.resolve(poolDirOf(entry.pool)) !== dir) continue
      entries.delete(key)
      const fk = fileKey(entry.pool, entry.file)
      if (fileToKey.get(fk) === key) fileToKey.delete(fk)
      changed = true
      break
    }
  }
  if (changed) saveIndex()
}

/**
 * 封面落盘后登记（scanner / librarySource 写完文件调用）。
 *
 * 无论档位如何都要登记：封面提取本身是曲库功能，写下的文件必须计入占用，
 * 否则它既不被配额约束、也不被「清空缓存」删掉，只会静默堆积（关闭档位下
 * 尤其明显）。关闭档位不删文件由 evictPool 的冻结语义保证，不靠跳过登记。
 */
export function registerCoverFile(trackId: string, filePath: string): void {
  if (!initialized) return
  const dir = poolDirOf('cover')
  if (path.dirname(path.resolve(filePath)) !== path.resolve(dir)) return
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    return
  }
  putEntry(bodyKey('cover', trackId), {
    pool: 'cover',
    file: path.basename(filePath),
    size: stat.size,
    lastUsed: Date.now(),
    trackId,
  })
}

/**
 * 读取歌词并刷新最近使用时间；文件不在时返回 null 由调用方走在线搜索。
 * 关闭档位下照读：缓存只是不再增长，已有内容继续可用。
 */
export function readCachedLyrics(trackId: string): string | null {
  if (!initialized) return null
  const file = `${trackId}.lrc`
  const abs = path.join(poolDirOf('lyrics'), file)
  let content: string
  try {
    content = fs.readFileSync(abs, 'utf-8')
  } catch {
    const stale = entries.get(bodyKey('lyrics', trackId))
    if (stale) dropEntry(bodyKey('lyrics', trackId), stale)
    return null
  }
  const size = Buffer.byteLength(content, 'utf-8')
  const indexKey = bodyKey('lyrics', trackId)
  const entry = entries.get(indexKey)
  if (entry) {
    // 命中即刷新：歌词很小，读一次就更新使用时间，常用歌词不会被当冷数据清掉
    entry.size = size
    touchEntry(entry)
  } else {
    putEntry(indexKey, { pool: 'lyrics', file, size, lastUsed: Date.now(), trackId })
  }
  return content
}

/** 写入歌词并登记；关闭档位不写盘（不增长），已有文件不受影响 */
export function writeCachedLyrics(trackId: string, content: string): string {
  const dir = poolDirOf('lyrics')
  const abs = path.join(dir, `${trackId}.lrc`)
  if (!initialized) return abs
  if (limitMB <= 0) return abs
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(abs, content, 'utf-8')
  } catch (err) {
    console.warn('[MediaCache] 歌词写入失败:', (err as Error).message)
    return abs
  }
  putEntry(bodyKey('lyrics', trackId), {
    pool: 'lyrics',
    file: `${trackId}.lrc`,
    size: Buffer.byteLength(content, 'utf-8'),
    lastUsed: Date.now(),
    trackId,
  })
  return abs
}

// ─── 协议与 IPC ─────────────────────────────────────────────

/** aurora-cache://<pool>/<file> 处理：读本地缓存文件，支持 Range（seek 依赖） */
export async function serveCachedMedia(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const segments = url.pathname
      .replace(/^\/+/, '')
      .split('/')
      .map((s) => decodeURIComponent(s))
    // 旧版本地址只有文件名（当时只有音频），按音频池兜底，老页面不会直接 404
    const hasPool = segments.length > 1 && (POOLS as readonly string[]).includes(segments[0])
    const pool: CachePool = hasPool ? (segments[0] as CachePool) : 'audio'
    const file = hasPool ? segments[1] : segments[0]
    if (!file) return new Response('', { status: 400 })

    // 只认索引里的文件：路径来自索引而非请求，天然免疫路径穿越
    const indexKey = fileToKey.get(fileKey(pool, file))
    const entry = indexKey ? entries.get(indexKey) : undefined
    if (!entry) return new Response('', { status: 404 })
    const filePath = path.join(poolDirOf(entry.pool), entry.file)
    const stat = await fs.promises.stat(filePath)

    const ext = path.extname(file).toLowerCase()
    const mimeMap: Record<string, string> = {
      '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
      '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.opus': 'audio/ogg',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
    }
    const mime = mimeMap[ext] || 'application/octet-stream'

    // 命中即刷新 lastUsed：协议请求本身就是「正在使用」的最强信号
    touchEntry(entry)

    const range = request.headers.get('range')
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range)
      if (m) {
        const start = parseInt(m[1], 10)
        // 越界与倒序区间一律 416：照原样回 206 会给出 end ≥ size 的非法
        // Content-Range，且声明长度与实际可读字节不符，播放端直接报错
        if (start >= stat.size) {
          return new Response('', {
            status: 416,
            headers: { 'Content-Range': `bytes */${stat.size}` },
          })
        }
        const end = Math.min(m[2] ? parseInt(m[2], 10) : stat.size - 1, stat.size - 1)
        if (end < start) {
          return new Response('', {
            status: 416,
            headers: { 'Content-Range': `bytes */${stat.size}` },
          })
        }
        // 流式返回：整段读进内存再 concat 会让一个大无损文件（几十上百 MB）
        // 在主进程里峰值翻倍，叠加预加载足以把播放器顶崩
        const stream = fs.createReadStream(filePath, { start, end })
        return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
          },
        })
      }
    }
    const buf = await fs.promises.readFile(filePath)
    return new Response(buf, {
      headers: { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' },
    })
  } catch {
    return new Response('', { status: 404 })
  }
}

export function registerMediaCacheIpc(): void {
  const validResolveReq = (req: { url?: unknown; key?: unknown } | undefined): boolean =>
    !!req && typeof req.url === 'string' && /^https?:\/\//i.test(req.url) && !!req.key

  ipcMain.handle(
    'cache:resolve',
    (_event, req: { url: string; key: string; headers?: Record<string, string> }) => {
      if (!validResolveReq(req)) return { src: null }
      return resolveCachedAudio(req.key, req.url, req.headers)
    }
  )

  ipcMain.handle(
    'cache:resolveCover',
    (_event, req: { url: string; key: string; headers?: Record<string, string> }) => {
      if (!validResolveReq(req)) return { src: null }
      return resolveCachedCover(req.key, req.url, req.headers)
    }
  )

  ipcMain.handle('cache:configure', (_event, opts: { limitMB: number }) => {
    configureMediaCache(Number(opts?.limitMB))
  })

  ipcMain.handle('cache:usage', () => getCacheUsage())

  ipcMain.handle('cache:clear', () => {
    clearMediaCache()
  })
}
