import { describe, expect, it, vi } from 'vitest'
import { createGuardedFetch, hostAllowed, hostOf, isHostNotAllowedError } from '../host'
import { validatePluginManifest } from '../validate'
import { PLUGIN_MANIFEST_FORMAT } from '../types'

describe('hostOf', () => {
  it('取 host（含端口，小写）', () => {
    expect(hostOf('https://API.Example.COM/x')).toBe('api.example.com')
    expect(hostOf('http://api.example.com:8080/x')).toBe('api.example.com:8080')
    expect(hostOf('[::1]:9000')).toBe('')
  })

  it('非 http(s) 与非法地址返回空串（调用方据此拒绝）', () => {
    expect(hostOf('file:///etc/passwd')).toBe('')
    expect(hostOf('data:text/plain,x')).toBe('')
    expect(hostOf('not a url')).toBe('')
  })
})

describe('hostAllowed', () => {
  const hosts = ['api.example.com', 'withport.example.com:8443']

  it('精确匹配主机', () => {
    expect(hostAllowed(hosts, 'https://api.example.com/a')).toBe(true)
  })

  it('白名单没写端口 → 该主机任意端口放行（端口不该成为"同一个主机"的区分依据）', () => {
    expect(hostAllowed(hosts, 'https://api.example.com:9999/a')).toBe(true)
  })

  it('白名单写了端口 → 只放行该端口', () => {
    expect(hostAllowed(hosts, 'https://withport.example.com:8443/a')).toBe(true)
    expect(hostAllowed(hosts, 'https://withport.example.com/a')).toBe(false)
    expect(hostAllowed(hosts, 'https://withport.example.com:1234/a')).toBe(false)
  })

  it('子域不放行（精确匹配，不做后缀匹配）', () => {
    expect(hostAllowed(hosts, 'https://evil.api.example.com/a')).toBe(false)
    expect(hostAllowed(hosts, 'https://api.example.com.evil.tld/a')).toBe(false)
  })

  it('大小写与空白不敏感', () => {
    expect(hostAllowed([' API.Example.COM '], 'https://api.example.com/a')).toBe(true)
  })

  it('空白名单拒绝一切', () => {
    expect(hostAllowed([], 'https://api.example.com/a')).toBe(false)
  })

  it('非 http 协议一律拒绝', () => {
    expect(hostAllowed(hosts, 'file:///etc/passwd')).toBe(false)
  })
})

/** 造一个假 fetch：记录被调用的 URL，返回固定 JSON */
function fakeFetch(payload: unknown = { ok: true }) {
  const calls: string[] = []
  const impl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  return { impl, calls }
}

describe('createGuardedFetch：越界请求不发出', () => {
  const manifest = { id: 'demo', hosts: ['api.example.com'] }

  it('白名单内的请求正常发出', async () => {
    const base = fakeFetch()
    const guarded = createGuardedFetch(manifest, base.impl)
    const resp = await guarded('https://api.example.com/search?q=x')
    expect(resp.status).toBe(200)
    expect(base.calls).toEqual(['https://api.example.com/search?q=x'])
  })

  it('白名单外的请求抛错且**不调用**底层 fetch', async () => {
    const base = fakeFetch()
    const guarded = createGuardedFetch(manifest, base.impl)
    await expect(guarded('https://evil.example.net/steal')).rejects.toThrow()
    // 关键：请求根本没发出去（否则"报错但数据已经泄露"毫无意义）
    expect(base.calls).toEqual([])
  })

  it('越界错误可被识别（上层据此区分"越界"与"网络失败"）', async () => {
    const base = fakeFetch()
    const guarded = createGuardedFetch(manifest, base.impl)
    try {
      await guarded('https://evil.example.net/x')
      throw new Error('should have thrown')
    } catch (err) {
      expect(isHostNotAllowedError(err)).toBe(true)
      // 错误里带目标主机：诊断"是哪个域名没声明"靠它
      expect(String(err)).toContain('evil.example.net')
    }
  })

  it('Request 对象与 URL 对象形式的入参同样受约束（不能靠换入参类型绕过）', async () => {
    const base = fakeFetch()
    const guarded = createGuardedFetch(manifest, base.impl)

    await expect(guarded(new Request('https://evil.example.net/a'))).rejects.toThrow()
    await expect(guarded(new URL('https://evil.example.net/b'))).rejects.toThrow()
    expect(base.calls).toEqual([])
  })
})

describe('端到端：校验后的清单 hosts 直接喂给 guardedFetch', () => {
  it('大小写混写的清单主机在运行期正确放行', async () => {
    const result = validatePluginManifest({
      format: PLUGIN_MANIFEST_FORMAT,
      id: 'demo',
      name: 'Demo',
      version: '1.0.0',
      permissions: ['network'],
      hosts: ['API.Example.COM'],
      source: {
        search: {
          url: 'https://api.example.com/s?q={query}',
          map: { title: 't', audioUrl: 'u' },
        },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const base = fakeFetch()
    const guarded = createGuardedFetch(result.manifest, base.impl)
    await expect(guarded('https://api.example.com/s?q=x')).resolves.toBeDefined()
  })
})

describe('不改造全局 fetch', () => {
  it('guardedFetch 不污染 globalThis（并发多插件各用各的白名单）', async () => {
    const original = globalThis.fetch
    const base = fakeFetch()
    const a = createGuardedFetch({ id: 'a', hosts: ['a.example.com'] }, base.impl)
    const b = createGuardedFetch({ id: 'b', hosts: ['b.example.com'] }, base.impl)

    await expect(a('https://a.example.com/x')).resolves.toBeDefined()
    await expect(b('https://a.example.com/x')).rejects.toThrow()
    await expect(a('https://b.example.com/x')).rejects.toThrow()

    expect(globalThis.fetch).toBe(original)
    // 静默 vi 未使用告警
    vi.restoreAllMocks()
  })
})
