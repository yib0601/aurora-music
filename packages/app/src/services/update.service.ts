import { isDesktop, isMobile } from '@/lib/utils'
import {
  ASSET_LABEL,
  assetInstallHint,
  assetPreferenceOrder,
  pickAsset,
  type AssetKind,
  type SystemInfoLike,
} from './update-asset'

// 当前版本号：构建期由 vite define 注入（package.json version），
// 开发环境回退到 import.meta.env，最终兜底硬编码
declare const __APP_VERSION__: string | undefined

export const APP_VERSION: string =
  (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) ||
  (import.meta as any).env?.VITE_APP_VERSION ||
  '0.0.0'

// GitHub 仓库（与 package.json repository 保持一致）
const RELEASES_API = 'https://api.github.com/repos/yib0601/aurora-music/releases/latest'
const RELEASES_PAGE = 'https://github.com/yib0601/aurora-music/releases/latest'

export interface UpdateInfo {
  version: string
  notes: string
  url: string
  /** 按当前系统匹配到的安装包下载地址（可能为空，此时回退到 release 页面） */
  assetUrl: string | null
  /** 匹配到的安装包类型，无匹配包时为 null */
  assetKind: AssetKind | null
  /** 安装包类型展示名（如「RPM 包」），无匹配包时为 null */
  assetLabel: string | null
  /** 覆盖安装命令提示（仅当前是系统包管理器安装时给出），否则 null */
  installHint: string | null
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[^0-9]+/).filter(Boolean).map(Number)
  const pb = b.split(/[^0-9]+/).filter(Boolean).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/**
 * 读取桌面端主进程探测到的系统环境（发行版包格式 / 安装形态）。
 * Web 与移动端没有这个能力，返回 null，由 update-asset 走 userAgent 兜底。
 */
async function getSystemInfo(): Promise<SystemInfoLike | null> {
  if (!isDesktop()) return null
  try {
    const info = await (window as any).electronAPI?.getSystemInfo?.()
    return info && typeof info === 'object' ? (info as SystemInfoLike) : null
  } catch {
    return null
  }
}

/** 请求 GitHub Releases API 检测新版本；无新版本时返回 null */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(RELEASES_API, {
      signal: ctrl.signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const latest = String(data.tag_name || '').replace(/^v/i, '')
    if (!latest || compareVersions(latest, APP_VERSION) <= 0) return null

    // 系统环境只用于挑选安装包，探测失败不能影响「有没有新版本」的判断
    const system = await getSystemInfo().catch(() => null)
    const order = assetPreferenceOrder({
      isMobile: isMobile(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      system,
    })
    const picked = pickAsset(Array.isArray(data.assets) ? data.assets : [], order)

    return {
      version: latest,
      notes: typeof data.body === 'string' ? data.body : '',
      url: typeof data.html_url === 'string' ? data.html_url : RELEASES_PAGE,
      assetUrl: picked?.url ?? null,
      assetKind: picked?.kind ?? null,
      assetLabel: picked ? ASSET_LABEL[picked.kind] : null,
      installHint: picked ? assetInstallHint(picked.kind, system) : null,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 用系统浏览器打开下载页（桌面端由 Electron setWindowOpenHandler 接管） */
export function openDownloadPage(info: UpdateInfo) {
  window.open(info.assetUrl || info.url, '_blank')
}

// ---- 启动提示去重：同一版本每次启动只提示一次 ----
const SESSION_KEY = 'aurora-update-shown'

export function shouldShowStartupBanner(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) !== '1'
  } catch {
    return true
  }
}

export function markStartupBannerShown() {
  try {
    sessionStorage.setItem(SESSION_KEY, '1')
  } catch {
    // 忽略隐私模式下的写入失败
  }
}
