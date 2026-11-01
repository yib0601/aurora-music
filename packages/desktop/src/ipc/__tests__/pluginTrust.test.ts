import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 信任表落盘层的测试。
 *
 * userData 指到临时目录（与 `pluginStore.test.ts` 同一隔离方式）：
 * 真跑在用户目录上会覆盖用户真实的信任根 —— 那比覆盖插件目录更糟，
 * 因为它决定"哪些插件被判为已验证"。
 */
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-plugin-trust-'))

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot },
  ipcMain: { handle: vi.fn() },
}))

/** 合法公钥（32 字节 hex） */
const KEY = 'a'.repeat(64)
const KEY2 = 'b'.repeat(64)

let trust: typeof import('../pluginTrust')

beforeEach(async () => {
  fs.rmSync(path.join(tempRoot, 'aurora-music'), { recursive: true, force: true })
  vi.resetModules()
  trust = await import('../pluginTrust')
})

afterEach(() => {
  fs.rmSync(path.join(tempRoot, 'aurora-music'), { recursive: true, force: true })
})

describe('读写往返', () => {
  it('文件不存在时读空表', () => {
    expect(trust.readUserTrustedKeys()).toEqual([])
  })

  it('写入后能读回', () => {
    trust.writeUserTrustedKeys([{ keyId: 'mine', publicKey: KEY, note: 'n', addedAt: 1 }])
    expect(trust.readUserTrustedKeys()).toEqual([{ keyId: 'mine', publicKey: KEY, note: 'n', addedAt: 1 }])
  })

  it('文件落在 <userData>/aurora-music/plugin-trust.json', () => {
    trust.writeUserTrustedKeys([{ keyId: 'mine', publicKey: KEY }])
    expect(fs.existsSync(path.join(tempRoot, 'aurora-music', 'plugin-trust.json'))).toBe(true)
  })

  it('写入不留下 .tmp 残留（原子写）', () => {
    trust.writeUserTrustedKeys([{ keyId: 'mine', publicKey: KEY }])
    const dir = path.join(tempRoot, 'aurora-music')
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('文件权限 0600（不含秘密，但不给同机其它用户可读）', () => {
    trust.writeUserTrustedKeys([{ keyId: 'mine', publicKey: KEY }])
    const stat = fs.statSync(path.join(tempRoot, 'aurora-music', 'plugin-trust.json'))
    // Windows 上 mode 语义不同，只在 POSIX 下断言
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600)
    }
  })
})

describe('容错：损坏的信任表不能阻止插件功能', () => {
  it('文件损坏 → 读空表而不是抛错', () => {
    const file = path.join(tempRoot, 'aurora-music', 'plugin-trust.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ this is not json')
    // 抛错会让"所有插件都加载失败"，而真实原因是信任表文件坏了
    expect(trust.readUserTrustedKeys()).toEqual([])
  })

  it('文件是 JSON 但不是数组 → 空表', () => {
    const file = path.join(tempRoot, 'aurora-music', 'plugin-trust.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{"keyId":"x"}')
    expect(trust.readUserTrustedKeys()).toEqual([])
  })

  it('单条坏数据被跳过，好数据保留', () => {
    const file = path.join(tempRoot, 'aurora-music', 'plugin-trust.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify([
        { keyId: 'good', publicKey: KEY },
        { keyId: 'bad', publicKey: 'short' },
      ])
    )
    expect(trust.readUserTrustedKeys().map((key) => key.keyId)).toEqual(['good'])
  })
})

describe('effectiveTrustedKeys：内置 ∪ 用户', () => {
  it('无用户表时等于内置表（当前为空）', () => {
    expect(trust.effectiveTrustedKeys()).toEqual([])
  })

  it('导入后出现在生效表里', () => {
    trust.writeUserTrustedKeys([{ keyId: 'mine', publicKey: KEY }])
    const effective = trust.effectiveTrustedKeys()
    expect(effective.map((key) => key.keyId)).toEqual(['mine'])
  })
})

describe('trustTableSnapshot：UI 需要"哪些能删"的信息', () => {
  it('把用户导入的与内置的分开列', () => {
    trust.writeUserTrustedKeys([{ keyId: 'mine', publicKey: KEY }])
    const snapshot = trust.trustTableSnapshot()
    expect(snapshot.user.map((key) => key.keyId)).toEqual(['mine'])
    // 内置表当前为空（TRUSTED_PLUGIN_KEYS 默认 []）
    expect(snapshot.builtin).toEqual([])
    expect(snapshot.effective).toBe(1)
  })

  it('空表时三类都为空', () => {
    const snapshot = trust.trustTableSnapshot()
    expect(snapshot).toEqual({ builtin: [], user: [], effective: 0 })
  })
})
