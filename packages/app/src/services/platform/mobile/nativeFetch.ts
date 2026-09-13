import { CapacitorHttp } from '@capacitor/core'

/**
 * 基于 CapacitorHttp（原生 HTTP 层）的 fetch 兼容实现。
 *
 * 背景：手机版运行在 Capacitor WebView 中（源为 https://localhost），
 * 用户配置的第三方歌源/歌词源大多不返回 Access-Control-Allow-Origin，
 * WebView 里的原生 fetch 会被 CORS 拦截，表现为在线搜索全部失败。
 * 改用原生 HTTP 发请求不受浏览器同源策略约束（与下载封面用
 * CapacitorHttp 的原因一致），再把结果包装回标准 Response，
 * 使 @aurora/shared 的协议执行器无需改动。
 */
export function createNativeFetch(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

    // 非 http(s) 请求（如 capacitor:// 本地文件）仍走 WebView 原生 fetch
    if (!/^https?:\/\//i.test(url)) return fetch(input, init)

    // 归一化请求头（本项目调用方均传普通对象，兼容 Headers/数组形式）
    const headers: Record<string, string> = {}
    const rawHeaders = init.headers
    if (rawHeaders) {
      if (typeof (rawHeaders as Headers).forEach === 'function') {
        ;(rawHeaders as Headers).forEach((v, k) => {
          headers[k] = v
        })
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) headers[k] = v
      } else {
        Object.assign(headers, rawHeaders)
      }
    }

    // responseType 'text' 拿原始文本：协议执行器会自行 resp.json() 解析，
    // 避免原生层按 json 解析失败时 data 结构不确定
    const resp = await CapacitorHttp.request({
      url,
      method: (init.method || 'GET').toUpperCase(),
      headers,
      responseType: 'text',
    })
    const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data ?? '')
    // Response 构造器要求 status 在 [200, 599]，异常值按 502 兜底
    const status = resp.status >= 200 && resp.status <= 599 ? resp.status : 502
    return new Response(body, {
      status,
      headers: resp.headers || {},
    })
  }
}
