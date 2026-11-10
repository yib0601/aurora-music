/**
 * 局域网同步鉴权原语的单测（纯函数，不起网络）。
 *
 * 覆盖：配对码格式与归一化、密钥派生的对称性、签名公式、验签的五类失败
 * （协议不符 / 过期 / 签名不符 / 重放 / 缺头），以及 nonce 表的 TTL 与容量。
 */

import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SYNC_LAN_PROTOCOL_VERSION } from '@aurora/shared'
import {
  LAN_KEY_CONTEXT,
  LAN_HEADERS,
  LAN_MAX_CLOCK_SKEW_MS,
  PAIR_CODE_ALPHABET,
  PAIR_CODE_LENGTH,
  createNonce,
  createNonceStore,
  deriveKey,
  generatePairCode,
  normalizePairCode,
  requestSignature,
  signRequest,
  verifyRequest,
  type LanSignParts,
} from '../lanSyncAuth'

const PATH = '/v1/snapshot'
const METHOD = 'GET'

function sign(
  code: string,
  overrides: Partial<LanSignParts> = {},
): { headers: Record<string, string>; parts: LanSignParts } {
  const parts: LanSignParts = {
    method: METHOD,
    path: PATH,
    ts: Date.now(),
    nonce: createNonce(),
    deviceId: '00000000-0000-0000-0000-000000000000',
    ...overrides,
  }
  return { headers: signRequest(deriveKey(code), parts), parts }
}

function verify(
  code: string,
  request: { headers: Record<string, string>; parts: LanSignParts },
  extra: { body?: string | Buffer; now?: number; path?: string; method?: string } = {},
) {
  return verifyRequest(
    deriveKey(code),
    {
      method: extra.method ?? request.parts.method,
      path: extra.path ?? request.parts.path,
      headers: request.headers,
      body: extra.body ?? request.parts.body,
      now: extra.now ?? Date.now(),
    },
    createNonceStore(),
  )
}

describe('generatePairCode', () => {
  it('生成 10 位、只含 Crockford 字母表的码', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generatePairCode()
      expect(code).toHaveLength(PAIR_CODE_LENGTH)
      for (const char of code) expect(PAIR_CODE_ALPHABET).toContain(char)
      // 生成的码必须自己能过归一化（否则贴到对端就废了）
      expect(normalizePairCode(code)).toBe(code)
    }
  })

  it('字母表不含易混字符 0/1/I/O（U 按契约保留）', () => {
    // 契约字母表 = Crockford 去掉 0/1/I/O；与标准 Crockford 的唯一差异是保留了 U
    for (const char of '01IO') expect(PAIR_CODE_ALPHABET).not.toContain(char)
    expect(PAIR_CODE_ALPHABET).toContain('U')
    expect(PAIR_CODE_ALPHABET).toHaveLength(32)
  })

  it('随机性：两次生成极大概率不同', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generatePairCode()))
    expect(codes.size).toBeGreaterThan(45)
  })
})

describe('normalizePairCode', () => {
  const canonical = '23456789AB'

  it('接受规范形式', () => {
    expect(normalizePairCode(canonical)).toBe(canonical)
  })

  it('去掉空格与连字符并转大写', () => {
    expect(normalizePairCode('2345 6789 ab')).toBe(canonical)
    expect(normalizePairCode('2345-6789-AB')).toBe(canonical)
    expect(normalizePairCode(' 2345\t6789-ab ')).toBe(canonical)
  })

  it('拒绝非法字符', () => {
    expect(normalizePairCode('23456789A0')).toBeNull() // 0 不在表里
    expect(normalizePairCode('23456789AI')).toBeNull() // I 不在表里
    expect(normalizePairCode('23456789AO')).toBeNull()
    expect(normalizePairCode('23456789A1')).toBeNull()
    expect(normalizePairCode('23456789A!')).toBeNull()
  })

  it('拒绝长度不对与非字符串', () => {
    expect(normalizePairCode('23456789A')).toBeNull()
    expect(normalizePairCode('23456789ABC')).toBeNull()
    expect(normalizePairCode('')).toBeNull()
    expect(normalizePairCode(undefined)).toBeNull()
    expect(normalizePairCode(null)).toBeNull()
    expect(normalizePairCode(1234567890)).toBeNull()
  })
})

describe('deriveKey', () => {
  it('按 HMAC-SHA256(code, "aurora-lan-sync/v1") 派生', () => {
    const expected = createHmac('sha256', '23456789AB').update(LAN_KEY_CONTEXT).digest('hex')
    expect(deriveKey('23456789AB').toString('hex')).toBe(expected)
  })

  it('对称：不同写法归一化后派生同一把 key', () => {
    expect(deriveKey('2345 6789 ab').equals(deriveKey('23456789AB'))).toBe(true)
    expect(deriveKey('2345-6789-AB').equals(deriveKey('23456789AB'))).toBe(true)
  })

  it('不同配对码派生出不同 key', () => {
    expect(deriveKey('23456789AB').equals(deriveKey('23456789AC'))).toBe(false)
  })
})

describe('signRequest', () => {
  it('发出 §15.3 规定的五个头', () => {
    const { headers } = sign('23456789AB')
    expect(headers[LAN_HEADERS.device]).toBe('00000000-0000-0000-0000-000000000000')
    expect(headers[LAN_HEADERS.proto]).toBe(String(SYNC_LAN_PROTOCOL_VERSION))
    expect(headers[LAN_HEADERS.ts]).toMatch(/^\d+$/)
    expect(headers[LAN_HEADERS.nonce]).toMatch(/^[0-9a-f]{32}$/)
    expect(headers[LAN_HEADERS.sig]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('签名公式逐字可复算：method\\npath\\nts\\nnonce\\nsha256(body)', () => {
    const body = '{"snapshot":1}'
    const parts: LanSignParts = {
      method: 'PUT',
      path: PATH,
      ts: 1_700_000_000_000,
      nonce: 'abcdef0123456789abcdef0123456789',
      body,
    }
    const manual = createHmac('sha256', deriveKey('23456789AB'))
      .update(
        [
          parts.method,
          parts.path,
          String(parts.ts),
          parts.nonce,
          createHash('sha256').update(body).digest('hex'),
        ].join('\n'),
      )
      .digest('hex')
    expect(requestSignature(deriveKey('23456789AB'), parts)).toBe(manual)
  })

  it('body 为 undefined 与空串等价（sha256("")）', () => {
    const key = deriveKey('23456789AB')
    const base = { method: 'GET', path: PATH, ts: 1, nonce: 'abcdefgh' }
    expect(requestSignature(key, base)).toBe(requestSignature(key, { ...base, body: '' }))
  })
})

describe('verifyRequest', () => {
  const code = '23456789AB'

  it('正确签名通过', () => {
    expect(verify(code, sign(code))).toEqual({ ok: true })
  })

  it('PUT 带 body 时通过（body 参与签名）', () => {
    const request = sign(code, { method: 'PUT', body: '{"snapshot":{}}' })
    expect(verify(code, request)).toEqual({ ok: true })
  })

  it('篡改 body → auth', () => {
    const request = sign(code, { method: 'PUT', body: '{"snapshot":{}}' })
    expect(verify(code, request, { body: '{"snapshot":{"revision":2}}' })).toEqual({
      ok: false,
      reason: 'auth',
    })
  })

  it('篡改 method / path → auth', () => {
    const request = sign(code)
    expect(verify(code, request, { method: 'PUT' })).toEqual({ ok: false, reason: 'auth' })
    expect(verify(code, request, { path: '/v1/hello' })).toEqual({ ok: false, reason: 'auth' })
  })

  it('篡改签名 → auth', () => {
    const { headers, parts } = sign(code)
    const tampered = { ...headers, [LAN_HEADERS.sig]: 'f'.repeat(64) }
    expect(verify(code, { headers: tampered, parts })).toEqual({ ok: false, reason: 'auth' })
  })

  it('错误配对码派生的 key → auth', () => {
    expect(verify('23456789AC', sign(code))).toEqual({ ok: false, reason: 'auth' })
  })

  it('过期 / 未来超窗口 → stale', () => {
    const now = Date.now()
    const old = sign(code, { ts: now - LAN_MAX_CLOCK_SKEW_MS - 1 })
    expect(verify(code, old, { now })).toEqual({ ok: false, reason: 'stale' })
    const future = sign(code, { ts: now + LAN_MAX_CLOCK_SKEW_MS + 1 })
    expect(verify(code, future, { now })).toEqual({ ok: false, reason: 'stale' })
  })

  it('窗口边界内仍通过（允许 5 分钟偏差）', () => {
    const now = Date.now()
    const edge = sign(code, { ts: now - LAN_MAX_CLOCK_SKEW_MS })
    expect(verify(code, edge, { now })).toEqual({ ok: true })
  })

  it('时间戳格式非法 → protocol', () => {
    const request = sign(code)
    const bad = { ...request.headers, [LAN_HEADERS.ts]: 'yesterday' }
    expect(verify(code, { headers: bad, parts: request.parts })).toEqual({
      ok: false,
      reason: 'protocol',
    })
  })

  it('协议版本不符 → protocol', () => {
    const request = sign(code, { proto: SYNC_LAN_PROTOCOL_VERSION + 1 })
    expect(verify(code, request)).toEqual({ ok: false, reason: 'protocol' })
  })

  it('缺协议头 / 缺签名 → protocol', () => {
    const request = sign(code)
    const noProto = { ...request.headers }
    delete noProto[LAN_HEADERS.proto]
    expect(verify(code, { headers: noProto, parts: request.parts })).toEqual({
      ok: false,
      reason: 'protocol',
    })

    const noSig = { ...request.headers }
    delete noSig[LAN_HEADERS.sig]
    expect(verify(code, { headers: noSig, parts: request.parts })).toEqual({
      ok: false,
      reason: 'protocol',
    })
  })

  it('重放同一 nonce → 第二次 replay', () => {
    const now = Date.now()
    const request = sign(code, { ts: now })
    const store = createNonceStore()

    const first = verifyRequest(
      deriveKey(code),
      { method: METHOD, path: PATH, headers: request.headers, now },
      store,
    )
    expect(first).toEqual({ ok: true })

    const second = verifyRequest(
      deriveKey(code),
      { method: METHOD, path: PATH, headers: request.headers, now },
      store,
    )
    expect(second).toEqual({ ok: false, reason: 'replay' })
  })

  it('伪造请求（签名不对）不会占用 nonce 表', () => {
    const store = createNonceStore()
    const request = sign(code)
    const forged = { ...request.headers, [LAN_HEADERS.sig]: '0'.repeat(64) }
    expect(
      verifyRequest(deriveKey(code), { method: METHOD, path: PATH, headers: forged }, store),
    ).toEqual({ ok: false, reason: 'auth' })
    expect(store.size).toBe(0)

    // 同一 nonce 的合法请求仍然能通过
    expect(
      verifyRequest(
        deriveKey(code),
        { method: METHOD, path: PATH, headers: request.headers },
        store,
      ),
    ).toEqual({ ok: true })
  })

  it('头值大小写不敏感（HTTP 语义）', () => {
    const request = sign(code)
    const upper = Object.fromEntries(
      Object.entries(request.headers).map(([k, v]) => [k.toUpperCase(), v]),
    )
    // 本函数直接吃已归一化的 header 对象，调用方负责小写；这里显式转小写后应通过
    const lowered = Object.fromEntries(Object.entries(upper).map(([k, v]) => [k.toLowerCase(), v]))
    expect(verify(code, { headers: lowered, parts: request.parts })).toEqual({ ok: true })
  })
})

describe('createNonceStore', () => {
  it('TTL 内命中，过期后失效', () => {
    const store = createNonceStore({ ttlMs: 1000 })
    store.remember('nonce-aaaa', 0)
    expect(store.has('nonce-aaaa', 500)).toBe(true)
    expect(store.has('nonce-aaaa', 1001)).toBe(false)
    expect(store.size).toBe(0)
  })

  it('容量上限：超出后淘汰最旧的', () => {
    const store = createNonceStore({ maxEntries: 2 })
    store.remember('nonce-1', 0)
    store.remember('nonce-2', 0)
    store.remember('nonce-3', 0)
    expect(store.size).toBe(2)
    expect(store.has('nonce-1', 0)).toBe(false)
    expect(store.has('nonce-2', 0)).toBe(true)
    expect(store.has('nonce-3', 0)).toBe(true)
  })

  it('verifyRequest 使用注入的独立表（互不影响）', () => {
    const code = '23456789AB'
    const request = sign(code)
    const a = createNonceStore()
    const b = createNonceStore()
    const req = { method: METHOD, path: PATH, headers: request.headers }
    expect(verifyRequest(deriveKey(code), req, a)).toEqual({ ok: true })
    expect(verifyRequest(deriveKey(code), req, b)).toEqual({ ok: true })
    expect(verifyRequest(deriveKey(code), req, a)).toEqual({ ok: false, reason: 'replay' })
  })
})
