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
 *
 * ## 已知限制：本实现**忽略 `init.signal`**
 *
 * 只取 `{method, headers, responseType}` 转发给 CapacitorHttp，不传 signal，
 * 因此 `fetchWithTimeout` 的超时**无法取消**底层原生请求 —— 超时只保证调用方
 * 按时拿到异常，原生侧仍会跑完（框架未提供取消入口）。
 * 这不影响「不永久挂起」这个结论：`fetchWithTimeout` 的响应头阶段有
 * `Promise.race` 兜底（实测 impl 永不 resolve 时也能按预算抛出），
 * 而本实现把**完整 body 物化**后才 `new Response(body, ...)` 返回，
 * 所以移动端没有「可停滞的增量 body」，读体预算在那里是空转。
 * 改动本函数时不要把「传了 signal」当成已实现能力。
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
