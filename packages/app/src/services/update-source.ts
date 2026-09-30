/**
 * 更新链路的多源兜底（纯函数，不依赖 window/electron，便于单独验证）。
 *
 * 背景：更新检查与安装包下载都指向 GitHub。大陆网络下 api.github.com 与
 * release 资产（github.com 会 302 到 objects.githubusercontent.com）常被阻断，
 * 表现为「检查更新失败」或下载进度停在 0 MB。更麻烦的是存在一类网络环境：
 * GitHub 主站 IP 放行而 CDN 域名被污染——检查更新能成功，下载却候选全灭。
 *
 * 策略：所有请求按「GitHub 官方 → 公共加速前缀」依次尝试，前一个失败（网络异常 /
 * 超时 / 限流 / 5xx）才降级到下一个，任一成功即返回。全部失败时抛出最后一个错误，
 * 由调用方按原有逻辑展示失败提示。
 *
 * 注意：加速前缀只拼接 GitHub 域名的原始链接（公开、无凭证），不承载任何用户数据。
 */

/**
 * 公共加速前缀候选：都接受「前缀 + 原始 GitHub 链接」的拼接形式。
 *
 * 实测（无代理直连，完整下载 13.6MB 安装包）：
 *   gh-proxy.com  3.76 MB/s  支持 API 与资产下载
 *   ghfast.top    3.01 MB/s  仅支持资产下载（对 api.github.com 恒 403）
 *   ghproxy.net   33 KB/s    150s 未下完，已剔除——留着只会把失败路径拖长
 *   ghproxy.cn    返回 HTML 错误页（HTTP 200 伪装），已剔除
 *
 * API 与下载分开维护：只有 gh-proxy.com 能透传 api.github.com，把恒 403 的候选
 * 塞进检查更新链路只会白等一轮超时。
 */
const DOWNLOAD_PROXY_PREFIXES = ['https://gh-proxy.com/', 'https://ghfast.top/']
const API_PROXY_PREFIXES = ['https://gh-proxy.com/']

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

/** 该地址是否是 GitHub 官方 API / release 资源 */
function isGithubHost(url: string): boolean {
  return matchesHost(url, [...GITHUB_DOWNLOAD_HOSTS, ...GITHUB_API_HOSTS])
}

/** 是否为白名单加速域名下的链接（形如 https://gh-proxy.com/https://github.com/...） */
export function isProxyUrl(url: string): boolean {
  return matchesHost(
    url,
    [...DOWNLOAD_PROXY_PREFIXES, ...API_PROXY_PREFIXES].map((prefix) => new URL(prefix).host)
  )
}

/** 下载白名单：GitHub 安装包直链或白名单加速链接 */
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
  return [url, ...DOWNLOAD_PROXY_PREFIXES.map((prefix) => prefix + url)]
}

/**
 * Releases API 的候选列表。只用能透传 api.github.com 的前缀（ghfast.top 对该域名
 * 恒 403，实测确认），避免把恒失败的候选塞进检查更新链路白等一轮超时。
 */
export function releasesApiCandidates(repoApi: string): string[] {
  if (!isGithubHost(repoApi)) return [repoApi]
  return [repoApi, ...API_PROXY_PREFIXES.map((prefix) => prefix + repoApi)]
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
