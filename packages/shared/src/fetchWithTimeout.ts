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
 * 本函数的中止有三个来源：**响应头阶段**的超时计时器、**读体阶段**的超时计时器、
 * 调用方传入的 init.signal。前两者统一转成 TimeoutError，后者原样抛出
 * （取消语义由调用方处理）。
 *
 * ## 为什么必须管到读体（曾经的永久挂死）
 *
 * 一个 AbortController 的计时器无法同时充当两个阶段的预算：响应头一到就必须清掉它
 * （否则调用方慢条斯理地处理响应头也会被算作超时），而清掉之后底层 socket 就再无
 * 任何约束。上游只要「送完响应头就停住 body」，调用方的 `await resp.json()` 就会
 * **永久 pending**。这不是理论风险——实测真实 TCP 上游（只写响应头不写 body）时，
 * 改造前后的两版都在 5s 处仍未 settle，用户侧看到的就是界面永久转圈；
 * 而并发化之后 `firstSuccess` 的收场条件是「所有档进入终态」，
 * 任何一档永不 settle 会让整个对冲永不 resolve，把这个既有缺陷放大成主链路故障。
 * 修复放在**源头**（本函数）而不是给每个调用方加截止：调用方有 8 处，
 * 漏一处就漏一处挂死，且各处自定的截止还会互相打架。
 *
 * ## 覆盖范围与它**不**覆盖的两件事（别把结论读过头）
 *
 * 读体预算只作用于四个读方法：`json` / `text` / `arrayBuffer` / `blob`。
 * 以下两条路径**不受约束**，仍会挂在停滞的 body 上（实测确认，与旧实现一致）：
 *   1. `resp.clone()` 得到的新对象——方法覆盖不随 clone 传播，而计时器又只在
 *      被覆盖的方法里惰性武装，于是 clone 上根本没有预算；
 *   2. `resp.body` 裸流读取（`Readable.fromWeb(resp.body)` 等）——绕过读方法，
 *      同样不会触发武装。
 * 当前仓库对 fetchWithTimeout 的返回值没有这两类消费点（handlers.ts / mediaCache.ts
 * 的下载路径用的是**全局原生 fetch**，不经过本函数），所以不是现存缺陷；
 * 但要把「四方法以外不受预算约束」当作本函数的显式接口契约对待，新增调用方前先看这条。
 * （实测教训：一度以为「socket 被 abort，所以 clone 也会跟着失败」——不成立。
 *  惰性武装意味着没人读体时计时器从未建立，压根没发生 abort。验证这类结论必须
 *  直接跑**当前源码**：我当时跑的是上一版构建产物，差点把逃逸写成受约束。）
 *
 * 另有一条路径**不释放连接**：调用方拿到响应头后自行抛错、**从不读体**
 * （例如 `!resp.ok` 就 throw）。惰性武装的设计意味着此时读体计时器从未建立，
 * 于是没有任何人 abort，socket 会留到 undici 的 keep-alive / socket 超时自然回收
 * （实测 T+2.45s 仍存活，新旧实现一致）。这是既有行为，不是本轮引入；
 * 若要在该路径上也立刻断开，得改成在返回时就武装计时器，但那会重新带回
 * 「调用方慢处理响应头被算作超时」的问题，需要单独的取舍。
 */

import { encodeErrorInfo } from './i18n/errors'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * 请求超时错误：可判定的 name + **结构化 message**。
 *
 * message 走 `AURORA_ERR:{...}` 编码载荷（而不是写死一句中文），理由：
 *   1. 这是跨进程错误的**源头**——主进程执行器抛出后经 IPC 回传，渲染层要按
 *      当前语言渲染。写死中文会让英文界面出现中文（写死英文则反过来）；
 *   2. 编码载荷不依赖关键词猜测：渲染层的 `toErrorInfo` 能直接解出
 *      `errors.network.timeout`，而靠 "timeout/timed out" 正则去认中文字面量
 *      是认不出来的（中文里只有「超时」二字）；
 *   3. `detail` 里保留人类可读的技术细节（`timeout after 15000ms`），
 *      供日志、诊断与「把底层原因嵌进上层句子」的场景使用——
 *      注意**不要**把 `error.message` 直接当参数插进别的模板（那会插进编码串），
 *      要用 `toErrorInfo(err).detail`。
 *
 * timeoutMs 随错误带出，调用方要展示「等待了多久」时无需另传参数。
 */
export class TimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(encodeErrorInfo({ code: 'errors.network.timeout', params: { ms: timeoutMs }, detail: `timeout after ${timeoutMs}ms` }))
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

/** setTimeout 在 Node 下返回带 unref 的对象；unref 只影响「是否阻止进程退出」，不影响触发 */
function unrefTimer(timer: unknown): void {
  ;(timer as { unref?: () => void } | null)?.unref?.()
}

/**
 * 读体的第二阶段：给响应体的每个读方法套上**同一份 timeoutMs 的独立预算**。
 *
 * 为什么要独立而不是「总预算减去响应头耗时」（deadline 语义）：
 * 本次修的是「永久挂死」，不是「收紧总预算」。deadline 会让原本成功的路径变成新的
 * 失败面——例如 NAS 上大文件先花 25s 出响应头（预算 30s），body 只剩 5s 必然读不完，
 * 于是把「慢但能成功」变成「稳定报超时」。两阶段各自一份预算则精确覆盖该缺陷：
 * 每个阶段都必然在有限时间内结束，不会无限等；同时不改变任何「本来能读完」的路径。
 *
 * 中止来源仍靠 `controller` 统一收敛：读体**进行中**时计时器到点 abort 会真的断掉
 * 底层 socket（与只让调用方拿到异常而底层继续挂着有本质区别）。
 * 这只覆盖「读体已经开始」的情形 —— 调用方拿到响应头后不读体就自行抛错时，
 * 计时器从未建立，连接不由本函数释放（见文件头「覆盖范围」一节）。
 * 移动端亦不满足，但影响与桌面端不同：`createNativeFetch()` 基于 CapacitorHttp 且
 * 忽略 `init.signal`，然而它把**完整 body 物化**后才 `new Response(body, ...)` 返回，
 * 所以移动端压根没有「可停滞的增量 body」，读体预算在那里是空转；
 * 真正的挂起点在 `CapacitorHttp.request` 本身，而响应头阶段的 race 第二路已经兜住
 * （实测：impl 永不 resolve 时 301ms 抛 TimeoutError）。代价只是 abort 无法取消
 * 底层原生请求（框架限制），不影响「不永久挂起」这个结论。
 */
function withBodyTimeout(resp: Response, ctx: {
  controller: AbortController
  external: AbortSignal | null
  timeoutMs: number
  /** 响应头阶段是否已因计时器超时；决定错误是 TimeoutError 还是原样透传取消 */
  isByTimer: () => boolean
}): Response {
  const { controller, external, timeoutMs, isByTimer } = ctx
  const signal = controller.signal

  // 计时器与监听器都**惰性**武装（首次读体时才建）：
  //   1. 调用方完全可能拿到 Response 后不读体（例如只看 resp.ok、只取 status），
  //      急切挂载会让 abort 监听器按未读响应数在调用方 signal 上累积，永不摘除；
  //   2. 预算应当从「开始读」起算。若在返回时就武装，调用方读体前做的其它事
  //      （日志、写库、下一个请求）会凭空吃掉这份预算，把慢一点但正常的读判成超时。
  let bodyTimer: ReturnType<typeof setTimeout> | null = null
  let bodyTimedOut = false
  let externalListenerAttached = false

  const onExternalAbort = () => controller.abort(external?.reason)

  const cleanup = () => {
    if (bodyTimer !== null) {
      clearTimeout(bodyTimer)
      bodyTimer = null
    }
    if (externalListenerAttached) {
      external?.removeEventListener('abort', onExternalAbort)
      externalListenerAttached = false
    }
  }

  /** 计时器发起的中止 → TimeoutError；调用方取消 → 原样透传（取消语义归调用方） */
  const reasonError = (reason: unknown): unknown => {
    if (!bodyTimedOut && !isByTimer()) return reason
    return reason instanceof TimeoutError ? reason : new TimeoutError(timeoutMs)
  }

  const armBodyBudget = () => {
    if (bodyTimer !== null) return
    if (external && !externalListenerAttached) {
      // 读体阶段仍要响应外部取消（响应头阶段那次监听已随 cleanupHeader 摘除）
      if (external.aborted) controller.abort(external.reason)
      else {
        external.addEventListener('abort', onExternalAbort, { once: true })
        externalListenerAttached = true
      }
    }
    bodyTimer = setTimeout(() => {
      bodyTimedOut = true
      controller.abort(new TimeoutError(timeoutMs))
    }, timeoutMs)
    // 只 unref 这一个：读体预算不该把进程退出推迟最多 timeoutMs。
    // 响应头阶段那个计时器保持原样 —— 它的存在本身就是「请求进行中」的语义，
    // unref 会让「自定义实现永不 resolve」在无人持有事件循环时静默退出而非按超时失败。
    unrefTimer(bodyTimer)
  }

  const readBody = <T>(call: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(reasonError(signal.reason))
        return
      }
      armBodyBudget()
      // 兜底监听：部分内核 / 自定义实现的中止不会传播到 body 读，显式接住才有超时语义
      const onAbort = () => reject(reasonError(signal.reason))
      signal.addEventListener('abort', onAbort, { once: true })
      const raw = call()
      // 中止后底层读的拒绝无人接收（Chrome 会打 unhandledrejection），先挂空处理器
      raw.catch(() => {})
      raw.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          cleanup()
          resolve(value)
        },
        (err) => {
          signal.removeEventListener('abort', onAbort)
          cleanup()
          // 读失败若发生在中止之后，报超时而非底层的 AbortError（后者文案是英文）
          reject(signal.aborted ? reasonError(signal.reason) : err)
        }
      )
    })

  // 先取原型上的原始读方法再覆盖，否则覆盖后的调用会自递归。
  // 取的是实例链上的方法（不绑定），调用时统一 `.call(resp)` 保住 this。
  const originalJson = resp.json
  const originalText = resp.text
  const originalArrayBuffer = resp.arrayBuffer
  const originalBlob = resp.blob

  // 就地覆盖读方法，而不是 `new Response(resp.body, resp)` 重建：
  // 重建会丢掉 url / type / redirected（实验已确认），而这些在某处被读到就是静默的行为变更。
  // Response 实例是可扩展的（实验确认 Object.isExtensible 为 true），且只覆盖该实例、
  // 不动原型，所以其它 Response 完全不受影响。
  resp.json = () => readBody(() => originalJson.call(resp))
  resp.text = () => readBody(() => originalText.call(resp))
  resp.arrayBuffer = () => readBody(() => originalArrayBuffer.call(resp))
  resp.blob = () => readBody(() => originalBlob.call(resp))
  // 已知未覆盖（实测确认为逃逸，不是「也会超时」）：`resp.clone()` 得到的新对象、
// 以及 `resp.body` 的裸流读取。原因见文件头「覆盖范围」一节。当前无调用方。
  return resp
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

  /** 响应头阶段收尾：撤计时器。读体阶段的监听与计时器由 withBodyTimeout 自己管 */
  const cleanupHeader = () => {
    clearTimeout(timer)
    external?.removeEventListener('abort', onExternalAbort)
  }

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
    let resp: Response
    try {
      resp = await race
    } catch (err) {
      // 中止是自己发起的：统一换成中文超时错误；调用方取消则原样抛出
      if (timedOut && !external?.aborted) throw new TimeoutError(timeoutMs)
      throw err
    }
    // 响应头到手即结束第一阶段。**不能**在这里只 clearTimeout 就返回——
    // 那正是「上游送完响应头停住 body 就永久挂死」的成因，读体预算必须接着武装。
    cleanupHeader()
    if (timedOut || external?.aborted) {
      // 中止与响应头几乎同时到达：这里返回一个已中止的响应会让调用方以为请求成功，
      // 直到读体才炸，错误来源更难定位；直接在第一阶段边界失败。
      const reason = controller.signal.reason
      throw reason instanceof Error ? reason : new TimeoutError(timeoutMs)
    }
    return withBodyTimeout(resp, {
      controller,
      external,
      timeoutMs,
      isByTimer: () => timedOut,
    })
  } catch (err) {
    cleanupHeader()
    throw err
  }
}