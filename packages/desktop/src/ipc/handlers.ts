import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { getAllTracks, initDatabase } from './database'
import { scanFolder } from './scanner'

let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow) {
  mainWindow = win
}

export function registerIpcHandlers() {
  initDatabase()

  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: '选择音乐文件夹',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('fs:readDir', async (_event, dirPath: string) => {
    try {
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
    const userData = app.getPath('userData')
    mainWindow?.webContents.send('scan:progress', {
      current: 0,
      total: 0,
      file: '准备扫描...',
    })

    const tracks = await scanFolder(folderPath, userData, (progress) => {
      mainWindow?.webContents.send('scan:progress', progress)
    })

    const allTracks = getAllTracks()
    mainWindow?.webContents.send('scan:complete', allTracks)
    return allTracks
  })

  ipcMain.handle('db:getAllTracks', () => {
    return getAllTracks()
  })

  // 读取本地歌词文件：路径 ${userData}/aurora-music/lyrics/${trackId}.lrc，不存在返回 null
  ipcMain.handle('lyrics:read', async (_event, trackId: string): Promise<string | null> => {
    try {
      const filePath = path.join(app.getPath('userData'), 'aurora-music', 'lyrics', `${trackId}.lrc`)
      const content = await fs.promises.readFile(filePath, 'utf-8')
      return content
    } catch {
      return null
    }
  })

  // 保存歌词到本地，返回保存的文件路径
  ipcMain.handle('lyrics:save', async (_event, lyrics: string, trackId: string): Promise<string> => {
    const dir = path.join(app.getPath('userData'), 'aurora-music', 'lyrics')
    await fs.promises.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, `${trackId}.lrc`)
    await fs.promises.writeFile(filePath, lyrics, 'utf-8')
    return filePath
  })

  // 在线搜索歌词（LRCLIB API，提供带时间标签的同步歌词）
  // 文档：https://lrclib.net/docs
  ipcMain.handle(
    'lyrics:search',
    async (
      _event,
      query: string,
      artist?: string,
      album?: string,
      duration?: number
    ): Promise<{ lrc: string | null; name: string; artist: string } | null> => {
      const UA = 'Aurora-Music v0.1.2 (https://github.com/yib0601/aurora-music)'
      try {
        // 优先用 /api/get 精确匹配（需要 track_name + artist_name，album 和 duration 提高精度）
        // query 即 track_name，artist 即 artist_name
        const params = new URLSearchParams()
        params.set('track_name', query)
        if (artist) params.set('artist_name', artist)
        if (album) params.set('album_name', album)
        if (duration && duration > 0 && duration <= 3600) params.set('duration', String(Math.round(duration)))

        const getUrl = `https://lrclib.net/api/get?${params.toString()}`
        const getResp = await fetch(getUrl, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(8000),
        })

        if (getResp.ok) {
          const data = (await getResp.json()) as {
            trackName?: string
            artistName?: string
            syncedLyrics?: string | null
            plainLyrics?: string | null
          }
          // 优先返回同步歌词（带时间标签），其次纯文本歌词
          const lrc = data.syncedLyrics || data.plainLyrics || null
          if (lrc) {
            return {
              lrc,
              name: data.trackName || query,
              artist: data.artistName || artist || '',
            }
          }
        }

        // /api/get 未命中，用 /api/search 模糊搜索作为 fallback
        const searchParams = new URLSearchParams()
        searchParams.set('track_name', query)
        if (artist) searchParams.set('artist_name', artist)
        const searchUrl = `https://lrclib.net/api/search?${searchParams.toString()}`
        const searchResp = await fetch(searchUrl, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(8000),
        })

        if (searchResp.ok) {
          const results = (await searchResp.json()) as Array<{
            trackName?: string
            artistName?: string
            duration?: number
            syncedLyrics?: string | null
            plainLyrics?: string | null
          }>
          if (Array.isArray(results) && results.length > 0) {
            // 如果有 duration，优先选 duration 最接近的
            let best = results[0]
            if (duration && duration > 0) {
              const targetDur = Math.round(duration)
              best = results.reduce((acc, cur) => {
                const accDiff = Math.abs((acc.duration || 0) - targetDur)
                const curDiff = Math.abs((cur.duration || 0) - targetDur)
                return curDiff < accDiff ? cur : acc
              })
            }
            const lrc = best.syncedLyrics || best.plainLyrics || null
            if (lrc) {
              return {
                lrc,
                name: best.trackName || query,
                artist: best.artistName || artist || '',
              }
            }
          }
        }

        return null
      } catch {
        return null
      }
    }
  )
}
