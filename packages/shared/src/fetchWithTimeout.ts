/**
 * 带超时的 fetch（兼容旧 WebView）
 *
 * 说明：AbortSignal.timeout() 需要 Chrome 103+（2022 年引入），
 * 旧内核（部分国产机 WebView / 老旧系统组件）会直接抛 TypeError，
 * 表现为「在线搜索 / 在线歌词全部静默失败」。这里统一改用
 * AbortController + setTimeout 实现，2018 年后的所有内核均可用。
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 10000
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}