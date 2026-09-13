import { app, ipcMain, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

/**
 * 内置更新下载与安装：
 * - 渲染层从 GitHub Releases 选好安装包后，把直链交给主进程流式下载到「下载」目录；
 * - 进度节流推送到渲染层（updater:progress），完成/失败分别发 updater:done / updater:error；
 * - AppImage 下载后自动注入可执行权限；
 * - 「现在安装」按包类型走各自的系统入口：
 *   exe / AppImage → 直接启动安装器（Windows NSIS 自带向导；AppImage 由用户确认后退出当前应用）；
 *   deb / rpm → 打开终端执行 sudo 覆盖安装命令（桌面端应用无法自行提权）。
 */

export interface UpdaterProgress {
  received: number
  total: number | null
}

export interface UpdaterDonePayload {
  filePath: string
  kind: string
}

/** 支持的安装包类型白名单（渲染层传入，避免被伪造出任意文件） */
const INSTALLER_KINDS = new Set(['apk', 'exe', 'appimage', 'deb', 'rpm'])

/** 下载中的请求；同一时间只允许一个，新请求会拒绝（渲染层已有互斥，这里兜底） */
let activeAbort: AbortController | null = null

function downloadDir(): string {
  try {
    return app.getPath('downloads')
  } catch {
    return app.getPath('home')
  }
}

/** 清理目录内同一应用的旧安装包，避免「下载」目录越攒越多（只删本应用、只留最新） */
function cleanupOldArtifacts(dir: string, keepFile: string) {
  try {
    const keep = path.resolve(keepFile)
    for (const entry of fs.readdirSync(dir)) {
      if (!/^Aurora-Music-.*\.(AppImage|appimage|deb|rpm|exe)$/i.test(entry)) continue
      const full = path.join(dir, entry)
      if (path.resolve(full) === keep) continue
      try {
        fs.rmSync(full, { force: true })
      } catch {
        // 删不掉不影响本次更新
      }
    }
  } catch {
    // 忽略
  }
}

/** 主进程把 URL 的文件名取出来（兜底按包类型生成） */
function fileNameFromUrl(url: string, kind: string): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '')
    if (name && /[\w.-]+\.[A-Za-z0-9]{2,8}$/.test(name)) return name
  } catch {
    // 落到兜底
  }
  const ext: Record<string, string> = { apk: '.apk', exe: '.exe', appimage: '.AppImage', deb: '.deb', rpm: '.rpm' }
  return `Aurora-Music-update${ext[kind] || ''}`
}

/** 目标路径已存在时依次追加 " (1)" " (2)"… */
function uniquePath(dir: string, fileName: string): string {
  const ext = path.extname(fileName)
  const stem = fileName.slice(0, -ext.length)
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i === 0 ? fileName : `${stem} (${i})${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
}

/**
 * 向窗口发送事件的安全封装：handlers.ts 里的 sendToRenderer 是模块私有，
 * 这里由 registerUpdaterIpc 注入主窗口引用。
 */
let send: (channel: string, ...args: unknown[]) => void = () => {}

export function registerUpdaterIpc(sender: (channel: string, ...args: unknown[]) => void) {
  send = sender

  ipcMain.handle('updater:download', async (_event, url: unknown, kind: unknown) => {
    if (typeof url !== 'string' || !/^https:\/\/(objects\.githubusercontent\.com|github\.com)\//i.test(url)) {
      throw new Error('下载地址无效')
    }
    if (typeof kind !== 'string' || !INSTALLER_KINDS.has(kind)) {
      throw new Error('安装包类型无效')
    }
    if (activeAbort) throw new Error('已有更新下载在进行中')

    const abort = new AbortController()
    activeAbort = abort
    const savePath = uniquePath(downloadDir(), fileNameFromUrl(url, kind))

    try {
      let resp: Response
      try {
        resp = await fetch(url, {
          headers: {
            // GitHub release 资源的下载会 302 到 objects.githubusercontent.com，fetch 自动跟随
            'User-Agent': 'Aurora-Music-Updater',
            Accept: '*/*',
          },
          redirect: 'follow',
          signal: abort.signal,
        })
      } catch {
        throw new Error('下载失败：网络连接异常')
      }
      if (!resp.ok || !resp.body) {
        throw new Error(`下载失败：服务器返回 HTTP ${resp.status}`)
      }

      const lengthHeader = resp.headers.get('content-length')
      const total = lengthHeader ? Number(lengthHeader) : NaN
      let received = 0
      let lastEmit = 0

      const nodeStream = Readable.fromWeb(resp.body as any)
      nodeStream.on('data', (chunk: Buffer) => {
        received += chunk.length
        const now = Date.now()
        if (now - lastEmit >= 200) {
          lastEmit = now
          send('updater:progress', { received, total: Number.isFinite(total) ? total : null })
        }
      })

      await pipeline(nodeStream, fs.createWriteStream(savePath))

      // AppImage 需要可执行权限才能运行
      if (kind === 'appimage') {
        try {
          fs.chmodSync(savePath, 0o755)
        } catch {
          // 权限设置失败不阻断，用户可手动 chmod +x
        }
      }

      cleanupOldArtifacts(downloadDir(), savePath)
      send('updater:progress', { received, total: Number.isFinite(total) ? total : null })
      send('updater:done', { filePath: savePath, kind })
      return { filePath: savePath }
    } catch (err) {
      // 失败时清理残留的部分文件
      try {
        fs.rmSync(savePath, { force: true })
      } catch {
        // 忽略
      }
      if (abort.signal.aborted) {
        throw new Error('已取消下载')
      }
      console.error('[Updater] 下载失败:', err)
      const message = err instanceof Error && err.message ? err.message : '下载失败，请稍后重试'
      send('updater:error', message)
      throw new Error(message)
    } finally {
      activeAbort = null
    }
  })

  ipcMain.handle('updater:cancel', () => {
    activeAbort?.abort()
  })

  // 在文件管理器中定位已下载的安装包
  ipcMain.handle('updater:reveal', (_event, filePath: unknown) => {
    if (typeof filePath === 'string' && path.isAbsolute(filePath) && fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath)
    }
  })

  ipcMain.handle('updater:install', async (_event, filePath: unknown, kind: unknown) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !fs.existsSync(filePath)) {
      throw new Error('安装包文件不存在')
    }
    if (typeof kind !== 'string' || !INSTALLER_KINDS.has(kind)) {
      throw new Error('安装包类型无效')
    }

    if (kind === 'exe') {
      // Windows NSIS 安装器：启动后由向导接管，当前实例退出避免占用文件
      shell.openPath(filePath).then((err) => {
        if (err) console.error('[Updater] 启动安装器失败:', err)
        else app.quit()
      })
      return { action: 'launched' as const }
    }

    if (kind === 'appimage') {
      // AppImage 无法原地覆盖：退出当前应用，用户运行新文件即完成「更新」
      try {
        fs.chmodSync(filePath, 0o755)
      } catch {
        // 忽略
      }
      const err = await shell.openPath(filePath)
      if (err) {
        throw new Error('启动新版本失败：' + err)
      }
      app.quit()
      return { action: 'launched' as const }
    }

    if (kind === 'deb' || kind === 'rpm') {
      // deb/rpm 覆盖安装需要 root，GUI 应用无法安全提权：
      // 打开系统终端并自动填入安装命令，用户确认密码即可
      const cmd =
        kind === 'deb'
          ? `sudo apt install -y '${filePath}'`
          : `sudo dnf install -y '${filePath}' || sudo rpm -Uvh '${filePath}'`
      const opened = await openTerminalWithCommand(cmd)
      if (!opened) {
        throw new Error('无法打开终端，请手动执行：' + cmd)
      }
      return { action: 'terminal' as const, command: cmd }
    }

    // apk 等：下载即完成，安装由系统在文件管理器中引导
    return { action: 'none' as const }
  })
}

/**
 * 打开系统终端并预填命令（不自动执行，sudo 密码必须由用户亲手输入）。
 * 常见终端依次探测；都找不到时返回 false。
 */
async function openTerminalWithCommand(cmd: string): Promise<boolean> {
  const { spawn } = await import('child_process')

  const attempts: Array<{ bin: string; args: string[] }> = [
    // GNOME Terminal：-- 之后整段作为 sh -c 的命令
    { bin: 'gnome-terminal', args: ['--', 'bash', '-c', cmd] },
    // Konsole / XFCE：-e 直接接命令
    { bin: 'konsole', args: ['-e', cmd] },
    { bin: 'xfce4-terminal', args: ['-e', cmd] },
    // xterm 兜底
    { bin: 'xterm', args: ['-e', cmd] },
  ]

  for (const { bin, args } of attempts) {
    try {
      const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
      const failed = await new Promise<boolean>((resolve) => {
        child.once('error', () => resolve(true))
        // spawn 成功但二进制不存在会立刻触发 error；给 300ms 判定窗口
        setTimeout(() => resolve(false), 300)
        child.unref()
      })
      if (!failed) return true
    } catch {
      // 试下一个候选终端
    }
  }
  return false
}
