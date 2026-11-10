/**
 * WebDAV 传输注入点（`setWebdavFetch`，T6 / verifier B-2 的前置）。
 *
 * 背景：桌面打包版的渲染层 origin 是 `file://`、`webSecurity` 为 true，而
 * PROPFIND / PUT / MKCOL 与 `Authorization`、`Depth` 头必然触发 CORS 预检；
 * 绝大多数 WebDAV 服务端不返回 `Access-Control-Allow-Origin`，渲染层直连必被拦死。
 * 唯一接缝是这里：主进程注入一条 IPC 代理的 fetch，之后本文件里所有请求都走它。
 *
 * 这个文件只验证**接缝本身**（注入生效、`null` 回落、错挂在 `webdav.ts` 的那个模块变量上），
 * 不重复验证各原语的错误映射——那是 `sync/__tests__/webdavSyncPlugin.test.ts` 的形状。
 * 断言全部基于**假的 fetch**，不连任何真实主机、不依赖端口。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureWebdavDir,
  readWebdavText,
  setWebdavFetch,
  writeWebdavText,
  type LibrarySourceConfig,
} from '../../../webdav'

const config: LibrarySourceConfig = {
  id: 'lib-test',
  kind: 'webdav',
  name: '测试存储',
  settings: {
    baseUrl: 'https://dav.example.com/dav',
    rootPath: '/aurora-music',
    username: 'demo-user',
    password: 'local-dev-key',
  },
  enabled: true,
}

/** 记录调用并按预设状态码返回的假 fetch */
function fakeFetch(handlers: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init: init ?? {} })
    return handlers(url, init ?? {})
  })
  return { fetcher: fetcher as unknown as typeof globalThis.fetch, calls, spy: fetcher }
}

afterEach(() => {
  setWebdavFetch(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('setWebdavFetch：注入的 fetch 接管所有 WebDAV 请求', () => {
  it('readWebdavText 走注入实现，带正确的 URL 与鉴权头', async () => {
    const { fetcher, calls } = fakeFetch(() => new Response('{"hello":"world"}', { status: 200 }))
    setWebdavFetch(fetcher)

    const text = await readWebdavText(config, 'aurora-sync/dev-a.json')

    expect(text).toBe('{"hello":"world"}')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://dav.example.com/dav/aurora-music/aurora-sync/dev-a.json')
    expect(calls[0].init.method).toBe('GET')
    expect(String(new Headers(calls[0].init.headers).get('authorization'))).toMatch(/^Basic /)
  })

  it('writeWebdavText（PUT）与 ensureWebdavDir（MKCOL）同样走注入实现', async () => {
    const seen: string[] = []
    const { fetcher } = fakeFetch((_url, init) => {
      seen.push(String(init.method))
      return new Response(null, { status: 201 })
    })
    setWebdavFetch(fetcher)

    await ensureWebdavDir(config, 'aurora-sync')
    await writeWebdavText(config, 'aurora-sync/dev-a.json', '{"a":1}')

    expect(seen).toEqual(['MKCOL', 'PUT'])
  })

  it('注入实现抛错时错误仍然是 webdav 的结构化连接错误（不被吞掉、不改形态）', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('ipc channel closed')
    }) as unknown as typeof globalThis.fetch
    setWebdavFetch(fetcher)

    await expect(readWebdavText(config, 'aurora-sync/dev-a.json')).rejects.toMatchObject({
      name: 'WebdavError',
    })
  })
})

describe('setWebdavFetch(null)：回落到全局 fetch', () => {
  it('传 null 之后请求走全局 fetch，不再碰注入实现', async () => {
    const injected = fakeFetch(() => new Response('注入的', { status: 200 }))
    setWebdavFetch(injected.fetcher)
    expect(await readWebdavText(config, 'a.json')).toBe('注入的')

    const fallback = fakeFetch(() => new Response('全局的', { status: 200 }))
    setWebdavFetch(null)
    vi.stubGlobal('fetch', fallback.fetcher)

    expect(await readWebdavText(config, 'a.json')).toBe('全局的')
    expect(fallback.calls).toHaveLength(1)
    expect(injected.calls).toHaveLength(1) // 注入实现只被第一次调用碰到
  })

  it('注入优先于全局 fetch（两者都在时用注入的那个）', async () => {
    const injected = fakeFetch(() => new Response('注入的', { status: 200 }))
    const fallback = fakeFetch(() => new Response('全局的', { status: 200 }))
    setWebdavFetch(injected.fetcher)
    vi.stubGlobal('fetch', fallback.fetcher)

    expect(await readWebdavText(config, 'a.json')).toBe('注入的')
    expect(fallback.calls).toHaveLength(0)
  })
})
