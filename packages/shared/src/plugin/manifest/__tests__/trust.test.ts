import { describe, expect, it } from 'vitest'
import {
  mergeTrustedKeys,
  parseTrustedKeys,
  removeTrustedKey,
  serializeTrustedKeys,
  validateTrustedKey,
  type TrustedKey,
} from '../trust'

/** 一条合法公钥（32 字节 hex） */
const KEY = 'a'.repeat(64)
const KEY2 = 'b'.repeat(64)

describe('validateTrustedKey：导入前校验', () => {
  it('合法输入通过并带上导入时间', () => {
    const result = validateTrustedKey({ keyId: 'my-registry', publicKey: KEY })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.key.keyId).toBe('my-registry')
      expect(result.key.publicKey).toBe(KEY)
      expect(result.key.addedAt).toBeGreaterThan(0)
    }
  })

  it('公钥统一归一为小写（用户可能粘贴大写）', () => {
    const result = validateTrustedKey({ keyId: 'k', publicKey: KEY.toUpperCase() })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.key.publicKey).toBe(KEY)
  })

  it('备注是可选；给了就保留', () => {
    const withNote = validateTrustedKey({ keyId: 'k', publicKey: KEY, note: ' 内部源 ' })
    expect(withNote.ok).toBe(true)
    if (withNote.ok) expect(withNote.key.note).toBe('内部源')

    const withoutNote = validateTrustedKey({ keyId: 'k', publicKey: KEY, note: '   ' })
    expect(withoutNote.ok).toBe(true)
    if (withoutNote.ok) expect(withoutNote.key.note).toBeUndefined()
  })

  it.each([
    ['', '空 keyId'],
    ['-lead', '短横开头'],
    ['has space', '含空格'],
    ['has/slash', '含斜杠'],
    ['a'.repeat(65), '超长'],
  ])('keyId %s（%s）→ bad-key-id', (keyId) => {
    const result = validateTrustedKey({ keyId, publicKey: KEY })
    expect(result).toEqual({ ok: false, code: 'bad-key-id' })
  })

  it.each([
    ['', '空'],
    ['abc', '太短'],
    ['g'.repeat(64), '非 hex'],
    ['a'.repeat(63), '63 位'],
    ['a'.repeat(65), '65 位'],
    ['a'.repeat(128), '签名长度的 hex（不是公钥）'],
  ])('公钥 %s（%s）→ bad-public-key', (publicKey) => {
    const result = validateTrustedKey({ keyId: 'k', publicKey })
    expect(result).toEqual({ ok: false, code: 'bad-public-key' })
  })

  it('备注超长 → note-too-long', () => {
    const result = validateTrustedKey({ keyId: 'k', publicKey: KEY, note: 'x'.repeat(121) })
    expect(result).toEqual({ ok: false, code: 'note-too-long' })
  })

  it('同 keyId 已存在 → duplicate（不静默覆盖：那是替换信任根）', () => {
    const existing: TrustedKey[] = [{ keyId: 'my-registry', publicKey: KEY }]
    const result = validateTrustedKey({ keyId: 'my-registry', publicKey: KEY2 }, existing)
    expect(result).toEqual({ ok: false, code: 'duplicate' })
  })

  it('查重不区分大小写（避免 My-Key 与 my-key 各存一份）', () => {
    const existing: TrustedKey[] = [{ keyId: 'My-Key', publicKey: KEY }]
    expect(validateTrustedKey({ keyId: 'my-key', publicKey: KEY2 }, existing)).toEqual({
      ok: false,
      code: 'duplicate',
    })
  })

  it('非字符串入参按"格式不对"处理（入参可能来自未校验的 UI）', () => {
    expect(validateTrustedKey({ keyId: 42, publicKey: KEY })).toEqual({ ok: false, code: 'bad-key-id' })
    expect(validateTrustedKey({ keyId: 'k', publicKey: null })).toEqual({ ok: false, code: 'bad-public-key' })
  })
})

describe('mergeTrustedKeys：内置 ∪ 用户，用户优先', () => {
  it('两表并集', () => {
    const builtin: TrustedKey[] = [{ keyId: 'official', publicKey: KEY }]
    const user: TrustedKey[] = [{ keyId: 'mine', publicKey: KEY2 }]
    const merged = mergeTrustedKeys(builtin, user)
    expect(merged.map((key) => key.keyId).sort()).toEqual(['mine', 'official'])
  })

  it('同 keyId 时以用户表为准（用户显式导入的意图更强）', () => {
    const builtin: TrustedKey[] = [{ keyId: 'shared', publicKey: KEY }]
    const user: TrustedKey[] = [{ keyId: 'shared', publicKey: KEY2 }]
    const merged = mergeTrustedKeys(builtin, user)
    expect(merged).toHaveLength(1)
    expect(merged[0].publicKey).toBe(KEY2)
  })

  it('内置条目不会被用户的其它 key 挤掉（将来真有官方公钥时的保护）', () => {
    const builtin: TrustedKey[] = [{ keyId: 'official', publicKey: KEY }]
    const user: TrustedKey[] = [{ keyId: 'mine', publicKey: KEY2 }]
    const merged = mergeTrustedKeys(builtin, user)
    expect(merged.some((key) => key.keyId === 'official')).toBe(true)
  })

  it('内置条目补 addedAt=0（表示随应用发布）', () => {
    const merged = mergeTrustedKeys([{ keyId: 'official', publicKey: KEY }], [])
    expect(merged[0].addedAt).toBe(0)
  })

  it('空表安全', () => {
    expect(mergeTrustedKeys([], [])).toEqual([])
  })
})

describe('removeTrustedKey：内置不可删', () => {
  const builtin: TrustedKey[] = [{ keyId: 'official', publicKey: KEY }]
  const user: TrustedKey[] = [
    { keyId: 'mine', publicKey: KEY2 },
    { keyId: 'also-mine', publicKey: 'c'.repeat(64) },
  ]

  it('删用户条目成功', () => {
    const result = removeTrustedKey(user, 'mine', builtin)
    expect(result.removed).toBe(true)
    expect(result.keys.map((key) => key.keyId)).toEqual(['also-mine'])
  })

  it('删内置条目被拒绝（删了重启又回来，那种体验更糟）', () => {
    const result = removeTrustedKey(user, 'official', builtin)
    expect(result.removed).toBe(false)
    expect(result.keys).toHaveLength(2)
  })

  it('删不存在的条目返回 false 且不改表', () => {
    const result = removeTrustedKey(user, 'nope', builtin)
    expect(result.removed).toBe(false)
    expect(result.keys).toHaveLength(2)
  })

  it('大小写不敏感', () => {
    const result = removeTrustedKey(user, 'MINE', builtin)
    expect(result.removed).toBe(true)
  })

  it('空 keyId 安全', () => {
    expect(removeTrustedKey(user, '', builtin).removed).toBe(false)
  })
})

describe('parseTrustedKeys：容错解析（一条坏不让整表失效）', () => {
  it('正常数组', () => {
    const keys = parseTrustedKeys([
      { keyId: 'a', publicKey: KEY, note: 'n', addedAt: 123 },
      { keyId: 'b', publicKey: KEY2 },
    ])
    expect(keys).toHaveLength(2)
    expect(keys[0]).toMatchObject({ keyId: 'a', publicKey: KEY, note: 'n', addedAt: 123 })
  })

  it('非数组返回空', () => {
    expect(parseTrustedKeys(null)).toEqual([])
    expect(parseTrustedKeys({})).toEqual([])
    expect(parseTrustedKeys('x')).toEqual([])
  })

  it('坏条目被跳过，好条目保留（关键：信任表坏了不该让所有插件失效）', () => {
    const keys = parseTrustedKeys([
      { keyId: 'good', publicKey: KEY },
      { keyId: 'bad', publicKey: 'short' },
      { publicKey: KEY2 },
      { keyId: 'no-key' },
      null,
      'string',
      { keyId: 'good2', publicKey: KEY2 },
    ])
    expect(keys.map((key) => key.keyId)).toEqual(['good', 'good2'])
  })

  it('重复 keyId 只留第一条', () => {
    const keys = parseTrustedKeys([
      { keyId: 'dup', publicKey: KEY },
      { keyId: 'dup', publicKey: KEY2 },
    ])
    expect(keys).toHaveLength(1)
    expect(keys[0].publicKey).toBe(KEY)
  })

  it('公钥归一为小写', () => {
    const keys = parseTrustedKeys([{ keyId: 'k', publicKey: KEY.toUpperCase() }])
    expect(keys[0].publicKey).toBe(KEY)
  })

  it('备注超长时截断而不是丢弃整条（备注是附属信息）', () => {
    const keys = parseTrustedKeys([{ keyId: 'k', publicKey: KEY, note: 'x'.repeat(200) }])
    expect(keys).toHaveLength(1)
    expect(keys[0].note!.length).toBe(120)
  })
})

describe('serializeTrustedKeys：落盘形状稳定', () => {
  it('往返一致', () => {
    const keys: TrustedKey[] = [
      { keyId: 'a', publicKey: KEY, note: 'n', addedAt: 1 },
      { keyId: 'b', publicKey: KEY2, addedAt: 2 },
    ]
    const parsed = parseTrustedKeys(JSON.parse(serializeTrustedKeys(keys)))
    expect(parsed).toEqual(keys)
  })

  it('只序列化契约字段（未知字段不落盘，便于人工检查）', () => {
    const json = JSON.parse(serializeTrustedKeys([{ keyId: 'k', publicKey: KEY, evil: true } as never]))
    expect(Object.keys(json[0]).sort()).toEqual(['addedAt', 'keyId', 'publicKey'])
  })

  it('空表 → 空数组 JSON', () => {
    expect(JSON.parse(serializeTrustedKeys([]))).toEqual([])
  })
})
