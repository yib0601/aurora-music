import { isMobile } from '@/lib/utils'

/**
 * Android 应用内更新的 JS 封装（对应原生 UpdatePlugin.kt）。
 *
 * 与桌面端 updater（Electron 主进程流式下载 + 推送进度事件）不同，这里走系统
 * DownloadManager：下载在系统服务中进行，App 被杀也不中断；进度靠轮询 progress()。
 * 两者在 updateDownloadStore 里被统一成同一套 phase/task 状态，UI 无需区分平台。
 *
 * 桌面端与 Web 端调用本模块时所有函数返回空/失败值，由调用方回退浏览器下载。
 */

export type MobileUpdatePhase = 'idle' | 'pending' | 'downloading' | 'done' | 'error'

export interface MobileProgress {
  phase: MobileUpdatePhase
  /** 已下载字节 */
  received: number
  /** 总字节；系统未知时为 0 */
  total: number
  /** phase === 'done' 时的安装包绝对路径 */
  filePath?: string
  /** phase === 'error' 时的原因 */
  error?: string
}

export interface MobileInstallResult {
  launched: boolean
  /** 未授予「安装未知应用」时为 true，调用方应引导用户去设置页 */
  needPermission: boolean
}

interface NativeUpdatePlugin {
  download(options: {
    url: string
    altUrls?: string[]
    fileName?: string
  }): Promise<{ filePath: string }>
  progress(): Promise<MobileProgress>
  install(options: { filePath: string }): Promise<MobileInstallResult>
  cancel(): Promise<{ cancelled: boolean }>
  canInstall(): Promise<{ granted: boolean }>
  openInstallPermissionSettings(): Promise<{ opened: boolean }>
}

function getPlugin(): NativeUpdatePlugin | null {
  if (!isMobile()) return null
  const cap = (window as any).Capacitor
  if (!cap?.Plugins?.Update) return null
  return cap.Plugins.Update as NativeUpdatePlugin
}

/** 移动端内置更新是否可用（原生插件已注册） */
export function isMobileUpdaterAvailable(): boolean {
  return !!getPlugin()
}

/** 从下载直链推断 APK 文件名，兜底用版本号生成 */
export function apkFileNameFromUrl(url: string, version: string): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '')
    if (/\.apk$/i.test(name)) return name
  } catch {
    // 落到兜底
  }
  return `Aurora-Music-${version}-android.apk`
}

/**
 * 启动 APK 下载。多源候选（GitHub 官方 + 加速前缀）交给原生侧按序降级重试，
 * 返回落地文件的绝对路径；下载本身在原生后台线程进行，进度用 queryProgress() 轮询。
 */
export async function downloadApk(
  url: string,
  version: string,
  altUrls?: string[]
): Promise<{ filePath: string }> {
  const plugin = getPlugin()
  if (!plugin) throw new Error('当前版本不支持应用内更新')
  return plugin.download({
    url,
    altUrls: altUrls?.length ? altUrls : undefined,
    fileName: apkFileNameFromUrl(url, version),
  })
}

/** 查询下载进度 */
export async function queryProgress(): Promise<MobileProgress> {
  const plugin = getPlugin()
  if (!plugin) throw new Error('当前版本不支持应用内更新')
  const res = await plugin.progress()
  return {
    phase: res.phase,
    received: Number(res.received) || 0,
    total: Number(res.total) || 0,
    filePath: res.filePath,
    error: res.error,
  }
}

/** 取消下载并清理残留文件 */
export async function cancelDownload(): Promise<void> {
  const plugin = getPlugin()
  if (!plugin) return
  try {
    await plugin.cancel()
  } catch {
    // 取消失败无需打扰用户
  }
}

/** 调起系统安装器；未授权时返回 needPermission=true */
export async function installApk(filePath: string): Promise<MobileInstallResult> {
  const plugin = getPlugin()
  if (!plugin) throw new Error('当前版本不支持应用内安装')
  return plugin.install({ filePath })
}

/** 是否已允许「安装未知应用」 */
export async function canInstallApk(): Promise<boolean> {
  const plugin = getPlugin()
  if (!plugin) return false
  try {
    const { granted } = await plugin.canInstall()
    return granted
  } catch {
    return false
  }
}

/** 跳到「安装未知应用」授权页 */
export async function openInstallPermissionSettings(): Promise<boolean> {
  const plugin = getPlugin()
  if (!plugin) return false
  try {
    const { opened } = await plugin.openInstallPermissionSettings()
    return opened
  } catch {
    return false
  }
}
