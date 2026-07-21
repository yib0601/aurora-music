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
    // Windows 下 transparent:true + frame:false + backgroundColor:#00000000 组合
    // 在部分显卡驱动/DWM 环境下会导致窗口创建成功但完全不可见（进程在跑、无窗口）。
    // 改为非透明 + 不透明背景色，毛玻璃效果通过 CSS backdrop-filter 在渲染层实现。
    transparent: false,
    frame: false,
    backgroundColor: '#0a0a0f',
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

  // ready-to-show 在某些情况下不触发（渲染进程卡住时窗口永远不显示）。
  // 加 1.5s 超时兜底强制显示，避免用户以为软件打不开。
  const showTimeout = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      win.show()
    }
  }, 1500)

  win.once('ready-to-show', () => {
    clearTimeout(showTimeout)
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

// 单实例锁：用户重复点击图标时聚焦已有窗口，而不是启动新进程
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows()
    if (wins.length > 0) {
      const w = wins[0]
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
    }
  })

  app.whenReady().then(() => {
    registerIpcHandlers()
    createWindow()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
