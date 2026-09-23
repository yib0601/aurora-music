/**
 * 更新安装包的挑选规则（纯函数，不依赖 window/electron，便于单独验证）。
 *
 * 优先级 = 当前安装形态 > 发行版包格式：
 * - 现在跑的就是 AppImage / 便携目录 → 继续给 AppImage；
 * - 系统包管理器装的（dnf/apt）→ 给对应原生包（rpm/deb），AppImage 仅作兜底；
 * - 判断不出发行版时保持历史行为（AppImage 优先）。
 * - macOS 只有 dmg（分 arm64/x64 两份），按 process.arch 挑本机那份。
 */

export type AssetKind = 'apk' | 'exe' | 'appimage' | 'deb' | 'rpm' | 'dmg'

/** 主进程 system:getInfo 返回的环境信息（Web/移动端为 null） */
export interface SystemInfoLike {
  platform?: string | null
  /** 进程架构（process.arch）：macOS 双架构 dmg 靠它区分 arm64 / x64 */
  arch?: string | null
  pkgFamily?: 'rpm' | 'deb' | 'unknown' | null
  installKind?: 'appimage' | 'system-package' | 'portable' | 'unknown' | null
}

export interface AssetPick {
  url: string
  kind: AssetKind
}

export const ASSET_LABEL: Record<AssetKind, string> = {
  apk: 'APK',
  exe: 'EXE 安装包',
  appimage: 'AppImage 便携版',
  deb: 'DEB 包',
  rpm: 'RPM 包',
  dmg: 'DMG 安装包',
}

const ASSET_SUFFIX: Record<AssetKind, string> = {
  apk: '.apk',
  exe: '.exe',
  appimage: '.appimage',
  deb: '.deb',
  rpm: '.rpm',
  dmg: '.dmg',
}

/** 便携形态（非系统包管理器安装）：继续推荐 AppImage */
function isPortableInstall(info?: SystemInfoLike | null): boolean {
  return info?.installKind === 'appimage' || info?.installKind === 'portable'
}

/** Linux 的候选顺序：先发行版原生包，再 AppImage，最后另一族的包 */
export function linuxAssetOrder(info?: SystemInfoLike | null): AssetKind[] {
  const native: AssetKind = info?.pkgFamily === 'rpm' ? 'rpm' : info?.pkgFamily === 'deb' ? 'deb' : 'appimage'
  if (native === 'appimage' || isPortableInstall(info)) return ['appimage', 'deb', 'rpm']
  const other: AssetKind = native === 'rpm' ? 'deb' : 'rpm'
  return [native, 'appimage', other]
}

/** 按平台与系统环境给出候选安装包顺序（空数组表示无可下载包，回退 release 页面） */
export function assetPreferenceOrder(env: {
  isMobile: boolean
  userAgent: string
  system?: SystemInfoLike | null
}): AssetKind[] {
  if (env.isMobile) return ['apk']

  const platform = (env.system?.platform || '').toLowerCase()
  const ua = (env.userAgent || '').toLowerCase()

  // 主进程探测到的平台最可靠；Web 环境退回 userAgent
  if (platform === 'win32' || (!platform && ua.includes('win'))) return ['exe']
  if (platform === 'darwin') return ['dmg']
  if (platform === 'linux' || (!platform && ua.includes('linux'))) return linuxAssetOrder(env.system)
  return []
}

/** 从 release assets 里按候选顺序挑出第一个存在的包（同类型有多个时优先本机架构那份） */
export function pickAsset(
  assets: Array<{ name?: string; browser_download_url?: string }>,
  order: AssetKind[],
  arch?: string | null
): AssetPick | null {
  const urls = new Map<AssetKind, string>()
  const archMatched = new Map<AssetKind, string>()
  const wantArch = (arch || '').toLowerCase()

  for (const asset of assets) {
    const name = (asset?.name || '').toLowerCase()
    const url = asset?.browser_download_url
    if (!name || !url) continue
    for (const kind of order) {
      if (!name.endsWith(ASSET_SUFFIX[kind])) continue
      if (!urls.has(kind)) urls.set(kind, url)
      // macOS 的 dmg 分 `-arm64` / `-x64` 两份，名字里带本机架构的才是能跑的那份
      if (wantArch && !archMatched.has(kind) && name.includes(`-${wantArch}`)) {
        archMatched.set(kind, url)
      }
      break
    }
  }

  for (const kind of order) {
    const url = archMatched.get(kind) || urls.get(kind)
    if (url) return { url, kind }
  }
  return null
}

/** 覆盖安装命令提示：仅当推荐的是系统包、且当前就是包管理器安装时给出 */
export function assetInstallHint(kind: AssetKind, info?: SystemInfoLike | null): string | null {
  if (info?.installKind !== 'system-package') return null
  if (kind === 'rpm') return '下载后用 sudo dnf install ./Aurora-Music-*.rpm 覆盖安装'
  if (kind === 'deb') return '下载后用 sudo apt install ./Aurora-Music-*.deb 覆盖安装'
  return null
}
