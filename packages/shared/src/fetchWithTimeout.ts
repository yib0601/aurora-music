/**
 * 带超时的 fetch（兼容旧 WebView）
 *
 * 说明：AbortSignal.timeout() 需要 Chrome 103+（2022 年引入），
 * 旧内核（部分国产机 WebView / 老旧系统控件）会直接抛 TypeError，
 * 表现为「在线搜索 / 在线歌词全部静默失败」。这里统一改用
 * AbortController + setTimeout 实现，2018 年后的所有内核均可用。
 */

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * 自定义 fetch 实现注入点：移动端 WebView 的 fetch 受 CORS 约束，
 * 而第三方歌源/歌词源普遍不返回 Access-Control-Allow-Origin，
 * 导致在线搜索全部失败。移动端启动时注入基于原生 HTTP 的实现绕开
 * （见 packages/app mobile 平台），桌面端保持浏览器/Node 原生 fetch。
 */
let customFetch: FetchLike | null = null

export function setCustomFetch(fn: FetchLike | null): void {
  customFetch = fn
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 10000
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const impl = customFetch ?? fetch
  try {
    const respPromise = impl(input, { ...init, signal: controller.signal })
    // 自定义实现（原生 HTTP 层）可能不支持 AbortSignal，
    // 用 signal 竞速兜底，保证超时语义不丢失
    return await Promise.race([
      respPromise,
      new Promise<never>((_, reject) => {
        if (controller.signal.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
          return
        }
        controller.signal.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true }
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}