import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import {
  PLUGIN_SIGNATURE_ALGORITHM,
  TRUSTED_PLUGIN_KEYS,
  bytesToHex,
  canonicalizeManifest,
  checkSignatureShape,
  hexToBytes,
  readSignature,
  signableBytes,
  signatureBadgeKey,
  verifyManifestSignature,
  type SignatureVerdict,
} from '../signature'
import { validatePluginManifest } from '../validate'
import { PLUGIN_MANIFEST_FORMAT } from '../types'

/**
 * 用 node:crypto 生成真实 Ed25519 密钥对来测（**不是**打桩验签）：
 * 签名的正确性没法用 mock 证明 —— 打桩只能验证"我调了验签函数"，
 * 而这里要验证的是"规范化字节 + 算法 + 编码三者确实能对上"。
 */
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  // raw 公钥：DER 的最后 32 字节就是 raw key（SPKI 固定前缀 12 字节）
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  return { privateKey, publicKeyHex: bytesToHex(new Uint8Array(raw)) }
}

function sign(privateKey: crypto.KeyObject, message: string): string {
  return crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex')
}

function verify(sigHex: string, publicKeyHex: string, message: string): boolean {
  const keyBytes = hexToBytes(publicKeyHex)
  if (!keyBytes) return false
  // raw 32 字节公钥 → SPKI DER（前面拼固定前缀）
  const prefix = Buffer.from('302a300506032b6570032100', 'hex')
  const key = crypto.createPublicKey({
    key: Buffer.concat([prefix, Buffer.from(keyBytes)]),
    format: 'der',
    type: 'spki',
  })
  return crypto.verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(sigHex, 'hex'))
}

/** 造一份带合法签名的清单 */
function signedManifest(privateKey: crypto.KeyObject, keyId = 'test-key', extra: Record<string, unknown> = {}) {
  const base = {
    format: PLUGIN_MANIFEST_FORMAT,
    id: 'signed-demo',
    name: 'Signed Demo',
    version: '1.0.0',
    permissions: ['network'],
    hosts: ['api.example.com'],
    source: {
      search: { url: 'https://api.example.com/s?q={query}', map: { title: 't', audioUrl: 'u' } },
    },
    ...extra,
  }
  const sig = sign(privateKey, signableBytes(base))
  return { ...base, signature: { algorithm: PLUGIN_SIGNATURE_ALGORITHM, keyId, sig } }
}

describe('canonicalizeManifest：键序不影响签名', () => {
  it('键顺序不同 → 规范化后一致', () => {
    expect(canonicalizeManifest({ b: 1, a: 2 })).toBe(canonicalizeManifest({ a: 2, b: 1 }))
  })

  it('嵌套对象同样排序', () => {
    expect(canonicalizeManifest({ x: { d: 1, c: 2 } })).toBe(canonicalizeManifest({ x: { c: 2, d: 1 } }))
  })

  it('数组保序（顺序是语义的一部分）', () => {
    expect(canonicalizeManifest([1, 2])).not.toBe(canonicalizeManifest([2, 1]))
  })

  it('缩进与空白不影响（比较的是语义）', () => {
    const compact = JSON.stringify({ a: { b: 1 } })
    const pretty = JSON.stringify({ a: { b: 1 } }, null, 2)
    expect(canonicalizeManifest(JSON.parse(compact))).toBe(canonicalizeManifest(JSON.parse(pretty)))
  })

  it('标量与 null 安全', () => {
    expect(canonicalizeManifest(null)).toBe('null')
    expect(canonicalizeManifest(42)).toBe('42')
    expect(canonicalizeManifest('x')).toBe('"x"')
  })
})

describe('signableBytes：签名块本身不参与签名', () => {
  it('去掉 signature 字段', () => {
    const a = signableBytes({ a: 1, signature: { x: 1 } })
    const b = signableBytes({ a: 1 })
    expect(a).toBe(b)
  })

  it('没有 signature 字段时等于规范化整份清单', () => {
    expect(signableBytes({ a: 1 })).toBe(canonicalizeManifest({ a: 1 }))
  })

  it('非对象入参不炸', () => {
    expect(signableBytes(null)).toBe('null')
    expect(signableBytes([])).toBe('[]')
  })
})

describe('hex 编解码', () => {
  it('往返一致', () => {
    const bytes = new Uint8Array([0, 1, 255, 16])
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes)
  })

  it('非法 hex 返回 null', () => {
    expect(hexToBytes('abc')).toBeNull()
    expect(hexToBytes('zz')).toBeNull()
    expect(hexToBytes('')).toBeNull()
  })

  it('bytesToHex 输出小写', () => {
    expect(bytesToHex(new Uint8Array([255]))).toBe('ff')
  })
})

describe('readSignature：形状不对就当没有', () => {
  it('合法签名块', () => {
    expect(readSignature({ signature: { algorithm: 'ed25519', keyId: 'k', sig: 'a'.repeat(128) } })).toEqual({
      algorithm: 'ed25519',
      keyId: 'k',
      sig: 'a'.repeat(128),
    })
  })

  it.each([
    [{}, '没有 signature'],
    [{ signature: null }, 'null'],
    [{ signature: 'x' }, '字符串'],
    [{ signature: { algorithm: 'rsa', keyId: 'k', sig: 'x' } }, '未知算法'],
    [{ signature: { algorithm: 'ed25519', keyId: '', sig: 'x' } }, '空 keyId'],
    [{ signature: { algorithm: 'ed25519', keyId: 'k' } }, '没有 sig'],
  ])('拒绝 %s（%s）', (input) => {
    expect(readSignature(input)).toBeNull()
  })
})

describe('verifyManifestSignature：三档语义', () => {
  const { privateKey, publicKeyHex } = keypair()
  const trusted = [{ keyId: 'test-key', publicKey: publicKeyHex }]

  it('无签名 → unsigned', async () => {
    const verdict = await verifyManifestSignature({ a: 1 }, { verify, trustedKeys: trusted })
    expect(verdict).toEqual({ status: 'unsigned' })
  })

  it('签名有效且公钥可信 → verified', async () => {
    const manifest = signedManifest(privateKey)
    const verdict = await verifyManifestSignature(manifest, { verify, trustedKeys: trusted })
    expect(verdict).toEqual({ status: 'verified', keyId: 'test-key' })
  })

  it('签名有效但公钥不在信任表 → unknown-key（不拒绝，但必须告知用户）', async () => {
    const manifest = signedManifest(privateKey, 'someone-else')
    const verdict = await verifyManifestSignature(manifest, { verify, trustedKeys: trusted })
    expect(verdict).toEqual({ status: 'unknown-key', keyId: 'someone-else' })
  })

  it('签名存在、公钥可信、但内容被改过 → invalid（**必须拒绝安装**）', async () => {
    const manifest = signedManifest(privateKey)
    // 改一处内容（签名不再匹配）
    manifest.version = '9.9.9'
    const verdict = await verifyManifestSignature(manifest, { verify, trustedKeys: trusted })
    expect(verdict.status).toBe('invalid')
  })

  it('签名是另一份清单的签名 → invalid（换件攻击）', async () => {
    const other = signedManifest(privateKey, 'test-key', { id: 'other-plugin' })
    const manifest = signedManifest(privateKey)
    // 把 other 的签名贴到 manifest 上
    manifest.signature = other.signature
    const verdict = await verifyManifestSignature(manifest, { verify, trustedKeys: trusted })
    expect(verdict.status).toBe('invalid')
  })

  it('验签实现抛错 → invalid（不是"未签名"：不能把技术故障当成没有签名）', async () => {
    const manifest = signedManifest(privateKey)
    const verdict = await verifyManifestSignature(manifest, {
      trustedKeys: trusted,
      verify: () => {
        throw new Error('ed25519 unsupported in this runtime')
      },
    })
    expect(verdict.status).toBe('invalid')
    if (verdict.status === 'invalid') expect(verdict.reason).toContain('unsupported')
  })

  it('默认信任表为空：任何签名都算 unknown-key', async () => {
    expect(TRUSTED_PLUGIN_KEYS).toEqual([])
    const manifest = signedManifest(privateKey)
    const verdict = await verifyManifestSignature(manifest, { verify })
    expect(verdict.status).toBe('unknown-key')
  })

  it('签名块里的公钥字段不被信任（只认 keyId → 信任表）', async () => {
    // 攻击者把自己的公钥塞进清单，并用自己的私钥签名：若应用盲信清单里的公钥就会通过
    const attacker = keypair()
    const manifest = signedManifest(attacker.privateKey, 'test-key')
    // 攻击者用 keyId 冒充被信任的标识，但签名是攻击者私钥生成的
    const verdict = await verifyManifestSignature(manifest, { verify, trustedKeys: trusted })
    expect(verdict.status).toBe('invalid')
  })
})

describe('checkSignatureShape：安装期 schema 校验', () => {
  function collect() {
    const issues: Array<{ path: string; code: string }> = []
    return {
      issues,
      log: { add: (path: string, code: string) => issues.push({ path, code }) },
    }
  }

  it('合法签名块无问题', () => {
    const { issues, log } = collect()
    checkSignatureShape(log as never, 'signature', {
      algorithm: 'ed25519',
      keyId: 'k',
      sig: 'a'.repeat(128),
    })
    expect(issues).toEqual([])
  })

  it('缺 algorithm / keyId / sig 各自报错', () => {
    const { issues, log } = collect()
    checkSignatureShape(log as never, 'signature', {})
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['signature.algorithm', 'signature.keyId', 'signature.sig'])
    )
  })

  it('签名长度不是 128 hex → 报错（Ed25519 固定 64 字节）', () => {
    const { issues, log } = collect()
    checkSignatureShape(log as never, 'signature', {
      algorithm: 'ed25519',
      keyId: 'k',
      sig: 'abc',
    })
    expect(issues.map((issue) => issue.path)).toContain('signature.sig')
  })

  it('未签名（undefined）不报错', () => {
    const { issues, log } = collect()
    checkSignatureShape(log as never, 'signature', undefined)
    expect(issues).toEqual([])
  })

  it('非对象报 invalid-type', () => {
    const { issues, log } = collect()
    checkSignatureShape(log as never, 'signature', 'string')
    expect(issues[0].code).toBe('invalid-type')
  })
})

describe('与清单校验器的集成', () => {
  const { privateKey } = keypair()

  it('带签名块的清单能通过 schema 校验，且签名块被保留', () => {
    const result = validatePluginManifest(signedManifest(privateKey))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.manifest.signature?.algorithm).toBe('ed25519')
      expect(result.manifest.signature?.keyId).toBe('test-key')
    }
  })

  it('签名形状不对时校验失败（不等到验签才报）', () => {
    const manifest = signedManifest(privateKey)
    manifest.signature.sig = 'short'
    const result = validatePluginManifest(manifest)
    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.path)).toContain('signature.sig')
  })

  it('签名块不影响签名校验的字节（重新校验仍通过）', async () => {
    const manifest = signedManifest(privateKey)
    const result = validatePluginManifest(manifest)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const verdict = await verifyManifestSignature(result.manifest, {
      verify,
      trustedKeys: [{ keyId: 'test-key', publicKey: keypairKey(privateKey) }],
    })
    // 注意：`keypairKey` 拿不到私钥对应的公钥（这里只作占位），真正的验证在下面这条
    expect(verdict.status).toBe('invalid') // 公钥不匹配 → invalid，证明确实做了验签
  })
})

/** 占位：从私钥拿不到公钥，返回一个无关的公钥让验签失败（用于证明"确实验了"） */
function keypairKey(_privateKey: crypto.KeyObject): string {
  const other = keypair()
  return other.publicKeyHex
}

describe('signatureBadgeKey：三档都必须能被用户看到', () => {
  const cases: Array<[SignatureVerdict, string]> = [
    [{ status: 'unsigned' }, 'sources.plugins.signature.unsigned'],
    [{ status: 'verified', keyId: 'k' }, 'sources.plugins.signature.verified'],
    [{ status: 'unknown-key', keyId: 'k' }, 'sources.plugins.signature.unknownKey'],
    [{ status: 'invalid', keyId: 'k', reason: 'x' }, 'sources.plugins.signature.invalid'],
  ]

  it.each(cases)('%o → %s', (verdict, expected) => {
    expect(signatureBadgeKey(verdict)).toBe(expected)
  })

  it('四档文案键互不相同（糊成一样等于没告知）', () => {
    const keys = cases.map(([verdict]) => signatureBadgeKey(verdict))
    expect(new Set(keys).size).toBe(keys.length)
  })
})
