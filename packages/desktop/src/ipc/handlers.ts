import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { app } from 'electron'
import { getAllTracks, getTrackById, initDatabase, deleteTracksByFolder } from './database'
import { scanFolder, ensureCover, fetchOnlineCover } from './scanner'
import { registerSystemIpc } from './system'
import type { OnlineTrackSearchResult, OnlineSearchOptions, Track } from '../types'
import type { LyricsSearchOptions, LyricsSearchResult } from '@aurora/shared'
import { searchOnlineTracks, searchLyrics, sanitizeFileName, inferAudioExtFromUrl } from '@aurora/shared'

let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow) {
  mainWindow = win
}

/** 安全地向渲染进程发送事件（窗口可能已销毁） */
function sendToRenderer(channel: string, ...args: unknown[]) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

// 已扫描过的目录白名单：fs:readFile 仅允许读取这些目录内的文件
const allowedRoots = new Set<string>()

function isPathAllowed(target: string): boolean {
  const resolved = path.resolve(target)
  for (const root of allowedRoots) {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep
    if (resolved.startsWith(prefix)) return true
  }
  return false
}

/** trackId 仅允许字母数字与连字符（uuid / 源id-歌曲id），防止路径穿越 */
function isValidTrackId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(id)
}

/** 从 Content-Type 推断音频扩展名，无法判断时回退到按 URL 推断 */
function inferAudioExtension(url: string, contentType?: string): string {
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
  return inferAudioExtFromUrl(url)
}

/** 生成不重名的保存路径：已存在同名文件时依次追加 " (1)" " (2)"… */
async function uniqueSavePath(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName)
  const stem = fileName.slice(0, -ext.length)
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i === 0 ? fileName : `${stem} (${i})${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
}

// 扫描队列：多个目录串行执行，避免并发写数据库、进度事件互相覆盖
let scanChain: Promise<unknown> = Promise.resolve()

function enqueueScan(folderPath: string): Promise<Track[]> {
  const task = scanChain.then(() => runScan(folderPath))
  // 链上吞掉错误，避免一次失败阻断后续扫描
  scanChain = task.catch(() => {})
  return task
}

async function runScan(folderPath: string): Promise<Track[]> {
  const userData = app.getPath('userData')

  try {
    if (!isReadableDir(folderPath)) {
      // 扫描目录本身已不存在：区分「确实被删除」与「外置盘未挂载/临时不可访问」
      // - 父目录仍在 → 目录被用户删除，清理其曲目并通知 UI 移除该扫描目录，
      //   否则音乐库里会残留已删目录的歌曲（数量对不上）
      // - 父目录也不在 → 更可能是外置盘未挂载，保留曲目记录，仅报错跳过，避免误删音乐库
      if (fs.existsSync(path.dirname(folderPath))) {
        const removed = deleteTracksByFolder(folderPath)
        console.log('扫描目录已不存在，清理其曲目:', folderPath, removed)
        const remaining = getAllTracks()
        sendToRenderer('scan:complete', remaining)
        sendToRenderer('scan:folder-missing', { folder: folderPath, removed })
        return remaining
      }
      throw new Error('文件夹不存在或不可访问')
    }
    allowedRoots.add(path.resolve(folderPath))
    // 渐进式扫描：每解析完一首立即推送到渲染进程，UI 端追加显示而非等全部完成
    await scanFolder(folderPath, userData, (track) => {
      sendToRenderer('track:scanned', track)
    })
    const allTracks = getAllTracks()
    sendToRenderer('scan:complete', allTracks)
    return allTracks
  } catch (err) {
    console.error('扫描失败:', folderPath, err)
    // 静默后台扫描：仅通知渲染进程记录日志，不向用户展示
    sendToRenderer('scan:error', {
      folder: folderPath,
      message: `扫描失败：文件夹「${folderPath}」不存在或无法读取`,
    })
    throw err
  }
}

function isReadableDir(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

export function registerIpcHandlers() {
  initDatabase()
  // 系统环境探测（发行版包格式 / 安装形态）：渲染层据此挑选匹配的安装包
  registerSystemIpc()

  ipcMain.handle('dialog:openFolder', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '选择音乐文件夹',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('fs:readDir', async (_event, dirPath: string) => {
    try {
      if (typeof dirPath !== 'string' || !isPathAllowed(dirPath)) return []
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
      return entries.map((e) => ({
        name: e.name,
        path: path.join(dirPath, e.name),
        isDirectory: e.isDirectory(),
      }))
    } catch {
      return []
    }
  })

  ipcMain.handle('fs:readFile', async (_event, filePath: string) => {
    try {
      // 只允许读取已扫描目录内的文件，防止任意文件读取
      if (typeof filePath !== 'string' || !isPathAllowed(filePath)) return new ArrayBuffer(0)
      const buf = await fs.promises.readFile(filePath)
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    } catch {
      return new ArrayBuffer(0)
    }
  })

  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })

  ipcMain.handle('window:close', () => {
    mainWindow?.close()
  })

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false
  })

  // 无边框窗口的边缘缩放：由渲染进程驱动鼠标手势，主进程应用 setBounds
  ipcMain.handle('window:getBounds', () => {
    if (!mainWindow) return null
    return mainWindow.getBounds()
  })

  ipcMain.handle('window:setBounds', (_event, bounds: Electron.Rectangle) => {
    if (!mainWindow) return
    mainWindow.setBounds(bounds)
  })

  ipcMain.handle('app:getUserDataPath', () => {
    return app.getPath('userData')
  })

  ipcMain.handle('scan:start', async (_event, folderPath: string) => {
    if (typeof folderPath !== 'string' || !folderPath.trim()) {
      sendToRenderer('scan:error', { folder: '', message: '扫描失败：未指定文件夹' })
      throw new Error('empty folder path')
    }
    // 进入串行队列执行；失败时 runScan 已发送 scan:error 事件
    return enqueueScan(folderPath)
  })

  ipcMain.handle('db:getAllTracks', () => {
    return getAllTracks()
  })

  // 从音乐库移除某个扫描目录：删除该目录下的全部曲目记录（含封面缓存），
  // 返回移除后的全库列表，渲染进程直接用它刷新音乐库
  ipcMain.handle('library:removeFolder', (_event, folderPath: string): Track[] => {
    if (typeof folderPath !== 'string' || !folderPath.trim()) return getAllTracks()
    allowedRoots.delete(path.resolve(folderPath))
    const removed = deleteTracksByFolder(folderPath)
    if (removed > 0) console.log('已移除扫描目录并清理曲目:', folderPath, removed)
    return getAllTracks()
  })

  ipcMain.handle('tracks:get', async (_event, id: string) => {
    return getTrackById(id)
  })

  // 按需补齐封面：扫描时为提速跳过了嵌入图片读取，UI 需要时单独提取并缓存
  ipcMain.handle('covers:ensure', async (_event, id: string): Promise<string | null> => {
    let track = getTrackById(id)
    if (!track) {
      // 渐进式扫描期间 UI 可能先于批量入库请求封面：等当前扫描队列落库后重查一次，
      // 避免把"记录尚未写入"误判成"无封面"（渲染层会把 null 缓存一整个会话）
      await scanChain
      track = getTrackById(id)
      if (!track) return null
    }
    return ensureCover(track, app.getPath('userData'))
  })

  // 在线补齐封面：文件无内嵌封面时，按标题/艺术家搜索用户配置的在线歌源，
  // 取标题匹配（艺术家/时长加分）的候选封面下载缓存。无匹配返回 null。
  ipcMain.handle(
    'covers:fetchOnline',
    async (_event, id: string, options?: OnlineSearchOptions): Promise<string | null> => {
      // trackId 白名单校验：封面以 id 为文件名落盘，防路径穿越
      if (typeof id !== 'string' || !isValidTrackId(id)) return null
      // 标题/艺术家/时长一律以库内记录为准，不信任渲染层下传；记录未入库时同样等扫描落库
      let track = getTrackById(id)
      if (!track) {
        await scanChain
        track = getTrackById(id)
        if (!track) return null
      }
      return fetchOnlineCover(track, app.getPath('userData'), options)
    }
  )

  // 读取本地歌词文件：路径 ${userData}/aurora-music/lyrics/${trackId}.lrc，不存在返回 null
  ipcMain.handle('lyrics:read', async (_event, trackId: string): Promise<string | null> => {
    try {
      // trackId 白名单校验，防止路径穿越（在线曲目的 id 来自远端服务器）
      if (typeof trackId !== 'string' || !isValidTrackId(trackId)) return null
      const filePath = path.join(app.getPath('userData'), 'aurora-music', 'lyrics', `${trackId}.lrc`)
      const content = await fs.promises.readFile(filePath, 'utf-8')
      return content
    } catch {
      return null
    }
  })

  // 保存歌词到本地，返回保存的文件路径
  ipcMain.handle('lyrics:save', async (_event, lyrics: string, trackId: string): Promise<string> => {
    if (typeof trackId !== 'string' || !isValidTrackId(trackId)) {
      throw new Error('invalid track id')
    }
    if (typeof lyrics !== 'string') lyrics = ''
    const dir = path.join(app.getPath('userData'), 'aurora-music', 'lyrics')
    await fs.promises.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, `${trackId}.lrc`)
    await fs.promises.writeFile(filePath, lyrics, 'utf-8')
    return filePath
  })

  // 在线搜索歌词：调用共享执行器，按用户配置的歌词源依次尝试
  // （应用不内置任何歌词源，源列表由渲染进程下传）
  ipcMain.handle(
    'lyrics:search',
    async (
      _event,
      query: string,
      artist?: string,
      album?: string,
      duration?: number,
      options?: LyricsSearchOptions
    ): Promise<LyricsSearchResult | null> => {
      try {
        return await searchLyrics(query, artist, album, duration, options)
      } catch {
        return null
      }
    }
  )

  // 聚合在线搜索：调用共享执行器，并发调用用户配置的所有启用源
  // - 单源失败不影响其他源；全部失败时抛错，前端展示直白的中文网络错误提示
  ipcMain.handle(
    'tracks:searchOnline',
    async (_event, query: string, options?: OnlineSearchOptions): Promise<OnlineTrackSearchResult[]> => {
      return searchOnlineTracks(query, options)
    }
  )

  // 下载在线歌曲：主进程直接拉流（渲染进程 fetch 会被歌源服务器 CORS 拦截）
  // 传了默认下载目录（downloadDir）则免对话框直存并自动去重名；
  // 未传时弹保存对话框由用户选择保存位置。流式写盘避免大文件占用内存
  ipcMain.handle(
    'tracks:download',
    async (
      _event,
      track: { audioUrl: string; title: string; artist?: string },
      headers?: Record<string, string>,
      downloadDir?: string
    ): Promise<{ savedPath: string }> => {
      if (!track || typeof track.audioUrl !== 'string' || !/^https?:\/\//i.test(track.audioUrl)) {
        throw new Error('下载地址无效')
      }
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error('窗口不可用')

      const baseName = sanitizeFileName(`${track.artist || '未知艺术家'} - ${track.title || '未知歌曲'}`)

      // 目标目录：默认目录直存 vs 对话框选择（对话框的扩展名此时只能按 URL 猜，最终以响应为准）
      let fixedDir: string | null = null
      let dialogFilePath: string | null = null
      if (typeof downloadDir === 'string' && downloadDir.trim()) {
        const dir = downloadDir.trim()
        // 渲染层下传的目录必须是绝对路径，防相对路径/盘符异常
        if (!path.isAbsolute(dir)) throw new Error('默认下载目录无效')
        await fs.promises.mkdir(dir, { recursive: true })
        fixedDir = dir
      } else {
        const systemMusicDir = (() => {
          try {
            return app.getPath('music')
          } catch {
            return app.getPath('downloads')
          }
        })()
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
          title: '保存歌曲',
          defaultPath: path.join(systemMusicDir, `${baseName}${inferAudioExtension(track.audioUrl)}`),
        })
        if (canceled || !filePath) throw new Error('已取消保存')
        dialogFilePath = filePath
      }

      let resp: Response
      try {
        resp = await fetch(track.audioUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ...(headers || {}),
          },
          // 下载大文件可能超过 1 分钟，给 10 分钟上限
          signal: AbortSignal.timeout(600000),
        })
      } catch {
        throw new Error('下载失败，请检查网络连接或稍后重试')
      }
      if (!resp.ok || !resp.body) {
        throw new Error(`下载失败：服务器返回 HTTP ${resp.status}`)
      }

      // 扩展名以实际响应的 Content-Type 为准（对话框时只能按 URL 猜测）
      const finalExt = inferAudioExtension(track.audioUrl, resp.headers.get('content-type') || undefined)
      const savePath = fixedDir
        ? await uniqueSavePath(fixedDir, `${baseName}${finalExt}`)
        : path.extname(dialogFilePath!)
          ? dialogFilePath!
          : dialogFilePath! + finalExt

      try {
        await pipeline(Readable.fromWeb(resp.body as any), fs.createWriteStream(savePath))
      } catch (err) {
        // 写盘失败时清理残留的部分文件
        try { fs.unlinkSync(savePath) } catch {}
        console.error('歌曲下载失败:', err)
        throw new Error('下载失败，写入文件时出错')
      }
      return { savedPath: savePath }
    }
  )
}
