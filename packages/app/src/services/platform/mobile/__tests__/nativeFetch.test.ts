import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `createNativeFetch` 的契约测试（此前无任何测试）。
 *
 * 它只在移动端启动时注入一次（`mobile/index.ts` → `setCustomFetch`），
 * 一旦行为漂移，影响面是移动端**全部**在线取数，却没有任何门禁能发现。
 *
 * 本文件重点钉住一条容易被误以为「已实现」的能力：**它忽略 `init.signal`**。
 * 这条写在源码注释里，但注释会随实现漂移而失真——用测试把它固定下来：
 * 若将来真的支持了 signal，这条用例会红，提醒同步修注释与 `fetchWithTimeout`
 * 里那条「移动端 abort 无法取消底层原生请求」的说明。
 */

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  CapacitorHttp: { request: mocks.request },
}))

const { createNativeFetch } = await import('../nativeFetch')

afterEach(() => {
  mocks.request.mockReset()
})

const okResponse = (data: string) => ({ status: 200, data, headers: { 'content-type': 'application/json' } })

describe('createNativeFetch', () => {
  it('把完整 body 物化成 Response 后返回（所以移动端没有「可停滞的增量 body」）', async () => {
    mocks.request.mockResolvedValue(okResponse('{"ok":true}'))
    const resp = await createNativeFetch()('https://source.invalid/api', {})
    expect(resp.status).toBe(200)
    // 关键契约：body 在返回时已完整可读，不存在「响应头到了 body 没到」的中间态
    expect(await resp.json()).toEqual({ ok: true })
  })

  it('忽略 init.signal：不把 signal 转发给 CapacitorHttp，也不因 signal 中止而拒绝', async () => {
    // 捕获实际转发给原生层的参数
    let seen: Record<string, unknown> = {}
    mocks.request.mockImplementation((opts: Record<string, unknown>) => {
      seen = opts
      return Promise.resolve(okResponse('{}'))
    })

    const ctrl = new AbortController()
    const fetchImpl = createNativeFetch()
    const pending = fetchImpl('https://source.invalid/api', { signal: ctrl.signal })
    ctrl.abort(new DOMException('canceled', 'AbortError'))

    // 即使调用方已中止，请求仍会正常完成 —— 这正是「忽略 signal」的表现
    const resp = await pending
    expect(resp.status).toBe(200)
    // 转发给原生的参数里根本没有 signal 键
    expect(seen).not.toHaveProperty('signal')
    expect(Object.keys(seen).sort()).toEqual(['headers', 'method', 'responseType', 'url'])
  })

  it('非 http(s) 请求回落到 WebView 原生 fetch（如 capacitor:// 本地文件）', async () => {
    const originalFetch = globalThis.fetch
    const called: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      called.push(String(input))
      return new Response('local', { status: 200 })
    }) as typeof fetch
    try {
      const resp = await createNativeFetch()('capacitor://localhost/file.txt', {})
      expect(await resp.text()).toBe('local')
      expect(called).toEqual(['capacitor://localhost/file.txt'])
      // 没有走原生 HTTP 层
      expect(mocks.request).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('状态码越界时按 502 兜底（Response 构造器只接受 200~599）', async () => {
    mocks.request.mockResolvedValue({ status: 0, data: '{}', headers: {} })
    const resp = await createNativeFetch()('https://source.invalid/api', {})
    expect(resp.status).toBe(502)
  })
})