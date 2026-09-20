import { app, BrowserWindow, shell, globalShortcut, protocol, Tray, Menu, nativeImage } from 'electron'
import path from 'path'
import fs from 'fs'
import { registerIpcHandlers, setMainWindow } from './ipc/handlers'
import { closeDatabase } from './ipc/database'
import { getLibrarySource } from './ipc/librarySource'
import {
  REMOTE_SCHEME,
  parseRemoteAudioUrl,
  resolveRemoteUrl,
  webdavHeaders,
  guessAudioMime,
  WebdavError,
  decodeFileUrlToPath,
} from '@aurora/shared'

const isDev = !app.isPackaged

// 统一应用名称：Linux 通知栏中 Chromium 内建 MPRIS 播放器的显示名取自应用名，
// 默认会显示包名 "@aurora/desktop"，这里改为可读的 "Aurora Music"
app.setName('Aurora Music')
// 改名后默认 userData 会变成 <appData>/Aurora Music，需固定回历史路径，
// 否则已有的音乐库数据库、封面与歌词缓存（<userData>/aurora-music/）会丢失
app.setPath('userData', path.join(app.getPath('appData'), '@aurora', 'desktop'))

// 托盘：点击窗口关闭按钮时最小化到托盘继续播放，从托盘菜单可真正退出
let tray: Tray | null = null
let isQuitting = false

function getTrayIconPath(): string {
  // 打包后图标随 extraResources 复制到 resources 目录；开发时直接读源码目录
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '../resources/icon.png')
}

function createTray(win: BrowserWindow) {
  try {
    const icon = nativeImage.createFromPath(getTrayIconPath())
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  } catch (err) {
    console.error('[Tray] 创建托盘失败:', err)
    return
  }
  tray.setToolTip('Aurora Music')
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      },
    },
    { type: 'separator' },
    {
      label: '退出 Aurora Music',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(contextMenu)
  tray.on('click', () => {
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}

// 主进程未捕获异常兜底：记录日志而不是直接崩溃，避免播放中静默退出
process.on('uncaughtException', (err) => {
  console.error('[Main] uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[Main] unhandledRejection:', reason)
})

// 注册安全的本地文件协议：替代 file://，避免 webSecurity 阻止渲染进程加载本地封面图
// 用法：cover-local://localhost/absolute/path/to/file.jpg
//
// aurora-remote 是 WebDAV 媒体库的音频代理协议：
// 用法 aurora-remote://<sourceId>/<URL 编码的相对路径>
// 远端地址需要 Basic 鉴权，而 <audio src> 无法携带自定义请求头，且把口令拼进
// URL 会随 Track 落库；因此由主进程持有来源配置并代为请求，顺带支持 Range。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cover-local',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
  {
    scheme: REMOTE_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
])

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
      // 保持渲染进程沙箱开启。preload.ts 只用 contextBridge + ipcRenderer（沙箱下均可用），
      // 不引用任何 node: 内置模块；所有文件读写都在主进程侧（fs:readDir / fs:readFile 等
      // ipcMain.handle）完成，不受渲染进程沙箱影响。
      // 实测 sandbox:true 下 electronAPI 的 33 个方法全部注入成功，getUserDataPath /
      // getAllTracks / readDir 等真实 IPC 调用均正常，零 SecurityError，60 FPS 无差异。
      sandbox: true,
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

  // 关闭按钮 → 隐藏窗口到托盘继续播放，而不是直接退出
  // 只有从托盘菜单选择「退出」时才真正关闭（isQuitting=true）
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  return win
}

// ⚠️ 必须在 app.whenReady() 之前调用，否则不生效
//
// 【不要加 --disable-gpu】历史上曾用它规避「Wayland 下 GPU 进程 SIGSEGV (exit 139)」，
// 但 2026-09 实测证明那是误判：本机（AMD Renoir Vega APU + GNOME Wayland + Mesa 26.2.2）
// 硬件加速路径完全正常，反倒是 --disable-gpu / --no-sandbox 会诱发
// `GPU process launch failed: error_code=1002` → `FATAL: GPU process isn't usable`。
// 实测对照（electron 43.1.0，1280x800 真实窗口，app/dist）：
//   · 不加参数        → 渲染器 ANGLE (AMD, radeonsi renoir ACO)，gpu_compositing=enabled，
//                       首屏 215ms，60.5 FPS，jank 0%；重度 blur/backdrop-filter 压测 20s 得 1190 帧且零崩溃
//   · --disable-gpu   → 软渲染（WebGL 不可用），gpu_compositing=disabled_software，
//                       首屏 658ms，60.2 FPS，同压测仅 335 帧（慢 3.55 倍）
// 即：加了这个开关反而更慢，还平白引入 GPU 进程启动失败的风险。
// 保留 enable-features=VaapiVideoDecoder 用于视频硬解（实测对 GPU 进程无副作用）。
// 若将来在别的 AMD/驱动组合上真的复现 GPU 崩溃，请先确认是 GPU 进程崩溃而非启动失败，
// 再针对性回归，不要直接恢复 --disable-gpu。
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder')
}

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
        // 用 decodeFileUrlToPath 替代裸 decodeURIComponent(url.pathname)：健壮性加固。
        // 说明：正常链路上渲染层用 encodeURIComponent 逐段编码，`%` 会先变成 `%25`，
        // 所以旧写法不会抛错，这条改动不是修线上 404。它解决的是「外部构造/第三方
        // 传入的、含裸 `%` 的 URL」（如 `.../100%.mp3`）会让 decodeURIComponent 抛
        // URIError: URI malformed，被下方 catch 吞掉后静默 404 的问题；
        // decodeFileUrlToPath 逐段解码、单段失败时原样保留，不抛错。
        //
        // 注意必须传 url.pathname，不能传整条 request.url：该函数只识别 `file://`
        // 前缀，对 `cover-local://localhost/...` 会走「非 file:// 按普通路径处理」
        // 分支，把 scheme 与 host 当成路径段，得到
        // `/cover-local:/localhost/home/...` 这种错误文件路径（导致所有本地封面 404）。
        // pathname 以 `/` 开头，按普通路径处理会补回前导 `/`，语义正确。
        let filePath = decodeFileUrlToPath(url.pathname)
        // Windows：渲染层把盘符路径转成 /C:/... 形式传入（否则盘符会被 URL
        // 吞进 host/port 部分），这里去掉前导斜杠还原成真实文件路径
        if (process.platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(filePath)) {
          filePath = filePath.slice(1)
        }
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

    // WebDAV 音频代理：按 sourceId 找到来源配置，带鉴权转发到远端，
    // 并把 Range 请求与 206 响应原样透传（html5 <audio> 的 seek 依赖它）。
    // 口令只在这里使用，渲染层拿到的永远是 aurora-remote://<sourceId>/...
    protocol.handle(REMOTE_SCHEME, async (request) => {
      const parsed = parseRemoteAudioUrl(request.url)
      if (!parsed) return new Response('', { status: 400 })

      const cfg = getLibrarySource(parsed.sourceId)
      if (!cfg || cfg.kind !== 'webdav' || !cfg.baseUrl) {
        // 来源配置尚未同步（例如刚启动、渲染层还在 rehydrate）或已被删除
        return new Response('', { status: 404 })
      }

      const headers = webdavHeaders(cfg)
      const range = request.headers.get('range')
      if (range) headers.Range = range

      try {
        const upstream = await fetch(resolveRemoteUrl(cfg, parsed.path), { headers })
        const out = new Headers()
        const passthrough: Array<[string, string | null]> = [
          ['Content-Type', upstream.headers.get('content-type')],
          ['Content-Length', upstream.headers.get('content-length')],
          ['Content-Range', upstream.headers.get('content-range')],
          ['Accept-Ranges', upstream.headers.get('accept-ranges')],
          ['Last-Modified', upstream.headers.get('last-modified')],
        ]
        for (const [k, v] of passthrough) if (v) out.set(k, v)
        if (!out.has('Content-Type')) {
          out.set('Content-Type', guessAudioMime(parsed.path) || 'application/octet-stream')
        }
        // 服务器不支持 Range 时补齐 Accept-Ranges，避免播放器误判可 seek
        if (!out.has('Accept-Ranges')) out.set('Accept-Ranges', 'bytes')
        // 与 cover-local 一致：允许渲染层在需要时以 fetch/XHR 方式读取
        out.set('Access-Control-Allow-Origin', '*')

        return new Response(upstream.body, { status: upstream.status, headers: out })
      } catch (err) {
        const status = err instanceof WebdavError && err.status ? err.status : 502
        console.error('[aurora-remote] 代理请求失败:', parsed.path, (err as Error).message)
        return new Response('', { status })
      }
    })

    registerIpcHandlers()
    const win = createWindow()
    createTray(win)

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

  // 退出清理：注销全局快捷键、销毁托盘、关闭数据库（确保 WAL 落盘）
  // 任何退出路径（托盘菜单、系统注销、Ctrl+C 之外的信号）都置 isQuitting，
  // 保证窗口 close 拦截不再阻止窗口销毁
  app.on('before-quit', () => {
    isQuitting = true
    tray?.destroy()
    tray = null
    globalShortcut.unregisterAll()
    closeDatabase()
  })
}
