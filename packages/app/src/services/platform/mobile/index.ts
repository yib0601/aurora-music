import { Filesystem, Directory, FileInfo as CapFileInfo } from '@capacitor/filesystem'
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { setCustomFetch } from '@aurora/shared'
import { createNativeFetch } from './nativeFetch'
import type {
  PlatformInterface,
  FileInfo,
  AudioMetadata,
  WindowControls,
  OnlineTrackSearchResult,
  OnlineSearchOptions,
  SourceProbeInput,
  SourceProbeResult,
  LyricsSearchOptions,
  LyricsSearchResult,
  FolderPickerOptions,
  Track,
  RecommendPlaylist,
  ToplistGroup,
  ToplistDetail,
  MusicHallOptions,
  MusicHallSource,
} from '@/types'
import { MobileDatabase } from './database'
import {
  scanFolder as mobileScanFolder,
  readLyricsFile,
  saveLyricsFile,
} from './scanner'
import { searchOnlineTracks, searchLyrics } from './online'
import {
  hostContextOf,
  resolveTrackAudioViaPlugin,
  recommendViaPlugin,
  toplistsViaPlugin,
  toplistDetailViaPlugin,
} from '@aurora/shared'
import type { PluginGateway } from '../index'
import type { OnlineSourceConfig } from '@aurora/shared'
import {
  clearMobileMediaCache,
  configureMobileMediaCache,
  getMobileCacheUsage,
  resolveMobileCachedAudio,
  resolveMobileCachedCover,
} from './mediaCache'
import {
  fetchLxScript,
  inspectLxSource,
  inspectLxSourceInSandbox,
  resolveLxSourceUrlInSandbox,
  installMobileLxHost,
  resolveLxSourceUrl,
} from './lxHost'
import { sanitizeFileName, inferAudioExtFromUrl, embedCoverIntoAudio, detectImageMime, encodeFilePathToUrl } from '@aurora/shared'
import {
  auroraError,
  auroraProbeToResult,
  isTrackEndpointKnownMissing,
  lxInspectionToProbe,
  parseSourceInput,
  probeAuroraService,
  resolveAuroraTrack,
  sourceSongIdOf,
  unavailableProbe,
} from '@aurora/shared'
import { appTranslate } from '@/i18n'
import { renderErrorMessage } from '@/lib/utils'
import {
  requestMediaPermissions,
  checkAllFilesAccess,
  openAllFilesAccessSettings,
} from '@/services/permission'
import { createMobileLogging, type MobileLoggingApi } from './logging'
import { currentLocale } from '@/stores/localeStore'
import { APP_VERSION } from '@/services/update.service'

// WebView 的原生 fetch 受 CORS 约束，而用户配置的歌源/歌词源普遍不带
// Access-Control-Allow-Origin，在线搜索会全部失败。注入基于原生 HTTP 的
// fetch 实现（仅原生容器生效），让 @aurora/shared 的请求绕开 WebView 限制
if (Capacitor.isNativePlatform()) {
  setCustomFetch(createNativeFetch())
  // 洛雪宿主依赖（含脚本源码供应器）必须在这里注册一次，不能等到用户点「测试洛雪源」：
  // 聚合搜索会先于它发生，未注册时 searchOnlineTracks 会把 kind='lx' 的源判为
  // 「脚本源码不可得」而静默跳过——用户看到的是「配了源却搜不出歌」且没有任何报错。
  installMobileLxHost()
}

// 单例数据库实例
const db = new MobileDatabase()
// 用 Promise 缓存避免并发 init：MobileDatabase.init 内部虽 initialized 检查，
// 但 createConnection 失败后 initialized 仍为 false，下次会再次尝试 createConnection 报
// "Connection already exists"。用 in-flight Promise 让所有并发 caller 复用同一次 init。
let initPromise: Promise<void> | null = null

async function ensureDbInited() {
  if (!initPromise) {
    initPromise = db.init()
  }
  try {
    await initPromise
  } catch (e) {
    // init 失败时清空缓存，允许后续重试
    initPromise = null
    throw e
  }
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

function uint8ArrayToBase64(data: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < data.length; i += chunk) {
    bin += String.fromCharCode.apply(null, data.subarray(i, i + chunk) as any)
  }
  return btoa(bin)
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * 移动端默认下载目录：相对外部存储根（Directory.ExternalStorage）的路径，
 * 与扫描目录共用同一套路径语义（scanner / MobileFolderPicker 都基于该根）。
 * 用户在「设置 → 下载 → 默认下载目录」里选择后即以此为准。
 */
export const DEFAULT_MOBILE_DOWNLOAD_DIR = 'Music/Aurora Music'

/**
 * 规范化下载目录，得到 Directory.ExternalStorage 下的相对路径。
 * - 空值 → 默认目录
 * - 相对路径（'Music'、'Music/Aurora Music'）→ 去掉尾部斜杠
 * - 绝对路径（'/storage/emulated/0/Music'）→ 用原生侧解析的存储根剥离前缀；
 *   不能硬编码 /storage/emulated/0：多用户/工作资料是 /storage/emulated/10，
 *   外置 SD 卡挂载点又不同，硬编码会把文件写到不存在的位置
 * - 剥离失败 → 回退默认目录，避免落到意料之外的位置
 */
async function normalizeDownloadDir(dir?: string | null): Promise<string> {
  const raw = (dir ?? '').trim()
  if (!raw) return DEFAULT_MOBILE_DOWNLOAD_DIR
  if (!raw.startsWith('/')) return raw.replace(/\/+$/, '') || DEFAULT_MOBILE_DOWNLOAD_DIR
  try {
    const { uri } = await Filesystem.getUri({ path: '', directory: Directory.ExternalStorage })
    const root = uri.replace(/^file:\/\//, '').replace(/\/+$/, '')
    if (root && raw.startsWith(`${root}/`)) {
      return raw.slice(root.length + 1).replace(/\/+$/, '') || DEFAULT_MOBILE_DOWNLOAD_DIR
    }
  } catch (err) {
    console.warn('[Mobile] 解析外部存储根失败，回退默认下载目录:', err)
  }
  return DEFAULT_MOBILE_DOWNLOAD_DIR
}

/**
 * 把封面嵌入刚下载的音频文件（downloadOnlineTrack 的后置步骤）
 * - 读文件用 fetch(convertFileSrc) 流式读，避免 Filesystem.readFile 的 base64 OOM
 * - 封面拉取用 CapacitorHttp（原生 HTTP，不受 WebView CORS 限制）
 * - 文件超过 100MB 跳过嵌入，避免一次性 base64 写回撑爆内存
 */
async function embedCoverIntoDownloaded(
  savePath: string,
  track: { title: string; artist?: string; album?: string; coverUrl?: string }
): Promise<void> {
  // 路径前缀不能硬编码 `/storage/emulated/0/`：多用户/工作资料（/storage/emulated/10/）
  // 或外置 SD 卡挂载点不同，硬编码会读到不存在的路径导致封面嵌入静默失败。
  // 统一用 Filesystem.getUri 由原生侧按实际挂载点解析。
  const { uri: abs } = await Filesystem.getUri({ path: savePath, directory: Directory.ExternalStorage })
  // 走 shared 的逐段 encode：文件名含中文/空格/`#` 时，裸路径拼进
  // convertFileSrc 生成的 URL 会被 WebView 当成 fragment 截断，fetch 到错误路径
  const fileRes = await fetch(Capacitor.convertFileSrc(encodeFilePathToUrl(abs)))
  if (!fileRes.ok) throw auroraError('runtime.error.downloadFileReadFailed', { status: fileRes.status })
  const fileData = new Uint8Array(await fileRes.arrayBuffer())
  if (fileData.length > 100 * 1024 * 1024) return

  const coverResp = await CapacitorHttp.get({
    url: track.coverUrl!,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    responseType: 'blob',
  })
  if (coverResp.status < 200 || coverResp.status >= 300 || typeof coverResp.data !== 'string') return
  const coverData = base64ToUint8Array(coverResp.data)
  if (coverData.length < 100) return

  const ext = savePath.slice(savePath.lastIndexOf('.'))
  const embedded = embedCoverIntoAudio(
    fileData,
    ext,
    { title: track.title, artist: track.artist, album: track.album },
    { data: coverData, mime: detectImageMime(coverData) }
  )
  if (!embedded) return
  await Filesystem.writeFile({
    path: savePath,
    directory: Directory.ExternalStorage,
    data: uint8ArrayToBase64(embedded),
  })
}

/**
 * 扫描事件订阅器（替代桌面端 IPC 的 scan:complete/error 事件）
 * 静默后台扫描：无进度事件，App.tsx 通过 onTracksScanned/onScanError 注册回调
 */
type ScanCompleteCb = (tracks: Track[]) => void
type ScanErrorCb = (e: { folder: string; message: string }) => void
type MediaControlCb = (action: string) => void
type TrackScannedCb = (track: Track) => void
type FolderMissingCb = (e: { folder: string; removed: number }) => void

const scanCompleteCbs = new Set<ScanCompleteCb>()
const scanErrorCbs = new Set<ScanErrorCb>()
const mediaControlCbs = new Set<MediaControlCb>()
const trackScannedCbs = new Set<TrackScannedCb>()
const folderMissingCbs = new Set<FolderMissingCb>()

function emitScanComplete(tracks: Track[]) {
  scanCompleteCbs.forEach((cb) => cb(tracks))
}
function emitScanError(e: { folder: string; message: string }) {
  scanErrorCbs.forEach((cb) => cb(e))
}
function emitTrackScanned(track: Track) {
  trackScannedCbs.forEach((cb) => cb(track))
}
function emitFolderMissing(e: { folder: string; removed: number }) {
  folderMissingCbs.forEach((cb) => cb(e))
}

/**
 * 文件夹选择 UI 回调机制：移动端不能用浏览器原生 prompt，
 * 由 UI 层（MobileFolderPicker）调用 setFolderPickerHandler 注册一个打开选择器的回调，
 * pickFolder() 调用该回调并等待用户在 UI 中选完目录后 resolve。
 * 替代旧版 window.prompt 手填路径的方案。
 * options 用于让同一个选择器承载不同用途（扫描目录 / 下载目录）的文案。
 */
type FolderPickerHandler = (options?: FolderPickerOptions) => Promise<string | null>
let folderPickerHandler: FolderPickerHandler | null = null

export function setFolderPickerHandler(handler: FolderPickerHandler | null) {
  folderPickerHandler = handler
}

/** 移动端日志能力实例（懒创建，见 createMobilePlatform 的 logging getter 注释） */
let mobileLogging: MobileLoggingApi | null = null

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
      // readdir 失败可能是权限不足，也可能是目录已删除：用 stat 区分。
      // 目录确实不存在才清理其曲目；权限问题必须保留记录，避免误删曲库
      const exists = await Filesystem.stat({ path: folderPath, directory: Directory.ExternalStorage })
        .then(() => true)
        .catch(() => false)
      if (!exists) {
        const removed = await db.deleteTracksByFolder(folderPath)
        console.log('[Mobile] 扫描目录已不存在，清理其曲目:', folderPath, removed)
        const remaining = await db.getAllTracks()
        emitScanComplete(remaining)
        emitFolderMissing({ folder: folderPath, removed })
        return remaining
      }
      throw auroraError('runtime.error.scanFolderMissing')
    }
    // 渐进式扫描：每解析完一首立即通知 UI 追加显示
    await mobileScanFolder(folderPath, db, (track) => {
      emitTrackScanned(track)
    })
    // 与桌面端对齐：扫描完成后从数据库读取全库再 emit，
    // 避免多次扫描不同目录时只 emit 本次结果导致前一次曲目被覆盖丢失
    const allTracks = await db.getAllTracks()
    emitScanComplete(allTracks)
    return allTracks
  } catch (err: any) {
    console.error('[Mobile] 扫描失败:', folderPath, err)
    emitScanError({
      folder: folderPath,
      // 事件负载是给人看的结论（不是抛错）：取值在触发时进行，跟随当前界面语言
      message: appTranslate()('runtime.scan.folderUnreadable', { folder: folderPath }),
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
  onTrackScanned: (cb: (track: Track) => void) => () => void
  onScanError: (cb: ScanErrorCb) => () => void
  onFolderMissing: (cb: FolderMissingCb) => () => void
  onMediaControl: (cb: MediaControlCb) => () => void
  scanFolder: (folderPath: string) => Promise<Track[]>
  getAllTracks: () => Promise<Track[]>
  removeFolder: (folderPath: string) => Promise<Track[]>
  // 在线音乐（推荐歌单 / 榜单）：渲染层直调共享执行器（原生 fetch 不受 CORS 限制）
  musicHall: {
    recommendPlaylists(
      source: MusicHallSource,
      options?: MusicHallOptions
    ): Promise<RecommendPlaylist[]>
    toplistGroups(source: MusicHallSource, options?: MusicHallOptions): Promise<ToplistGroup[]>
    toplistSongs(source: MusicHallSource, options?: MusicHallOptions): Promise<ToplistDetail>
  }
  searchLyrics: (
    query: string,
    artist?: string,
    album?: string,
    duration?: number,
    options?: LyricsSearchOptions
  ) => Promise<LyricsSearchResult | null>
  downloadOnlineTrack: (
    track: { audioUrl: string; title: string; artist?: string; album?: string; coverUrl?: string },
    headers?: Record<string, string>,
    downloadDir?: string
  ) => Promise<{ savedPath: string }>
  /** 媒体缓存（音频 / 封面 / 歌词）：实现在 ./mediaCache.ts，与桌面端同构 */
  resolveCachedAudio: (req: {
    url: string
    key: string
    headers?: Record<string, string>
  }) => Promise<{ src: string | null }>
  resolveCachedCover: (req: {
    url: string
    key: string
    headers?: Record<string, string>
  }) => Promise<{ src: string | null }>
  configureAudioCache: (opts: { limitMB: number }) => Promise<void>
  getAudioCacheUsage: () => Promise<{ usedBytes: number; count: number }>
  clearAudioCache: () => Promise<void>
  /**
   * 诊断日志能力：落盘走应用专属存储 + Capacitor Filesystem。
   * 形状与桌面端网关一致（services/platform/index.ts 的 LoggingGateway），
   * 多出的 flush 供导出前显式冲刷攒批队列。
   */
  logging: MobileLoggingApi
  /**
   * 插件网关（移动端）。
   *
   * 与桌面端形状一致，但**没有 IPC**：注册表在本进程，凭证不支持（无安全存储）。
   * 安装 / 卸载走 Capacitor Filesystem + CapacitorHttp（见 ./pluginInstall.ts）。
   */
  plugins: PluginGateway
} {
  return {
    platform: 'mobile',

    async pickFolder(options?: FolderPickerOptions): Promise<string | null> {
      // 打开选择器前先确保存储权限：未授权时 readdir 读不到任何目录，
      // 选择器目录树会是空的（用户会误以为手机里没有文件夹）
      const granted = await requestMediaPermissions()
      if (!granted) {
        alert(appTranslate()('runtime.permission.mediaDenied'))
        return null
      }
      // 走 UI 层注册的文件夹选择器（MobileFolderPicker），用户在目录树中点选，
      // 不再使用 window.prompt 手填路径。UI 未注册时降级为 prompt。
      if (folderPickerHandler) {
        try {
          return await folderPickerHandler(options)
        } catch (err) {
          console.warn('[Mobile] pickFolder UI 选择器异常:', err)
          return null
        }
      }
      // 降级路径：UI 未注册时使用旧 prompt 行为
      const hint = appTranslate()('runtime.permission.dirPathHint')
      const input = window.prompt(hint, 'Music')
      if (input === null) return null
      const trimmed = input.trim()
      if (!trimmed) return null
      try {
        await Filesystem.readdir({ path: trimmed, directory: Directory.ExternalStorage })
        return trimmed
      } catch (err) {
        console.warn('[Mobile] pickFolder 目录不可访问:', trimmed, err)
        alert(appTranslate()('runtime.permission.folderUnreachable', { path: trimmed }))
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
        // 必须逐段 encode 后再交给 convertFileSrc：Capacitor 6 的 convertFileSrc
        // 只是把入参字符串拼进 `http://localhost/_capacitor_file_<path>`（见
        // @capacitor/core 实现），不做任何转义。中文/空格会被 WebView 的 URL
        // 解析器规整，而 `#` 会被当成 fragment 截断，`?` 会被当成 query 截断，
        // 导致 <audio> 请求到错误路径而播放失败。
        // 传入已编码的 file:// URL 是 convertFileSrc 的受支持用法（其实现会识别
        // 并保留该前缀），故此处直接传 encodeFilePathToUrl(abs) 的结果。
        return cap.convertFileSrc(encodeFilePathToUrl(abs))
      }
      return path
    },

    getCoverSrc(path: string): string {
      // scanner 已在扫描时通过 Filesystem.getUri + Capacitor.convertFileSrc
      // 把封面转成可直接在 WebView 加载的 URL 存入 coverPath，
      // 这里原样返回即可。在线 URL（https://）也直接返回。
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

    async searchOnlineTracks(query: string, options?: OnlineSearchOptions): Promise<OnlineTrackSearchResult[]> {
      return searchOnlineTracks(query, options)
    },

    /**
     * 源探测与惰性取址：形态差异收在这一层。
     * - 脚本形态：移动端没有「宿主与调用方分离」的问题，渲染层直接执行共享宿主
     *   （依赖在 ./lxHost.ts 注册，请求走 CapacitorHttp 原生 HTTP）；
     * - 服务形态：直连探测（fetch 已换成原生 HTTP，不受 WebView CORS 限制）。
     */
    async probeSource(input: SourceProbeInput): Promise<SourceProbeResult> {
      if ((input.kind || 'aurora') === 'lx') {
        try {
          const script = input.script?.trim() || (await fetchLxScript(input.sourceUrl))
          const config = {
            id: input.id || 'probe-draft',
            name: input.name || '',
            kind: 'lx' as const,
            sourceUrl: input.sourceUrl,
            headers: input.headers,
            enabled: true,
            script,
          }
          // 优先走 Worker 沙箱（超时可强制终止）；不支持时回落 lxHost 的 new Function 路径
          const sandboxed = await inspectLxSourceInSandbox(config)
          const inspection = sandboxed ?? (await inspectLxSource(config))
          return lxInspectionToProbe(inspection)
        } catch (err) {
          // 底层错误可能是 AuroraError（码 + 参数）：走 renderErrorMessage 渲染成当前语言，
          // 直接读 message 会把编码载荷（AURORA_ERR:{...}）当结论上屏
          return unavailableProbe('lx', renderErrorMessage(err))
        }
      }
      const parsed = parseSourceInput(input.sourceUrl)
      const result = await probeAuroraService(
        parsed?.baseUrl || input.sourceUrl,
        parsed?.apiKey || input.apiKey
      )
      return auroraProbeToResult(result)
    },

    async resolveTrackAudio(track: Track): Promise<Track | null> {
      // 定位凭据：曲目自带的脚本令牌（trackRef）或源内 id（onlineId）。
      // 都没有时这条路不适用：调用方回落按名搜索。
      const ref = track?.trackRef
      const songId = sourceSongIdOf(track?.onlineSource, track?.onlineId)
      if (!ref && !songId) return null

      try {
        const { useLibraryStore } = await import('@/stores/libraryStore')
        const state = useLibraryStore.getState()
        // 脚本多数按音质档位取址，档位唯一意图来源是用户的下载音质设置（默认 flac）
        const quality = state.downloadQuality || 'flac'
        const source = state.onlineSources.find(
          (s) => s.id === (ref?.sourceId || track?.onlineSource)
        )
        if (!source) return null

        // 走**插件门面**（与桌面端同一条路）：不再按 `kind === 'lx'` 分派两套通道。
        // 移动端与插件同进程，直接调共享编排即可（fetch 已被换成 CapacitorHttp，
        // 不受 WebView CORS 限制）。
        //
        // 脚本沙箱的择优（Worker 可打断 vs new Function 回退）仍在 `lxHost` 内部，
        // 对这里透明 —— 那是实现细节，不是调用方的形态判断。
        const resolved = await resolveTrackAudioViaPlugin(
          source,
          track,
          hostContextOf(source),
          quality
        )
        if (!resolved) return null
        return {
          ...track,
          onlineUrl: resolved.url,
          ...(resolved.qualityUrls ? { onlineQualityUrls: resolved.qualityUrls } : {}),
          ...(resolved.coverUrl ? { coverUrl: resolved.coverUrl } : {}),
        }
      } catch (err) {
        // 取址失败要静默回落按名搜索，不打断播放
        console.warn('[音源] 移动端取址失败:', ref?.sourceId || track?.onlineId, err)
        return null
      }
    },

    /**
     * 在线音乐（推荐歌单 / 榜单）：渲染层直调共享执行器。
     * 移动端 fetch 已被换成 CapacitorHttp（原生 HTTP），不受 WebView CORS 限制，
     * 因此无需像桌面端那样绕主进程
     */
    /**
     * 插件网关（移动端）。
     *
     * 与桌面端的差别：**没有 IPC**。移动端的插件注册表就在本进程（WebView），
     * 所以这里的"网关"其实是直接转发到插件门面与移动端安装器，
     * 而不是跨进程调用。形状与桌面端一致，上层 UI 不需要知道这个差别。
     *
     * 凭证类方法在移动端是空实现：移动端没有 `safeStorage` 等价物，
     * 因此声明了 auth 能力的插件在手机端不可用（`list` 里会如实反映能力，
     * UI 据此隐藏登录面板而不是点了才失败）。
     */
    plugins: {
      async list() {
        const { listCatalogEntries } = await import('./pluginInstall')
        const { entries } = await listCatalogEntries(currentLocale())
        // 只回「音源域且有实际能力」的插件：与桌面端 listPluginMeta 的口径一致
        return entries
          .filter((entry) => entry.domain === 'source' && entry.removable !== undefined)
          .map((entry) => ({
            id: entry.id,
            displayNameKey: entry.displayNameKey || entry.id,
            ...(entry.descriptionKey ? { descriptionKey: entry.descriptionKey } : {}),
            version: entry.version,
            capabilities: entry.capabilities,
            hasCredential: false,
          }))
      },
      // 能力调用：移动端没有 IPC，直接走插件门面（注册表在本进程）
      async probe(pluginId: string, config: unknown) {
        const { getPlugin } = await import('@aurora/shared')
        const plugin = getPlugin(pluginId)
        if (!plugin || typeof plugin.probe !== 'function') {
          return { ok: false, kind: 'aurora', capabilities: [], error: 'AURORA_ERR:{"code":"desktop.error.plugin.capabilityMissing"}' }
        }
        return plugin.probe(config as never, hostContextOf(config as never))
      },
      async search(pluginId: string, config: unknown, query: string, quality?: string) {
        const { getPlugin } = await import('@aurora/shared')
        const plugin = getPlugin(pluginId)
        if (!plugin || typeof plugin.search !== 'function') return []
        return plugin.search(
          config as never,
          query,
          quality as never,
          hostContextOf(config as never)
        )
      },
      async resolveTrack(pluginId: string, config: unknown, ref: unknown, quality?: string) {
        const { getPlugin } = await import('@aurora/shared')
        const plugin = getPlugin(pluginId)
        if (!plugin || typeof plugin.resolveTrack !== 'function') return null
        return plugin.resolveTrack(
          config as never,
          ref as never,
          quality as never,
          hostContextOf(config as never)
        )
      },
      async userPlaylists(pluginId: string, config: unknown) {
        const { getPlugin } = await import('@aurora/shared')
        const plugin = getPlugin(pluginId)
        if (!plugin || typeof plugin.listUserPlaylists !== 'function') return []
        return plugin.listUserPlaylists(config as never, hostContextOf(config as never))
      },
      async playlistTracks(pluginId: string, config: unknown, playlistId: string) {
        const { getPlugin } = await import('@aurora/shared')
        const plugin = getPlugin(pluginId)
        if (!plugin || typeof plugin.getPlaylistTracks !== 'function') return []
        return plugin.getPlaylistTracks(
          config as never,
          playlistId,
          hostContextOf(config as never)
        )
      },
      // 登录类：移动端无安全存储，明确不支持（UI 据 authState.encryptionAvailable 隐藏）
      async login() {
        throw new Error('AURORA_ERR:{"code":"desktop.error.plugin.encryptionUnavailable"}')
      },
      async authState() {
        return { loggedIn: false, encryptionAvailable: false }
      },
      async logout() {
        return { ok: true }
      },
      // ─── 安装 / 卸载 / 目录（移动端：Capacitor Filesystem + 原生 HTTP） ───
      async catalog(locale?: string) {
        const { listCatalogEntries } = await import('./pluginInstall')
        return listCatalogEntries(locale || currentLocale())
      },
      // 启动加载报告：移动端没有 IPC，直接读本进程那次挂载的结果。
      // 与桌面端同一形状，UI 的"插件没加载起来"提示两端共用一套逻辑。
      async startup() {
        const { lastPluginStartupReport } = await import('./pluginInstall')
        return lastPluginStartupReport()
      },
      // 移动端没有"选本地文件"（需要额外原生插件）：明确不给这个方法，
      // UI 据 `pickManifest === undefined` 隐藏对应按钮
      async installFromUrl(url: string, expectedSha256?: string, locale?: string) {
        void expectedSha256
        const { installFromUrl: install } = await import('./pluginInstall')
        return install(url, locale || currentLocale())
      },
      async uninstall(pluginId: string, locale?: string) {
        const { performUninstall } = await import('./pluginInstall')
        return performUninstall(pluginId, locale || currentLocale())
      },
      // 移动端没有"打开所在目录"的文件管理器体验
      async openDir() {
        return { ok: false }
      },
      async removeBroken(dirPath: string) {
        const { removeInstalledPlugin } = await import('./pluginStore')
        // dirPath 形如 `plugins/<id>/manifest.json`：取目录名当插件 id
        const id = dirPath.split('/').filter(Boolean).slice(-2)[0] || ''
        if (!id) return { ok: false, message: 'AURORA_PLUGIN_INVALID_PATH' }
        try {
          await removeInstalledPlugin(id)
          return { ok: true }
        } catch {
          return { ok: false, message: 'AURORA_PLUGIN_REMOVE_FAILED' }
        }
      },
    },

    /**
     * 在线发现（推荐 / 榜单）：同样走**插件门面**。
     *
     * 移动端没有独立主进程，插件就在本进程注册（内置插件 + 启动时挂载的已安装插件），
     * 因此这里可以直接调门面 —— 与桌面端主进程走的是同一段代码，
     * 差别只是「谁持有注册表」。改造前这里直连 aurora 协议执行器，
     * 结果是装来的声明式插件在手机端永远不提供在线发现。
     */
    musicHall: {
      async recommendPlaylists(source, options) {
        return recommendViaPlugin(
          source as unknown as OnlineSourceConfig,
          options ?? {},
          hostContextOf(source as unknown as OnlineSourceConfig)
        )
      },
      async toplistGroups(source, options) {
        return toplistsViaPlugin(
          source as unknown as OnlineSourceConfig,
          options ?? {},
          hostContextOf(source as unknown as OnlineSourceConfig)
        )
      },
      async toplistSongs(source, options) {
        return toplistDetailViaPlugin(
          source as unknown as OnlineSourceConfig,
          options ?? {},
          hostContextOf(source as unknown as OnlineSourceConfig)
        )
      },
    },

    /** 在线歌词搜索（与桌面端 lyrics:search 一致，源列表由调用方下传） */
    async searchLyrics(query, artist, album, duration, options) {
      return searchLyrics(query, artist, album, duration, options)
    },

    /**
     * 下载在线歌曲到外部存储的下载目录（默认 Music/Aurora Music/，可在设置里改）
     * - 使用 Capacitor Filesystem.downloadFile（native HTTP 下载，
     *   不受 WebView CORS 限制，也不会像 readFile 那样把大文件转 base64 导致 OOM）
     * - 写入公共目录需要「所有文件访问」权限（Android 11+），未授权时引导用户前往设置
     */
    async downloadOnlineTrack(track, headers, downloadDir) {
      if (!track || typeof track.audioUrl !== 'string' || !/^https?:\/\//i.test(track.audioUrl)) {
        throw auroraError('runtime.error.downloadUrlInvalid')
      }
      // Android 11+ 写公共目录需 MANAGE_EXTERNAL_STORAGE
      const hasAllFiles = await checkAllFilesAccess()
      if (!hasAllFiles) {
        alert(appTranslate()('runtime.permission.allFilesRequired'))
        await openAllFilesAccessSettings()
        throw auroraError('runtime.error.storagePermissionMissing')
      }

      const baseName = sanitizeFileName(
        `${track.artist || appTranslate()('runtime.download.unknownArtist')} - ${track.title || appTranslate()('runtime.download.unknownTitle')}`
      )
      const ext = inferAudioExtFromUrl(track.audioUrl)
      const dir = await normalizeDownloadDir(downloadDir)
      try {
        await Filesystem.mkdir({ path: dir, directory: Directory.ExternalStorage, recursive: true })
      } catch (err: any) {
        // 目录已存在不算错误；其余（无权限、存储卸载）转成结构化错误码，文案由显示端渲染
        if (!err?.message || !/exist/i.test(err.message)) {
          console.error('[Mobile] 创建下载目录失败:', err)
          throw auroraError('runtime.error.downloadDirCreateFailed')
        }
      }

      // 下载前探测同名文件并追加 " (1)" 后缀：downloadFile 对已存在路径会直接覆盖，
      // 静默覆盖用户已下载的歌曲。这里最多探测 99 次，超限回退到时间戳后缀。
      let fileName = `${baseName}${ext}`
      for (let i = 0; i < 100; i++) {
        const candidate = i === 0 ? `${baseName}${ext}` : `${baseName} (${i})${ext}`
        try {
          await Filesystem.stat({ path: `${dir}/${candidate}`, directory: Directory.ExternalStorage })
          // 未抛错说明文件已存在，继续探测下一个后缀
        } catch {
          fileName = candidate
          break
        }
        if (i === 99) {
          fileName = `${baseName} (${Date.now().toString(36)})${ext}`
        }
      }

      const savePath = `${dir}/${fileName}`
      try {
        await Filesystem.downloadFile({
          url: track.audioUrl,
          path: savePath,
          directory: Directory.ExternalStorage,
          headers: headers || {},
        })
      } catch (err) {
        console.error('[Mobile] 下载失败:', err)
        throw auroraError('runtime.error.downloadFailed', undefined, err instanceof Error ? err.message : String(err))
      }

      // 源直链的音频大多不带内嵌封面，下载后用搜索结果里的 coverUrl 嵌入封面
      // （MP3 写 ID3v2 APIC，FLAC 写 PICTURE 块，M4A/MP4 写 ilst covr）。
      // 失败只记日志、保留原文件。
      if (typeof track.coverUrl === 'string' && /^https?:\/\//i.test(track.coverUrl)) {
        try {
          await embedCoverIntoDownloaded(savePath, track)
        } catch (err) {
          console.warn('[Mobile] 封面嵌入失败（不影响下载）:', err)
        }
      }
      // 返回完整路径，便于提示与后续扫描定位。
      // 不能硬编码 `/storage/emulated/0/` 前缀：多用户/工作资料（/storage/emulated/10/）
      // 或外置 SD 卡上真实挂载点不同，硬编码会让「下载完成」提示里的路径打不开。
      // Filesystem.getUri 由原生侧按实际挂载点解析，返回 file:// 形式的绝对 URI，
      // 这里转成本机路径（去掉 file:// 前缀）。
      try {
        const { uri } = await Filesystem.getUri({ path: savePath, directory: Directory.ExternalStorage })
        return { savedPath: uri.replace(/^file:\/\//, '') }
      } catch (err) {
        // getUri 失败时不该让「已下载成功」的结论翻转成失败：退回相对路径，
        // 提示里至少是可读的「下载目录/文件名」
        console.warn('[Mobile] 获取保存路径失败，回退相对路径:', err)
        return { savedPath: savePath }
      }
    },

    // ─── 媒体缓存：音频 / 封面 / 歌词（实现在 ./mediaCache.ts）───
    // 与桌面端同构：三类内容共用一份容量配置、按池 LRU 驱逐，落盘走 Capacitor
    // Filesystem（应用专属目录，无需存储权限）。设置页按能力探测决定是否显示
    // 缓存分区，这里挂上方法即代表移动端可用。
    resolveCachedAudio: resolveMobileCachedAudio,
    resolveCachedCover: resolveMobileCachedCover,
    async configureAudioCache(opts) {
      await configureMobileMediaCache(opts?.limitMB ?? 1024)
    },
    getAudioCacheUsage: getMobileCacheUsage,
    clearAudioCache: clearMobileMediaCache,

    database: db,
    windowControls: new NoopWindowControls(),

    // 扩展接口（仅 mobile 需要）
    async getAllTracks() {
      await ensureDbInited()
      return db.getAllTracks()
    },

    /** 移除扫描目录：删除该目录下的全部曲目，返回移除后的全库列表 */
    async removeFolder(folderPath: string) {
      await ensureDbInited()
      const removed = await db.deleteTracksByFolder(folderPath)
      if (removed > 0) console.log('[Mobile] 已移除扫描目录并清理曲目:', folderPath, removed)
      return db.getAllTracks()
    },

    // ─── 诊断日志：写应用专属存储（无需权限），导出时才尝试公共目录 ───
    // 懒创建：日志能力在启动最早期就会用到，但 createMobilePlatform 的返回对象是
    // 冻结的单例；用 getter 让「第一次访问时才装配」与「后续访问返回同一实例」同时成立，
    // 实例一旦建好就持有攒批队列，重复创建会把队列清空。
    get logging() {
      if (!mobileLogging) {
        mobileLogging = createMobileLogging(() => ({
          appVersion: APP_VERSION,
          // Capacitor.getPlatform() 而非 process.platform：WebView 里没有 process，
          // 这里要的是 android / ios 而不是宿主 OS
          platform: Capacitor.getPlatform(),
          locale: currentLocale(),
          runtime: `Capacitor ${Capacitor.getPlatform()}`,
          arch: undefined,
        }))
      }
      return mobileLogging
    },

    async scanFolder(folderPath: string) {
      if (typeof folderPath !== 'string' || !folderPath.trim()) {
        emitScanError({ folder: '', message: appTranslate()('runtime.scan.folderUnspecified') })
        throw new Error('empty folder path')
      }
      return enqueueScan(folderPath)
    },

    onTracksScanned(cb: ScanCompleteCb) {
      scanCompleteCbs.add(cb)
      return () => scanCompleteCbs.delete(cb)
    },

    onTrackScanned(cb: TrackScannedCb) {
      trackScannedCbs.add(cb)
      return () => trackScannedCbs.delete(cb)
    },

    onScanError(cb: ScanErrorCb) {
      scanErrorCbs.add(cb)
      return () => scanErrorCbs.delete(cb)
    },

    onFolderMissing(cb: FolderMissingCb) {
      folderMissingCbs.add(cb)
      return () => folderMissingCbs.delete(cb)
    },

    onMediaControl(cb: MediaControlCb) {
      // 移动端通过 navigator.mediaSession 接收系统媒体键（在 App.tsx 中已注册）
      // 这里保留接口与桌面端 electronAPI.onMediaControl 对齐，但实际无 native 事件
      mediaControlCbs.add(cb)
      return () => mediaControlCbs.delete(cb)
    },
  }
}
