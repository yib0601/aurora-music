import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { openSandbox, sandboxSupported } from '../sandbox'

/**
 * Worker 沙箱的测试。
 *
 * ## 这里能测什么、不能测什么
 *
 * Node 环境没有真正的 `Worker`/`Blob`，所以**协议与终止语义用桩验证**：
 * 核心契约是"任何路径都必须 terminate()，且调用方不会永久挂起"——
 * 那恰恰是可以用假 Worker 精确断言的。
 *
 * 真实脚本执行（遮蔽是否正确、死循环是否真被打断）需要浏览器环境，
 * 属于 `docs/development.md` 里"需要真实运行时"的那类验证，不在单测覆盖范围内。
 * 这一点必须如实写明，否则会给人"死循环已经测过了"的错觉。
 */

/** 假 Worker：记录收到的消息与 terminate 次数 */
function fakeWorkerFactory() {
  const sent: unknown[] = []
  let terminated = 0
  let onmessage: ((event: MessageEvent) => void) | null = null
  let onerror: ((event: ErrorEvent) => void) | null = null

  const worker = {
    postMessage: (msg: unknown) => {
      sent.push(msg)
    },
    terminate: () => {
      terminated += 1
    },
    set onmessage(handler: ((event: MessageEvent) => void) | null) {
      onmessage = handler
    },
    get onmessage() {
      return onmessage
    },
    set onerror(handler: ((event: ErrorEvent) => void) | null) {
      onerror = handler
    },
    get onerror() {
      return onerror
    },
  }

  return {
    worker,
    sent,
    terminated: () => terminated,
    /** 模拟 Worker 回消息 */
    emit: (data: unknown) => onmessage?.({ data } as MessageEvent),
    fail: (message: string) => onerror?.({ message } as ErrorEvent),
  }
}

let fake: ReturnType<typeof fakeWorkerFactory>

beforeEach(() => {
  fake = fakeWorkerFactory()
  // 桩掉全局 Worker / Blob / URL.createObjectURL
  vi.stubGlobal('Worker', function Worker() {
    return fake.worker
  })
  vi.stubGlobal('Blob', function Blob() {
    return { size: 1 }
  })
  vi.stubGlobal('URL', {
    createObjectURL: () => 'blob:fake',
    revokeObjectURL: () => {},
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 启动一个会话，并在微任务里模拟 Worker 回 inited */
async function openWithInspection(inspection: unknown) {
  const promise = openSandbox({
    script: 'lx.on("request", () => {})',
    request: () => {},
    scriptTimeoutMs: 50,
  })
  // 让 openSandbox 先挂上 onmessage 并 postMessage
  await Promise.resolve()
  fake.emit({ type: 'inited', inspection })
  return promise
}

describe('sandboxSupported：能力探测', () => {
  it('有 Worker 与 Blob 时为 true', () => {
    expect(sandboxSupported()).toBe(true)
  })

  it('缺 Worker 时为 false（调用方据此回落 lxHost）', () => {
    vi.stubGlobal('Worker', undefined)
    expect(sandboxSupported()).toBe(false)
  })
})

describe('启动：把脚本交给 Worker', () => {
  it('postMessage 一条 run 指令，携带脚本', async () => {
    const session = await openWithInspection({ ok: true, platforms: {} })
    const run = fake.sent.find((msg) => (msg as { type?: string }).type === 'run') as {
      script: string
    }
    expect(run.script).toContain('lx.on')
    session.dispose()
  })

  it('inited 结果原样返回给调用方', async () => {
    const inspection = {
      ok: true,
      platforms: { kw: { actions: ['musicUrl'], qualitys: ['128k'] } },
    }
    const session = await openWithInspection(inspection)
    expect(session.inspection).toEqual(inspection)
    session.dispose()
  })
})

describe('超时必须强制 terminate（本模块存在的全部理由）', () => {
  it('脚本超时 → inspection.ok=false 且 Worker 被 terminate', async () => {
    const promise = openSandbox({
      script: 'while(true){}',
      request: () => {},
      scriptTimeoutMs: 20,
    })
    // 故意不 emit inited：模拟脚本卡在同步死循环里
    const session = await promise

    expect(session.inspection.ok).toBe(false)
    expect(session.inspection.error).toContain('timed out')
    // 关键断言：Worker 确实被终止了（否则脚本会一直转）
    expect(fake.terminated()).toBe(1)
    session.dispose()
  })

  it('超时后调 call 会抛错（不挂起调用方）', async () => {
    const session = await openSandbox({ script: 'x', request: () => {}, scriptTimeoutMs: 10 })
    await expect(session.call('kw', 'musicUrl', {})).rejects.toThrow()
    session.dispose()
  })

  it('正常完成也要 terminate（不 terminate 的 Worker 会一直占资源）', async () => {
    const session = await openWithInspection({ ok: true, platforms: {} })
    session.dispose()
    expect(fake.terminated()).toBe(1)
  })

  it('dispose 是幂等的（重复调用不多次 terminate）', async () => {
    const session = await openWithInspection({ ok: true, platforms: {} })
    session.dispose()
    session.dispose()
    expect(fake.terminated()).toBe(1)
  })
})

describe('脚本失败：明确收场而不是挂起', () => {
  it('inited.ok=false 时会话可用但 call 抛错', async () => {
    const session = await openWithInspection({ ok: false, error: 'Script error', platforms: {} })
    expect(session.inspection.ok).toBe(false)
    await expect(session.call('kw', 'musicUrl', {})).rejects.toThrow()
    session.dispose()
  })

  it('Worker 抛未捕获异常 → ok=false 且 terminate', async () => {
    const promise = openSandbox({ script: 'x', request: () => {}, scriptTimeoutMs: 100 })
    await Promise.resolve()
    fake.fail('uncaught error')
    const session = await promise
    expect(session.inspection.ok).toBe(false)
    expect(session.inspection.error).toContain('uncaught')
    expect(fake.terminated()).toBe(1)
    session.dispose()
  })
})

describe('请求代发：脚本的请求转发给主线程（CapacitorHttp）', () => {
  it('Worker 发 request → 调用注入的 request 实现 → 回 response', async () => {
    const calls: Array<{ url: string; options: unknown }> = []
    const request = vi.fn(
      (url: string, options: Record<string, unknown>, callback: (err: unknown, resp: Record<string, unknown> | null) => void) => {
        calls.push({ url, options })
        // 模拟主线程拿到响应
        callback(null, { statusCode: 200, body: { ok: true } })
      }
    )

    const promise = openSandbox({ script: 'x', request, scriptTimeoutMs: 100 })
    await Promise.resolve()
    fake.emit({ type: 'inited', inspection: { ok: true, platforms: {} } })
    const session = await promise

    fake.emit({ type: 'request', id: 7, url: 'https://api.example.com/x', options: { method: 'GET' } })
    // 让回调跑完
    await Promise.resolve()

    expect(calls).toEqual([{ url: 'https://api.example.com/x', options: { method: 'GET' } }])
    // 回应被 postMessage 回 Worker
    const response = fake.sent.find((msg) => (msg as { type?: string }).type === 'response') as {
      id: number
      resp: unknown
    }
    expect(response.id).toBe(7)
    expect(response.resp).toEqual({ statusCode: 200, body: { ok: true } })
    session.dispose()
  })

  it('请求失败时回 err（脚本据此判错）', async () => {
    const request = vi.fn(
      (
        _url: string,
        _options: Record<string, unknown>,
        callback: (err: unknown, resp: Record<string, unknown> | null) => void
      ) => {
        callback('network down', null)
      }
    )
    const promise = openSandbox({ script: 'x', request, scriptTimeoutMs: 100 })
    await Promise.resolve()
    fake.emit({ type: 'inited', inspection: { ok: true, platforms: {} } })
    const session = await promise

    fake.emit({ type: 'request', id: 3, url: 'https://x/y', options: {} })
    await Promise.resolve()

    const response = fake.sent.find((msg) => (msg as { type?: string }).type === 'response') as {
      err: string
    }
    expect(response.err).toBe('network down')
    session.dispose()
  })
})

describe('call：取结果与超时', () => {
  it('正常取到结果', async () => {
    const promise = openSandbox({ script: 'x', request: () => {}, scriptTimeoutMs: 100, callTimeoutMs: 100 })
    await Promise.resolve()
    fake.emit({ type: 'inited', inspection: { ok: true, platforms: {} } })
    const session = await promise

    const callPromise = session.call('kw', 'musicUrl', { name: 'A' })
    await Promise.resolve()
    // 找到 call 指令的 id 并回结果
    const call = fake.sent.find((msg) => (msg as { type?: string }).type === 'call') as { id: number }
    fake.emit({ type: 'callResult', id: call.id, ok: true, value: 'https://a/1.mp3' })

    expect(await callPromise).toBe('https://a/1.mp3')
    session.dispose()
  })

  it('脚本回失败 → 抛错（不带结果）', async () => {
    const promise = openSandbox({ script: 'x', request: () => {}, scriptTimeoutMs: 100, callTimeoutMs: 100 })
    await Promise.resolve()
    fake.emit({ type: 'inited', inspection: { ok: true, platforms: {} } })
    const session = await promise

    const callPromise = session.call('kw', 'musicUrl', {})
    await Promise.resolve()
    const call = fake.sent.find((msg) => (msg as { type?: string }).type === 'call') as { id: number }
    fake.emit({ type: 'callResult', id: call.id, ok: false, message: 'no url' })

    await expect(callPromise).rejects.toThrow('no url')
    session.dispose()
  })

  it('call 超时 → 抛错并 terminate（回调永不 settle 时不挂起）', async () => {
    const promise = openSandbox({ script: 'x', request: () => {}, scriptTimeoutMs: 100, callTimeoutMs: 20 })
    await Promise.resolve()
    fake.emit({ type: 'inited', inspection: { ok: true, platforms: {} } })
    const session = await promise

    const callPromise = session.call('kw', 'musicUrl', {})
    await expect(callPromise).rejects.toThrow(/timed out/)
    expect(fake.terminated()).toBe(1)
    session.dispose()
  })

  it('dispose 后 call 抛错（不静默返回）', async () => {
    const session = await openWithInspection({ ok: true, platforms: {} })
    session.dispose()
    await expect(session.call('kw', 'musicUrl', {})).rejects.toThrow()
  })

  it('dispose 时还在飞的 call 被落地（不永久挂起）', async () => {
    const promise = openSandbox({ script: 'x', request: () => {}, scriptTimeoutMs: 100, callTimeoutMs: 5000 })
    await Promise.resolve()
    fake.emit({ type: 'inited', inspection: { ok: true, platforms: {} } })
    const session = await promise

    const callPromise = session.call('kw', 'musicUrl', {})
    session.dispose()
    await expect(callPromise).rejects.toThrow(/disposed/)
  })
})
