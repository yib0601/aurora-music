import { isMobile } from '@/lib/utils'

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
  /** 按当前平台匹配到的安装包下载地址（可能为空，此时回退到 release 页面） */
  assetUrl: string | null
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

/** 按平台从 release assets 中挑选对应安装包 */
function pickAsset(assets: Array<{ name: string; browser_download_url: string }>): string | null {
  const names = assets.map((a) => a.name.toLowerCase())
  const pick = (test: (n: string) => boolean) => {
    const idx = names.findIndex(test)
    return idx >= 0 ? assets[idx].browser_download_url : null
  }
  if (isMobile()) {
    return pick((n) => n.endsWith('.apk'))
  }
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('win')) {
    return pick((n) => n.endsWith('.exe'))
  }
  if (ua.includes('linux')) {
    return pick((n) => n.endsWith('.appimage')) || pick((n) => n.endsWith('.deb')) || pick((n) => n.endsWith('.rpm'))
  }
  return null
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
    return {
      version: latest,
      notes: typeof data.body === 'string' ? data.body : '',
      url: typeof data.html_url === 'string' ? data.html_url : RELEASES_PAGE,
      assetUrl: pickAsset(Array.isArray(data.assets) ? data.assets : []),
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
