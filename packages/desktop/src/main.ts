import { app, BrowserWindow, shell, globalShortcut, protocol } from 'electron'
import path from 'path'
import fs from 'fs'
import { registerIpcHandlers, setMainWindow } from './ipc/handlers'
import { closeDatabase } from './ipc/database'

const isDev = !app.isPackaged

// 主进程未捕获异常兜底：记录日志而不是直接崩溃，避免播放中静默退出
process.on('uncaughtException', (err) => {
  console.error('[Main] uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[Main] unhandledRejection:', reason)
})

// 注册安全的本地文件协议：替代 file://，避免 webSecurity 阻止渲染进程加载本地封面图
// 用法：cover-local://localhost/absolute/path/to/file.jpg
protocol.registerSchemesAsPrivileged([{
  scheme: 'cover-local',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    bypassCSP: true,
    corsEnabled: true,
  },
}])

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
      // 开发模式下关闭 webSecurity，允许 file:// 音频加载（Web Audio API 的 MediaElementSource 需要同源访问）
      // 生产模式打包后页面用 file:// 加载，与音频同源，无需关闭
      webSecurity: !isDev,
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
app.commandLine.appendSwitch('disable-gpu')

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
    // 注册 cover-local 协议处理器：读取本地文件并返回，绕过 webSecurity 对 file:// 的限制
    // 用法：cover-local://localhost/absolute/path → 读取 /absolute/path
    protocol.handle('cover-local', async (request) => {
      try {
        const url = new URL(request.url)
        const filePath = decodeURIComponent(url.pathname)
        const ext = path.extname(filePath).toLowerCase()
        // 支持音频 Range 请求（html5 <audio> seek 需要）
        const stat = await fs.promises.stat(filePath)
        const range = request.headers.get('range')
        if (range) {
          const m = /bytes=(\d+)-(\d*)/.exec(range)
          if (m) {
            const start = parseInt(m[1])
            const end = m[2] ? parseInt(m[2]) : stat.size - 1
            const chunkSize = end - start + 1
            const stream = fs.createReadStream(filePath, { start, end })
            const chunks: Buffer[] = []
            for await (const chunk of stream) chunks.push(chunk as Buffer)
            const buffer = Buffer.concat(chunks)
            const ext = path.extname(filePath).toLowerCase()
            const mimeMap: Record<string, string> = {
              '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
              '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
              '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.wma': 'audio/x-ms-wma', '.opus': 'audio/ogg',
            }
            const mime = mimeMap[ext] || 'application/octet-stream'
            return new Response(buffer, {
              status: 206,
              headers: {
                'Content-Type': mime,
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Content-Length': String(chunkSize),
                'Accept-Ranges': 'bytes',
                'Access-Control-Allow-Origin': '*',
              },
            })
          }
        }
        const buf = await fs.promises.readFile(filePath)
        const mimeMap2: Record<string, string> = {
          '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
          '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.wma': 'audio/x-ms-wma', '.opus': 'audio/ogg',
        }
        const mime2 = mimeMap2[ext] || 'application/octet-stream'
        return new Response(buf, { headers: { 'Content-Type': mime2, 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' } })
      } catch (err) {
        console.error('[cover-local] 读取失败:', err)
        return new Response('', { status: 404 })
      }
    })

    registerIpcHandlers()
    const win = createWindow()

    if (process.platform === 'linux') {
      // Linux 上通过 MPRIS 协议（DBus）响应媒体键
      // TODO: mpris-service 依赖的原生模块在 Electron 中可能不兼容，暂时禁用
      // initMpris(win)
      console.log('[MPRIS] Disabled temporarily')
    } else {
      // Windows/macOS 上通过 globalShortcut 注册媒体键
      const shortcuts = [
        { key: 'MediaPlayPause', action: 'toggle-play' },
        { key: 'MediaNextTrack', action: 'next' },
        { key: 'MediaPreviousTrack', action: 'previous' },
        { key: 'MediaStop', action: 'stop' },
      ]
      shortcuts.forEach(({ key, action }) => {
        const success = globalShortcut.register(key, () => {
          win?.webContents.send('media-control', action)
        })
        console.log(`[GlobalShortcut] Registered ${key}: ${success ? 'SUCCESS' : 'FAILED'}`)
      })
    }
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

  // 退出清理：注销全局快捷键、关闭数据库（确保 WAL 落盘）
  app.on('before-quit', () => {
    globalShortcut.unregisterAll()
    closeDatabase()
  })
}
