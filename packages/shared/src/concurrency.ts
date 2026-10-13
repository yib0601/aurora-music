/**
 * 并发原语：**延迟对冲取首个成功** + **有界并发映射**。
 *
 * 为什么手写而不用 Promise.any：
 *   1. 本包 target 是 ES2020（lib ES2021），运行环境里没有 Promise.any（app 侧同理）；
 *   2. Promise.any 只能「一次全发」，无法表达这里真正需要的语义 ——
 *      **优先级**（按用户配置顺序依次启动）+ **延迟对冲**（前一档迟迟不定才并行下一档）。
 *      纯竞速会让「配在第一位的音源」被网络快慢颠倒，这不是等价替换。
 *
 * 用途：凡是「多档候选、先来的更好、又不想等串行累加」的取数场景
 * （歌词聚合、歌单链接解析）都走这里；候选之间**无优先级**时把 hedgeMs 设 0 即退化为纯竞速。
 */

/** firstSuccess 的选项 */
export interface FirstSuccessOptions {
  /**
   * 对冲延迟（毫秒）：上一档启动后等这么久仍未定，就并行启动下一档。
   *
   * 0 表示一次性并发全部（纯竞速，放弃优先级）；负数按 0 处理。
   * 缺省 0 —— 但调用方应显式给出，这个值决定了「首屏等待」与「优先级」的取舍点。
   */
  hedgeMs?: number
  /**
   * 同时在途的档数上限（缺省不限）。
   *
   * 存在的意义是**上游压力**：对冲把请求数从 1 放大到 N，对有限流的音源服务是实打实的
   * 配额消耗。1 等价于完全串行（放弃并发收益），调用方按源的承受能力取 2~3 通常合适。
   */
  maxInFlight?: number
}

/** 命中的结果与来源档位下标 */
export interface FirstSuccessHit<R> {
  result: R
  /** 命中的那一档在入参里的下标（调用方据此知道是谁给的结果） */
  index: number
}

/**
 * 按顺序启动候选，取**第一个非空结果**；全部落空返回 null。
 *
 * 启动节奏：
 *   - 第 0 档立即启动；
 *   - 之后每档在前一档启动后等 `hedgeMs` 仍未定则启动（滚动对冲，最多 `maxInFlight` 档在途）；
 *   - 某档**落空**（返回 null / undefined，或抛错）时立刻启动下一档，不再等对冲计时 ——
 *     这一档的等待时间已经花掉了，再等一轮纯属浪费。
 *
 * 错误处理：`run` 抛出的错误**一律按落空处理**（记录与否由调用方在 `run` 内部决定，
 * 例如先 `console.warn` 再返回 null）。理由：本函数的职责是「取到结果」，
 * 而多档候选的失败原因该由调用方决定怎么呈现（歌词/歌单最后一档错误的取舍各不相同）。
 *
 * 落空的档不取消：仍在途的请求会在后台自然结束，settle 时因已收场而什么都不做。
 * 这也是刻意的 —— 上游取数没有副作用，为一个纯读请求引入取消信号只会增加调用面复杂度。
 *
 * ## 已知限制：没有全局截止，任一档永不 settle 即整体永不 resolve
 *
 * 收场条件是「所有档都进入终态」；因此只要有一档既不成功也不失败（例如上游返回了响应头
 * 却停住 body，调用方又没把读体纳入超时），整体就会永久 pending；`maxInFlight` 卡满时
 * 剩余候选连启动机会都没有。**这不是本模块独有的问题**：旧的逐档串行实现在同样的上游
 * 下会卡在同一档上（已实测，两版都会挂），而对冲反而修复了「停滞档排在前、后档本可成功」
 * 这一类（旧实现永远等不到后档）。真正的兜底属于**调用方**：把整条请求链路
 * （含读体）纳入超时。`__tests__/concurrency.test.ts` 中「永不 settle 的候选」一节
 * 把这个契约写成了测试，日后若在此加入截止计时器，那些用例会显式变红。
 */
export async function firstSuccess<T, R>(
  items: readonly T[],
  run: (item: T, index: number) => Promise<R | null>,
  options: FirstSuccessOptions = {}
): Promise<FirstSuccessHit<R> | null> {
  const list = items || []
  if (list.length === 0) return null
  const hedgeMs = Math.max(0, options.hedgeMs ?? 0)
  const maxInFlight = Math.max(1, options.maxInFlight ?? list.length)

  return new Promise<FirstSuccessHit<R> | null>((resolve) => {
    /** 下一档待启动的下标 */
    let next = 0
    /** 在途档数 */
    let inFlight = 0
    let done = false
    let hedgeTimer: ReturnType<typeof setTimeout> | null = null

    const finish = (value: FirstSuccessHit<R> | null) => {
      if (done) return
      done = true
      if (hedgeTimer !== null) {
        clearTimeout(hedgeTimer)
        hedgeTimer = null
      }
      resolve(value)
    }

    /** 排定「下一档」的对冲计时；条件不满足（无在途档 / 槽位已满 / 已排定）则什么都不做 */
    const armHedge = () => {
      if (done || next >= list.length) return
      // 没有在途档时不排对冲：推进由落空分支立刻完成，计时只会白等一轮
      if (inFlight === 0 || inFlight >= maxInFlight) return
      // 已有计时在跑就不重排：每有一档落空都重排会把对冲无限推迟
      if (hedgeTimer !== null) return
      if (hedgeMs <= 0) {
        launchNext()
        return
      }
      hedgeTimer = setTimeout(() => {
        hedgeTimer = null
        launchNext()
      }, hedgeMs)
    }

    const launchNext = () => {
      if (done || next >= list.length || inFlight >= maxInFlight) return
      const index = next++
      inFlight++

      const settle = (value: R | null | undefined) => {
        if (done) return
        inFlight--
        if (value !== null && value !== undefined) {
          finish({ result: value, index })
          return
        }
        // 落空：立刻推进下一档，并清掉当前对冲计时（避免它稍后又启动一档）
        if (hedgeTimer !== null) {
          clearTimeout(hedgeTimer)
          hedgeTimer = null
        }
        if (next >= list.length && inFlight === 0) {
          finish(null)
          return
        }
        launchNext()
        armHedge()
      }

      // run 的同步抛出也要算落空：用 async IIFE 包住，绝不让它变成未捕获异常
      void (async () => {
        try {
          settle(await run(list[index], index))
        } catch {
          settle(null)
        }
      })()

      armHedge()
    }

    launchNext()
  })
}

/**
 * 有界并发映射：结果**按入参顺序**返回，同时在途任务数不超过 limit。
 *
 * 顺序保证很重要：调用方常拿结果与入参做下标对齐（扫描结果要与文件列表同序）。
 * limit < 1 或缺省按 1 处理，退化为串行 —— 语义与逐条 await 一致。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const list = items || []
  const out = new Array<R>(list.length)
  if (list.length === 0) return out
  const width = Math.min(Math.max(1, Math.floor(limit) || 1), list.length)
  let cursor = 0

  const run = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= list.length) return
      out[index] = await worker(list[index], index)
    }
  }

  await Promise.all(Array.from({ length: width }, () => run()))
  return out
}