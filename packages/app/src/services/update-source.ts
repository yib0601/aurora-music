/**
 * 更新链路的多源兜底（纯函数，不依赖 window/electron，便于单独验证）。
 *
 * 背景：更新检查与安装包下载都指向 GitHub，大陆网络直连 api.github.com 与
 * release 资源常被阻断，导致「检查失败」或下载进度停在 0 MB。
 *
 * 策略：所有请求按「GitHub 官方 → 公共加速前缀」依次尝试，前一个失败（网络异常 /
 * 超时 / 限流 / 5xx）才降级到下一个，任一成功即返回。全部失败时抛出最后一个错误，
 * 由调用方按原有逻辑展示失败提示。
 *
 * 注意：加速前缀只拼接 GitHub 域名的原始链接（公开、无凭证），不承载任何用户数据。
 */

/**
 * 公共加速前缀候选：都接受「前缀 + 原始 GitHub 链接」的拼接形式。
 * 只保留实测较稳的两个；gh.llkk.cc 等第三方镜像会与前者同时失效，加入反而拖慢失败路径。
 */
const GITHUB_PROXY_PREFIXES = ['https://gh-proxy.com/', 'https://ghfast.top/']

/**
 * GitHub 官方域名。
 * - GITHUB_DOWNLOAD_HOSTS：release 安装包直链所在域名（最终会 302 到 objects.githubusercontent.com）
 * - 另加 api.github.com：仅用于「检查更新」的 Releases API，不下发安装包
 * 两者分开维护，避免把 API 域名混进安装包下载白名单。
 */
const GITHUB_DOWNLOAD_HOSTS = ['github.com', 'objects.githubusercontent.com']
const GITHUB_API_HOSTS = ['api.github.com']

/** 该地址是否可作为「安装包下载」的 GitHub 官方直链 */
export function isGithubUrl(url: string): boolean {
  return matchesHost(url, GITHUB_DOWNLOAD_HOSTS)
}

/** 该地址是否是 GitHub 官方 API / release 资源（检查更新与下载共用同一套加速前缀） */
function isGithubHost(url: string): boolean {
  return matchesHost(url, [...GITHUB_DOWNLOAD_HOSTS, ...GITHUB_API_HOSTS])
}

/** 是否为白名单加速域名下的链接（形如 https://gh-proxy.com/https://github.com/...） */
export function isProxyUrl(url: string): boolean {
  return matchesHost(
    url,
    GITHUB_PROXY_PREFIXES.map((prefix) => new URL(prefix).host)
  )
}

/** 主进程下载白名单：GitHub 安装包直链或白名单加速链接 */
export function isAllowedDownloadUrl(url: string): boolean {
  return isGithubUrl(url) || isProxyUrl(url)
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
 * 非 GitHub 地址（含已带加速前缀的地址）直接原样返回，避免二次包裹。
 */
export function withGithubProxies(url: string): string[] {
  if (!isGithubHost(url)) return [url]
  return [url, ...GITHUB_PROXY_PREFIXES.map((prefix) => prefix + url)]
}

/**
 * Releases API 的候选列表（与安装包下载共用同一套前缀策略）。
 * 注意 api.github.com 只出现在这里，不会进入安装包下载白名单。
 */
export function releasesApiCandidates(repoApi: string): string[] {
  return withGithubProxies(repoApi)
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
