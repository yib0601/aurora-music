import { app, ipcMain } from 'electron'
import fs from 'fs'

/**
 * 系统环境探测：供渲染层的「检查更新」挑选匹配的安装包使用。
 *
 * 此前渲染层只能靠 userAgent 判断出「Linux」，于是固定优先 AppImage，
 * 结果 dnf 系（Fedora/RHEL/openEuler）用户即使装的是 rpm，更新时也被推荐便携版。
 * 这里把「发行版包格式」与「当前实例的安装形态」一并暴露给渲染层。
 */

/** 发行版的包格式家族：决定推荐 rpm 还是 deb */
export type LinuxPkgFamily = 'rpm' | 'deb' | 'unknown'

/** 当前运行实例的安装形态 */
export type InstallKind = 'appimage' | 'system-package' | 'portable' | 'unknown'

export interface SystemInfo {
  platform: string
  arch: string
  /** /etc/os-release 的 ID（仅 Linux），如 fedora、ubuntu */
  distroId: string | null
  /** /etc/os-release 的 PRETTY_NAME（仅 Linux） */
  distroName: string | null
  pkgFamily: LinuxPkgFamily
  installKind: InstallKind
}

// 按发行版身份判断包格式，而不是探测 dpkg/rpm 命令是否存在：
// 在 Fedora 上为了打 deb 包常常装有 dpkg，按命令探测会把 Fedora 误判成 deb 系。
const RPM_DISTRO_IDS = new Set([
  'fedora', 'rhel', 'redhat', 'centos', 'centos-stream', 'rocky', 'almalinux', 'ol', 'oracle',
  'amzn', 'amazon', 'scientific', 'cloudlinux', 'virtuozzo', 'alinux', 'alios', 'anolis',
  'openeuler', 'tencentos', 'mandriva', 'mageia', 'opensuse', 'opensuse-leap',
  'opensuse-tumbleweed', 'opensuse-slowroll', 'sles', 'sled', 'suse', 'mariner', 'azurelinux',
  'photon', 'clear-linux-os', 'rocky-linux',
])

const DEB_DISTRO_IDS = new Set([
  'debian', 'ubuntu', 'linuxmint', 'lmde', 'pop', 'elementary', 'kali', 'raspbian', 'deepin',
  'zorin', 'neon', 'mx', 'devuan', 'parrot', 'trisquel', 'bodhi', 'antix', 'peppermint',
  'pureos', 'ubuntu-core', 'astra',
])

// ID_LIKE 里的“像谁”：新衍生版（如 Nobara、Bazzite）只在这里暴露血缘
const RPM_LIKE = new Set(['rhel', 'fedora', 'centos', 'suse', 'sles', 'opensuse', 'rpm'])
const DEB_LIKE = new Set(['debian', 'ubuntu', 'apt'])

/** 解析 os-release 的 KEY=VALUE 文本（值可能带引号） */
function parseOsRelease(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (!m) continue
    let value = m[2].trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    out[m[1]] = value
  }
  return out
}

function readOsRelease(): Record<string, string> {
  for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      return parseOsRelease(fs.readFileSync(file, 'utf8'))
    } catch {
      // 换下一个候选路径
    }
  }
  return {}
}

function resolvePkgFamily(id: string | null, idLike: string | undefined): LinuxPkgFamily {
  if (id && RPM_DISTRO_IDS.has(id)) return 'rpm'
  if (id && DEB_DISTRO_IDS.has(id)) return 'deb'
  const likes = (idLike || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (likes.some((l) => RPM_LIKE.has(l))) return 'rpm'
  if (likes.some((l) => DEB_LIKE.has(l))) return 'deb'
  return 'unknown'
}

function detectInstallKind(): InstallKind {
  // AppImage 运行时会把自身路径写进 APPIMAGE（含 AppImageLauncher 集成的场景）
  if (process.env.APPIMAGE) return 'appimage'
  // 仅 Linux 需要区分：Windows/macOS 只有安装包形态
  if (process.platform !== 'linux') return 'unknown'
  // 开发模式（electron .）无法判断最终形态，交给发行版包格式兜底
  if (!app.isPackaged) return 'unknown'
  // electron-builder 的 deb/rpm 安装到 /opt/<ProductName>；
  // 解压即用的 --dir 产物（便携版）落在任意用户目录
  return process.execPath.startsWith('/opt/') ? 'system-package' : 'portable'
}

let cached: SystemInfo | null = null

/** 探测当前系统环境（结果缓存：一个进程生命周期内不会变） */
export function detectSystemInfo(): SystemInfo {
  if (cached) return cached

  let distroId: string | null = null
  let distroName: string | null = null
  let pkgFamily: LinuxPkgFamily = 'unknown'

  if (process.platform === 'linux') {
    const rel = readOsRelease()
    distroId = rel.ID ? rel.ID.toLowerCase() : null
    distroName = rel.PRETTY_NAME || rel.NAME || null
    pkgFamily = resolvePkgFamily(distroId, rel.ID_LIKE)
  }

  cached = {
    platform: process.platform,
    arch: process.arch,
    distroId,
    distroName,
    pkgFamily,
    installKind: detectInstallKind(),
  }
  console.log(
    `[System] platform=${cached.platform} distro=${cached.distroId ?? '-'} family=${cached.pkgFamily} install=${cached.installKind}`
  )
  return cached
}

export function registerSystemIpc() {
  ipcMain.handle('system:getInfo', () => detectSystemInfo())
}
