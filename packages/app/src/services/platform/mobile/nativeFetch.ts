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
 * ## 两条绕开 CapacitorHttp 的路径（都交给 NativeHttp 原生插件）
 *
 * `CapacitorHttp` 在 Android 上的底层是 `HttpURLConnection`，它有两个硬限制：
 *
 * 1. **非标准动词**：`setRequestMethod("PROPFIND")` 直接抛 `ProtocolException`
 *    （JDK 从 1.6 起就只放行 RFC 2616 的那几个动词，见 JDK-7017158）。
 *    所以网络存储的 PROPFIND 必须走 OkHttp —— 它接受任意 method 字符串。
 * 2. **二进制读体**：本文件用 `responseType: 'text'` 取回响应（协议执行器随后
 *    自己 `resp.json()`），把这条路径用在音频字节上会把二进制当文本解码而损坏。
 *    带 `Range` 的请求（远端曲目的元数据头、封面提取）因此改走原生插件的
 *    base64 通道。
 *
 * 其余请求仍旧走 CapacitorHttp：它是 Capacitor 自带实现，少一层 JS 桥开销。
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

/** 原生插件暴露的方法集合形状（`window.Capacitor.Plugins.NativeHttp`） */
interface NativeHttpPlugin {
  request(options: {
    url: string
    method: string
    headers: Record<string, string>
    body?: string
  }): Promise<{ status: number; headers?: Record<string, string>; data?: string }>
}

/** HttpURLConnection 放行的动词；其余（PROPFIND / MKCOL / MOVE / COPY …）走原生插件 */
const STANDARD_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])

function nativeHttpPlugin(): NativeHttpPlugin | null {
  // 单测跑在 node 环境（没有 window）：这里必须容忍它缺失，
  // 否则一条 `window is not defined` 会让整个 fetch 实现不可测
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  const plugin = cap?.Plugins?.NativeHttp as NativeHttpPlugin | undefined
  return plugin && typeof plugin.request === 'function' ? plugin : null
}

function normalizeHeaders(rawHeaders: HeadersInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!rawHeaders) return headers
  if (typeof (rawHeaders as Headers).forEach === 'function') {
    ;(rawHeaders as Headers).forEach((value, key) => {
      headers[key] = value
    })
  } else if (Array.isArray(rawHeaders)) {
    for (const [key, value] of rawHeaders) headers[key] = value
  } else {
    Object.assign(headers, rawHeaders)
  }
  return headers
}

/** 请求头里是否有 `Range`（大小写不敏感：调用方两种写法都出现过） */
function hasRangeHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === 'range')
}

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * 走原生插件发一次请求，把结果包成标准 Response。
 *
 * 二进制语义：插件回 base64，这里解成字节再交给 `Response` —— 之后
 * `resp.arrayBuffer()` 拿到的就是原始字节，`resp.text()` 也能正常工作
 * （按 UTF-8 解码，PROPFIND 的 XML 正是这种）。
 */
async function nativeRequest(
  plugin: NativeHttpPlugin,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: BodyInit | null | undefined
): Promise<Response> {
  // 只有字符串体有意义：本项目里唯一的自定义动词请求是 WebDAV 的 PROPFIND（XML 体）
  const textBody = typeof body === 'string' ? body : undefined
  const result = await plugin.request({ url, method, headers, body: textBody })
  const status = result?.status >= 200 && result?.status <= 599 ? result.status : 502
  const bytes = typeof result?.data === 'string' ? base64ToBytes(result.data) : new Uint8Array(0)
  // 用独立 ArrayBuffer 交给 Response：TS 的 BodyInit 只认 ArrayBuffer，
  // 而 Uint8Array 的 buffer 类型是 ArrayBufferLike（可能是 SharedArrayBuffer）
  const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new Response(payload, {
    status,
    headers: (result?.headers || {}) as Record<string, string>,
  })
}

export function createNativeFetch(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

    // 非 http(s) 请求（如 capacitor:// 本地文件）仍走 WebView 原生 fetch
    if (!/^https?:\/\//i.test(url)) return fetch(input, init)

    // 归一化请求头（本项目调用方均传普通对象，兼容 Headers/数组形式）
    const headers = normalizeHeaders(init.headers)
    const method = (init.method || 'GET').toUpperCase()

    // 非标准动词 / 带 Range 的二进制读：交给原生插件（见文件头两条限制）
    if (!STANDARD_METHODS.has(method) || hasRangeHeader(headers)) {
      const plugin = nativeHttpPlugin()
      if (plugin) return nativeRequest(plugin, url, method, headers, init.body)
      // 插件缺失（老包 / iOS 未注册）时继续走 CapacitorHttp：
      // 标准动词仍可用；PROPFIND 会在原生层报 ProtocolException，由调用方按传输错误处理
    }

    // responseType 'text' 拿原始文本：协议执行器会自行 resp.json() 解析，
    // 避免原生层按 json 解析失败时 data 结构不确定
    const resp = await CapacitorHttp.request({
      url,
      method,
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
