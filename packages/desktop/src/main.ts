import { app, BrowserWindow, shell } from 'electron'
import path from 'path'
import { registerIpcHandlers, setMainWindow } from './ipc/handlers'

const isDev = !app.isPackaged

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    hasShadow: true,
    thickFrame: false,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
    show: false,
  })

  setMainWindow(win)

  win.once('ready-to-show', () => {
    win.show()
  })

  if (isDev) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    const htmlPath = path.join(__dirname, '../app-dist/index.html')
    win.loadFile(htmlPath)
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('maximize', () => {
    win.webContents.send('window:maximized', true)
  })
  win.on('unmaximize', () => {
    win.webContents.send('window:maximized', false)
  })

  return win
}

// ⚠️ 必须在 app.whenReady() 之前调用，否则不生效
// 注意：ozone-platform 必须用命令行参数 --ozone-platform=x11 在 desktop 文件中设置，
// app.commandLine.appendSwitch 在 Electron 43 上太晚（Chromium 已选 Wayland）
// --disable-gpu：AMD Radeon Vega APU 在 Wayland 下 GPU 进程会 SIGSEGV (exit 139)
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder')

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
