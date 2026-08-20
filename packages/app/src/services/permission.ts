import { isDesktop } from '@/lib/utils'

/**
 * 移动端 Android MANAGE_EXTERNAL_STORAGE 特殊权限引导
 *
 * Android 11+（API 30）起，普通存储权限不再允许访问 /storage/emulated/0 下
 * 的任意目录。扫描本地音乐需要 MANAGE_EXTERNAL_STORAGE，但这是特殊权限，
 * 必须由用户在系统设置中手动授予，不能通过弹窗自动获取。
 *
 * 本模块通过 Capacitor 原生插件 PermissionPlugin 调用：
 *   - checkAllFilesAccess(): 检测当前是否已授权
 *   - openAllFilesAccessSettings(): 跳到系统「所有文件访问」设置页
 *
 * App.tsx 启动时调用 checkAllFilesAccess 检测，未授权则弹引导 Dialog，
 * 用户点「前往设置」后调用 openAllFilesAccessSettings 跳转；监听 @capacitor/app
 * 的 appStateChange(resume) 重新检测，已授权则触发扫描。
 *
 * 桌面端为空操作（直接返回 granted=true）。
 */

interface NativePermissionPlugin {
  hasAllFilesAccess(): Promise<{ granted: boolean }>
  requestAllFilesAccess(): Promise<{ opened: boolean }>
}

function getPlugin(): NativePermissionPlugin | null {
  if (isDesktop()) return null
  const cap = (window as any).Capacitor
  if (!cap?.Plugins?.Permission) return null
  return cap.Plugins.Permission as NativePermissionPlugin
}

/**
 * 检测是否拥有「所有文件访问」权限。
 * 桌面端 / Android 10 及以下直接返回 true（无需特殊权限）。
 */
export async function checkAllFilesAccess(): Promise<boolean> {
  const plugin = getPlugin()
  if (!plugin) return true
  try {
    const { granted } = await plugin.hasAllFilesAccess()
    return granted
  } catch (e) {
    console.warn('[Permission] hasAllFilesAccess 失败:', e)
    return false
  }
}

/**
 * 跳到系统「所有文件访问」设置页（带本应用 deep link）。
 * 用户授权后按返回键回到 App，前端通过 appStateChange(resume) 重新检测。
 */
export async function openAllFilesAccessSettings(): Promise<boolean> {
  const plugin = getPlugin()
  if (!plugin) return false
  try {
    const { opened } = await plugin.requestAllFilesAccess()
    return opened
  } catch (e) {
    console.warn('[Permission] requestAllFilesAccess 失败:', e)
    return false
  }
}
