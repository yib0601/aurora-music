import http from 'node:http'
import { getEventListeners } from 'node:events'
import type { AddressInfo } from 'node:net'
import { fetchWithTimeout, isTimeoutError, setCustomFetch, TimeoutError } from '../fetchWithTimeout'
import { expectCode, rejectionOf } from './i18nAssert'

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
    // 保留原 Response 的次要属性（就地覆盖读方法而不是重建对象，正是为了这些）
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

  it('拿到 Response 却不读体时，不会在调用方 signal 上留下监听器（长跑进程不累积）', async () => {
    const external = new AbortController()
    // AbortSignal 上没有 listenerCount（实测 undefined），必须用 node:events 的
    // getEventListeners —— 否则 `?.() ?? 0` 会让断言恒成立，变成一条永远为绿的假测试。
    const listeners = () => getEventListeners(external.signal, 'abort').length

    // 自证测量手段有效：手动挂一个监听必须被数出来，否则下面的 0 毫无意义
    const probe = () => {}
    external.signal.addEventListener('abort', probe)
    expect(listeners()).toBe(1)
    external.signal.removeEventListener('abort', probe)
    expect(listeners()).toBe(0)

    for (let i = 0; i < 5; i++) {
      const resp = await fetchWithTimeout(url('/hang'), { signal: external.signal }, 5000)
      // 只读状态、不读体 —— 这是真实存在的用法（调用方只看 resp.ok / resp.status）
      expect(resp.status).toBe(200)
    }
    // 每个未读响应都挂一个监听的话，这里会是 5
    expect(listeners()).toBe(0)
  })

  it('读体预算从「开始读」起算，而不是从响应头到达起算', async () => {
    mode.current = 'ok'
    const TIMEOUT_MS = 500
    const resp = await fetchWithTimeout(url('/ok'), {}, TIMEOUT_MS)
    // 故意拖延超过一个超时窗口再读：若预算在返回时就武装，这里会误报超时
    await new Promise((r) => setTimeout(r, TIMEOUT_MS + 300))
    expect(await resp.json()).toEqual({ ok: true })
  })

  it('已知契约：clone() 与 resp.body 裸流读取**逃逸**读体预算（不是「也会超时」）', async () => {
    // 这条钉住一个我一开始写反、外部复核抓出来的事实。
    // 我当时的错误推理：「计时器 abort 断掉底层 socket，共享同一条流的 clone 自然也失败」
    // ——不成立。惰性武装意味着**没人调用被覆盖的读方法时计时器从未建立**，
    // 压根没有 abort 发生，于是 clone 和裸流都会挂到上游自然结束为止。
    //
    // 这个文件存在的意义就是把「四方法以外不受约束」写成显式接口契约：
    // 当前仓库没有这两类消费点（下载路径用全局原生 fetch），所以不是现存缺陷，
    // 但新增调用方若绕过 json/text/arrayBuffer/blob，就会重新掉进永久挂起的坑。
    const TIMEOUT_MS = 300
    const HANG_PROBE_MS = TIMEOUT_MS + 1200

    const respA = await fetchWithTimeout(url('/hang'), {}, TIMEOUT_MS)
    const cloneOutcome = await Promise.race([
      respA.clone().json().then(() => 'settled').catch(() => 'settled'),
      new Promise<string>((r) => setTimeout(() => r('hung'), HANG_PROBE_MS)),
    ])
    expect(cloneOutcome).toBe('hung')

    const respB = await fetchWithTimeout(url('/hang'), {}, TIMEOUT_MS)
    const streamOutcome = await Promise.race([
      (async () => {
        const reader = respB.body!.getReader()
        for (;;) {
          const { done } = await reader.read()
          if (done) return 'settled'
        }
      })().catch(() => 'settled'),
      new Promise<string>((r) => setTimeout(() => r('hung'), HANG_PROBE_MS)),
    ])
    expect(streamOutcome).toBe('hung')

    // 反向对照：受覆盖的读方法在同一窗口内**确实**会收敛，
    // 否则上面两条「hung」可能只是上游/环境问题，而不是「逃逸」的证据
    const respC = await fetchWithTimeout(url('/hang'), {}, TIMEOUT_MS)
    const coveredOutcome = await Promise.race([
      respC.json().then(() => 'settled').catch(() => 'settled'),
      new Promise<string>((r) => setTimeout(() => r('hung'), HANG_PROBE_MS)),
    ])
    expect(coveredOutcome).toBe('settled')
  }, 20000)
})
