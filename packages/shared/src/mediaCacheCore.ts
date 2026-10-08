/**
 * 媒体缓存核心（纯逻辑，无 IO）
 *
 * 音频 / 封面 / 歌词三类内容共用一份磁盘配额，按固定比例切给三个池，
 * 池内各自按 lastUsed 做 LRU 驱逐：某类内容暴涨（例如一次扫进几千张封面）
 * 不会把另一类挤到不可用。容量档位为 0 是「不限制」档：不切配额、不驱逐，
 * 各端据此照常写入新内容。
 *
 * 这里是桌面端主进程与移动端**唯一**的缓存口径来源：容量分配、使用量统计、驱逐选择、
 * 索引解析与序列化、扩展名推断、稳定文件名（sha1）、索引键拼法、默认 UA 与刷新间隔
 * 全在此处，两端只保留各自「怎么落盘」的部分（Electron 的 node:fs / Android 的
 * Capacitor Filesystem）。历史上两端各写一份，2026-10 合并——改一端漏一端会让桌面与
 * 手机对同一份配额算出不同结果、或对同一个键算出不同文件名而互相读不到缓存。
 * 因此本模块不引入任何平台 API，可直接跑单元测试。
 *
 * 各端仍保留的有意差异见 desktop/src/ipc/mediaCache.ts 与
 * app/src/services/platform/mobile/mediaCache.ts 的注释（落盘目录、索引文件读取方式、
 * 封面是否纳入配额、.part 命名等）。
 */

/** 缓存池：三类内容各自独立配额与 LRU，共享同一份总量配置 */
export const CACHE_POOLS = ['audio', 'cover', 'lyrics'] as const

export type CachePool = (typeof CACHE_POOLS)[number]

/**
 * 后台拉流缓存用的默认 User-Agent。
 * 放在这里而不是各端各写一份：两端拉的是同一批歌源/图床，UA 一旦只有一端更新，
 * 就会出现「桌面能缓存、手机被源站挡掉」这种只在单端复现的问题。
 */
export const CACHE_FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * 命中只改内存里的 lastUsed、攒一会儿再落盘的间隔（毫秒）。
 * 两端共用：命中发生在播放热路径上（一次播放会发很多 Range 请求），
 * 每次都同步重写整份索引会让主进程/WebView 在拖动进度条时卡顿。
 */
export const CACHE_TOUCH_FLUSH_MS = 60000

export interface CacheEntry {
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

/** 索引版本：2 起条目自带 pool；1（或缺失）是只有音频单池的旧格式 */
export const CACHE_INDEX_VERSION = 2

/** 总量切给各池的比例（音频占大头，封面次之，歌词文本极小） */
export const POOL_RATIO: Record<CachePool, number> = { audio: 0.8, cover: 0.15, lyrics: 0.05 }

/**
 * 各池最低配额（MB）：容量档位很小时按比例切出的额度放不下基本用量，
 * 这里兜底，避免某一类内容被压成 0 而完全失去缓存意义。
 */
export const POOL_MIN_MB: Record<CachePool, number> = { audio: 16, cover: 8, lyrics: 4 }

/**
 * 把总容量按比例切给各池（MB）。比例切完不足最低配额的按最低配额补；
 * 补完若超过总量（容量档位很小时会发生）再等比缩回，保证各池之和不超过总量。
 * totalMB ≤ 0 是「不限制」档：三池都不分配配额，调用方据此跳过驱逐，
 * 而不是停止缓存——继续拉新、继续写盘，占用不设上限。
 */
export function poolLimitsMB(totalMB: number): Record<CachePool, number> {
  const raw = {} as Record<CachePool, number>
  if (!Number.isFinite(totalMB) || totalMB <= 0) {
    for (const pool of CACHE_POOLS) raw[pool] = 0
    return raw
  }
  let sum = 0
  for (const pool of CACHE_POOLS) {
    raw[pool] = Math.max(totalMB * POOL_RATIO[pool], POOL_MIN_MB[pool])
    sum += raw[pool]
  }
  if (sum <= totalMB) return raw
  const scale = totalMB / sum
  for (const pool of CACHE_POOLS) raw[pool] *= scale
  return raw
}

/** 索引键：`<pool>:<主体>`（主体通常是缓存键的哈希） */
export function cacheBodyKey(pool: CachePool, stem: string): string {
  return `${pool}:${stem}`
}

/** 反查键：`<pool>:<文件名>`；协议请求只带池与文件名，据此 O(1) 定位 */
export function cacheFileKey(pool: CachePool, file: string): string {
  return `${pool}:${file}`
}

/** 某一池（或全部池，pool 省略时）的占用字节数 */
export function sumSizes(entries: Iterable<CacheEntry>, pool?: CachePool): number {
  let sum = 0
  for (const entry of entries) {
    if (pool && entry.pool !== pool) continue
    sum += entry.size
  }
  return sum
}

/**
 * 超限时挑出该池要删的条目（最久未用优先），返回索引键列表。
 * 只做选择不做删除：落盘由各端执行，选择逻辑保持可测。
 * limitBytes ≤ 0 时返回空数组——0 是「不限制」档：不驱逐任何条目，
 * 已有内容原样保留，腾空间由用户显式「清空缓存」完成。
 */
export function selectEvictions(
  entries: Iterable<[string, CacheEntry]>,
  pool: CachePool,
  limitBytes: number
): string[] {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return []
  const candidates: Array<[string, CacheEntry]> = []
  let used = 0
  for (const [key, entry] of entries) {
    if (entry.pool !== pool) continue
    candidates.push([key, entry])
    used += entry.size
  }
  if (used <= limitBytes) return []
  candidates.sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  const doomed: string[] = []
  for (const [key, entry] of candidates) {
    if (used <= limitBytes) break
    doomed.push(key)
    used -= entry.size
  }
  return doomed
}

/** 解析索引 JSON（含 v1 单池格式升级）；结构非法的条目直接丢弃 */
export function parseCacheIndex(raw: unknown): Map<string, CacheEntry> {
  const out = new Map<string, CacheEntry>()
  const parsed = raw as { version?: number; entries?: Record<string, CacheEntry> } | null
  if (!parsed || !parsed.entries || typeof parsed.entries !== 'object') return out
  // 旧版索引只有音频一类，键即 sha1(缓存键)，与现音频键同构，补上池前缀即可直接沿用
  const current = parsed.version === CACHE_INDEX_VERSION
  for (const [key, value] of Object.entries(parsed.entries)) {
    if (!value || typeof value.file !== 'string' || typeof value.size !== 'number') continue
    const pool: CachePool = current ? value.pool : 'audio'
    if (!CACHE_POOLS.includes(pool)) continue
    const indexKey = current ? key : cacheBodyKey('audio', key)
    out.set(indexKey, {
      pool,
      file: value.file,
      size: value.size,
      lastUsed: Number(value.lastUsed) || Date.now(),
      url: typeof value.url === 'string' ? value.url : undefined,
      trackId: typeof value.trackId === 'string' ? value.trackId : undefined,
    })
  }
  return out
}

/** 序列化索引：条目按索引键落成对象，读回时顺序与语义都不依赖 */
export function serializeCacheIndex(entries: Iterable<[string, CacheEntry]>): string {
  return JSON.stringify({ version: CACHE_INDEX_VERSION, entries: Object.fromEntries(entries) })
}

/** 从 URL 路径取扩展名，命中白名单才返回 */
function extFromUrl(url: string | undefined, allowed: readonly string[], fallback: string): string {
  if (!url) return fallback
  try {
    const pathname = new URL(url).pathname
    const ext = pathname.slice(pathname.lastIndexOf('.')).toLowerCase()
    if (allowed.includes(ext)) return ext === '.jpeg' ? '.jpg' : ext
  } catch {
    // URL 解析失败时忽略，走兜底
  }
  return fallback
}

const AUDIO_CT_MAP: Record<string, string> = {
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

const IMAGE_CT_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
}

const AUDIO_EXTS = ['.mp3', '.flac', '.ogg', '.wav', '.aac', '.m4a', '.opus']
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']

/** Content-Type → 音频扩展名（拿不到响应头时按 URL 兜底，最后默认 .mp3） */
export function audioExtFrom(contentType?: string | null, url?: string): string {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase()
  return AUDIO_CT_MAP[ct] || extFromUrl(url, AUDIO_EXTS, '.mp3')
}

/** Content-Type → 图片扩展名（歌源封面多为 jpeg，判不出来时按 jpg 存） */
export function imageExtFrom(contentType?: string | null, url?: string): string {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase()
  return IMAGE_CT_MAP[ct] || extFromUrl(url, IMAGE_EXTS, '.jpg')
}

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) | 0
}

/** SHA-1（纯 JS 实现，无平台依赖）：缓存文件名用哈希，键里可能带 URL 与中文 */
export function hashCacheKey(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const bitLen = bytes.length * 8
  const withOne = bytes.length + 1
  const total = withOne + ((56 - (withOne % 64) + 64) % 64) + 8
  const message = new Uint8Array(total)
  message.set(bytes)
  message[bytes.length] = 0x80
  const view = new DataView(message.buffer)
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000))
  view.setUint32(total - 4, bitLen >>> 0)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)

  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1)

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]) | 0
      e = d
      d = c
      c = rotl(b, 30)
      b = a
      a = temp
    }
    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0
  }

  return [h0, h1, h2, h3, h4].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('')
}
