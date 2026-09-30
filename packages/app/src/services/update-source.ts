/**
 * 更新链路的多源兜底（纯函数，不依赖 window/electron，便于单独验证）。
 *
 * 背景：更新检查与安装包下载历史上都指向 GitHub。大陆网络下 api.github.com 与
 * release 资产（github.com 会 302 到 objects.githubusercontent.com）常被阻断，
 * 表现为「检查更新失败」或下载进度停在 0 MB。更麻烦的是存在一类网络环境：
 * GitHub 主站 IP 放行而 CDN 域名被污染，此时连停留在 Cloudflare 上的公共加速站
 * 也一并不可达——检查更新能成功、下载却三个候选全灭。
 *
 * 因此通道分三档，按「境内自控 > 官方直连 > 第三方加速」排序：
 * 1. 境内清单源 registry.npmmirror.com：npm 包托管 update.json 与各平台安装包，
 *    境内 CDN、匿名可取、实测约 6.7MB/s，且完全不依赖 GitHub；
 * 2. GitHub 官方：releases API 与资产直链；
 * 3. 公共加速前缀：只拼接 GitHub 原始链接（公开、无凭证），最后的兜底。
 *
 * 检查更新按「境内 → 官方」降级；清单源未发布时 registry 返回 404，
 * 失败很快，不会拖慢官方通道。
 */

/**
 * 境内清单源：发布端（CI）把 update.json 与各平台安装包打成 npm 包推送到 npmjs，
 * registry.npmmirror.com 会自动镜像，客户端从这里取清单与安装包。
 *
 * 选用 registry.npmmirror.com 而不是 Gitee：前者匿名可下、无仓库配额、无「拿平台当
 * CDN」的封号风险，实测吞吐 6.7MB/s；Gitee 的 release 附件匿名下载政策不明确，
 * 且有仓库附件总量 1GB 上限与非会员限速。
 */
const MANIFEST_REGISTRY = 'https://registry.npmmirror.com'
const MANIFEST_PACKAGE = 'aurora-music-release'

/**
 * 公共加速前缀候选：都接受「前缀 + 原始 GitHub 链接」的拼接形式。
 *
 * 实测（无代理直连）：资产下载 gh-proxy.com / ghfast.top / ghproxy.net 均可用，
 * 但只有 gh-proxy.com 支持代理 api.github.com——ghfast.top 与 ghproxy.net 对 API
 * 请求一律 403。两者分开维护，避免把恒失败的候选塞进检查更新链路白等一轮超时。
 */
const DOWNLOAD_PROXY_PREFIXES = ['https://gh-proxy.com/', 'https://ghfast.top/', 'https://ghproxy.net/']
const API_PROXY_PREFIXES = ['https://gh-proxy.com/']

/**
 * GitHub 官方域名。
 * - GITHUB_DOWNLOAD_HOSTS：release 安装包直链所在域名（最终会 302 到 objects.githubusercontent.com）
 * - 另加 api.github.com：仅用于「检查更新」的 Releases API，不下发安装包
 * 两者分开维护，避免把 API 域名混进安装包下载白名单。
 */
const GITHUB_DOWNLOAD_HOSTS = ['github.com', 'objects.githubusercontent.com']
const GITHUB_API_HOSTS = ['api.github.com']

/** 境内清单源域名 */
const MANIFEST_HOSTS = ['registry.npmmirror.com']

/** 该地址是否可作为「安装包下载」的 GitHub 官方直链 */
export function isGithubUrl(url: string): boolean {
  return matchesHost(url, GITHUB_DOWNLOAD_HOSTS)
}

/** 该地址是否是 GitHub 官方 API / release 资源 */
function isGithubHost(url: string): boolean {
  return matchesHost(url, [...GITHUB_DOWNLOAD_HOSTS, ...GITHUB_API_HOSTS])
}

/** 是否为清单源地址（境内 npm 镜像） */
export function isManifestUrl(url: string): boolean {
  return matchesHost(url, MANIFEST_HOSTS)
}

/** 是否为白名单加速域名下的链接（形如 https://gh-proxy.com/https://github.com/...） */
export function isProxyUrl(url: string): boolean {
  return matchesHost(
    url,
    [...DOWNLOAD_PROXY_PREFIXES, ...API_PROXY_PREFIXES].map((prefix) => new URL(prefix).host)
  )
}

/** 下载白名单：GitHub 安装包直链、白名单加速链接，或境内清单源 */
export function isAllowedDownloadUrl(url: string): boolean {
  return isGithubUrl(url) || isProxyUrl(url) || isManifestUrl(url)
}

function matchesHost(url: string, hosts: string[]): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    return hosts.includes(parsed.host.toLowerCase())
  } catch {
    return false
  }
}

/**
 * 把上游地址展开为候选列表：GitHub 官方优先，其后是各加速前缀。
 * 非 GitHub 地址（含已带加速前缀的地址、境内清单源地址）直接原样返回，避免二次包裹。
 */
export function withGithubProxies(url: string): string[] {
  if (!isGithubHost(url)) return [url]
  return [url, ...DOWNLOAD_PROXY_PREFIXES.map((prefix) => prefix + url)]
}

/**
 * Releases API 的候选列表。只用能透传 api.github.com 的前缀（ghfast.top / ghproxy.net
 * 对该域名恒 403，实测确认）。
 */
export function releasesApiCandidates(repoApi: string): string[] {
  if (!isGithubHost(repoApi)) return [repoApi]
  return [repoApi, ...API_PROXY_PREFIXES.map((prefix) => prefix + repoApi)]
}

/** 境内清单文件地址：latest 别名由 registry 302 到具体版本的 files 路径 */
export function manifestCandidates(packageName = MANIFEST_PACKAGE): string[] {
  return [`${MANIFEST_REGISTRY}/${packageName}/latest/files/update.json`]
}

/** 境内安装包地址：必须用具体版本号（latest 别名不能直接拼文件路径） */
export function manifestAssetUrl(packageName: string, version: string, fileName: string): string {
  return `${MANIFEST_REGISTRY}/${packageName}/${version}/files/${fileName}`
}

/** 带超时的 fetch：AbortController + 外部取消信号联动 */
async function fetchWithTimeout(
  url: string,
  { timeoutMs, signal, headers }: { timeoutMs: number; signal?: AbortSignal; headers?: Record<string, string> }
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    return await fetch(url, { signal: ctrl.signal, headers })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 依次尝试候选地址，返回第一个成功响应的 body；失败则抛最后一个错误 */
export async function fetchWithFallback<T>(
  candidates: string[],
  parse: (res: Response) => Promise<T>,
  opts: { timeoutMs: number; headers?: Record<string, string>; signal?: AbortSignal }
): Promise<T> {
  let lastError: unknown = new Error('网络不可用')
  for (const url of candidates) {
    if (opts.signal?.aborted) throw lastError
    try {
      const res = await fetchWithTimeout(url, { timeoutMs: opts.timeoutMs, signal: opts.signal, headers: opts.headers })
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`)
        continue
      }
      return await parse(res)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}

/**
 * 并发竞速：所有候选同时发起，第一个成功解析的胜出，其余立刻中止。
 *
 * 串行降级最坏要等「候选数 × 单次超时」才报失败（三个候选即 18s，用户感知就是卡死），
 * 竞速只等一个超时窗口。适合检查更新这类小请求；大文件下载不要用（会白白吞多份流量）。
 */
export async function fetchFastest<T>(
  candidates: string[],
  parse: (res: Response) => Promise<T>,
  opts: { timeoutMs: number; headers?: Record<string, string>; signal?: AbortSignal }
): Promise<T> {
  const list = candidates.filter(Boolean)
  if (!list.length) throw new Error('网络不可用')
  if (opts.signal?.aborted) throw new Error('已取消')

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs)
  const onAbort = () => ctrl.abort()
  opts.signal?.addEventListener('abort', onAbort)

  const errors: unknown[] = []
  try {
    // 手写竞速而非 Promise.any：本包 tsconfig 的 lib 低于 ES2021 没有 Promise.any，
    // 且这里要精确控制三件事——首个成功者胜出、其余候选立即中止、全部失败回传最有信息量的错误。
    return await new Promise<T>((resolve, reject) => {
      let pending = list.length
      let done = false

      const settleFailure = (err: unknown) => {
        if (done) return
        if (--pending > 0) return
        done = true
        // 优先回传带状态码的错误：比 AbortError / TypeError 更能说明是限流还是不通
        const httpError = errors.find((e) => e instanceof Error && /^HTTP \d+/.test(e.message))
        reject(httpError ?? errors[errors.length - 1] ?? err)
      }

      for (const url of list) {
        void (async () => {
          try {
            const res = await fetch(url, { signal: ctrl.signal, headers: opts.headers })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const parsed = await parse(res)
            if (done) return
            done = true
            resolve(parsed)
          } catch (err) {
            errors.push(err)
            settleFailure(err)
          }
        })()
      }
    })
  } finally {
    clearTimeout(timer)
    // 胜出后立刻掐掉仍在跑的候选，避免白等剩余超时窗口
    ctrl.abort()
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
