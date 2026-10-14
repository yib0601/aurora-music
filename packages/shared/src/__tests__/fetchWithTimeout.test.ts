import http from 'node:http'
import { getEventListeners } from 'node:events'
import { Readable, Writable, pipeline } from 'node:stream'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import { fetchWithTimeout, isTimeoutError, setCustomFetch, TimeoutError } from '../fetchWithTimeout'
import { expectCode, rejectionOf } from './i18nAssert'

const pipelineAsync = promisify(pipeline)

/**
 * 原始全局 fetch。本文件多处以覆盖 `globalThis.fetch` 的方式模拟底层行为，
 * 必须**逐例恢复**：那些假实现是「永不 resolve 直到 abort」的，一旦残留，
 * 后续任何用真实 fetch 的用例都会在响应头阶段直接超时
 * （新增的读体超时用例首轮即全线踩此坑，表现为 6 例集体失败）。
 */
const realFetch = globalThis.fetch

afterEach(() => {
  setCustomFetch(null)
  globalThis.fetch = realFetch
})

describe('fetchWithTimeout', () => {
  it('优先使用注入的自定义 fetch 实现', async () => {
    const calls: string[] = []
    setCustomFetch(async (input) => {
      calls.push(String(input))
      return new Response('{"ok":true}', { status: 200 })
    })
    const resp = await fetchWithTimeout('https://example.test/api', {}, 1000)
    expect(await resp.json()).toEqual({ ok: true })
    expect(calls).toEqual(['https://example.test/api'])
  })

  it('未注入自定义实现时回落到全局 fetch', async () => {
    const original = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response('ok', { status: 200 })
    }) as typeof fetch
    try {
      const resp = await fetchWithTimeout('https://example.test/fallback', {}, 1000)
      expect(resp.status).toBe(200)
      expect(calls).toEqual(['https://example.test/fallback'])
    } finally {
      globalThis.fetch = original
    }
  })

  it('自定义实现不响应 AbortSignal 时，超时仍以 AbortError 失败', async () => {
    // 模拟原生 HTTP 层忽略 signal 的场景：永不 resolve
    setCustomFetch(() => new Promise<Response>(() => {}))
    await expect(fetchWithTimeout('https://example.test/slow', {}, 30)).rejects.toThrow()
  })

  it('超时抛结构化的 TimeoutError（码 errors.network.timeout），而不是底层 fetch 的英文 AbortError', async () => {
    // 真实场景：本机音源服务慢于超时预算，renderer 的 AbortController 中止请求，
    // 原生 fetch 抛 DOMException('The operation was aborted.', 'AbortError')
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        )
      })
    }) as typeof fetch
    // 文案在产生地只给码 + 参数，中文/英文由显示端按当前语言渲染
    const err = await rejectionOf(fetchWithTimeout('https://example.test/slow', {}, 30))
    expectCode(err, 'errors.network.timeout', { ms: 30 })
    expect(err).toBeInstanceOf(TimeoutError)
    expect((err as Error).name).toBe('TimeoutError')
    expect((err as Error).message).not.toMatch(/aborted/i)
    expect(isTimeoutError(err)).toBe(true)
  })

  it('调用方自己的 signal 中止时原样抛出取消错误，不误报超时', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
        if (init?.signal?.aborted) abort()
        else init?.signal?.addEventListener('abort', abort)
      })
    }) as typeof fetch
    const external = new AbortController()
    const pending = fetchWithTimeout('https://example.test/slow', { signal: external.signal }, 5000)
    external.abort()
    await expect(pending).rejects.toThrow(/aborted/) // 取消语义保留，不等 5s
  })
})

/**
 * 读体阶段的超时（曾经的永久挂死）。
 *
 * 全部走**真实 TCP 服务器**，而不是打桩 fetch。理由：本组要证的正是「底层 socket 到底
 * 有没有被断」，mock 里那个「永不 resolve 的 Promise」根本不持有 socket，
 * 无论实现是否真的 abort 都会「看起来通过」——那就成了自证清白。
 */
describe('fetchWithTimeout：读体超时', () => {
  /** 服务器行为：hang-body = 送完响应头就停住 body；ok = 正常完整响应 */
  type Mode = 'hang-body' | 'ok'

  let server: http.Server
  let port = 0
  const mode: { current: Mode } = { current: 'hang-body' }
  /** 每条连接是否真的被客户端断开（证「socket 断了」而不是只在客户端 reject） */
  const socketClosed: boolean[] = []

  beforeAll(async () => {
    // 用 http.Server 而不是裸 net.Server：裸 TCP 服务器不处理 keep-alive，
    // 第二次请求复用连接时不会再触发 'data'，本组用例会以「响应头阶段超时」的假象失败
    // （实测：裸 net 下第 2~4 次请求均在响应头处就超时，与读体修复无关）。
    server = http.createServer((req, res) => {
      const idx = socketClosed.push(false) - 1
      // 读体超时靠 abort 断连，server 侧会看到 ECONNRESET；默认行为会打 error 到进程
      req.socket.on('close', () => {
        socketClosed[idx] = true
      })
      req.socket.on('error', () => {})
      if (mode.current === 'ok') {
        const body = '{"ok":true}'
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        })
        res.end(body)
        return
      }
      // Content-Length 声称 100 字节，只写 5 字节且**永不 end**：
      // 这正是「响应头到达了、body 永远读不完」的上游行为
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' })
      res.write('{"a":')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    // 挂住的响应会让 server.close 等所有连接结束，主动销毁
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    mode.current = 'hang-body'
    socketClosed.length = 0
  })

  const url = (path = '/') => `http://127.0.0.1:${port}${path}`

  it('上游送完响应头停住 body 时，resp.json() 必须在 timeoutMs 量级内抛 TimeoutError（不再永久挂死）', async () => {
    const TIMEOUT_MS = 400
    const started = Date.now()
    const resp = await fetchWithTimeout(url('/hang'), {}, TIMEOUT_MS)

    // 自证构造有效：响应头确实拿到了（否则测的是另一个阶段，白测）
    expect(resp.ok).toBe(true)
    expect(resp.status).toBe(200)

    const err = await rejectionOf(resp.json())
    const elapsed = Date.now() - started

    expect(err).toBeInstanceOf(TimeoutError)
    expectCode(err, 'errors.network.timeout', { ms: TIMEOUT_MS })
    expect(isTimeoutError(err)).toBe(true)
    // 文案不能是底层 fetch 的英文 AbortError
    expect((err as Error).message).not.toMatch(/aborted/i)
    // 上界给足（CI 抖动），下界防止「立刻失败」这种假通过
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 20)
    expect(elapsed).toBeLessThan(TIMEOUT_MS + 3000)
  })

  it('读体超时真的掐断底层 socket，而不是只在客户端 reject 后把连接挂着', async () => {
    const TIMEOUT_MS = 300
    const resp = await fetchWithTimeout(url('/hang'), {}, TIMEOUT_MS)
    await rejectionOf(resp.json())

    // 自证构造有效：服务器确实接受了连接
    expect(socketClosed.length).toBeGreaterThan(0)

    // abort 到 socket 真正 close 之间有延迟，轮询等待
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && !socketClosed.every(Boolean)) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(socketClosed.every(Boolean)).toBe(true)
  })

  it('text() / arrayBuffer() / blob() 同样受读体超时约束（不止 json）', async () => {
    const TIMEOUT_MS = 250
    for (const read of ['text', 'arrayBuffer', 'blob'] as const) {
      const resp = await fetchWithTimeout(url('/hang'), {}, TIMEOUT_MS)
      const err = await rejectionOf((resp[read] as () => Promise<unknown>)())
      expectCode(err, 'errors.network.timeout', { ms: TIMEOUT_MS })
    }
  })

  it('响应正常完整时行为不变：状态、头、body 都能读，且不再触发读体超时', async () => {
    mode.current = 'ok'
    const resp = await fetchWithTimeout(url('/ok'), {}, 300)
    // 次要属性必须保留：实现用 `new Response(stream, resp)` 重建了响应对象，
    // 而那一步会丢掉 url / type / redirected（实测：url 变空串），故显式补回
    expect(resp.status).toBe(200)
    expect(resp.ok).toBe(true)
    expect(resp.url).toBe(url('/ok'))
    expect(resp.headers.get('content-type')).toBe('application/json')
    expect(resp.body).toBeTruthy()

    // 读到的是真内容；且等过一个超时窗口后不应冒出迟到的异常
    expect(await resp.json()).toEqual({ ok: true })
    await new Promise((r) => setTimeout(r, 400))
  })

  it('读体成功后会撤掉读体计时器，不影响后续（bodyUsed 语义保留）', async () => {
    mode.current = 'ok'
    const resp = await fetchWithTimeout(url('/ok'), {}, 300)
    expect(await resp.json()).toEqual({ ok: true })
    expect(resp.bodyUsed).toBe(true)
    // 读完再读一次：原生语义是抛「body already read」，不能被我们的包装吞成超时
    await expect(resp.json()).rejects.toThrow()
  })

  it('调用方 signal 在读体阶段中止时原样透传取消语义，不误报超时', async () => {
    const external = new AbortController()
    const resp = await fetchWithTimeout(url('/hang'), { signal: external.signal }, 5000)
    const pending = resp.json()
    setTimeout(() => external.abort(new DOMException('canceled by user', 'AbortError')), 100)
    const err = await rejectionOf(pending)
    expect(isTimeoutError(err) === false || (err as Error).name === 'AbortError').toBe(true)
    // 关键：不能变成我们自己的 TimeoutError（那是把用户主动取消误报成网络超时）
    expect((err as Error).name).not.toBe('TimeoutError')
  })

  it('响应头阶段超时仍按原语义在 fetchWithTimeout 处失败（未被读体阶段改变）', async () => {
    // 服务器接受连接但完全不回响应头
    const silent = http.createServer(() => {})
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const silentPort = (silent.address() as AddressInfo).port
    try {
      const err = await rejectionOf(
        fetchWithTimeout(`http://127.0.0.1:${silentPort}/`, {}, 300)
      )
      expectCode(err, 'errors.network.timeout', { ms: 300 })
    } finally {
      silent.closeAllConnections?.()
      await new Promise<void>((resolve) => silent.close(() => resolve()))
    }
  })

  it('未读的响应在预算到点后会摘掉调用方 signal 上的监听（长跑进程不累积）', async () => {
    // AbortSignal 上没有 listenerCount（实测 undefined），必须用 node:events 的
    // getEventListeners —— 否则 `?.() ?? 0` 会让断言恒成立，变成一条永远为绿的假测试。
    const listeners = () => getEventListeners(external.signal, 'abort').length
    const external = new AbortController()

    // 自证测量手段有效：手动挂一个监听必须被数出来，否则下面的断言毫无意义
    const probe = () => {}
    external.signal.addEventListener('abort', probe)
    expect(listeners()).toBe(1)
    external.signal.removeEventListener('abort', probe)
    expect(listeners()).toBe(0)

    // ⚠️ 口径说明（我曾把这理解错过一次）：`new Response(stream, ...)` 构造时会**预取一次**
    // 流，于是「读端开口」的钩子会立刻触发，监听随即挂上。所以**在途期间**监听数是
    // 「未读完的响应数」，不是 0 —— 这是必要的：停滞的 body 下 pull 会一直 await，
    // 此时若没人接取消，调用方中止就永远等不到结论（正是要修的那类挂死）。
    // 真正该保证的是「预算到点后必须摘干净、且多轮不累积」。
    const TIMEOUT_MS = 300
    const peakPerRound: number[] = []
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) {
        const resp = await fetchWithTimeout(url('/hang'), { signal: external.signal }, TIMEOUT_MS)
        // 只读状态、不读体 —— 这是真实存在的用法（调用方只看 resp.ok / resp.status）
        expect(resp.status).toBe(200)
      }
      peakPerRound.push(listeners())
      // 等过预算：到点必须摘干净
      await new Promise((r) => setTimeout(r, TIMEOUT_MS + 250))
      expect(listeners()).toBe(0)
    }

    // 多轮之间峰值不应增长（若每轮都留下垃圾，峰值会随之抬升）
    const first = peakPerRound[0]
    for (const p of peakPerRound) expect(p).toBeLessThanOrEqual(first)
  }, 20000)

  it('响应头到手后闲置一段时间再读，只要没超预算就能成功（未退化成 deadline 语义）', async () => {
    mode.current = 'ok'
    const TIMEOUT_MS = 500
    const resp = await fetchWithTimeout(url('/ok'), {}, TIMEOUT_MS)
    // 返回时就会武装预算，但**开始读体时会重置为完整一份**。
    // 这里拖延 250ms（不到预算）再读：若计时器不重置、按「响应头到手起算」递减，
    // 就变成 deadline 语义 —— 那是刻意的拒绝项（NAS 慢响应头 + 大文件会被误杀）。
    await new Promise((r) => setTimeout(r, TIMEOUT_MS - 250))
    expect(await resp.json()).toEqual({ ok: true })
  })

  it('clone() 与 resp.body 裸流读取同样受预算约束（不再逃逸，实测会 timeout）', async () => {
    // 实现是「包装底层 body 流」：Response 内部消费的就是包装后的流，
    // 于是 clone / 裸流读 / Readable.fromWeb 全部走同一条受保护的管道，
    // 不需要给四条路径分别做方法覆盖。
    // 这是修掉的一个真实缺口：更早的实现逐个覆盖 json/text/arrayBuffer/blob，
    // clone 与裸流读完全绕过约束（实测挂死）。
    const TIMEOUT_MS = 300
    const HANG_PROBE_MS = TIMEOUT_MS + 1500

    const respA = await fetchWithTimeout(url('/hang'), {}, TIMEOUT_MS)
    const cloneOutcome = await Promise.race([
      respA.clone().json().then(
        () => 'resolved',
        (e) => `rejected:${(e as Error).name}`
      ),
      new Promise<string>((r) => setTimeout(() => r('hung'), HANG_PROBE_MS)),
    ])
    expect(cloneOutcome).toBe('rejected:TimeoutError')

    const respB = await fetchWithTimeout(url('/hang'), {}, TIMEOUT_MS)
    const streamOutcome = await Promise.race([
      (async () => {
        const reader = respB.body!.getReader()
        for (;;) {
          const { done } = await reader.read()
          if (done) return 'done'
        }
      })().then(
        () => 'done',
        (e) => `rejected:${(e as Error).name}`
      ),
      new Promise<string>((r) => setTimeout(() => r('hung'), HANG_PROBE_MS)),
    ])
    expect(streamOutcome).toBe('rejected:TimeoutError')

    // 反向对照：受覆盖的读方法在同一窗口内也必须收敛，
    // 否则上面两条不能归因于「预算生效」，可能只是环境问题
    const respC = await fetchWithTimeout(url('/hang'), {}, TIMEOUT_MS)
    const coveredOutcome = await Promise.race([
      respC.json().then(
        () => 'resolved',
        (e) => `rejected:${(e as Error).name}`
      ),
      new Promise<string>((r) => setTimeout(() => r('hung'), HANG_PROBE_MS)),
    ])
    expect(coveredOutcome).toBe('rejected:TimeoutError')
  }, 20000)

  it('拿到响应头后始终不读体：预算到点也会释放连接（不再挂到 keep-alive 超时）', async () => {
    // 这条对应「调用方只看 resp.ok / resp.status 就返回」的真实用法。
    // 旧（惰性武装）实现下计时器从未建立 ⇒ 没人 abort ⇒ socket 一直挂着。
    //
    // 观测面用 socket 的 **close 事件**而不是 `socket.destroyed` 标志：
    // 客户端中止后服务端侧先收到 FIN/RST，`destroyed` 的置位时机取决于 Node 内部
    // 收尾（实测：改成流包装后 close 已在 ~1.2s 触发，但该标志并未同步置位，
    // 于是断言会假红）。close 事件才是「连接确实被释放」的可靠证据。
    let closed = false
    let accepted = 0
    const dedicated = http.createServer((req, res) => {
      req.socket.on('error', () => {})
      req.socket.on('close', () => {
        closed = true
      })
      req.resume()
      accepted++
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' })
      res.write('{"a":')
    })
    await new Promise<void>((r) => dedicated.listen(0, '127.0.0.1', r))
    const dedicatedPort = (dedicated.address() as AddressInfo).port
    try {
      const TIMEOUT_MS = 300
      const resp = await fetchWithTimeout(`http://127.0.0.1:${dedicatedPort}/x`, {}, TIMEOUT_MS)
      // 自证构造有效：响应头到手了，且此刻连接是活的
      expect(resp.status).toBe(200)
      expect(accepted).toBe(1)
      expect(closed).toBe(false)

      const deadline = Date.now() + 3000
      while (Date.now() < deadline && !closed) {
        await new Promise((r) => setTimeout(r, 25))
      }
      expect(closed).toBe(true)
    } finally {
      dedicated.closeAllConnections?.()
      await new Promise<void>((r) => dedicated.close(() => r()))
    }
  }, 20000)

  it('读体开始**之前**被取消时立刻失败（不留给忽略 signal 的底层实现挂死）', async () => {
    // 复现过的真漏洞：external 在「响应头已到手、还没开始读体」这段窗口里中止时，
    // 响应头阶段的监听已随 cleanupHeader 摘除，读体阶段的监听又还没挂上。
    // 那时若不 abort 只想等计时器，而底层实现忽略 signal（移动端 CapacitorHttp 正是），
    // 就会**永久挂起**（实测复现过 HUNG）。
    //
    // 构造要点：必须给出**真实的 body 流**（而不是 `body: null`）——
    // 无 body 的响应走 withBodyTimeout 的另一条分支，测不到读体路径；
    // 而这个流永不产出数据，正是「读体一开始就停滞」的等价物。
    const neverEndingBody = new ReadableStream<Uint8Array>({
      start() {
        /* 永不 enqueue、永不 close：模拟停滞的 body */
      },
    })
    setCustomFetch(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          body: neverEndingBody,
        }) as unknown as Response
    )

    const external = new AbortController()
    // 预算给得很大：这样「立刻失败」只可能来自取消，而不是超时到点
    const resp = await fetchWithTimeout('https://example.test/x', { signal: external.signal }, 20000)
    // 自证构造有效：响应头确实拿到了，且此刻尚未被取消
    expect(resp.status).toBe(200)
    external.abort(new DOMException('user canceled the page', 'AbortError'))

    const outcome = await Promise.race([
      resp.text().then(
        () => 'resolved',
        (e) => `rejected:${(e as Error).name}`
      ),
      // 该窗口远小于 20000ms 预算：只要不是立刻失败，就说明落进了挂死
      new Promise<string>((r) => setTimeout(() => r('hung'), 1500)),
    ])
    // 立刻失败（取消语义），而不是干等超时、更不是挂死
    expect(outcome).toBe('rejected:AbortError')
  }, 20000)
})

/**
 * 停滞（idle）语义：这是本轮修掉的一个**我自己引入的回归**。
 *
 * 早先的实现把读体预算当作「读完整个 body 的总时长上限」，实测会误杀
 * 「上游一直在供数、只是总量大」的正常传输（分片流动 1200ms 撞 500ms 预算）。
 * 真实调用点里 `openWebdavRange`（服务器忽略 Range 时会回整个文件，预算 30s）
 * 与 `fetchLxScript`（允许 4MB）都可能撞上。
 *
 * 正确语义：**有数据流动就不算超时，只有供数中断才失败**。
 * 这也正是要解决的场景——上游送完响应头就停住 body（停滞），而不是上游慢慢传（变慢）。
 */
describe('fetchWithTimeout：停滞（idle）语义', () => {
  /** 按给定节奏分片发送的服务器：每片间隔 intervalMs，共 chunks 片 */
  async function chunkedServer(chunks: number, intervalMs: number): Promise<{ server: http.Server; port: number }> {
    const server = http.createServer((req, res) => {
      req.socket.on('error', () => {})
      req.resume()
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(chunks * 10),
      })
      let sent = 0
      const timer = setInterval(() => {
        if (sent++ >= chunks) {
          clearInterval(timer)
          res.end()
          return
        }
        res.write('1234567890')
      }, intervalMs)
      res.on('close', () => clearInterval(timer))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    return { server, port: (server.address() as AddressInfo).port }
  }

  it('body 持续流动但总时长超过预算时**不**报超时（这是 idle 而非总时长上限）', async () => {
    const BUDGET = 400
    // 8 片 × 150ms ≈ 1200ms，远超 400ms 预算；但每片间隔都短于预算
    const { server, port } = await chunkedServer(8, 150)
    try {
      const resp = await fetchWithTimeout(`http://127.0.0.1:${port}/slow`, {}, BUDGET)
      const started = Date.now()
      const body = await resp.text()
      const elapsed = Date.now() - started
      // 关键断言：读到了完整内容，且耗时明显超过预算 —— 若语义是总时长上限，这里会抛
      expect(body.length).toBe(80)
      expect(elapsed).toBeGreaterThan(BUDGET)
    } finally {
      server.closeAllConnections?.()
      await new Promise<void>((r) => server.close(() => r()))
    }
  }, 20000)

  it('**背压**不误杀：上游一次送完、消费者停读（真实背压）仍成功', async () => {
    // 这条是本轮修掉的第二个自己引入的回归，**构造必须是真的背压**。
    //
    // 反面教材（我第一版就是这么写的，被外部复核证伪）：用手动 `getReader()` +
    // `sleep(120ms)` 而预算 500ms。那样每个 read 都会立刻腾空队列、马上触发下一次
    // pull，旧实现里 `armStall()` 被**不断续期**、计时器永不触发 —— 于是把实现换回
    // 有 bug 的旧版，这条用例**依然全绿**，等于没测。实测确认：
    //   （旧 bug 版）sleep=120(<预算) ⇒ ok；sleep=700(>预算) ⇒ TimeoutError
    // 也就是说「sleep 小于预算」时旧 bug 根本不显形。
    //
    // 真背压的定义是**消费者停止读取**：管道下游慢 ⇒ 内部队列填满 ⇒ pull 长时间
    // 不再发生 ⇒ 旧实现在「无人等上游」的空档里依然跑计时器 ⇒ 误杀。
    // 因此这里用 `pipeline(Readable.fromWeb(...), 慢 Writable)`，与真实调用形态一致
    // （`mediaCache.ts` / `handlers.ts` 就是 pipeline 到慢磁盘）。
    //
    // 为什么「间隔 > 预算」才有效：每次 read 都会腾空担保队列、立刻触发下一次 pull，
    // 于是旧实现里 `armStall()` 被**重置**；只有「两次 pull 之间的空档本身超过预算」时，
    // 那个永不撤销的计时器才会到期 —— 这正是旧 bug 的显形条件。
    // 改参数前请先跑一次旧实现确认本用例会红，否则鉴别力会静默消失。
    // ⚠️ 有鉴别力的**必要条件只有一个**：**两次 pull 之间的空档 > 预算**。
    // 实测标定（判据：把实现换回引入该 bug 的历史版本，本用例应变红）：
    //   pipeline + 间隔 400ms(>预算) ⇒ 旧版 err      ✅ 有鉴别力
    //   pipeline + 间隔 120ms(<预算) ⇒ 旧版 ok       ❌ 无（我第一版就踩了这个坑）
    //   手动 getReader + sleep 400ms(>预算) ⇒ 旧版 err ✅ 同样有鉴别力
    // 即**并非「必须用 pipeline」**——手动读只要间隔够长也一样能测。
    // 本文用 pipeline 是因为它贴合真实调用形态（mediaCache / handlers 就是 pipeline 到慢盘）。
    //
    // 另外：这个「慢消费 + 连接空闲」组合偶发会撞上 undici 既有行为
    // （`TypeError: terminated` / `other side closed`）。实测**原生 fetch 零包装也复现**，
    // 且与总时长**非单调**（1MB/600ms 失败、4MB/400ms 反而成功），故不归因本包装层。
    // 这里把规模压到 256KB（约 2s）是工程取舍，不是存在什么「时长阈值」。
    const BUDGET = 300
    const SIZE = 256 * 1024
    const WRITE_DELAY_MS = 400
    const server = http.createServer((req, res) => {
      req.socket.on('error', () => {})
      req.resume()
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(SIZE) })
      // 一次送完全部：上游零停滞
      res.end(Buffer.alloc(SIZE, 7))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    try {
      const resp = await fetchWithTimeout(`http://127.0.0.1:${port}/big`, {}, BUDGET)
      let got = 0
      const started = Date.now()
      // 慢 Writable：写入侧每次 120ms，highWaterMark 压小以尽快形成背压
      await pipelineAsync(
        Readable.fromWeb(resp.body as never),
        new Writable({
          highWaterMark: 16 * 1024,
          write(chunk: Buffer, _enc, cb) {
            got += chunk.length
            setTimeout(cb, WRITE_DELAY_MS)
          },
        })
      )
      const elapsed = Date.now() - started
      // 关键断言：字节一个不少，且总耗时远超预算（上游没停过，不该被判超时）
      expect(got).toBe(SIZE)
      expect(elapsed).toBeGreaterThan(BUDGET)
    } finally {
      server.closeAllConnections?.()
      await new Promise<void>((r) => server.close(() => r()))
    }
  }, 30000)

  it('两点之间停住超过预算时报超时（停滞才失败）', async () => {
    const BUDGET = 300
    // 只在开头送一片，之后永不 end：首片之后即停滞
    const server = http.createServer((req, res) => {
      req.socket.on('error', () => {})
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' })
      res.write('1234567890')
      // 之后不发任何数据，也不 end
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    try {
      const resp = await fetchWithTimeout(`http://127.0.0.1:${port}/stall`, {}, BUDGET)
      const started = Date.now()
      const err = await rejectionOf(resp.text())
      const elapsed = Date.now() - started
      expectCode(err, 'errors.network.timeout', { ms: BUDGET })
      // 从「最后一次有数据」起算：首片几乎立即写入，所以总耗时约等于预算
      expect(elapsed).toBeGreaterThanOrEqual(BUDGET - 50)
      expect(elapsed).toBeLessThan(BUDGET + 3000)
    } finally {
      server.closeAllConnections?.()
      await new Promise<void>((r) => server.close(() => r()))
    }
  }, 20000)
})

/**
 * 包装流引入后的**语义等价性**自查项。
 *
 * 实现从「覆盖读方法」换成「包装底层 body 流」后，多了一层读-写转发。
 * 这组用例把最容易因转发而改变的原生语义固定下来，避免日后回归：
 * clone 的双分支、重复读的 TypeError、并发互不干扰、无 body 响应。
 */
describe('fetchWithTimeout：包装流下的语义等价性', () => {
  let server: http.Server
  let port = 0

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.socket.on('error', () => {})
      req.resume()
      if (req.url === '/204') {
        res.writeHead(204)
        res.end()
        return
      }
      if (req.url === '/stall') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' })
        res.write('{"a":')
        return
      }
      const body = JSON.stringify({ v: 42, path: req.url })
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      })
      res.end(body)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    server.closeAllConnections?.()
    await new Promise<void>((r) => server.close(() => r()))
  })

  const u = (p: string) => `http://127.0.0.1:${port}${p}`

  it('clone() 的两个分支能各自读到完整内容', async () => {
    const resp = await fetchWithTimeout(u('/x'), {}, 2000)
    const cloned = resp.clone()
    const [a, b] = await Promise.all([resp.json(), cloned.json()])
    expect(a).toEqual({ v: 42, path: '/x' })
    expect(b).toEqual({ v: 42, path: '/x' })
  })

  it('读完一次再读第二次抛 TypeError（与原生 bodyUsed 语义一致，不能被包装吞成超时）', async () => {
    const resp = await fetchWithTimeout(u('/y'), {}, 2000)
    await resp.json()
    expect(resp.bodyUsed).toBe(true)
    const err = await rejectionOf(resp.json())
    expect((err as Error).name).toBe('TypeError')
  })

  it('并发请求互不干扰：停滞的不会拖累正常请求', async () => {
    const started = Date.now()
    const settled = await Promise.allSettled([
      fetchWithTimeout(u('/a'), {}, 800).then((r) => r.json()),
      fetchWithTimeout(u('/b'), {}, 800).then((r) => r.json()),
      fetchWithTimeout(u('/c'), {}, 800).then((r) => r.json()),
      fetchWithTimeout(u('/stall'), {}, 300).then((r) => r.json()),
      fetchWithTimeout(u('/stall'), {}, 300).then((r) => r.json()),
    ])
    const elapsed = Date.now() - started
    const ok = settled.filter((s) => s.status === 'fulfilled')
    const bad = settled.filter((s) => s.status === 'rejected')
    expect(ok).toHaveLength(3)
    expect(bad).toHaveLength(2)
    for (const s of bad) expect((s as PromiseRejectedResult).reason).toBeInstanceOf(TimeoutError)
    // 三个正常请求各自的 800ms 预算不该被停滞请求串起来等
    expect(elapsed).toBeLessThan(2000)
  }, 20000)

  it('无 body 的 204 响应正常返回，text() 给空串（走 !resp.body 分支）', async () => {
    const resp = await fetchWithTimeout(u('/204'), {}, 500)
    expect(resp.status).toBe(204)
    expect(resp.body).toBeNull()
    expect(await resp.text()).toBe('')
  })
})
