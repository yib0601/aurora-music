import { isDesktop } from '@/lib/utils'

/**
 * 移动端存储权限引导
 *
 * 权限分两层（与原生 PermissionPlugin.kt 对应）：
 * 1. 运行时媒体权限 READ_MEDIA_AUDIO（Android 13+；旧系统为 READ_EXTERNAL_STORAGE）
 *    —— 系统弹窗一键授予，足以读取公共目录（Music/Download 等）中的音频文件。
 *    注意：@capacitor/filesystem 在 Android 11+ 上认为存储权限恒为已授予，
 *    不会真正申请 READ_MEDIA_AUDIO，因此必须走本模块的原生插件。
 * 2. 特殊权限 MANAGE_EXTERNAL_STORAGE（「所有文件访问」，Android 11+）
 *    —— 覆盖任意目录，但必须由用户在系统设置中手动授予，不能弹窗获取。
 *
 * 推荐流程（App.tsx 启动时）：
 *   requestMediaPermissions() 先弹系统一键授权 → 拒绝时再引导「所有文件访问」设置页。
 *
 * 桌面端所有函数均为空操作（直接返回 granted=true）。
 */

interface NativePermissionPlugin {
  hasAllFilesAccess(): Promise<{ granted: boolean }>
  requestAllFilesAccess(): Promise<{ opened: boolean }>
  hasMediaPermissions(): Promise<{ granted: boolean }>
  requestMediaPermissions(): Promise<{ granted: boolean }>
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

/**
 * 检测是否拥有读取本地音频的能力：
 * 运行时媒体权限已授予，或已拥有「所有文件访问」。
 */
export async function checkMediaPermissions(): Promise<boolean> {
  const plugin = getPlugin()
  if (!plugin) return true
  try {
    const { granted } = await plugin.hasMediaPermissions()
    return granted
  } catch (e) {
    console.warn('[Permission] hasMediaPermissions 失败:', e)
    return false
  }
}

/**
 * 弹系统对话框申请运行时媒体权限（READ_MEDIA_AUDIO）。
 * 已具备读取能力时直接返回 true 不弹窗；用户拒绝时返回 false。
 */
export async function requestMediaPermissions(): Promise<boolean> {
  const plugin = getPlugin()
  if (!plugin) return true
  try {
    const { granted } = await plugin.requestMediaPermissions()
    return granted
  } catch (e) {
    console.warn('[Permission] requestMediaPermissions 失败:', e)
    return false
  }
}
