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
}
