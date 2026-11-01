/**
 * 服务地址形态（service profile）与 `configured-origin` 白名单的单测。
 *
 * 这两块合在一个文件里，因为它们解决的是**同一个矛盾**：
 * 清单要求绝对 URL + 固定 hosts，而"用户填自己的服务地址"这种形态两者都不成立。
 * 分开测会让"派生出的端点是否被白名单放行"这一关键联动没人验。
 */

import { describe, expect, it } from 'vitest'
import {
  deriveService,
  fillServicePlaceholders,
  isConfiguredOriginService,
  mergeSelfDescribed,
  splitServiceUrl,
} from '../service'
import { allowlistAllows, createGuardedFetch, manifestAllowlistMode, originOf } from '../host'
import type { PluginManifest } from '../types'

describe('splitServiceUrl：服务地址与密钥拆分', () => {
  it('把 key 从 query 里取出来，baseUrl 不含 query', () => {
    const out = splitServiceUrl('https://music.example.com?key=abc123')
    expect(out.baseUrl).toBe('https://music.example.com')
    expect(out.secret).toBe('abc123')
  })

  it('保留路径、去掉 query 与 hash', () => {
    const out = splitServiceUrl('https://h.example.com/api/aurora/?key=k#frag')
    expect(out.baseUrl).toBe('https://h.example.com/api/aurora')
    expect(out.secret).toBe('k')
  })

  it('自定义参数名（secretFrom=query:api_key）', () => {
    const out = splitServiceUrl('https://h.example.com/?api_key=xyz', 'query:api_key')
    expect(out.secret).toBe('xyz')
  })

  it('没有密钥 → secret 为空串（下游会剔除相关参数）', () => {
    const out = splitServiceUrl('https://music.example.com')
    expect(out.baseUrl).toBe('https://music.example.com')
    expect(out.secret).toBe('')
  })

  it('非 http(s) / 非法地址 → 空 baseUrl（fail-closed，派生不成立）', () => {
    expect(splitServiceUrl('ftp://h/x').baseUrl).toBe('')
    expect(splitServiceUrl('not a url').baseUrl).toBe('')
    expect(splitServiceUrl('').baseUrl).toBe('')
  })
})

describe('fillServicePlaceholders：只替换服务级占位符', () => {
  it('替换 baseUrl / secret', () => {
    expect(
      fillServicePlaceholders('{baseUrl}/aurora?key={secret}', {
        baseUrl: 'https://h',
        secret: 'k',
      })
    ).toBe('https://h/aurora?key=k')
  })

  it('**不动**执行期占位符（{query} / {id} 此刻还没有值）', () => {
    const out = fillServicePlaceholders('{baseUrl}/s?q={query}&id={id}&key={secret}', {
      baseUrl: 'https://h',
      secret: 'k',
    })
    // 这条是关键：若把 {query} 当占位符换成空串，dropUnfilledParams 会在执行前
    // 就把整段参数删掉，端点模板彻底错掉
    expect(out).toBe('https://h/s?q={query}&id={id}&key=k')
  })
})

describe('deriveService：从用户地址派生端点', () => {
  const spec = {
    secretFrom: 'query:key',
    endpoints: {
      search: '{baseUrl}/aurora?query={query}&quality={quality}&key={secret}',
      track: '{baseUrl}/aurora/track?id={id}&key={secret}',
      lyric: '{baseUrl}/aurora/lyric?track={track}&key={secret}',
    },
  }

  it('用户填了地址 → 各端点被派生，执行期占位符原样保留', () => {
    const derived = deriveService(spec, { sourceUrl: 'https://h.example.com?key=k' })!
    expect(derived.baseUrl).toBe('https://h.example.com')
    expect(derived.secret).toBe('k')
    expect(derived.endpoints.search).toBe(
      'https://h.example.com/aurora?query={query}&quality={quality}&key=k'
    )
    expect(derived.endpoints.track).toBe('https://h.example.com/aurora/track?id={id}&key=k')
  })

  it('用户没填地址 → null（不发必然失败的请求）', () => {
    expect(deriveService(spec, { sourceUrl: '' })).toBeNull()
    expect(deriveService(spec, null)).toBeNull()
  })

  it('没有 service 声明 → null', () => {
    expect(deriveService(null, { sourceUrl: 'https://h' })).toBeNull()
  })

  it('自描述地址也被派生', () => {
    const derived = deriveService(
      { ...spec, selfDescribe: { url: '{baseUrl}/', endpoints: 'endpoints' } },
      { sourceUrl: 'https://h.example.com?key=k' }
    )!
    expect(derived.selfDescribeUrl).toBe('https://h.example.com/')
    expect(derived.selfDescribePath).toBe('endpoints')
  })
})

describe('mergeSelfDescribed：服务端自描述优先', () => {
  const spec = {
    selfDescribe: { url: '{baseUrl}/', endpoints: 'endpoints' },
    endpoints: { search: '{baseUrl}/old?query={query}', track: '{baseUrl}/old-track?id={id}' },
  }

  it('自描述给出的端点覆盖静态模板（服务端改路径不必改配置）', () => {
    const derived = deriveService(spec, { sourceUrl: 'https://h.example.com' })!
    const merged = mergeSelfDescribed(derived, {
      endpoints: { search: '/v2/search?q={query}' },
    })
    expect(merged.endpoints.search).toBe('/v2/search?q={query}')
    // 自描述没提的键保留静态值
    expect(merged.endpoints.track).toBe('https://h.example.com/old-track?id={id}')
  })

  it('自描述缺失 / 形状不对 → 原样返回，不抛错', () => {
    const derived = deriveService(spec, { sourceUrl: 'https://h.example.com' })!
    expect(mergeSelfDescribed(derived, null).endpoints).toEqual(derived.endpoints)
    expect(mergeSelfDescribed(derived, { other: 1 }).endpoints).toEqual(derived.endpoints)
  })
})

describe('configured-origin 白名单', () => {
  it('originOf：规范化 scheme + host + port', () => {
    expect(originOf('HTTPS://Music.Example.COM/a/b?x=1')).toBe('https://music.example.com')
    expect(originOf('http://127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080')
    expect(originOf('ftp://h')).toBe('')
    expect(originOf('')).toBe('')
  })

  it('只放行用户填的那一个 origin', () => {
    const policy = { mode: 'configured-origin' as const, configuredUrl: 'https://mine.example.com' }
    expect(allowlistAllows(policy, 'https://mine.example.com/aurora?q=1')).toBe(true)
    // 别的主机不放行（哪怕同子域）
    expect(allowlistAllows(policy, 'https://evil.example.com/x')).toBe(false)
    expect(allowlistAllows(policy, 'https://mine.example.com.evil.com/x')).toBe(false)
  })

  it('端口不同视为不同 origin（比 declared-hosts 更严）', () => {
    const policy = { mode: 'configured-origin' as const, configuredUrl: 'https://mine.example.com' }
    expect(allowlistAllows(policy, 'https://mine.example.com:8443/x')).toBe(false)
  })

  it('协议不同视为不同 origin', () => {
    const policy = { mode: 'configured-origin' as const, configuredUrl: 'https://mine.example.com' }
    expect(allowlistAllows(policy, 'http://mine.example.com/x')).toBe(false)
  })

  it('用户没填地址 → 拒绝一切（fail-closed，绝不放行）', () => {
    const policy = { mode: 'configured-origin' as const, configuredUrl: '' }
    expect(allowlistAllows(policy, 'https://anything.com/x')).toBe(false)
  })

  it('缺省模式仍是 declared-hosts（向后兼容）', () => {
    expect(allowlistAllows({ hosts: ['api.example.com'] }, 'https://api.example.com/x')).toBe(true)
    expect(allowlistAllows({ hosts: ['api.example.com'] }, 'https://other.com/x')).toBe(false)
  })
})

describe('createGuardedFetch：越界请求不发出', () => {
  it('configured-origin 模式下越界请求直接抛错，且 base 未被调用', async () => {
    let called = 0
    const base = (async () => {
      called++
      return new Response('ok')
    }) as unknown as typeof globalThis.fetch

    const manifest = { id: 'svc', hosts: [] } as Pick<PluginManifest, 'id' | 'hosts'>
    const guarded = createGuardedFetch(manifest, base, {
      mode: 'configured-origin',
      configuredUrl: 'https://mine.example.com',
    })

    await expect(guarded('https://evil.example.com/x')).rejects.toThrow()
    expect(called).toBe(0)
    // 放行的地址正常发出
    await guarded('https://mine.example.com/aurora')
    expect(called).toBe(1)
  })

  /**
   * 回归：mode 由清单推断，而不是调用方硬编码。
   *
   * 曾经的 bug：`installed.ts` 调 `createGuardedFetch` 不传 options，mode 回落
   * `declared-hosts`；而 service 形态的 `hosts` 按约定允许为空 → 白名单恒空 →
   * **该插件所有请求都被拒**，表现是"装上了但什么也搜不到"。
   *
   * 这个用例故意**不传 options**，模拟生产路径的真实调用方式。
   */
  it('service 形态清单不传 options 时，按 configured-origin 放行同 origin 请求', async () => {
    let called = 0
    const base = (async () => {
      called++
      return new Response('ok')
    }) as unknown as typeof globalThis.fetch

    // 真实 service 形态：allowlist + service 同时存在，hosts 为空（validate 已放行）
    const manifest = {
      id: 'svc',
      hosts: [],
      allowlist: 'configured-origin',
      service: { endpoints: {} },
    } as unknown as Parameters<typeof createGuardedFetch>[0]

    const guarded = createGuardedFetch(manifest, base, {
      configuredUrl: 'https://h.example.com?key=k',
    })

    // 用户填的那个 origin 必须放行 —— 否则整条 service 链路在运行期全废
    await guarded('https://h.example.com/aurora?query=x&key=k')
    expect(called).toBe(1)

    // 仍然禁止越界（不因为推断就放宽）
    await expect(guarded('https://evil.example.com/x')).rejects.toThrow()
    expect(called).toBe(1)
  })

  it('没填用户地址时 service 形态仍 fail-closed（不放行一切）', async () => {
    const base = (async () => new Response('ok')) as unknown as typeof globalThis.fetch
    const manifest = {
      id: 'svc',
      hosts: [],
      allowlist: 'configured-origin',
      service: { endpoints: {} },
    } as unknown as Parameters<typeof createGuardedFetch>[0]
    // 不传 configuredUrl：调用方没拿到配置，不能因此放行
    const guarded = createGuardedFetch(manifest, base)
    await expect(guarded('https://h.example.com/x')).rejects.toThrow()
  })

  it('普通清单（无 service）仍走 declared-hosts，不因改动误放行', async () => {
    const base = (async () => new Response('ok')) as unknown as typeof globalThis.fetch
    const manifest = { id: 'p', hosts: ['api.example.com'] } as unknown as Parameters<
      typeof createGuardedFetch
    >[0]
    const guarded = createGuardedFetch(manifest, base)
    await guarded('https://api.example.com/x')
    await expect(guarded('https://other.example.com/x')).rejects.toThrow()
  })
})

describe('manifestAllowlistMode：清单是 mode 的唯一权威', () => {
  it('allowlist + service 同时具备才推断为 configured-origin', () => {
    const svc = { allowlist: 'configured-origin', service: {} } as never
    expect(manifestAllowlistMode(svc)).toBe('configured-origin')
    // 只有 allowlist 没有 service：校验期就会被拒，运行期按旧规则处理
    expect(manifestAllowlistMode({ allowlist: 'configured-origin' } as never)).toBe('declared-hosts')
    expect(manifestAllowlistMode({ hosts: [] } as never)).toBe('declared-hosts')
  })
})

describe('isConfiguredOriginService', () => {
  it('要求 allowlist 与 service 同时具备', () => {
    const base = { id: 'a', hosts: [] } as unknown as PluginManifest
    expect(isConfiguredOriginService(base)).toBe(false)
    expect(
      isConfiguredOriginService({ ...base, allowlist: 'configured-origin' } as PluginManifest)
    ).toBe(false)
    expect(
      isConfiguredOriginService({
        ...base,
        allowlist: 'configured-origin',
        service: { endpoints: { search: '{baseUrl}/s?q={query}' } },
      } as PluginManifest)
    ).toBe(true)
  })
})
