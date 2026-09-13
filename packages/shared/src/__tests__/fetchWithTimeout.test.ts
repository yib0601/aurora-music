import { fetchWithTimeout, setCustomFetch } from '../fetchWithTimeout'

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
})
