import * as mm from 'music-metadata-browser'
import type { FileInfo, Track } from '@/types'

/**
 * Web 平台实现：基于 File System Access API（Chrome / Edge 支持）。
 *
 * 浏览器沙箱不允许枚举磁盘，但 showDirectoryPicker 可让用户授权某个目录的
 * 读取权限，之后即可递归扫描音频文件、解析元数据并用 objectURL 播放。
 *
 * 会话级限制（浏览器安全模型决定，无法绕过）：
 * - 目录句柄与 objectURL 仅在当前页面会话有效，刷新后丢失；
 *   后台静默扫描发现句柄缺失时静默跳过，用户重新「导入音乐」即可恢复。
 * - 曲目记录不做跨会话持久化（Noop 数据库），刷新后音乐库为空。
 *
 * 地址约定：track.path = `web:<folderKey>/<相对路径>`，
 * 播放/封面通过 trackId 查会话缓存（audioUrls / coverUrls）转成 objectURL。
 */

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav', '.wma', '.opus',
])

/** 最小句柄类型（TS lib 未内置 File System Access API 类型） */
interface FsHandle {
  kind: 'file' | 'directory'
  name: string
  getFile?: () => Promise<File>
  queryPermission?: (d: { mode: 'read' }) => Promise<PermissionState>
  requestPermission?: (d: { mode: 'read' }) => Promise<PermissionState>
  values?: () => AsyncIterableIterator<FsHandle>
}

// 目录句柄：folderKey → handle（pickFolder 时写入，scanFolder 时取用）
const dirHandles = new Map<string, FsHandle>()
// 音频文件句柄与播放地址：完整 path（web:<key>/<rel>）→ handle / objectURL
const fileHandles = new Map<string, FsHandle>()
const audioUrls = new Map<string, string>()
// 内嵌封面 objectURL：trackId → url（扫描时提取，ensureCover 按需返回）
const coverUrls = new Map<string, string>()
// 会话级曲目列表：removeFolder 需返回「移除后的全库」，平台侧需自持一份
let allTracks: Track[] = []

type TrackScannedCb = (track: Track) => void
type ScanErrorCb = (e: { folder: string; message: string }) => void
const trackScannedCbs = new Set<TrackScannedCb>()
const scanErrorCbs = new Set<ScanErrorCb>()

function emitTrackScanned(track: Track) {
  trackScannedCbs.forEach((cb) => cb(track))
}

function emitScanError(folder: string, message: string) {
  scanErrorCbs.forEach((cb) => cb({ folder, message }))
}

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

async function ensureReadPermission(handle: FsHandle): Promise<boolean> {
  if (!handle.queryPermission) return true
  try {
    if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true
    return (await handle.requestPermission!({ mode: 'read' })) === 'granted'
  } catch {
    return false
  }
}

/** 递归收集目录下的音频文件（句柄 + 相对路径） */
async function walkDir(
  dir: FsHandle,
  prefix: string,
  out: { handle: FsHandle; path: string }[]
): Promise<void> {
  if (!dir.values) return
  try {
    for await (const entry of dir.values()) {
      if (entry.kind === 'directory') {
        if (!entry.name.startsWith('.')) {
          await walkDir(entry, `${prefix}${entry.name}/`, out)
        }
      } else {
        const ext = entry.name.includes('.') ? `.${entry.name.split('.').pop()!.toLowerCase()}` : ''
        if (AUDIO_EXTENSIONS.has(ext)) {
          out.push({ handle: entry, path: `${prefix}${entry.name}` })
        }
      }
    }
  } catch (err) {
    // 单个子目录不可读不中断整个扫描
    console.warn('[Web] walkDir: 无法读取目录，已跳过:', prefix, err)
  }
}

function coverMimeFor(declaredFormat?: string): string {
  const f = (declaredFormat || '').toLowerCase()
  if (f.includes('png')) return 'image/png'
  if (f.includes('webp')) return 'image/webp'
  if (f.includes('gif')) return 'image/gif'
  if (f.includes('bmp')) return 'image/bmp'
  return 'image/jpeg'
}

async function processFile(
  folderKey: string,
  relPath: string,
  handle: FsHandle,
  albumCoverCache: Map<string, string>
): Promise<Track | null> {
  try {
    const fileName = relPath.split('/').pop() || relPath
    if (!handle.getFile) return null
    const file = await handle.getFile()

    let metadata
    try {
      metadata = await mm.parseBlob(file, { duration: true })
    } catch (err) {
      console.warn('[Web] parseBlob failed for', relPath, err)
      return null
    }

    const trackId = crypto.randomUUID()
    const fullPath = `web:${folderKey}/${relPath}`
    // 播放地址：objectURL 会话内有效，getAudioSrc 按 path 查表
    fileHandles.set(fullPath, handle)
    audioUrls.set(fullPath, URL.createObjectURL(file))

    const title = metadata.common.title || fileName.replace(/\.[^.]+$/, '')
    const artist = metadata.common.artist || '未知艺术家'
    const album = metadata.common.album || '未知专辑'

    // 专辑级封面复用键：与移动端一致，仅专辑与艺术家标签都真实存在时启用，
    // 避免无标签曲目串用封面
    const albumKey =
      metadata.common.album && metadata.common.artist
        ? `${metadata.common.album}|${metadata.common.artist}`
        : null

    // 内嵌封面转 objectURL 存入 coverUrls；coverPath 留空，
    // 由 CoverImage 走既有 ensureCover 按需契约取用（命中缓存，无重复解析）
    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const pic = metadata.common.picture[0]
      try {
        // 拷贝到新 ArrayBuffer：Buffer 的池化 buffer 类型是 ArrayBufferLike，
        // 直接作为 BlobPart 会触发 SharedArrayBuffer 类型不兼容
        const buf = new Uint8Array(pic.data)
        const url = URL.createObjectURL(new Blob([buf], { type: coverMimeFor(pic.format) }))
        coverUrls.set(trackId, url)
        if (albumKey) albumCoverCache.set(albumKey, url)
      } catch (err) {
        console.warn('[Web] 保存封面失败:', err)
      }
    } else if (albumKey) {
      const cached = albumCoverCache.get(albumKey)
      if (cached) coverUrls.set(trackId, cached)
    }

    const track: Track = {
      id: trackId,
      path: `web:${folderKey}/${relPath}`,
      title,
      artist,
      album,
      year: metadata.common.year,
      genre: metadata.common.genre?.[0],
      duration: metadata.format.duration || 0,
      trackNumber: typeof metadata.common.track.no === 'number' ? metadata.common.track.no : undefined,
      fileSize: file.size,
      addedAt: Date.now(),
      playCount: 0,
      liked: false,
    }
    return track
  } catch (err) {
    console.error('[Web] 处理文件失败:', relPath, err)
    return null
  }
}

function releaseTrack(track: Track) {
  const url = audioUrls.get(track.path)
  if (url) URL.revokeObjectURL(url)
  audioUrls.delete(track.path)
  fileHandles.delete(track.path)
  // 封面 url 可能被同专辑曲目共享，仅在无其他人引用时释放
  const cover = coverUrls.get(track.id)
  if (cover && ![...coverUrls.entries()].some(([id, u]) => id !== track.id && u === cover)) {
    URL.revokeObjectURL(cover)
  }
  coverUrls.delete(track.id)
}

export function createWebPlatform() {
  return {
    platform: 'desktop' as const,

    async pickFolder(): Promise<string | null> {
      const picker = (window as any).showDirectoryPicker
      if (typeof picker !== 'function') return null
      try {
        const handle: FsHandle = await picker.call(window, { mode: 'read' })
        // 同名目录去重：追加序号，保证 folderKey 唯一
        let key = handle.name || 'Music'
        let n = 2
        while (dirHandles.has(key) && dirHandles.get(key) !== handle) {
          key = `${handle.name} (${n++})`
        }
        dirHandles.set(key, handle)
        return key
      } catch (err) {
        // 用户取消选择：静默返回 null
        if ((err as any)?.name === 'AbortError') return null
        console.warn('[Web] pickFolder 失败:', err)
        return null
      }
    },

    async readDir(_path: string): Promise<FileInfo[]> {
      // Web 端无目录浏览 UI（MobileFolderPicker 仅移动端），无需实现
      return []
    },

    async readFile(_path: string): Promise<ArrayBuffer> {
      return new ArrayBuffer(0)
    },

    getAudioSrc(path: string): string {
      if (/^https?:\/\//i.test(path)) return path
      if (path.startsWith('web:')) {
        return audioUrls.get(path) || ''
      }
      return path
    },

    getCoverSrc(path: string): string {
      // coverPath 存的是 objectURL（由 ensureCover 返回），原样可用
      return path
    },

    async getMetadata(path: string) {
      return { title: path.split('/').pop() || 'Unknown', artist: 'Unknown', album: 'Unknown', duration: 0 }
    },

    async getUserDataPath(): Promise<string> {
      return ''
    },

    async saveCover(): Promise<string> {
      return ''
    },

    async saveLyrics(): Promise<string> {
      return ''
    },

    async readLyrics(): Promise<string | null> {
      return null
    },

    async searchOnlineTracks(): Promise<never[]> {
      return []
    },

    database: {
      init: async () => {},
      insertTrack: async () => {},
      getAllTracks: async () => [] as Track[],
      getTrackById: async () => null,
      getTracksByAlbum: async () => [] as Track[],
      searchTracks: async () => [] as Track[],
      updateTrack: async () => {},
      deleteTrack: async () => {},
      insertAlbum: async () => {},
      getAllAlbums: async () => [] as never[],
      getAlbumById: async () => null,
      insertPlaylist: async () => {},
      getAllPlaylists: async () => [] as never[],
      getPlaylistById: async () => null,
      updatePlaylist: async () => {},
      deletePlaylist: async () => {},
      getLikedTracks: async () => [] as Track[],
      getRecentlyPlayed: async () => [] as Track[],
      getMostPlayed: async () => [] as Track[],
    },

    windowControls: {
      minimize: async () => {},
      maximize: async () => {},
      close: async () => {},
      isMaximized: async () => false,
    },

    // —— 扩展能力：扫描 / 事件订阅 ——

    onTrackScanned(cb: TrackScannedCb) {
      trackScannedCbs.add(cb)
      return () => trackScannedCbs.delete(cb)
    },

    onScanError(cb: ScanErrorCb) {
      scanErrorCbs.add(cb)
      return () => scanErrorCbs.delete(cb)
    },

    async getAllTracks(): Promise<Track[]> {
      return [...allTracks]
    },

    /** 按需返回扫描时提取的内嵌封面 objectURL；无封面返回 null（触发在线兜底） */
    async ensureCover(trackId: string): Promise<string | null> {
      return coverUrls.get(trackId) ?? null
    },

    async scanFolder(folderKey: string): Promise<Track[]> {
      const handle = dirHandles.get(folderKey)
      if (!handle) {
        // 刷新后句柄丢失：静默跳过，用户重新导入即可（避免启动时连环弹提示）
        console.info('[Web] 目录句柄未持有（页面刷新后需重新导入）:', folderKey)
        emitScanError(folderKey, '目录访问权限未持有')
        return []
      }
      if (!(await ensureReadPermission(handle))) {
        emitScanError(folderKey, '未获得目录读取权限')
        return []
      }

      const files: { handle: FsHandle; path: string }[] = []
      await walkDir(handle, '', files)

      const prefix = `web:${folderKey}/`
      const newPathSet = new Set(files.map((f) => `${prefix}${f.path}`))

      // 清理已删除文件的会话记录（与桌面/移动端语义一致）
      const stale = allTracks.filter((t) => t.path.startsWith(prefix) && !newPathSet.has(t.path))
      if (stale.length > 0) {
        stale.forEach(releaseTrack)
        allTracks = allTracks.filter((t) => !stale.includes(t))
      }

      // 查重：已入库路径直接跳过，避免重复解析
      const existingByPath = new Map(allTracks.map((t) => [t.path, t]))
      const albumCoverCache = new Map<string, string>()
      const scanned: Track[] = []

      // 并发解析：串行时大文件读取的 IO 等待完全浪费，4 路并发重叠 IO
      // （与桌面端封面提取并发上限一致，避免瞬间打满磁盘/内存）
      const CONCURRENCY = 4
      let cursor = 0
      const workers = Array.from(
        { length: Math.min(CONCURRENCY, files.length) },
        async () => {
          while (cursor < files.length) {
            const { handle: fh, path: relPath } = files[cursor++]
            const full = `${prefix}${relPath}`
            if (existingByPath.has(full)) continue
            const track = await processFile(folderKey, relPath, fh, albumCoverCache)
            if (track) {
              scanned.push(track)
              allTracks.push(track)
              emitTrackScanned(track)
            }
          }
        }
      )
      await Promise.all(workers)

      return scanned
    },

    /** 移除扫描目录：清理该目录下的会话记录，返回移除后的全库曲目 */
    async removeFolder(folderKey: string): Promise<Track[]> {
      const prefix = `web:${folderKey}/`
      const removed = allTracks.filter((t) => t.path.startsWith(prefix))
      removed.forEach(releaseTrack)
      allTracks = allTracks.filter((t) => !t.path.startsWith(prefix))
      dirHandles.delete(folderKey)
      return [...allTracks]
    },
  }
}
