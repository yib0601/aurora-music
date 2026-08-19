import { Filesystem, Directory, FileInfo as CapFileInfo } from '@capacitor/filesystem'
import { Capacitor } from '@capacitor/core'
import type {
  PlatformInterface,
  FileInfo,
  AudioMetadata,
  WindowControls,
  OnlineTrackSearchResult,
  Track,
} from '@/types'
import { MobileDatabase } from './database'
import {
  scanFolder as mobileScanFolder,
  readLyricsFile,
  saveLyricsFile,
} from './scanner'
import { searchOnlineTracks, searchLyrics } from './online'

// 单例数据库实例
const db = new MobileDatabase()
let dbInited = false

async function ensureDbInited() {
  if (dbInited) return
  await db.init()
  dbInited = true
}

/** NoopWindowControls：移动端没有原生窗口控制概念（系统级返回/全屏由 OS 托管） */
class NoopWindowControls implements WindowControls {
  async minimize() {}
  async maximize() {}
  async close() {}
  async isMaximized() {
    return false
  }
}

/**
 * 扫描事件订阅器（替代桌面端 IPC 的 scan:complete/error 事件）
 * 静默后台扫描：无进度事件，App.tsx 通过 onTracksScanned/onScanError 注册回调
 */
type ScanCompleteCb = (tracks: Track[]) => void
type ScanErrorCb = (e: { folder: string; message: string }) => void
type MediaControlCb = (action: string) => void

const scanCompleteCbs = new Set<ScanCompleteCb>()
const scanErrorCbs = new Set<ScanErrorCb>()
const mediaControlCbs = new Set<MediaControlCb>()

function emitScanComplete(tracks: Track[]) {
  scanCompleteCbs.forEach((cb) => cb(tracks))
}
function emitScanError(e: { folder: string; message: string }) {
  scanErrorCbs.forEach((cb) => cb(e))
}

/**
 * 文件夹选择 UI 回调机制：移动端不能用浏览器原生 prompt，
 * 由 UI 层（MobileFolderPicker）调用 setFolderPickerHandler 注册一个打开选择器的回调，
 * pickFolder() 调用该回调并等待用户在 UI 中选完目录后 resolve。
 * 替代旧版 window.prompt 手填路径的方案。
 */
type FolderPickerHandler = () => Promise<string | null>
let folderPickerHandler: FolderPickerHandler | null = null

export function setFolderPickerHandler(handler: FolderPickerHandler | null) {
  folderPickerHandler = handler
}

/** 扫描队列：多个目录串行执行（与桌面端一致），避免并发写数据库 */
let scanChain: Promise<Track[]> = Promise.resolve([])
function enqueueScan(folderPath: string): Promise<Track[]> {
  const task = scanChain.then(() => runScan(folderPath))
  scanChain = task.catch(() => [])
  return task
}

async function runScan(folderPath: string): Promise<Track[]> {
  try {
    await ensureDbInited()
    // 校验目录可读
    try {
      await Filesystem.readdir({ path: folderPath, directory: Directory.ExternalStorage })
    } catch {
      throw new Error('文件夹不存在或不可访问')
    }
    await mobileScanFolder(folderPath, db)
    // 与桌面端对齐：扫描完成后从数据库读取全库再 emit，
    // 避免多次扫描不同目录时只 emit 本次结果导致前一次曲目被覆盖丢失
    const allTracks = await db.getAllTracks()
    emitScanComplete(allTracks)
    return allTracks
  } catch (err: any) {
    console.error('[Mobile] 扫描失败:', folderPath, err)
    emitScanError({
      folder: folderPath,
      message: `扫描失败：文件夹「${folderPath}」不存在或无法读取`,
    })
    throw err
  }
}

/** trackId 仅允许字母数字与连字符，防止路径穿越 */
function isValidTrackId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(id)
}

export function createMobilePlatform(): PlatformInterface & {
  // 扩展接口：扫描事件订阅（移动端用回调替代 IPC 事件）
  onTracksScanned: (cb: (tracks: Track[]) => void) => () => void
  onScanError: (cb: ScanErrorCb) => () => void
  onMediaControl: (cb: MediaControlCb) => () => void
  scanFolder: (folderPath: string) => Promise<Track[]>
  getAllTracks: () => Promise<Track[]>
  searchLyrics: (
    query: string,
    artist?: string,
    album?: string,
    duration?: number
  ) => Promise<{ lrc: string | null; name: string; artist: string } | null>
} {
  return {
    platform: 'mobile',

    async pickFolder(): Promise<string | null> {
      // 走 UI 层注册的文件夹选择器（MobileFolderPicker），用户在目录树中点选，
      // 不再使用 window.prompt 手填路径。UI 未注册时降级为 prompt。
      if (folderPickerHandler) {
        try {
          return await folderPickerHandler()
        } catch (err) {
          console.warn('[Mobile] pickFolder UI 选择器异常:', err)
          return null
        }
      }
      // 降级路径：UI 未注册时使用旧 prompt 行为
      const hint =
        '请输入音乐目录的相对路径（相对于 storage/emulated/0）。\n常见目录：\n' +
        '  Music\n  Download/Music\n  Documents/Music\n  DCIM/Music'
      const input = window.prompt(hint, 'Music')
      if (input === null) return null
      const trimmed = input.trim()
      if (!trimmed) return null
      try {
        await Filesystem.readdir({ path: trimmed, directory: Directory.ExternalStorage })
        return trimmed
      } catch (err) {
        console.warn('[Mobile] pickFolder 目录不可访问:', trimmed, err)
        alert(`无法访问目录「${trimmed}」\n请检查路径是否正确，或确认已授予存储权限。`)
        return null
      }
    },

    async readDir(path: string): Promise<FileInfo[]> {
      try {
        const result = await Filesystem.readdir({
          path,
          directory: Directory.ExternalStorage,
        })
        return result.files.map((e: CapFileInfo) => ({
          name: e.name,
          path: path.endsWith('/') ? `${path}${e.name}` : `${path}/${e.name}`,
          isDirectory: e.type === 'directory',
          size: e.size || 0,
          lastModified: 0,
        }))
      } catch (err) {
        console.warn('[Mobile] readDir 失败:', path, err)
        return []
      }
    },

    async readFile(path: string): Promise<ArrayBuffer> {
      try {
        const result = await Filesystem.readFile({
          path,
          directory: Directory.ExternalStorage,
        })
        const raw = result.data as string
        const b64 = raw.includes(',') ? raw.split(',')[1] : raw
        const binary = atob(b64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        // ArrayBuffer 视图，slice 出独立 buffer（避免 detach 风险）
        return bytes.buffer.slice(0)
      } catch (err) {
        console.warn('[Mobile] readFile 失败:', path, err)
        return new ArrayBuffer(0)
      }
    },

    getAudioSrc(path: string): string {
      // 在线流地址直接返回
      if (/^https?:\/\//i.test(path)) return path
      // Capacitor 文件协议：把 storage 相对路径转成可被 <audio> 加载的 URL
      // 用 Capacitor.convertFileSrc，需要传入 absolute file:// 路径或 capacitor:// scheme
      // Filesystem.getUri 返回 file:// 形式的绝对路径
      // 为避免异步调用，这里用同步的 convertFileSrc + 推断的绝对路径前缀
      const cap = (window as any).Capacitor
      if (cap) {
        // Android 上 native URI 前缀：file:///storage/emulated/0/<path>
        const abs = `/storage/emulated/0/${path.replace(/^\/+/, '')}`
        return cap.convertFileSrc(abs)
      }
      return path
    },

    getCoverSrc(path: string): string {
      // 移动端封面图也用 Capacitor.convertFileSrc
      const cap = (window as any).Capacitor
      if (cap) {
        const abs = `/storage/emulated/0/${path.replace(/^\/+/, '')}`
        return cap.convertFileSrc(abs)
      }
      return path
    },

    async getMetadata(path: string): Promise<AudioMetadata> {
      // mobile 端：通过 scanner 隐式获取（扫描时已写入数据库），这里直接从数据库查
      await ensureDbInited()
      const track = await db.getTrackById(path)
      if (track) {
        return {
          title: track.title,
          artist: track.artist,
          album: track.album,
          year: track.year,
          genre: track.genre,
          duration: track.duration,
          trackNumber: track.trackNumber,
        }
      }
      // 数据库未命中时，仅返回文件名作为标题
      return {
        title: path.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Unknown',
        artist: 'Unknown',
        album: 'Unknown',
        duration: 0,
      }
    },

    async getUserDataPath(): Promise<string> {
      // 移动端使用 Capacitor Data 目录（应用专属存储）
      try {
        const result = await Filesystem.getUri({ path: '', directory: Directory.Data })
        return result.uri
      } catch {
        return ''
      }
    },

    async saveCover(coverData: Buffer, trackId: string): Promise<string> {
      if (!isValidTrackId(trackId)) return ''
      try {
        const dir = 'aurora-music/covers'
        try {
          await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true })
        } catch (err: any) {
          if (err?.message && !/exist/i.test(err.message)) throw err
        }
        const path = `${dir}/${trackId}.jpg`
        // Buffer 转 base64
        const b64 = coverData.toString('base64')
        await Filesystem.writeFile({
          path,
          directory: Directory.Data,
          data: b64,
          recursive: true,
        })
        return path
      } catch (err) {
        console.warn('[Mobile] saveCover 失败:', err)
        return ''
      }
    },

    async saveLyrics(lyrics: string, trackId: string): Promise<string> {
      if (!isValidTrackId(trackId)) {
        throw new Error('invalid track id')
      }
      return saveLyricsFile(lyrics, trackId)
    },

    async readLyrics(trackId: string): Promise<string | null> {
      if (!isValidTrackId(trackId)) return null
      return readLyricsFile(trackId)
    },

    async searchOnlineTracks(query: string): Promise<OnlineTrackSearchResult[]> {
      return searchOnlineTracks(query)
    },

    /** 在线歌词搜索（与桌面端 lyrics:search 一致） */
    async searchLyrics(query, artist, album, duration) {
      return searchLyrics(query, artist, album, duration)
    },

    database: db,
    windowControls: new NoopWindowControls(),

    // 扩展接口（仅 mobile 需要）
    async getAllTracks() {
      await ensureDbInited()
      return db.getAllTracks()
    },

    async scanFolder(folderPath: string) {
      if (typeof folderPath !== 'string' || !folderPath.trim()) {
        emitScanError({ folder: '', message: '扫描失败：未指定文件夹' })
        throw new Error('empty folder path')
      }
      return enqueueScan(folderPath)
    },

    onTracksScanned(cb: ScanCompleteCb) {
      scanCompleteCbs.add(cb)
      return () => scanCompleteCbs.delete(cb)
    },

    onScanError(cb: ScanErrorCb) {
      scanErrorCbs.add(cb)
      return () => scanErrorCbs.delete(cb)
    },

    onMediaControl(cb: MediaControlCb) {
      // 移动端通过 navigator.mediaSession 接收系统媒体键（在 App.tsx 中已注册）
      // 这里保留接口与桌面端 electronAPI.onMediaControl 对齐，但实际无 native 事件
      mediaControlCbs.add(cb)
      return () => mediaControlCbs.delete(cb)
    },
  }
}
