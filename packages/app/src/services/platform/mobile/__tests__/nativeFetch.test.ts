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

/**
 * 两条绕开 CapacitorHttp 的路径（见 nativeFetch 文件头）。
 *
 * 存在的理由：`CapacitorHttp` 在 Android 上最终调 `HttpURLConnection`，
 * 它拒绝非标准动词（PROPFIND → ProtocolException），而文本通道会毁掉二进制。
 * 这两条**必须**走原生插件，否则移动端网络存储整条链路直接不可用。
 */
describe('createNativeFetch：非标准动词与二进制读体走 NativeHttp 插件', () => {
  const nativeCalls: Array<Record<string, unknown>> = []

  const installPlugin = () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      Capacitor: {
        Plugins: {
          NativeHttp: {
            request: async (opts: Record<string, unknown>) => {
              nativeCalls.push(opts)
              return {
                status: 207,
                headers: { 'content-type': 'application/xml' },
                // 「ok」的 base64：证明回传的是字节而非被解码过的文本
                data: Buffer.from('ok', 'utf8').toString('base64'),
              }
            },
          },
        },
      },
    }
  }

  afterEach(() => {
    nativeCalls.length = 0
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('PROPFIND 不再交给 CapacitorHttp（那边会抛 ProtocolException）', async () => {
    installPlugin()
    const resp = await createNativeFetch()('https://nas.invalid/dav/Music', {
      method: 'PROPFIND',
      headers: { Depth: '1', Authorization: 'Basic abc' },
      body: '<?xml version="1.0"?><propfind/>',
    })
    expect(mocks.request).not.toHaveBeenCalled()
    expect(nativeCalls).toHaveLength(1)
    // 方法与请求体原样透传：PROPFIND 的 XML 体就在 body 里
    expect(nativeCalls[0].method).toBe('PROPFIND')
    expect(nativeCalls[0].body).toContain('<propfind/>')
    expect(resp.status).toBe(207)
    // base64 → 字节 → Response：读出来必须是原文
    expect(await resp.text()).toBe('ok')
  })

  it('带 Range 的 GET（元数据头）也走插件，避免文本通道损坏二进制', async () => {
    installPlugin()
    await createNativeFetch()('https://nas.invalid/dav/Music/a.mp3', {
      method: 'GET',
      headers: { Range: 'bytes=0-1023' },
    })
    expect(mocks.request).not.toHaveBeenCalled()
    expect(nativeCalls).toHaveLength(1)
    expect((nativeCalls[0].headers as Record<string, string>).Range).toBe('bytes=0-1023')
  })

  it('普通 GET 仍走 CapacitorHttp（少一层 JS 桥）', async () => {
    installPlugin()
    mocks.request.mockResolvedValue(okResponse('{"ok":true}'))
    await createNativeFetch()('https://source.invalid/api', {})
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(nativeCalls).toHaveLength(0)
  })

  it('插件缺失（老包 / 未注册）时回落 CapacitorHttp，而不是直接失败', async () => {
    mocks.request.mockResolvedValue(okResponse('{}'))
    const resp = await createNativeFetch()('https://nas.invalid/dav', {
      method: 'PROPFIND',
      headers: { Depth: '1' },
    })
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(resp.status).toBe(200)
  })
})
