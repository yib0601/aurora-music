/**
 * 在线播放缓存（桌面端主进程）
 *
 * 在线歌源直链有效期通常只有几十分钟，URL 本身不能当缓存键；渲染层按
 * 「来源 id + 歌曲 id」推导稳定键传来，主进程哈希后落盘。命中时播放地址
 * 换成 aurora-cache://<hash>.<ext> 自定义协议（支持 Range，seek 可用）；
 * 未命中不阻塞播放——渲染层继续用直链流式播放，主进程在后台把文件拉进
 * 缓存，下一首再播同一首歌时即命中。
 *
 * 容量上限由渲染层的设置页下发（持久化在 libraryStore），写入后按
 * lastUsed 从旧到新驱逐（LRU）。limitMB 为 0 表示关闭缓存。
 */
import { app, ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export const CACHE_SCHEME = 'aurora-cache'

interface CacheEntry {
  /** 磁盘文件名（含扩展名） */
  file: string
  size: number
  lastUsed: number
  /** 记录来源直链，仅用于排查，不参与命中判断 */
  url: string
}

interface CacheIndex {
  entries: Record<string, CacheEntry>
}

const INDEX_FILE = 'index.json'

let cacheDir = ''
let limitMB = 1024
let index: CacheIndex = { entries: {} }
/** 同一键的并发下载去重：直链失效/网络慢时避免重复拉流 */
const inflight = new Set<string>()

function indexPath(): string {
  return path.join(cacheDir, INDEX_FILE)
}

function totalUsedBytes(): number {
  return Object.values(index.entries).reduce((sum, e) => sum + e.size, 0)
}

function saveIndex(): void {
  try {
    // 目录可能被手动删除，写索引前自愈
    if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(indexPath(), JSON.stringify(index), 'utf-8')
  } catch (err) {
    console.warn('[AudioCache] 索引写入失败:', err)
  }
}

/** 启动时加载索引并校验文件完整性：索引存在但文件丢失的条目直接剔除 */
export function initAudioCache(): void {
  try {
    cacheDir = path.join(app.getPath('userData'), 'audio-cache')
    fs.mkdirSync(cacheDir, { recursive: true })
    const raw = fs.readFileSync(indexPath(), 'utf-8')
    const parsed = JSON.parse(raw) as CacheIndex
    if (parsed && typeof parsed.entries === 'object') {
      for (const [key, entry] of Object.entries(parsed.entries)) {
        const file = path.join(cacheDir, entry.file)
        if (entry && typeof entry.size === 'number' && fs.existsSync(file)) {
          index.entries[key] = entry
        }
      }
    }
  } catch {
    // 首次启动或索引损坏：空索引重来
    index = { entries: {} }
  }
  if (cacheDir && !fs.existsSync(cacheDir)) {
    console.warn('[AudioCache] 缓存目录不可用:', cacheDir)
  }
}

function hashKey(key: string): string {
  return crypto.createHash('sha1').update(key).digest('hex')
}

function cacheUrlFor(entry: CacheEntry): string {
  return `${CACHE_SCHEME}://localhost/${entry.file}`
}

/** 超限时从最久未用的开始删，直到回到限额内 */
function evictIfNeeded(): void {
  const limitBytes = limitMB * 1024 * 1024
  let used = totalUsedBytes()
  if (limitBytes <= 0) return
  while (used > limitBytes) {
    const oldest = Object.entries(index.entries).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]
    if (!oldest) break
    const [key, entry] = oldest
    try {
      fs.unlinkSync(path.join(cacheDir, entry.file))
    } catch {
      // 文件已不在，只清索引
    }
    delete index.entries[key]
    used -= entry.size
  }
  saveIndex()
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** Content-Type → 扩展名（与 handlers.ts 的 inferAudioExtension 同源逻辑） */
function extFromContentType(contentType?: string | null, fallbackUrl?: string): string {
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

/** 后台拉流写缓存：先写临时文件再原子改名，避免半截文件进索引 */
async function downloadToCache(key: string, url: string, headers?: Record<string, string>): Promise<void> {
  const hashed = hashKey(key)
  if (inflight.has(hashed)) return
  inflight.add(hashed)
  try {
    // 目录可能被用户手动删除，写入前自愈
    fs.mkdirSync(cacheDir, { recursive: true })
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, ...(headers || {}) },
      // 与歌曲下载同口径：10 分钟上限
      signal: AbortSignal.timeout(600000),
    })
    if (!resp.ok || !resp.body) {
      console.warn(`[AudioCache] 下载失败：HTTP ${resp.status}`, url)
      return
    }
    const ext = extFromContentType(resp.headers.get('content-type'), url)
    const finalFile = `${hashed}${ext}`
    const tmpFile = `${hashed}.part`
    const tmpPath = path.join(cacheDir, tmpFile)
    const finalPath = path.join(cacheDir, finalFile)

    const { Readable } = await import('stream')
    const { pipeline } = await import('stream/promises')
    await pipeline(Readable.fromWeb(resp.body as any), fs.createWriteStream(tmpPath))

    // 下载期间配置可能被关闭（limitMB=0）：写完直接丢弃，不进索引
    if (limitMB <= 0) {
      fs.unlinkSync(tmpPath)
      return
    }

    // 同键旧文件（扩展名可能变化）先清掉
    const prev = index.entries[hashed]
    if (prev) {
      try { fs.unlinkSync(path.join(cacheDir, prev.file)) } catch {}
    } else {
      try { fs.unlinkSync(finalPath) } catch {}
    }
    fs.renameSync(tmpPath, finalPath)

    const size = fs.statSync(finalPath).size
    index.entries[hashed] = { file: finalFile, size, lastUsed: Date.now(), url }
    evictIfNeeded()
    saveIndex()
  } catch (err) {
    console.warn('[AudioCache] 后台缓存失败:', (err as Error).message)
  } finally {
    inflight.delete(hashed)
  }
}

/** 渲染层播放前调用：命中返回缓存协议地址；未命中返回 null 并触发后台下载 */
export function resolveCachedAudio(
  key: string,
  url: string,
  headers?: Record<string, string>
): { src: string | null } {
  if (limitMB <= 0 || !cacheDir) return { src: null }
  const hashed = hashKey(key)
  const entry = index.entries[hashed]
  if (entry && fs.existsSync(path.join(cacheDir, entry.file))) {
    entry.lastUsed = Date.now()
    saveIndex()
    return { src: cacheUrlFor(entry) }
  }
  // 索引有但文件没了：清掉脏条目
  if (entry) {
    delete index.entries[hashed]
    saveIndex()
  }
  void downloadToCache(key, url, headers)
  return { src: null }
}

/** aurora-cache:// 协议处理：读本地缓存文件，支持 Range（seek 依赖） */
export async function serveCachedAudio(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const file = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    // 文件名只允许 <hash>.<ext> 形态，防路径穿越
    if (!/^[a-f0-9]{40}\.[a-z0-9]{2,5}$/i.test(file)) {
      return new Response('', { status: 400 })
    }
    const filePath = path.join(cacheDir, file)
    const stat = await fs.promises.stat(filePath)
    const ext = path.extname(file).toLowerCase()
    const mimeMap: Record<string, string> = {
      '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
      '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.opus': 'audio/ogg',
    }
    const mime = mimeMap[ext] || 'application/octet-stream'

    // 命中即刷新 lastUsed：协议请求本身就是「正在使用」的最强信号
    const hashed = file.replace(/\.[a-z0-9]+$/i, '')
    const entry = index.entries[hashed]
    if (entry) {
      entry.lastUsed = Date.now()
      saveIndex()
    }

    const range = request.headers.get('range')
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range)
      if (m) {
        const start = parseInt(m[1])
        const end = m[2] ? parseInt(m[2]) : stat.size - 1
        const stream = fs.createReadStream(filePath, { start, end })
        const chunks: Buffer[] = []
        for await (const chunk of stream) chunks.push(chunk as Buffer)
        return new Response(Buffer.concat(chunks), {
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

export function registerAudioCacheIpc(): void {
  ipcMain.handle(
    'cache:resolve',
    (_event, req: { url: string; key: string; headers?: Record<string, string> }) => {
      if (!req || typeof req.url !== 'string' || !/^https?:\/\//i.test(req.url) || !req.key) {
        return { src: null }
      }
      return resolveCachedAudio(req.key, req.url, req.headers)
    }
  )

  ipcMain.handle('cache:configure', (_event, opts: { limitMB: number }) => {
    const next = Number(opts?.limitMB)
    limitMB = Number.isFinite(next) && next >= 0 ? Math.floor(next) : 1024
    if (limitMB === 0) {
      // 关闭缓存：立即清空磁盘占用
      clearCacheFiles()
    } else {
      evictIfNeeded()
    }
    saveIndex()
  })

  ipcMain.handle('cache:usage', () => {
    return { usedBytes: totalUsedBytes(), count: Object.keys(index.entries).length }
  })

  ipcMain.handle('cache:clear', () => {
    clearCacheFiles()
    saveIndex()
  })
}

function clearCacheFiles(): void {
  for (const entry of Object.values(index.entries)) {
    try { fs.unlinkSync(path.join(cacheDir, entry.file)) } catch {}
  }
  index.entries = {}
}
