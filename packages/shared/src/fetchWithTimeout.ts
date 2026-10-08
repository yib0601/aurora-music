/**
 * 带超时的 fetch（兼容旧 WebView）
 *
 * 说明：AbortSignal.timeout() 需要 Chrome 103+（2022 年引入），
 * 旧内核（部分国产机 WebView / 老旧系统控件）会直接抛 TypeError，
 * 表现为「在线搜索 / 在线歌词全部静默失败」。这里统一改用
 * AbortController + setTimeout 实现，2018 年后的所有内核均可用。
 *
 * 超时错误必须是**我们自己的中文错误**（TimeoutError），不能把底层 fetch 的
 * 原生 AbortError 透出去：它的 message 是浏览器英文 "The operation was aborted."。
 * 桌面端执行链路是「渲染层选源 → 主进程执行（shared 执行器）→ IPC 回传」，
 * IPC 只在 message 前拼一句 "Error invoking remote method 'hall:recommend':"，
 * name 一律退化成 Error —— 于是渲染层拿到 `Error invoking remote method
 * 'hall:recommend': AbortError: The operation was aborted.`，剥掉前缀丢给用户
 * 就是那条无主语的英文（musicHallStore 的 messageOf 正是 `err.message`）。
 * 本函数的中止有两个来源：自己的超时计时器、调用方传入的 init.signal。
 * 前者统一转成 TimeoutError，后者原样抛出（取消语义由调用方处理）。
 */

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * 请求超时错误：中文 message + 可判定的 name（跨 IPC 后 message 仍带中文结论）。
 * timeoutMs 随错误带出，调用方要展示「等待了多久」时无需另传参数。
 */
export class TimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`请求超时（${timeoutMs}ms）`)
    this.name = 'TimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/**
 * 是否超时类错误。AbortError 一并认下：原生 fetch 被中止、以及历史版本
 * fetchWithTimeout 抛出的都是它（拿到旧主进程回传时仍能判定为超时）。
 */
export function isTimeoutError(err: unknown): boolean {
  const name = (err as Error | null | undefined)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

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
  // 调用方自带的取消信号（如页面卸载）原样透传给底层实现，且不计入「超时」判定
  const external = init.signal ?? null
  let timedOut = false
  const onExternalAbort = () => controller.abort(external?.reason)
  if (external) {
    if (external.aborted) controller.abort(external.reason)
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new TimeoutError(timeoutMs))
  }, timeoutMs)
  const impl = customFetch ?? fetch
  // 未处理的拒绝兜底：调用方带的 signal 中止时，race 抢先抛出，底层 promise 的
  // 拒绝就没人接了（Chrome 会打 unhandledrejection）。这里挂一个空处理器吞掉。
  const guard = (p: Promise<Response>) => {
    p.catch(() => {})
    return p
  }
  try {
    // 自定义实现（原生 HTTP 层）可能不支持 AbortSignal，
    // 用 signal 竞速兜底，保证超时语义不丢失
    const race = Promise.race([
      guard(impl(input, { ...init, signal: controller.signal })),
      new Promise<never>((_, reject) => {
        const onAbort = () => reject(controller.signal.reason ?? new TimeoutError(timeoutMs))
        if (controller.signal.aborted) onAbort()
        else controller.signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
    try {
      return await race
    } catch (err) {
      // 中止是自己发起的：统一换成中文超时错误；调用方取消则原样抛出
      if (timedOut && !external?.aborted) throw new TimeoutError(timeoutMs)
      throw err
    }
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onExternalAbort)
  }
}