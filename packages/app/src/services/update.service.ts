import { isDesktop, isMobile } from '@/lib/utils'
import {
  ASSET_LABEL,
  assetInstallHint,
  assetPreferenceOrder,
  pickAsset,
  type AssetKind,
  type SystemInfoLike,
} from './update-asset'
import { fetchFastest, manifestCandidates, releasesApiCandidates, withGithubProxies } from './update-source'

// 当前版本号：构建期由 vite define 注入（package.json version），
// 开发环境回退到 import.meta.env，最终兜底硬编码
declare const __APP_VERSION__: string | undefined

export const APP_VERSION: string =
  (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) ||
  (import.meta as any).env?.VITE_APP_VERSION ||
  '0.0.0'

// GitHub 仓库（与 package.json repository 保持一致）；设置页「关于本软件」复用同一地址
export const REPO_URL = 'https://github.com/yib0601/aurora-music'
const RELEASES_API = 'https://api.github.com/repos/yib0601/aurora-music/releases/latest'
const RELEASES_PAGE = `${REPO_URL}/releases/latest`

/**
 * 检查更新的单次请求超时：大陆直连 api.github.com 失败时可能挂起 10s 以上，
 * 必须限时放弃才能及时降级到加速前缀。
 */
const CHECK_TIMEOUT_MS = 6000

export interface UpdateInfo {
  version: string
  notes: string
  url: string
  /** 按当前系统匹配到的安装包下载地址（可能为空，此时回退到 release 页面） */
  assetUrl: string | null
  /** 安装包候选下载地址（优先境内源，其次 GitHub 官方 + 加速前缀） */
  assetUrls: string[]
  /** 匹配到的安装包类型，无匹配包时为 null */
  assetKind: AssetKind | null
  /** 安装包字节数，下载完成后用于校验完整性 */
  assetSize: number | null
  /** 安装包 sha256 摘要，下载完成后端到端校验内容 */
  assetDigest: string | null
  /** 安装包类型展示名（如「RPM 包」），无匹配包时为 null */
  assetLabel: string | null
  /** 覆盖安装命令提示（仅当前是系统包管理器安装时给出），否则 null */
  installHint: string | null
  /** 结论来自哪条通道，用于诊断与 UI 提示 */
  channel: 'manifest' | 'github'
}

/** 境内清单源（npm 包内的 update.json）结构，由发布端 CI 生成 */
interface UpdateManifest {
  version?: string
  notes?: string
  assets?: Array<{ kind?: string; name?: string; url?: string; size?: number; sha256?: string }>
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

/** 当前平台该按什么顺序找安装包（移动端只要 apk） */
async function currentAssetOrder(): Promise<{ order: AssetKind[]; system: SystemInfoLike | null }> {
  // 系统环境只用于挑选安装包，探测失败不能影响「有没有新版本」的判断
  const system = await getSystemInfo().catch(() => null)
  const order = assetPreferenceOrder({
    isMobile: isMobile(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    system,
  })
  return { order, system }
}

/** 把清单源的 assets 归一成 pickAsset 认识的结构 */
function toPickableAssets(list: UpdateManifest['assets']) {
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && typeof a.url === 'string' && typeof a.name === 'string')
    .map((a) => ({
      name: a.name as string,
      browser_download_url: a.url as string,
      size: typeof a.size === 'number' && a.size > 0 ? a.size : undefined,
      digest: a.sha256 ? `sha256:${String(a.sha256).replace(/^sha256:/, '')}` : undefined,
    }))
}

/**
 * 通道一：境内清单源（registry.npmmirror.com 上的 npm 包）。
 *
 * 这是唯一完全绕开 GitHub 的通道——实测该网络环境下 GitHub 资产域名与 Cloudflare
 * 加速站同时不可达时，只有它能同时提供「版本号」与「安装包本体」。
 * 包未发布或镜像未同步时 registry 快速返回 404，降级代价可忽略。
 */
async function checkViaManifest(): Promise<UpdateInfo | null> {
  const data = (await fetchFastest(manifestCandidates(), (res) => res.json(), {
    timeoutMs: CHECK_TIMEOUT_MS,
    headers: { Accept: 'application/json' },
  })) as UpdateManifest

  const latest = String(data?.version || '').replace(/^v/i, '')
  if (!latest || compareVersions(latest, APP_VERSION) <= 0) return null

  const { order, system } = await currentAssetOrder()
  const picked = pickAsset(toPickableAssets(data.assets), order, system?.arch)

  return {
    version: latest,
    notes: typeof data.notes === 'string' ? data.notes : '',
    url: RELEASES_PAGE,
    assetUrl: picked?.url ?? null,
    // 清单源地址已经是境内直链，withGithubProxies 会原样返回，不会二次包裹
    assetUrls: picked?.url ? withGithubProxies(picked.url) : [],
    assetKind: picked?.kind ?? null,
    assetSize: picked?.size ?? null,
    assetDigest: picked?.digest ?? null,
    assetLabel: picked ? ASSET_LABEL[picked.kind] : null,
    installHint: picked ? assetInstallHint(picked.kind, system) : null,
    channel: 'manifest',
  }
}

/**
 * 通道二：GitHub Releases API。
 * 候选列表用并发竞速：直连与加速前缀同时发起，谁先拿到有效响应就用谁（串行最坏 12s）。
 */
async function checkViaGithub(): Promise<UpdateInfo | null> {
  const data = await fetchFastest(releasesApiCandidates(RELEASES_API), (res) => res.json(), {
    timeoutMs: CHECK_TIMEOUT_MS,
    headers: { Accept: 'application/vnd.github+json' },
  })

  const latest = String(data?.tag_name || '').replace(/^v/i, '')
  if (!latest || compareVersions(latest, APP_VERSION) <= 0) return null

  const { order, system } = await currentAssetOrder()
  const picked = pickAsset(Array.isArray(data.assets) ? data.assets : [], order, system?.arch)

  return {
    version: latest,
    notes: typeof data.body === 'string' ? data.body : '',
    url: typeof data.html_url === 'string' ? data.html_url : RELEASES_PAGE,
    assetUrl: picked?.url ?? null,
    assetUrls: picked?.url ? withGithubProxies(picked.url) : [],
    assetKind: picked?.kind ?? null,
    assetSize: picked?.size ?? null,
    assetDigest: picked?.digest ?? null,
    assetLabel: picked ? ASSET_LABEL[picked.kind] : null,
    installHint: picked ? assetInstallHint(picked.kind, system) : null,
    channel: 'github',
  }
}

/**
 * 检查更新：境内清单源与 GitHub 官方**并发**发起，取版本更高的结论。
 *
 * 并发而非串行，是因为两条通道互为补充：清单源可能滞后于 GitHub（CI 先发 release
 * 后发 npm），GitHub 则可能在当前网络下不可达。任一通道成功、且都没有更高版本时
 * 判定为「已是最新」；两条通道全部失败才抛错。
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const [manifest, github] = await Promise.allSettled([checkViaManifest(), checkViaGithub()])

  const found = [manifest, github]
    .filter((r): r is PromiseFulfilledResult<UpdateInfo | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((v): v is UpdateInfo => !!v)

  if (found.length) {
    return found.sort((a, b) => compareVersions(b.version, a.version))[0]
  }

  // 没有更高版本：只要有一条通道正常应答，就是「已是最新」，不是网络故障
  if (manifest.status === 'fulfilled' || github.status === 'fulfilled') return null

  throw manifest.status === 'rejected' ? manifest.reason : (github as PromiseRejectedResult).reason
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
