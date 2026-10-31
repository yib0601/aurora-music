import { describe, expect, it, beforeEach, vi } from 'vitest'

/**
 * 移动端插件落盘层的测试。
 *
 * Capacitor Filesystem 用**内存文件系统**打桩（与既有 `mediaCache.test.ts` 同一做法）：
 * 真设备上它是原生桥，在 Node 里不存在；而这里要验的正是
 * 「目录布局 / 哈希校验 / 原子写 / 一坏不坏全体」这些与平台无关的纪律。
 *
 * CapacitorHttp 同样打桩：下载逻辑要能在不联网的情况下验证失败分类
 * （HTTP 非 2xx / 超限 / 空体 / 哈希不符）。
 */

/** 内存文件系统：path → 文本内容 */
const files = new Map<string, string>()

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    async mkdir({ path }: { path: string }) {
      // 已存在时不抛（真实实现在 recursive 时也容忍已存在）
      return
    },
    async writeFile({ path, data }: { path: string; data: string }) {
      files.set(path, data)
    },
    async readFile({ path }: { path: string }) {
      const value = files.get(path)
      if (value === undefined) throw new Error('File does not exist')
      return { data: value }
    },
    async readdir({ path }: { path: string }) {
      // 只回该目录下的直接子项（目录名去重），模拟真实 readdir
      const prefix = `${path}/`
      const names = new Set<string>()
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const head = rest.split('/')[0]
        if (head) names.add(head)
      }
      return { files: [...names].map((name) => ({ name })) }
    },
    async rmdir({ path }: { path: string }) {
      const prefix = `${path}`
      let removed = false
      for (const key of [...files.keys()]) {
        if (key === prefix || key.startsWith(`${prefix}/`)) {
          files.delete(key)
          removed = true
        }
      }
      if (!removed) throw new Error('Directory does not exist')
    },
    async stat({ path }: { path: string }) {
      const prefix = `${path}/`
      if (!files.has(path) && ![...files.keys()].some((key) => key.startsWith(prefix))) {
        throw new Error('Not found')
      }
      return { type: 'directory' }
    },
  },
}))

/** CapacitorHttp 打桩：每个用例设置 response */
const httpResponses: Array<{ status: number; data: unknown }> = []

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
  CapacitorHttp: {
    async get() {
      const next = httpResponses.shift()
      if (!next) throw new Error('no stubbed response')
      return next
    },
  },
}))

const {
  parseManifestText,
  readInstallRecord,
  removeInstalledPlugin,
  scanInstalledPlugins,
  sha256OfBytes,
  writeInstalledPlugin,
} = await import('../pluginStore')

const { installFromUrl, performInstall, performUninstall, listCatalogEntries, resetInstallingFlagForTest } =
  await import('../pluginInstall')

const shared = await import('@aurora/shared')

function manifestText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      format: 'aurora-plugin/1',
      id: 'demo',
      name: { 'zh-CN': '演示插件', en: 'Demo' },
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
  )
}

function recordFor(id: string, sha: string) {
  return { id, version: '1.0.0', sha256: sha, installedAt: Date.now(), origin: 'test' }
}

beforeEach(() => {
  files.clear()
  httpResponses.length = 0
  resetInstallingFlagForTest()
  shared.clearPluginsForTest()
  shared.clearInstalledForTest()
  shared.resetBuiltinsRegistrationForTest()
})

describe('sha256OfBytes（WebCrypto）', () => {
  it('与已知向量一致（空串 / abc）', async () => {
    expect(await sha256OfBytes(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
    expect(await sha256OfBytes(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })

  it('返回 64 位小写 hex', async () => {
    const hash = await sha256OfBytes(new TextEncoder().encode('hello'))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('parseManifestText：三步失败分类', () => {
  it('合法清单', () => {
    const result = parseManifestText(manifestText(), 'x')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.manifest.id).toBe('demo')
  })

  it('非 JSON → BAD_JSON（带解析器位置）', () => {
    const result = parseManifestText('{ nope }', 'x.json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('AURORA_PLUGIN_BAD_JSON')
  })

  it('结构不对 → INVALID_MANIFEST 且逐条带 issues', () => {
    const result = parseManifestText(JSON.stringify({ format: 'aurora-plugin/1', id: 'BAD ID' }), 'x')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toBe('AURORA_PLUGIN_INVALID_MANIFEST')
      expect(result.issues.length).toBeGreaterThan(0)
    }
  })
})

describe('writeInstalledPlugin：目录布局与原子替换', () => {
  it('写出 manifest.json + install.json', async () => {
    const text = manifestText()
    const sha = await sha256OfBytes(new TextEncoder().encode(text))
    await writeInstalledPlugin({ id: 'demo' } as never, text, recordFor('demo', sha))

    expect(files.has('plugins/demo/manifest.json')).toBe(true)
    expect(files.has('plugins/demo/install.json')).toBe(true)
    // 清单按原始文本落盘（哈希必须可复现）
    expect(files.get('plugins/demo/manifest.json')).toBe(text)
  })

  it('B 档脚本正文一并落盘', async () => {
    const text = manifestText({
      permissions: ['network', 'script'],
      script: { url: 'https://api.example.com/s.js' },
    })
    const sha = await sha256OfBytes(new TextEncoder().encode(text))
    await writeInstalledPlugin({ id: 'demo' } as never, text, recordFor('demo', sha), 'lx.on()')
    expect(files.get('plugins/demo/script.js')).toBe('lx.on()')
  })

  it('重装同一 id 覆盖旧目录，不留临时目录', async () => {
    const first = manifestText({ version: '1.0.0' })
    const sha1 = await sha256OfBytes(new TextEncoder().encode(first))
    await writeInstalledPlugin({ id: 'demo' } as never, first, recordFor('demo', sha1))

    const second = manifestText({ version: '2.0.0' })
    const sha2 = await sha256OfBytes(new TextEncoder().encode(second))
    await writeInstalledPlugin({ id: 'demo' } as never, second, recordFor('demo', sha2))

    expect(files.get('plugins/demo/manifest.json')).toContain('2.0.0')
    expect([...files.keys()].filter((key) => key.includes('.tmp-'))).toEqual([])
  })

  it('非法 id 被挡在落盘之前（路径穿越防线）', async () => {
    const text = manifestText()
    for (const bad of ['../escape', 'a/b', '']) {
      await expect(writeInstalledPlugin({ id: bad } as never, text, recordFor(bad, 'x'))).rejects.toThrow()
    }
  })
})

describe('scanInstalledPlugins：一坏不坏全体', () => {
  it('空目录返回空', async () => {
    const scan = await scanInstalledPlugins()
    expect(scan.plugins).toEqual([])
    expect(scan.broken).toEqual([])
  })

  it('正常插件被扫出来', async () => {
    const text = manifestText()
    const sha = await sha256OfBytes(new TextEncoder().encode(text))
    await writeInstalledPlugin({ id: 'demo' } as never, text, recordFor('demo', sha))

    const scan = await scanInstalledPlugins()
    expect(scan.plugins).toHaveLength(1)
    expect(scan.plugins[0].manifest.id).toBe('demo')
  })

  it('内容被改过 → 拒绝加载并进 broken（哈希锁定）', async () => {
    const text = manifestText()
    const sha = await sha256OfBytes(new TextEncoder().encode(text))
    await writeInstalledPlugin({ id: 'demo' } as never, text, recordFor('demo', sha))
    // 模拟"别的东西写入了"
    files.set('plugins/demo/manifest.json', '{"format":"aurora-plugin/1","id":"demo","evil":true}')

    const scan = await scanInstalledPlugins()
    expect(scan.plugins).toEqual([])
    expect(scan.broken[0].message).toContain('AURORA_PLUGIN_HASH_MISMATCH')
  })

  it('一个坏目录不影响另一个好插件', async () => {
    const good = manifestText({ id: 'good' })
    const goodSha = await sha256OfBytes(new TextEncoder().encode(good))
    await writeInstalledPlugin({ id: 'good' } as never, good, recordFor('good', goodSha))

    // 手工造一个坏插件
    files.set('plugins/broken/manifest.json', '{}')
    files.set('plugins/broken/install.json', '{"id":"broken","sha256":"deadbeef"}')

    const scan = await scanInstalledPlugins()
    expect(scan.plugins.map((item) => item.manifest.id)).toEqual(['good'])
    expect(scan.broken).toHaveLength(1)
  })

  it('目录名与清单 id 不一致 → broken（id 是注册键与卸载目标）', async () => {
    const text = manifestText({ id: 'actual' })
    const sha = await sha256OfBytes(new TextEncoder().encode(text))
    await writeInstalledPlugin({ id: 'actual' } as never, text, recordFor('actual', sha))
    // 手改目录名
    for (const name of ['manifest.json', 'install.json']) {
      files.set(`plugins/renamed/${name}`, files.get(`plugins/actual/${name}`)!)
      files.delete(`plugins/actual/${name}`)
    }

    const scan = await scanInstalledPlugins()
    expect(scan.plugins).toEqual([])
    expect(scan.broken[0].message).toContain('AURORA_PLUGIN_DIR_MISMATCH')
  })

  it('临时目录被跳过（原子写的残留不是插件）', async () => {
    files.set('plugins/demo.tmp-123/manifest.json', '{}')
    const scan = await scanInstalledPlugins()
    expect(scan.plugins).toEqual([])
    expect(scan.broken).toEqual([])
  })

  it('B 档：脚本哈希不符 → broken', async () => {
    const text = manifestText({
      permissions: ['network', 'script'],
      script: { url: 'https://api.example.com/s.js', sha256: 'a'.repeat(64) },
    })
    const sha = await sha256OfBytes(new TextEncoder().encode(text))
    await writeInstalledPlugin({ id: 'demo' } as never, text, recordFor('demo', sha), 'lx.on()')

    const scan = await scanInstalledPlugins()
    expect(scan.plugins).toEqual([])
    expect(scan.broken[0].message).toContain('AURORA_PLUGIN_SCRIPT_HASH_MISMATCH')
  })

  it('B 档：脚本哈希匹配 → 正常加载且带 scriptBody', async () => {
    const body = 'lx.on("request", () => {})'
    const bodySha = await sha256OfBytes(new TextEncoder().encode(body))
    const text = manifestText({
      permissions: ['network', 'script'],
      script: { url: 'https://api.example.com/s.js', sha256: bodySha },
    })
    const sha = await sha256OfBytes(new TextEncoder().encode(text))
    await writeInstalledPlugin({ id: 'demo' } as never, text, recordFor('demo', sha), body)

    const scan = await scanInstalledPlugins()
    expect(scan.plugins).toHaveLength(1)
    expect(scan.plugins[0].scriptBody).toBe(body)
  })
})

describe('installFromUrl：原生 HTTP 下载 + 校验', () => {
  it('成功安装：磁盘有目录、运行期有实现', async () => {
    httpResponses.push({ status: 200, data: manifestText() })
    const result = await installFromUrl('https://api.example.com/plugin.json', 'zh-CN')

    expect(result.ok).toBe(true)
    expect(files.has('plugins/demo/manifest.json')).toBe(true)
    expect(shared.isInstalledPlugin('demo')).toBe(true)
    expect(shared.getPlugin('demo')).toBeDefined()
  })

  it('HTTP 非 2xx → 拒绝，不留痕迹', async () => {
    httpResponses.push({ status: 404, data: 'not found' })
    const result = await installFromUrl('https://api.example.com/missing.json')
    expect(result.ok).toBe(false)
    expect(files.size).toBe(0)
  })

  it('清单超限 → 拒绝', async () => {
    httpResponses.push({ status: 200, data: 'x'.repeat(1024 * 1024 + 10) })
    const result = await installFromUrl('https://api.example.com/big.json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('AURORA_PLUGIN_TOO_LARGE')
  })

  it('空响应体 → 拒绝', async () => {
    httpResponses.push({ status: 200, data: '   ' })
    const result = await installFromUrl('https://api.example.com/empty.json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('AURORA_PLUGIN_EMPTY_BODY')
  })

  it('非 http(s) 地址 → 拒绝（不从 file:// 装插件）', async () => {
    const result = await installFromUrl('file:///etc/passwd')
    expect(result.ok).toBe(false)
  })

  it('与内置插件撞名 → 拒绝且不覆盖', async () => {
    httpResponses.push({ status: 200, data: manifestText({ id: 'aurora' }) })
    const result = await installFromUrl('https://api.example.com/plugin.json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toBe('AURORA_PLUGIN_BUILTIN_ID')
    expect(shared.getPlugin('aurora')).toBeDefined()
  })

  it('连点重入被挡住（BUSY）', async () => {
    // 第一个请求挂起不返回 → 第二个应当 BUSY
    httpResponses.push({ status: 200, data: manifestText() })
    const first = installFromUrl('https://api.example.com/a.json')
    const second = await installFromUrl('https://api.example.com/b.json')
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.message).toBe('AURORA_PLUGIN_BUSY')
    await first
  })

  it('B 档：脚本随安装一起拉取并落盘', async () => {
    httpResponses.push({ status: 200, data: manifestText({
      id: 'lx-demo',
      permissions: ['network', 'script'],
      source: undefined,
      script: { url: 'https://api.example.com/source.js' },
    }) })
    // 第二次请求是脚本本体
    httpResponses.push({ status: 200, data: 'lx.on("request", () => {})' })

    const result = await installFromUrl('https://api.example.com/plugin.json')
    expect(result.ok).toBe(true)
    expect(files.get('plugins/lx-demo/script.js')).toBe('lx.on("request", () => {})')
    expect(shared.scriptBodyFor('lx-demo')).toBe('lx.on("request", () => {})')
  })

  it('B 档：清单声明脚本哈希且不匹配 → 拒绝，不留半成品', async () => {
    httpResponses.push({ status: 200, data: manifestText({
      id: 'lx-demo',
      permissions: ['network', 'script'],
      source: undefined,
      script: { url: 'https://api.example.com/source.js', sha256: 'a'.repeat(64) },
    }) })
    httpResponses.push({ status: 200, data: 'lx.on("request", () => {})' })

    const result = await installFromUrl('https://api.example.com/plugin.json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('AURORA_PLUGIN_SCRIPT_HASH_MISMATCH')
    expect(files.size).toBe(0)
    expect(shared.isInstalledPlugin('lx-demo')).toBe(false)
  })

  it('B 档：脚本下载失败 → 整次安装失败', async () => {
    httpResponses.push({ status: 200, data: manifestText({
      id: 'lx-demo',
      permissions: ['network', 'script'],
      source: undefined,
      script: { url: 'https://api.example.com/source.js' },
    }) })
    httpResponses.push({ status: 500, data: 'boom' })

    const result = await installFromUrl('https://api.example.com/plugin.json')
    expect(result.ok).toBe(false)
    expect(files.size).toBe(0)
  })
})

describe('performUninstall：同时摘运行期与磁盘', () => {
  it('卸载后磁盘目录与注册表都没了', async () => {
    httpResponses.push({ status: 200, data: manifestText() })
    await installFromUrl('https://api.example.com/plugin.json')
    expect(shared.getPlugin('demo')).toBeDefined()

    const result = await performUninstall('demo')
    expect(result.ok).toBe(true)
    expect(files.has('plugins/demo/manifest.json')).toBe(false)
    expect(shared.getPlugin('demo')).toBeUndefined()
  })

  it('卸载未安装的 id → NOT_INSTALLED', async () => {
    const result = await performUninstall('nope')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toBe('AURORA_PLUGIN_NOT_INSTALLED')
  })
})

describe('listCatalogEntries：反映真实状态', () => {
  it('未装插件时只有内置条目', async () => {
    const { entries, broken } = await listCatalogEntries('zh-CN')
    expect(broken).toEqual([])
    expect(entries.every((entry) => entry.provenance === 'builtin')).toBe(true)
  })

  it('装完后出现在列表里，且按语言取展示名', async () => {
    httpResponses.push({ status: 200, data: manifestText() })
    await installFromUrl('https://api.example.com/plugin.json')

    const zh = await listCatalogEntries('zh-CN')
    expect(zh.entries.find((entry) => entry.id === 'demo')?.displayName).toBe('演示插件')

    const en = await listCatalogEntries('en')
    expect(en.entries.find((entry) => entry.id === 'demo')?.displayName).toBe('Demo')
  })
})

describe('removeInstalledPlugin：幂等', () => {
  it('删不存在的目录不抛错', async () => {
    await expect(removeInstalledPlugin('nope')).resolves.toBeUndefined()
  })

  it('非法 id 被拒绝（不能靠 ../ 删到别处）', async () => {
    await expect(removeInstalledPlugin('../escape')).rejects.toThrow()
  })
})

// ─── 清单签名（移动端）──────────────────────────────────────

describe('签名校验（移动端 WebCrypto）', () => {
  it('未签名 → 正常安装', async () => {
    httpResponses.push({ status: 200, data: manifestText() })
    const result = await installFromUrl('https://api.example.com/plugin.json')
    expect(result.ok).toBe(true)
  })

  it('签名形状不对 → schema 校验期拒绝', async () => {
    httpResponses.push({
      status: 200,
      data: manifestText({ signature: { algorithm: 'ed25519', keyId: 'k', sig: 'short' } }),
    })
    const result = await installFromUrl('https://api.example.com/plugin.json')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues?.map((issue) => issue.path)).toContain('signature.sig')
  })

  it('签名者不在信任表 → 放行（否则自建托管装不了自签插件）', async () => {
    httpResponses.push({
      status: 200,
      data: manifestText({
        signature: { algorithm: 'ed25519', keyId: 'unknown-signer', sig: 'a'.repeat(128) },
      }),
    })
    const result = await installFromUrl('https://api.example.com/plugin.json')
    expect(result.ok).toBe(true)
  })
})
