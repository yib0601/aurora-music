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
 *   deb / rpm → 打开终端执行 sudo 覆盖安装命令（桌面端应用无法自行提权）；
 *   dmg → 挂载 dmg 并让 Finder 显示，用户把 App 拖进「应用程序」完成覆盖。
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
const INSTALLER_KINDS = new Set(['apk', 'exe', 'appimage', 'deb', 'rpm', 'dmg'])

/**
 * 下载地址白名单：GitHub 官方域名，或「公共加速前缀 + GitHub 原始链接」。
 * 与渲染层 services/update-source.ts 的前缀列表保持一致（主进程无法复用 app 包代码）。
 * 任何其他域名一律拒绝，避免该 IPC 被利用来下载任意文件。
 */
const GITHUB_HOSTS = new Set(['github.com', 'objects.githubusercontent.com'])
const PROXY_HOSTS = new Set(['gh-proxy.com', 'ghfast.top'])

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' ? parsed.host.toLowerCase() : null
  } catch {
    return null
  }
}

function isAllowedDownloadUrl(url: string): boolean {
  const host = hostOf(url)
  if (!host) return false
  return GITHUB_HOSTS.has(host) || PROXY_HOSTS.has(host)
}

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
      if (!/^Aurora-Music-.*\.(AppImage|appimage|deb|rpm|exe|dmg)$/i.test(entry)) continue
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
  const ext: Record<string, string> = { apk: '.apk', exe: '.exe', appimage: '.AppImage', deb: '.deb', rpm: '.rpm', dmg: '.dmg' }
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
 * 单个下载源的「建连超时」：大陆网络下直连 GitHub 失败时 TCP 建连会挂起
 * 10~40s（不是立刻报错），必须先超时放弃再换下一个源，否则降级兜底形同虚设。
 * 只约束「拿到响应头」这一步；开始写盘后不再限时，避免大包被误杀。
 */
const CONNECT_TIMEOUT_MS = 8000

/**
 * 组装下载候选地址列表（GitHub 官方直链 + 加速前缀）。
 * 渲染层传入的 altUrls 只是「顺序建议」，每一项仍逐个校验：
 * 只接受 GitHub 官方域名或白名单加速域名，避免被伪造出任意文件下载。
 */
function normalizeDownloadUrls(url: unknown, altUrls: unknown): string[] {
  const raw = [url, ...(Array.isArray(altUrls) ? altUrls : [])]
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    if (!isAllowedDownloadUrl(item)) continue
    if (seen.has(item)) continue
    seen.add(item)
    result.push(item)
  }
  return result
}

/** 带建连超时的 fetch：signal 由外部传入，超时只中断本次请求 */
async function fetchWithConnectTimeout(url: string, signal: AbortSignal): Promise<Response> {
  const timer = new AbortController()
  const timeoutId = setTimeout(() => timer.abort(), CONNECT_TIMEOUT_MS)
  const onAbort = () => timer.abort()
  signal.addEventListener('abort', onAbort)
  try {
    return await fetch(url, {
      headers: {
        // GitHub release 资源的下载会 302 到 objects.githubusercontent.com，fetch 自动跟随
        'User-Agent': 'Aurora-Music-Updater',
        Accept: '*/*',
      },
      redirect: 'follow',
      signal: timer.signal,
    })
  } finally {
    clearTimeout(timeoutId)
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 向窗口发送事件的安全封装：handlers.ts 里的 sendToRenderer 是模块私有，
 * 这里由 registerUpdaterIpc 注入主窗口引用。
 */
let send: (channel: string, ...args: unknown[]) => void = () => {}

export function registerUpdaterIpc(sender: (channel: string, ...args: unknown[]) => void) {
  send = sender

  ipcMain.handle('updater:download', async (_event, url: unknown, kind: unknown, altUrls: unknown) => {
    const candidates = normalizeDownloadUrls(url, altUrls)
    if (!candidates.length) throw new Error('下载地址无效')
    if (typeof kind !== 'string' || !INSTALLER_KINDS.has(kind)) {
      throw new Error('安装包类型无效')
    }
    if (activeAbort) throw new Error('已有更新下载在进行中')

    const abort = new AbortController()
    activeAbort = abort
    // 文件名统一按 GitHub 官方原始链接推导：加速链接的 pathname 同样是原始链接
    const savePath = uniquePath(downloadDir(), fileNameFromUrl(candidates[0], kind))

    try {
      // 多源依次尝试：直连 GitHub 失败（大陆网络常见）时自动换加速前缀。
      // 只在「拿响应头」阶段失败时换源；已开始写盘后中断属于传输失败，
      // 不重试以免把半截文件当成功（失败时下方会清理残留）。
      let resp: Response | null = null
      let connectError: unknown = null
      for (const candidate of candidates) {
        if (abort.signal.aborted) break
        try {
          const res = await fetchWithConnectTimeout(candidate, abort.signal)
          if (!res.ok || !res.body) {
            connectError = new Error(`服务器返回 HTTP ${res.status}`)
            continue
          }
          resp = res
          break
        } catch (err) {
          // 取消是用户意图，立刻退出，不再换源
          if (abort.signal.aborted) break
          connectError = err
        }
      }

      if (!resp || !resp.body) {
        if (abort.signal.aborted) throw new Error('已取消下载')
        const detail = connectError instanceof Error ? connectError.message : ''
        throw new Error(
          /HTTP \d+/.test(detail) ? `下载失败：${detail}` : '下载失败：网络连接异常（已尝试所有下载源）'
        )
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

    if (kind === 'dmg') {
      // macOS：dmg 无法原地覆盖安装（App 在 /Applications 里运行中，替换需用户拖拽）。
      // 挂载 dmg 并让 Finder 显示，用户把 Aurora Music 拖进「应用程序」即完成更新；
      // 不退出当前实例——用户可能还想继续听，且退出会让拖拽替换更难操作。
      const err = await shell.openPath(filePath)
      if (err) {
        throw new Error('打开安装包失败：' + err)
      }
      return { action: 'mounted' as const }
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
