/**
 * 并发原语的语义钉桩。
 *
 * 这里要钉的不是「能跑」，而是三个容易被后续改动悄悄破坏的性质：
 *   1. **优先级**：先启动的档在合理时间内出结果时，后面的档根本不该被启动
 *      （否则「配在第一位的音源」这个用户意图就没了）；
 *   2. **对冲**：前一档迟迟不定必须并行启动下一档（否则等于串行，等待累加）；
 *   3. **落空即推进**：返回 null / 抛错时立刻启动下一档，不再白等一个对冲窗口。
 *
 * 用真实计时器而非假计时器：本模块的全部逻辑都围绕「何时启动下一档」，
 * 与 Promise 微任务队列交织，假计时器需要手工推进到恰到好处的 tick 才不 flaky，
 * 反而更难维护。用例里的延时都在 10~60ms 量级，整批跑完约百余毫秒。
 */
import { firstSuccess, mapWithConcurrency } from '../concurrency'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('firstSuccess：优先级与对冲', () => {
  it('空候选返回 null，不调用 run', async () => {
    let calls = 0
    const hit = await firstSuccess([], async () => {
      calls += 1
      return 'x'
    })
    expect(hit).toBeNull()
    expect(calls).toBe(0)
  })

  it('首档及时成功时，后续档根本不启动（优先级不被网络快慢颠倒）', async () => {
    const started: number[] = []
    const faster = { ms: 10 }
    const hit = await firstSuccess(
      [faster, { ms: 10 }],
      async (item, index) => {
        started.push(index)
        await sleep(item.ms)
        return `v${index}`
      },
      { hedgeMs: 60 }
    )
    // 第 0 档 10ms 就回来了，对冲窗口 60ms 还没到 -> 第 1 档不该出现
    expect(hit).toEqual({ result: 'v0', index: 0 })
    expect(started).toEqual([0])
  })

  it('首档迟迟不定时并行启动下一档，先回来的胜出', async () => {
    const started: number[] = []
    const hit = await firstSuccess(
      [{ ms: 200 }, { ms: 10 }],
      async (item, index) => {
        started.push(index)
        await sleep(item.ms)
        return `v${index}`
      },
      { hedgeMs: 40 }
    )
    // 第 0 档 40ms 未定 -> 启动第 1 档；第 1 档 10ms 后回来（约 50ms）胜出，
    // 第 0 档还要再等 150ms —— 若退化成串行，这里会拿到 v0
    expect(hit).toEqual({ result: 'v1', index: 1 })
    expect(started).toEqual([0, 1])
  })

  it('落空（返回 null）立刻推进下一档，不白等对冲窗口', async () => {
    const started: Array<{ index: number; at: number }> = []
    const t0 = Date.now()
    const hit = await firstSuccess(
      [null, 'ok', 'never'],
      async (item, index) => {
        started.push({ index, at: Date.now() - t0 })
        return item
      },
      // 对冲窗口给得远大于「立刻推进」所需：若落空后仍等计时器才推进，
      // 这一轮会多花 300ms 且用例仍会通过 —— 所以直接断言启动时刻
      { hedgeMs: 300 }
    )
    expect(hit).toEqual({ result: 'ok', index: 1 })
    // 第 1 档在第 0 档落空后几乎立刻启动（同一次微任务链上），远早于 300ms
    expect(started.map((s) => s.index)).toEqual([0, 1])
    expect(started[1].at).toBeLessThan(150)
  })

  it('抛错按落空处理，不中断后续候选', async () => {
    const hit = await firstSuccess(
      ['boom', 'ok'],
      async (item, index) => {
        if (item === 'boom') throw new Error('炸了')
        return `v${index}`
      },
      { hedgeMs: 50 }
    )
    expect(hit).toEqual({ result: 'v1', index: 1 })
  })

  it('全部落空返回 null', async () => {
    const hit = await firstSuccess([null, null, null], async () => null, { hedgeMs: 10 })
    expect(hit).toBeNull()
  })

  it('全部抛错返回 null（错误由调用方在 run 内自行记录）', async () => {
    const hit = await firstSuccess(
      [1, 2],
      async () => {
        throw new Error('nope')
      },
      { hedgeMs: 10 }
    )
    expect(hit).toBeNull()
  })

  it('hedgeMs 为 0 退化为纯竞速：所有候选取同时启动', async () => {
    const started: number[] = []
    const hit = await firstSuccess(
      [{ ms: 200 }, { ms: 30 }, { ms: 10 }],
      async (item, index) => {
        started.push(index)
        await sleep(item.ms)
        return `v${index}`
      },
      { hedgeMs: 0 }
    )
    expect(hit).toEqual({ result: 'v2', index: 2 })
    expect(started).toEqual([0, 1, 2])
  })

  it('maxInFlight 限制同时在途的档数', async () => {
    let peak = 0
    let live = 0
    const started: number[] = []
    const hit = await firstSuccess(
      [{ ms: 40 }, { ms: 40 }, { ms: 40 }, { ms: 40 }, { ms: 40 }],
      async (item, index) => {
        started.push(index)
        live += 1
        peak = Math.max(peak, live)
        await sleep(item.ms)
        live -= 1
        // 全部落空：逼着函数把所有档都启一遍，从而暴露在途数
        return null
      },
      { hedgeMs: 1, maxInFlight: 2 }
    )
    expect(hit).toBeNull()
    expect(peak).toBeLessThanOrEqual(2)
    expect(started).toHaveLength(5)
  })

  it('maxInFlight 为 1 等价于串行（顺序启动、顺序完成）', async () => {
    const started: number[] = []
    const finished: number[] = []
    const hit = await firstSuccess(
      [null, null, 'ok'],
      async (item, index) => {
        started.push(index)
        await sleep(5)
        finished.push(index)
        return item
      },
      { hedgeMs: 1, maxInFlight: 1 }
    )
    expect(hit).toEqual({ result: 'ok', index: 2 })
    expect(started).toEqual([0, 1, 2])
    expect(finished).toEqual([0, 1, 2])
  })

  it('对联调不泄漏未捕获拒绝（run 同步抛错也算落空）', async () => {
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)
    try {
      const hit = await firstSuccess(
        [1, 2],
        (item) => {
          // 非 async 的 worker：同步抛出，firstSuccess 内部必须接住
          throw new Error('sync boom')
        },
        { hedgeMs: 5 }
      )
      expect(hit).toBeNull()
      await sleep(20)
      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

/**
 * 「永不 settle」的候选 —— 独立验证者点出的覆盖缺口。
 *
 * 这些用例钉的是一条**已知的结构性限制**，而不是「这里很健壮」：
 * `firstSuccess` 的收场条件是「所有档都进入终态」，因此只要有任意一档永不 settle，
 * 整体就会永久 pending。这一限制**不是本次改造引入的**（旧的逐档串行实现同样会卡在
 * 停滞的那一档上，实测两版都会挂），对冲反而修复了「停滞档排在前、后档本可成功」这一类。
 *
 * 之所以仍然把它们写成测试：一旦将来有人给 `firstSuccess` 加截止计时器或改成
 * 「不等在途档」，这些用例会立刻变成红灯 —— 它们记录的是**当前契约**，
 * 让契约的变化必须被显式看见，而不是悄悄漂移。
 */
describe('firstSuccess：永不 settle 的候选（记录已知限制）', () => {
  /** 永不 resolve 的 promise */
  const never = () => new Promise<never>(() => {})

  /** 判定「在 ms 内是否 resolve」的 watchdog */
  async function settledWithin<T>(task: Promise<T>, ms: number): Promise<boolean> {
    let done = false
    void task.then(
      () => {
        done = true
      },
      () => {
        done = true
      }
    )
    await sleep(ms)
    return done
  }

  it('任一档永不 settle 时整体不会 resolve（当前契约：无全局截止）', async () => {
    const task = firstSuccess(
      [never(), null, null],
      async (item) => item as unknown as string | null,
      { hedgeMs: 5 }
    )
    expect(await settledWithin(task, 200)).toBe(false)
  })

  it('全部候选永不 settle 时同样不会 resolve', async () => {
    const task = firstSuccess([1, 2], async () => never(), { hedgeMs: 5 })
    expect(await settledWithin(task, 200)).toBe(false)
  })

  it('maxInFlight 卡满且前排永不 settle 时，剩余候选连启动机会都没有', async () => {
    let started = 0
    const task = firstSuccess(
      [1, 2, 3, 4, 5],
      async () => {
        started += 1
        return never()
      },
      { hedgeMs: 5, maxInFlight: 2 }
    )
    expect(await settledWithin(task, 250)).toBe(false)
    // 只有 2 档被启动：槽位被占满，后 3 档既不满足启动条件（inFlight >= maxInFlight），
    // 也不可能有档落空来腾位置 —— 这正是「结构性挂死」的成因。
    expect(started).toBe(2)
  })

  it('对照组：停滞档**落空**（而非永不 settle）时整体能正常收场', async () => {
    // 与上面的区别只有一处：停滞档最终会返回 null。这说明挂死的成因是
    // 「档永不进入终态」，而不是「有档很慢」——后者由对冲窗口覆盖。
    const task = firstSuccess(
      [
        (async () => {
          await sleep(80)
          return null
        })(),
        'ok',
      ],
      async (item) => (item as unknown as string | null),
      { hedgeMs: 10 }
    )
    // 第二档 10ms 就被对冲启动并命中，不必等第一档那 80ms
    await expect(task).resolves.toEqual({ result: 'ok', index: 1 })
  })

  it('对照组：停滞档在前、后档能在窗口内成功时，对冲确实救回了整轮', async () => {
    // 这是对冲相对旧串行实现的实际收益：旧实现会一直等第 0 档。
    const started: number[] = []
    const task = firstSuccess(
      [never(), 'ok'],
      async (item, index) => {
        started.push(index)
        return (item as unknown as string | null)
      },
      { hedgeMs: 30 }
    )
    await expect(task).resolves.toEqual({ result: 'ok', index: 1 })
    expect(started).toEqual([0, 1])
  })
})

describe('mapWithConcurrency：有界并发且保序', () => {
  it('空数组返回空数组，不调用 worker', async () => {
    let calls = 0
    const out = await mapWithConcurrency([], 4, async () => {
      calls += 1
      return 0
    })
    expect(out).toEqual([])
    expect(calls).toBe(0)
  })

  it('结果按入参顺序返回（乱序完成也不改序）', async () => {
    const out = await mapWithConcurrency([50, 5, 25, 1], 4, async (ms, i) => {
      await sleep(ms)
      return i
    })
    expect(out).toEqual([0, 1, 2, 3])
  })

  it('并发数不超过 limit', async () => {
    let live = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async (i) => {
      live += 1
      peak = Math.max(peak, live)
      await sleep(5)
      live -= 1
      return i
    })
    expect(peak).toBe(3)
  })

  it('limit 非法（0 / 负数 / NaN）退化为串行而非丢数据', async () => {
    for (const limit of [0, -3, Number.NaN]) {
      const order: number[] = []
      const out = await mapWithConcurrency([1, 2, 3], limit, async (n) => {
        order.push(n)
        return n * 2
      })
      expect(out).toEqual([2, 4, 6])
      expect(order).toEqual([1, 2, 3])
    }
  })

  it('limit 超过条目数时不做多余调度', async () => {
    const out = await mapWithConcurrency([1, 2], 100, async (n) => n + 1)
    expect(out).toEqual([2, 3])
  })

  it('worker 抛错时整体拒绝（由调用方决定兜底）', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      })
    ).rejects.toThrow('boom')
  })
})