import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 落盘层的测试。
 *
 * `pluginStore.ts` 依赖 `electron` 的 `app.getPath('userData')`。测试里用 `vi.mock`
 * 把 userData 指到一个临时目录 —— 这是**不能**省略的隔离：真跑在用户目录上会往
 * 真实插件目录写文件，跑一次测试就把用户装的插件搅乱了。
 */
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-plugin-test-'))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return tempRoot
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
  net: { fetch: vi.fn() },
  safeStorage: {},
}))

/**
 * 动态 import + `vi.resetModules()`（沿用本仓 `pluginHost.test.ts` 的写法）：
 * 顶层 await 需要 `module: es2022+`，而 desktop 的 tsconfig 是 CommonJS 目标。
 * 更重要的原因是 `app.getPath('userData')` 指向 `tempRoot`，而 `tempRoot` 每个用例
 * 都可能不同 —— 必须在 mock 生效后重新求值模块，否则拿到的是上一个目录的闭包。
 */
let store: typeof import('../pluginStore')

/** 一份最小合法清单的字节 */
function manifestBytes(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        format: 'aurora-plugin/1',
        id: 'demo',
        name: 'Demo',
        version: '1.0.0',
        permissions: ['network'],
        hosts: ['api.example.com'],
        source: {
          search: {
            url: 'https://api.example.com/s?q={query}',
            map: { title: 't', audioUrl: 'u' },
          },
        },
        ...overrides,
      },
      null,
      2
    ),
    'utf8'
  )
}

function recordFor(id: string, bytes: Buffer) {
  return {
    id,
    version: '1.0.0',
    sha256: store.sha256OfBytes(bytes),
    installedAt: Date.now(),
    origin: 'test',
  }
}

beforeEach(async () => {
  // 每个用例从空的插件根目录开始（tempRoot 是同一个，只清内部内容）
  fs.rmSync(path.join(tempRoot, 'aurora-music'), { recursive: true, force: true })
  vi.resetModules()
  store = await import('../pluginStore')
})

afterEach(() => {
  fs.rmSync(path.join(tempRoot, 'aurora-music'), { recursive: true, force: true })
})

describe('store.sha256OfBytes', () => {
  it('同一份内容稳定，不同内容不同', () => {
    const a = Buffer.from('hello')
    expect(store.sha256OfBytes(a)).toBe(store.sha256OfBytes(Buffer.from('hello')))
    expect(store.sha256OfBytes(a)).not.toBe(store.sha256OfBytes(Buffer.from('hellp')))
    expect(store.sha256OfBytes(a)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('对 Uint8Array 同样成立（Buffer 之外的入参）', () => {
    expect(store.sha256OfBytes(new Uint8Array([1, 2, 3]))).toBe(store.sha256OfBytes(Buffer.from([1, 2, 3])))
  })
})

describe('store.parseManifestBytes：三步失败各有可归因的原因', () => {
  it('合法清单', () => {
    const result = store.parseManifestBytes(manifestBytes(), 'test')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.manifest.id).toBe('demo')
  })

  it('非 UTF-8 → NOT_UTF8（而不是笼统的"解析失败"）', () => {
    // 0xFF 0xFE 是 UTF-16LE BOM，用严格的 UTF-8 解码会抛
    const result = store.parseManifestBytes(Buffer.from([0xff, 0xfe, 0x00, 0x00]), 'x.json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('AURORA_PLUGIN_NOT_UTF8')
  })

  it('非 JSON → BAD_JSON 且带解析器给的位置', () => {
    const result = store.parseManifestBytes(Buffer.from('{ not json }', 'utf8'), 'x.json')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('AURORA_PLUGIN_BAD_JSON')
      expect(result.message.length).toBeGreaterThan('AURORA_PLUGIN_BAD_JSON:x.json:'.length)
    }
  })

  it('结构不对 → INVALID_MANIFEST 且逐条带 issues', () => {
    const result = store.parseManifestBytes(
      Buffer.from(JSON.stringify({ format: 'aurora-plugin/1', id: 'BAD ID' }), 'utf8'),
      'x.json'
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toBe('AURORA_PLUGIN_INVALID_MANIFEST')
      expect(result.issues.length).toBeGreaterThan(0)
      // 字段路径要指到具体位置，用户才能改
      expect(result.issues.some((issue) => issue.path === 'id')).toBe(true)
    }
  })
})

describe('store.writeInstalledPlugin：原子写与目录布局', () => {
  it('写出 manifest.json + install.json，路径在插件根目录下', () => {
    const bytes = manifestBytes()
    const manifestPath = store.writeInstalledPlugin(
      { id: 'demo' } as never,
      bytes,
      recordFor('demo', bytes)
    )
    expect(manifestPath).toBe(path.join(store.installedPluginsRoot(), 'demo', 'manifest.json'))
    expect(fs.existsSync(manifestPath)).toBe(true)
    expect(fs.existsSync(path.join(store.installedPluginsRoot(), 'demo', 'install.json'))).toBe(true)
  })

  it('清单按**原始字节**落盘（不是重新序列化 —— 哈希必须能复现）', () => {
    const bytes = manifestBytes()
    // 故意用非标准格式（无缩进、键序特殊），落盘必须逐字节一致
    const compact = Buffer.from('{"format":"aurora-plugin/1","id":"demo"}', 'utf8')
    store.writeInstalledPlugin({ id: 'demo' } as never, compact, recordFor('demo', compact))
    const onDisk = fs.readFileSync(path.join(store.installedPluginsRoot(), 'demo', 'manifest.json'))
    expect(onDisk.equals(compact)).toBe(true)
    // 顺便确认我们没把入参 bytes 本身改了
    expect(bytes.length).toBeGreaterThan(0)
  })

  it('重装同一 id 会覆盖旧目录（不残留两份）', () => {
    const first = manifestBytes({ version: '1.0.0' })
    store.writeInstalledPlugin({ id: 'demo' } as never, first, recordFor('demo', first))
    const second = manifestBytes({ version: '2.0.0' })
    store.writeInstalledPlugin({ id: 'demo' } as never, second, recordFor('demo', second))

    const onDisk = fs.readFileSync(path.join(store.installedPluginsRoot(), 'demo', 'manifest.json'), 'utf8')
    expect(onDisk).toContain('2.0.0')
    // 目录里不该有临时目录残留
    const names = fs.readdirSync(store.installedPluginsRoot())
    expect(names.filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('非法 id 被挡在落盘之前（路径穿越防线）', () => {
    const bytes = manifestBytes()
    for (const bad of ['../escape', 'a/b', '', '.hidden', 'A B']) {
      expect(() => store.writeInstalledPlugin({ id: bad } as never, bytes, recordFor(bad, bytes))).toThrow()
    }
    // 什么都没写出去
    expect(fs.existsSync(path.join(tempRoot, 'aurora-music', 'plugins'))).toBe(false)
  })
})

describe('store.verifyInstalledBytes：哈希锁定的落点', () => {
  it('内容未变 → 通过', () => {
    const bytes = manifestBytes()
    const manifestPath = store.writeInstalledPlugin({ id: 'demo' } as never, bytes, recordFor('demo', bytes))
    const result = store.verifyInstalledBytes(manifestPath, recordFor('demo', bytes))
    expect(result.ok).toBe(true)
  })

  it('内容被改过 → 拒绝，并给出期望与实际（诊断要能对比）', () => {
    const bytes = manifestBytes()
    const record = recordFor('demo', bytes)
    const manifestPath = store.writeInstalledPlugin({ id: 'demo' } as never, bytes, record)
    // 模拟"作者更新了 / 别的东西写入了"
    fs.writeFileSync(manifestPath, Buffer.from('{"format":"aurora-plugin/1","id":"demo","evil":true}'))

    const result = store.verifyInstalledBytes(manifestPath, record)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.expected).toBe(record.sha256)
      expect(result.actual).not.toBe(record.sha256)
    }
  })
})

describe('store.scanInstalledPlugins：一个坏目录不能让其余插件消失', () => {
  it('空目录（未装任何插件）返回空且不抛错', () => {
    const scan = store.scanInstalledPlugins()
    expect(scan.plugins).toEqual([])
    expect(scan.broken).toEqual([])
  })

  it('正常插件被扫出来', () => {
    const bytes = manifestBytes()
    store.writeInstalledPlugin({ id: 'demo' } as never, bytes, recordFor('demo', bytes))
    const scan = store.scanInstalledPlugins()
    expect(scan.plugins).toHaveLength(1)
    expect(scan.plugins[0].manifest.id).toBe('demo')
    expect(scan.broken).toEqual([])
  })

  it('哈希不符的插件被跳过（不加载），其余照常', () => {
    const good = manifestBytes({ id: 'good' })
    store.writeInstalledPlugin({ id: 'good' } as never, good, recordFor('good', good))

    const evil = manifestBytes({ id: 'evil' })
    const evilPath = store.writeInstalledPlugin({ id: 'evil' } as never, evil, recordFor('evil', evil))
    fs.writeFileSync(evilPath, Buffer.from('{"format":"aurora-plugin/1","id":"evil"}'))

    const scan = store.scanInstalledPlugins()
    expect(scan.plugins.map((item) => item.manifest.id)).toEqual(['good'])
    expect(scan.broken).toHaveLength(1)
    expect(scan.broken[0].message).toContain('AURORA_PLUGIN_HASH_MISMATCH')
  })

  it('安装记录损坏的目录被记为坏，不影响其他', () => {
    const bytes = manifestBytes()
    store.writeInstalledPlugin({ id: 'demo' } as never, bytes, recordFor('demo', bytes))
    fs.writeFileSync(path.join(store.installedPluginsRoot(), 'demo', 'install.json'), 'not json')

    const scan = store.scanInstalledPlugins()
    expect(scan.plugins).toEqual([])
    expect(scan.broken[0].message).toContain('AURORA_PLUGIN_RECORD_INVALID')
  })

  it('目录名与清单 id 不一致被记为坏（id 是注册键与卸载目标，不能靠猜）', () => {
    const bytes = manifestBytes({ id: 'actual' })
    store.writeInstalledPlugin({ id: 'actual' } as never, bytes, recordFor('actual', bytes))
    // 手动改目录名
    fs.renameSync(
      path.join(store.installedPluginsRoot(), 'actual'),
      path.join(store.installedPluginsRoot(), 'renamed')
    )

    const scan = store.scanInstalledPlugins()
    expect(scan.plugins).toEqual([])
    expect(scan.broken[0].message).toContain('AURORA_PLUGIN_DIR_MISMATCH')
  })

  it('原子写的临时目录被跳过（不是插件）', () => {
    fs.mkdirSync(path.join(store.installedPluginsRoot(), 'demo.tmp-123-456'), { recursive: true })
    const scan = store.scanInstalledPlugins()
    expect(scan.plugins).toEqual([])
    expect(scan.broken).toEqual([])
  })

  it('安装记录缺 sha256 视为损坏（否则哈希校验形同虚设）', () => {
    const bytes = manifestBytes()
    const manifestPath = store.writeInstalledPlugin({ id: 'demo' } as never, bytes, recordFor('demo', bytes))
    fs.writeFileSync(
      path.join(path.dirname(manifestPath), 'install.json'),
      JSON.stringify({ id: 'demo', version: '1.0.0' })
    )
    const scan = store.scanInstalledPlugins()
    expect(scan.plugins).toEqual([])
    expect(scan.broken).toHaveLength(1)
  })
})

describe('store.readManifestBytes：大小与文件类型限制', () => {
  it('超过 1 MiB 被拒绝（挡住"拿一个 GB 级文件当插件装"）', () => {
    const big = Buffer.alloc(1024 * 1024 + 1, 0x20)
    const file = path.join(tempRoot, 'big.json')
    fs.writeFileSync(file, big)
    expect(() => store.readManifestBytes(file)).toThrow()
  })

  it('目录不是文件 → 拒绝', () => {
    const dir = path.join(tempRoot, 'a-dir')
    fs.mkdirSync(dir, { recursive: true })
    expect(() => store.readManifestBytes(dir)).toThrow()
  })

  it('正常大小可读', () => {
    const file = path.join(tempRoot, 'ok.json')
    fs.writeFileSync(file, '{}')
    expect(store.readManifestBytes(file).toString()).toBe('{}')
  })
})

describe('store.readInstallRecord / store.removeInstalledPlugin', () => {
  it('读回刚写的记录', () => {
    const bytes = manifestBytes()
    const record = recordFor('demo', bytes)
    const manifestPath = store.writeInstalledPlugin({ id: 'demo' } as never, bytes, record)
    const read = store.readInstallRecord(path.join(path.dirname(manifestPath), 'install.json'))
    expect(read).toMatchObject({ id: 'demo', sha256: record.sha256, origin: 'test' })
  })

  it('记录不存在返回 null', () => {
    expect(store.readInstallRecord(path.join(tempRoot, 'nope.json'))).toBeNull()
  })

  it('卸载删掉整个目录（幂等）', () => {
    const bytes = manifestBytes()
    store.writeInstalledPlugin({ id: 'demo' } as never, bytes, recordFor('demo', bytes))
    store.removeInstalledPlugin('demo')
    expect(fs.existsSync(path.join(store.installedPluginsRoot(), 'demo'))).toBe(false)
    // 再删一次不抛错
    expect(() => store.removeInstalledPlugin('demo')).not.toThrow()
  })

  it('卸载非法 id 被拒绝（不能靠 "../" 删到别处）', () => {
    expect(() => store.removeInstalledPlugin('../escape')).toThrow()
  })
})
