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
 * ## 覆盖范围：所有读路径都被包住
 *
 * 实现方式是**包装底层 body 流**（见 withBodyTimeout），而不是逐个覆盖读方法。
 * 于是下面这些路径**全部**走同一条受保护的管道，拿到的都是可判定的错误：
 *   1. `resp.json()` / `text()` / `arrayBuffer()` / `blob()`；
 *   2. `resp.clone()` 得到的新对象（共享同一条包装流）；
 *   3. `resp.body` 裸流读取；
 *   4. `Readable.fromWeb(resp.body)` 这类把流交给别处消费的用法。
 * 早期版本逐个覆盖四个读方法，2~4 完全绕过约束（实测挂死），且无法区分
 * 「上游停滞」与「上游只是慢」——那正是下面要讲的误杀。
 *
 * **「调用方拿到响应头后从不读体」时连接也会被释放**：另有一份**兜底计时**
 * 在响应返回时武装，只有当消费者表现出读的意图（碰 json/text/arrayBuffer/blob、
 * clone 或 body）才撤销；到点即 `abort` 断掉底层 socket（实测 300ms 预算下连接在 3s 内关闭）。
 *
 * 代价：`new Response(stream, ...)` 构造后 Node 会**预取**一次 pull，
 * 因此「读端开口」的钩子会立刻触发、外部取消监听随即挂上。所以**在途期间**
 * 监听数是「未读完的响应数」而非 0；到点会摘干净，长跑不累积（有测试钉住）。
 * 这是必要的代价——停滞的 body 下读会一直 await，此时若没人接取消，
 * 调用方中止就永远等不到结论，正是要修的那类挂死。
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
 * 把中止/失败原因归一成 Error，供流读端 error() 使用。
 *
 * `AbortController.abort()` 不带参数时 reason 是 AbortError（DOMException），
 * 但调用方也可能传任意值（字符串等）。流规范要求 error() 接受任意值，
 * 这里只在「不是 Error」时包一层，保留原值作为 message，避免丢失信息。
 */
function reasonOf(reason: unknown): Error {
  if (reason instanceof Error) return reason
  if (reason === undefined) return new DOMException('This operation was aborted', 'AbortError')
  return new Error(String(reason))
}

/**
 * 读体阶段的**停滞（idle）预算**：把响应体包一层流，只要数据还在流动就续期，
 * 停住 `timeoutMs` 没动静才 abort。
 *
 * ## 为什么不是「读体总时长上限」
 *
 * 最初的实现给读体单独一份 timeoutMs，语义是「读完整个 body 的总时长上限」。
 * 实测发现那是**误杀**：分片持续流动的 body（每 150ms 一片、共 1200ms）在
 * 500ms 预算下被判超时——而上游一直在供数、只是总量大。真实调用点里
 * `openWebdavRange`（服务器忽略 Range 时会回整个文件，预算 30s）与
 * `fetchLxScript`（允许 4MB）都可能撞上，HEAD 原本是允许慢但不断流的传输的。
 * 那等于把「修复挂死」变成「收紧总预算」，属于本轮引入的回归。
 *
 * 正确语义是**停滞超时**：有数据流动就不算超时，只有供数中断才失败。
 * 这也正是本项目要解决的场景——上游送完响应头就停住 body（停滞），
 * 而不是上游慢慢传（变慢）。两者在实现上必须区分开。
 *
 * ## 为什么用流包装而不是覆盖 json/text/arrayBuffer/blob
 *
 * 上一版逐个覆盖四个读方法，有两个缺点：
 *   1. `resp.clone()` 与 `resp.body` 裸流读**绕过**这四个方法，不受约束（实测挂死）；
 *   2. 逐个覆盖无法感知「中间有没有数据流动」，只能算总时长，于是有上面的误杀。
 * 包装底层流则一次解决两件事：`Response` 内部消费的是包装后的流，
 * 四个读方法、`clone()`、裸流读**全部**走同一条受保护的管道。
 *
 * ## 属性等价性
 *
 * `new Response(wrappedStream, resp)` 会丢掉 `url` / `type` / `redirected`
 * （实测：url 变空串、type 变 'default'），因此用 `defineProperty` 逐个补回。
 * 其余可观察面（status / statusText / ok / headers / bodyUsed）实测与原响应一致。
 *
 * ## 错误归一
 *
 * 到点时 `controller.abort(new TimeoutError(timeoutMs))`，并把 reason 推进包装流
 * （`terminate`）—— 于是四个读方法、clone、裸流读拿到的**都是我们的 TimeoutError**。
 * 调用方取消则原样透传（AbortError 或它给的任意 reason），取消语义归调用方。
 */
function withBodyTimeout(resp: Response, ctx: {
  controller: AbortController
  external: AbortSignal | null
  timeoutMs: number
}): Response {
  const { controller, external, timeoutMs } = ctx
  const signal = controller.signal
  const onExternalAbort = () => controller.abort(external?.reason)

  // 没有 body 的响应（204 / HEAD / 304）没有可停滞的东西：只需保证
  // 「调用方从不读体时连接也会被释放」，同时接上外部取消。
  if (!resp.body) {
    if (external) {
      if (external.aborted) controller.abort(external.reason)
      else external.addEventListener('abort', onExternalAbort, { once: true })
    }
    const timer = setTimeout(() => {
      external?.removeEventListener('abort', onExternalAbort)
      controller.abort(new TimeoutError(timeoutMs))
    }, timeoutMs)
    unrefTimer(timer)
    return resp
  }

  /**
   * 两份计时器，职责必须分开（这是本函数最容易写错的地方，我在这里栽过两次）：
   *
   * 1. `stallTimer` —— **停滞判定**。只在「已经向底层要数据、还没等到回应」这段时间里
   *    有效（即包住 `await reader.read()`）。拿到回应立刻撤。
   *    为什么不能「读到一块就续期、放着不管」：pull 由**消费者**驱动，
   *    消费者一慢（队列满 → 不再 pull → 无人续期 → 到点 abort），就会在
   *    **上游全程正常供数**时误杀。实测：上游 450ms 送完 100 片、消费者每块 150ms、
   *    预算 1000ms ⇒ 1428ms 处判超时，只读到 10/100 片。
   *
   * 2. `backstopTimer` —— **「消费者压根没在读」时的连接释放**。
   *    响应返回即武装，撤销条件是「消费者表现出读的意图」（调用 json/text/
   *    arrayBuffer/blob、clone，或访问 body）。为什么用一个独立信号而不是
   *    「首次 pull」或「首次 enqueue」：`new Response(stream)` 构造后 Node 会**预取**
   *    一次 pull，上游若已送出首块就会立刻 enqueue —— 两者都不等于「有人在读」。
   *    实测用「首次 pull」撤销会让「只看 resp.ok 就返回」的调用方把兜底清掉，
   *    socket 一直挂到 undici 自己回收（T+3s 仍存活）。
   */
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  let backstopTimer: ReturnType<typeof setTimeout> | null = null
  let externalListenerAttached = false

  const clearStallTimer = () => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer)
      stallTimer = null
    }
  }
  const clearBackstopTimer = () => {
    if (backstopTimer !== null) {
      clearTimeout(backstopTimer)
      backstopTimer = null
    }
  }
  const detachExternal = () => {
    if (externalListenerAttached) {
      external?.removeEventListener('abort', onExternalAbort)
      externalListenerAttached = false
    }
  }
  const disposeAll = () => {
    clearStallTimer()
    clearBackstopTimer()
    detachExternal()
  }

  /** 到点：断 socket（两个计时器共用同一套收尾） */
  const onBudgetExpired = () => {
    disposeAll()
    controller.abort(new TimeoutError(timeoutMs))
  }

  /** 开始等上游：从这里起算停滞 */
  const armStall = () => {
    clearStallTimer()
    stallTimer = setTimeout(onBudgetExpired, timeoutMs)
    // 不该把进程退出推迟最多 timeoutMs
    unrefTimer(stallTimer)
  }

  /** 消费者还没来读的兜底 */
  const armBackstop = () => {
    clearBackstopTimer()
    backstopTimer = setTimeout(onBudgetExpired, timeoutMs)
    unrefTimer(backstopTimer)
  }

  /**
   * 外部取消桥接：读体进行中被调用方取消时立刻失败。
   *
   * ⚠️ 挂载时机是**读端第一次要数据**（ReadableStream 的 pull），因为
   * `pull` 在消费者一开口（含构造时的预取）就会触发，而在此之前挂监听会让
   * 「拿到响应却不读体」的调用方按未读响应数在它的 signal 上攒下永不摘除的监听。
   */
  const attachExternalOnce = () => {
    if (!external || externalListenerAttached) return
    if (external.aborted) {
      // 已被取消：signal 的 abort 事件已经派发过，补挂监听接不到，必须自己中止。
      // 防御性分支 —— 在当前实现下通常够不到（预取 pull 总在首个 macrotask 内发生，
      // 而用户取消只可能来自更晚的 macrotask，且响应头阶段已检查过 external.aborted），
      // 但保留它以免依赖这个时序细节。
      controller.abort(external.reason)
      return
    }
    external.addEventListener('abort', onExternalAbort, { once: true })
    externalListenerAttached = true
  }

  const source = resp.body
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let outCtrl: ReadableStreamDefaultController<Uint8Array> | null = null
  let terminated = false

  /**
   * 终结读端：把原因交给消费者，并释放底层读锁。
   *
   * 不能只依赖 `reader.read()` 的拒绝：`controller.abort()` 未必能让一个**已经挂起**
   * 的底层读 reject（忽略 signal 的实现就是如此），于是必须主动把错误推进包装流，
   * 否则消费者永远等不到结论 —— 那正是本函数要消灭的挂死。
   */
  const terminate = (reason: unknown) => {
    if (terminated) return
    terminated = true
    disposeAll()
    try {
      outCtrl?.error(reason)
    } catch {
      /* 流已关闭/已错：无需再推进 */
    }
    void reader?.cancel(reason).catch(() => {})
  }
  signal.addEventListener('abort', () => terminate(reasonOf(signal.reason)), { once: true })

  const idleStream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      outCtrl = ctrl
      attachExternalOnce()
      if (terminated) return
      if (!reader) reader = source.getReader()
      armStall()
      try {
        const { done, value } = await reader.read()
        // 上游给了回应（有数据或已结束）：本次等待结束，撤掉停滞计时。
        // 必须在这里撤，否则消费者慢时计时器会在「没人等上游」的空档里继续跑。
        clearStallTimer()
        if (terminated) return
        if (done) {
          terminated = true
          disposeAll()
          ctrl.close()
          return
        }
        if (value) ctrl.enqueue(value)
      } catch (err) {
        terminate(reasonOf(err))
      }
    },
    cancel(reason) {
      terminated = true
      disposeAll()
      void reader?.cancel(reason).catch(() => {})
    },
  })

  const wrapped = new Response(idleStream, resp)
  // 补回 new Response 会丢掉的三个只读属性（实测：url 会变空串、type 变 'default'）
  for (const key of ['url', 'type', 'redirected'] as const) {
    Object.defineProperty(wrapped, key, { value: resp[key], configurable: true })
  }

  // ── 消费者意图标记：这些入口一被触碰，就说明「有人要读」 ──────────────
  // 撤销兜底计时，之后只按「等上游」判停滞 —— 于是慢消费者不会被兜底误杀。
  // 反过来，一个只读 resp.status 就返回的调用方不会触碰任何入口，
  // 兜底到点即断���释放。
  const markConsumerStarted = () => clearBackstopTimer()

  for (const key of ['json', 'text', 'arrayBuffer', 'blob'] as const) {
    const original = wrapped[key].bind(wrapped) as () => Promise<unknown>
    Object.defineProperty(wrapped, key, {
      value: () => {
        markConsumerStarted()
        return original()
      },
      configurable: true,
      writable: true,
    })
  }
  {
    const originalClone = wrapped.clone.bind(wrapped)
    Object.defineProperty(wrapped, 'clone', {
      value: () => {
        markConsumerStarted()
        return originalClone()
      },
      configurable: true,
      writable: true,
    })
  }
  // `body` 是原型上的 getter：访问它就等于「准备自己读流」，同样算消费者意图。
  // 注意：这段必须放在 `new Response(idleStream, resp)` **之后** —— 构造期若读一次
  // `wrapped.body` 就会把兜底误清（这也是下面那条「不读体也要释放连接」的测试
  // 能反过来验证本顺序的原因）。
  Object.defineProperty(wrapped, 'body', {
    get() {
      markConsumerStarted()
      return idleStream
    },
    configurable: true,
  })

  armBackstop()
  return wrapped
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
    })
  } catch (err) {
    cleanupHeader()
    throw err
  }
}