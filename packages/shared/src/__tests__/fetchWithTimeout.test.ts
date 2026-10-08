import { fetchWithTimeout, isTimeoutError, setCustomFetch, TimeoutError } from '../fetchWithTimeout'

describe('fetchWithTimeout', () => {
  afterEach(() => setCustomFetch(null))

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

  it('超时抛中文 TimeoutError，而不是底层 fetch 的英文 AbortError', async () => {
    // 真实场景：本机音源服务慢于超时预算，renderer 的 AbortController 中止请求，
    // 原生 fetch 抛 DOMException('The operation was aborted.', 'AbortError')
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        )
      })
    }) as typeof fetch
    await expect(fetchWithTimeout('https://example.test/slow', {}, 30)).rejects.toThrow('请求超时（30ms）')
    try {
      await fetchWithTimeout('https://example.test/slow', {}, 30)
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError)
      expect((err as Error).name).toBe('TimeoutError')
      expect((err as Error).message).not.toMatch(/aborted/i)
      expect(isTimeoutError(err)).toBe(true)
    }
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
