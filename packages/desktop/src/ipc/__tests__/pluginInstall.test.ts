import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 安装 / 卸载流程的端到端测试（不经 IPC，直接驱动流程函数）。
 *
 * 覆盖的是**装完之后的状态**：磁盘上有什么、运行期注册里有什么、再装一次会怎样。
 * 这三件事任何一条不对，用户看到的现象都是"装了个插件，但音源列表里没有它"
 * 或者"卸了插件，重启后又回来了"。
 */
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-plugin-install-'))

/**
 * 脚本下载的 mock 出口。
 *
 * 为什么不写成 `require('electron').net.fetch`：本包是 ESM，`require` 在测试里
 * 不可用（上一版尝试就是这样挂住的 —— keepalive 都没建立，测试进程一直等）。
 * 改成"mock 工厂写入一个模块级 holder"，测试直接改 holder 里的实现。
 */
const scriptFetches: { current: (url: string, init?: unknown) => Promise<Response> } = {
  // 默认拒绝：**任何**未显式设置的用例都不该真的联网（否则一次疏忽就是 30s 挂起）
  current: async () => new Response('no network in tests', { status: 599 }),
}

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot },
  net: { fetch: (url: string, init?: unknown) => scriptFetches.current(url, init) },
  safeStorage: {},
  // dialog / shell 在流程函数里没被调用，但模块顶层 import 了它们
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn() },
  ipcMain: { handle: vi.fn() },
}))

// i18n 依赖 app.getPath('locale') 之外的 Electron 能力，这里只要它能返回一个翻译函数
vi.mock('../../i18n', () => ({
  getMainLocale: () => 'zh-CN',
  mainTranslate: () => (key: string) => key,
  mainErrorText: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}))

/**
 * 动态 import + `vi.resetModules()`（沿用本仓 `pluginHost.test.ts`）：
 * 顶层 await 需要 `module: es2022+`，desktop 的 tsconfig 是 CommonJS 目标。
 * 且 `app.getPath('userData')` 必须在 mock 生效后重新求值。
 */
let install: typeof import('../pluginInstall')
let store: typeof import('../pluginStore')
let shared: typeof import('@aurora/shared')

function manifestBytes(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
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
    }),
    'utf8'
  )
}

function resetAll(): void {
  fs.rmSync(path.join(tempRoot, 'aurora-music'), { recursive: true, force: true })
  // 首次调用发生在 shared 加载前，用可选链兜住 —— 那次本来也没有状态要清
  shared?.clearPluginsForTest()
  shared?.clearInstalledForTest()
  shared?.resetBuiltinsRegistrationForTest()
}

beforeEach(async () => {
  resetAll()
  vi.resetModules()
  install = await import('../pluginInstall')
  store = await import('../pluginStore')
  shared = await import('@aurora/shared')
})
afterEach(resetAll)

describe('performInstall：一条成功路径要同时改三处状态', () => {
  it('磁盘上有目录、运行期有实现、目录里有条目', async () => {
    const result = await install.performInstall({ bytes: manifestBytes(), origin: 'test' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // 1) 磁盘
    expect(fs.existsSync(path.join(store.installedPluginsRoot(), 'demo', 'manifest.json'))).toBe(true)
    // 2) 运行期注册（不重启就能用）
    expect(shared.getPlugin('demo')).toBeDefined()
    expect(shared.isInstalledPlugin('demo')).toBe(true)
    // 3) 目录条目（UI 立刻能看到）
    expect(result.entry).toMatchObject({ id: 'demo', provenance: 'installed', removable: true })
    // 展示名是按 locale 解析好的字面量
    expect(result.entry?.displayName).toBe('演示插件')
  })
})

describe('performInstall：校验失败不能留下任何痕迹', () => {
  it('清单结构非法 → 不写盘、不注册，逐条给 issues', async () => {
    const result = await install.performInstall({
      bytes: Buffer.from(JSON.stringify({ format: 'aurora-plugin/1', id: 'BAD ID' }), 'utf8'),
      origin: 'test',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toBe('AURORA_PLUGIN_INVALID_MANIFEST')
    expect(result.issues?.length).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(store.installedPluginsRoot(), 'BAD ID'))).toBe(false)
    expect(shared.isInstalledPlugin('BAD ID')).toBe(false)
  })

  it('与内置插件撞名 → 拒绝（AURORA_PLUGIN_BUILTIN_ID），且不覆盖内置实现', async () => {
    const result = await install.performInstall({ bytes: manifestBytes({ id: 'aurora' }), origin: 'test' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toBe('AURORA_PLUGIN_BUILTIN_ID')
    // 内置实现还在（没有被清单替换）
    expect(shared.getPlugin('aurora')).toBeDefined()
    expect(shared.isInstalledPlugin('aurora')).toBe(false)
    expect(fs.existsSync(path.join(store.installedPluginsRoot(), 'aurora'))).toBe(false)
  })

  it('重复安装同 id → 拒绝（AURORA_PLUGIN_DUPLICATE_ID）', async () => {
    expect((await install.performInstall({ bytes: manifestBytes(), origin: 'first' })).ok).toBe(true)
    const second = await install.performInstall({ bytes: manifestBytes(), origin: 'second' })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.message).toBe('AURORA_PLUGIN_DUPLICATE_ID')
  })

  it('调用方给的哈希不匹配 → 拒绝（用户确认过的内容必须是这一份）', async () => {
    const result = await install.performInstall({
      bytes: manifestBytes(),
      origin: 'test',
      expectedSha256: 'b'.repeat(64),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toBe('AURORA_PLUGIN_HASH_MISMATCH_REQUESTED')
    expect(shared.isInstalledPlugin('demo')).toBe(false)
  })

  it('调用方给的哈希匹配 → 正常安装', async () => {
    const bytes = manifestBytes()
    // 静态 import 在 ESM 下不能用 require：这里的第二参数必须来自同一个模块实例
    const result = await install.performInstall({ bytes, origin: 'test', expectedSha256: store.sha256OfBytes(bytes) })
    expect(result.ok).toBe(true)
  })
})

describe('performUninstall：必须同时摘掉磁盘与运行期', () => {
  it('卸载后磁盘目录没了、注册表里也没了（不出现"已卸载但音源还在工作"）', async () => {
    await install.performInstall({ bytes: manifestBytes(), origin: 'test' })
    expect(shared.getPlugin('demo')).toBeDefined()

    const result = install.performUninstall('demo')
    expect(result.ok).toBe(true)
    expect(fs.existsSync(path.join(store.installedPluginsRoot(), 'demo'))).toBe(false)
    expect(shared.getPlugin('demo')).toBeUndefined()
    expect(shared.isInstalledPlugin('demo')).toBe(false)
  })

  it('卸载未安装的 id → AURORA_PLUGIN_NOT_INSTALLED（不假装成功）', () => {
    const result = install.performUninstall('never-installed')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toBe('AURORA_PLUGIN_NOT_INSTALLED')
  })

  it('卸载后可以重新安装（不是一次性状态）', async () => {
    await install.performInstall({ bytes: manifestBytes(), origin: 'first' })
    install.performUninstall('demo')
    const again = await install.performInstall({ bytes: manifestBytes(), origin: 'second' })
    expect(again.ok).toBe(true)
    expect(shared.getPlugin('demo')).toBeDefined()
  })
})

describe('listCatalogEntries：列表反映磁盘与运行期的真实状态', () => {
  it('未装插件时只有内置条目', () => {
    const { entries, broken } = install.listCatalogEntries('zh-CN')
    expect(broken).toEqual([])
    expect(entries.every((entry) => entry.provenance === 'builtin')).toBe(true)
    expect(entries.map((entry) => entry.id)).toEqual(expect.arrayContaining(['aurora', 'lx', 'qishui']))
  })

  it('装完后出现在列表里', async () => {
    await install.performInstall({ bytes: manifestBytes(), origin: 'test' })
    const { entries } = install.listCatalogEntries('zh-CN')
    const demo = entries.find((entry) => entry.id === 'demo')
    expect(demo).toMatchObject({ provenance: 'installed', removable: true })
    expect(demo?.displayName).toBe('演示插件')
  })

  it('英文语言下取英文展示名', async () => {
    await install.performInstall({ bytes: manifestBytes(), origin: 'test' })
    const { entries } = install.listCatalogEntries('en')
    expect(entries.find((entry) => entry.id === 'demo')?.displayName).toBe('Demo')
  })

  it('坏文件进 broken 且不影响其他条目', async () => {
    await install.performInstall({ bytes: manifestBytes({ id: 'good' }), origin: 'test' })
    // 手动造一个坏目录
    const badDir = path.join(store.installedPluginsRoot(), 'broken')
    fs.mkdirSync(badDir, { recursive: true })
    fs.writeFileSync(path.join(badDir, 'manifest.json'), '{}')
    fs.writeFileSync(path.join(badDir, 'install.json'), '{"id":"broken","sha256":"deadbeef"}')

    const { entries, broken } = install.listCatalogEntries('zh-CN')
    expect(broken).toHaveLength(1)
    expect(entries.find((entry) => entry.id === 'good')).toBeDefined()
  })
})

/**
 * 纯歌词插件的安装。
 *
 * v15 修正：旧断言是「音源表里没有它」（`getPlugin` 为 undefined），理由是
 * "它不进音源列表"。但歌词链路（`lyricsSourceViaPlugin` / `installedLyricsSources`）
 * 都要靠 `getPlugin(id)` 取实现 —— 不注册等于这条链路必然断，而目录里却仍有
 * 它的条目（`domain: 'lyrics'`），用户看到的是"装得上、永远取不到歌词、也不报错"。
 *
 * 现在它**必须**进注册表；"不进音源列表"由目录的域（`domain`）表达，不由注册表表达。
 */
describe('纯歌词插件的安装（进注册表，但目录里归 lyrics 域）', () => {
  it('装上后 isInstalled 为 true、注册表里有实现、目录里 domain 是 lyrics', async () => {
    const bytes = manifestBytes({
      id: 'lyrics-demo',
      // 纯歌词清单：**没有** source 块（默认 fixture 自带一份，必须显式去掉）
      source: undefined,
      lyrics: { url: 'https://api.example.com/l?t={track}' },
    })
    const result = await install.performInstall({ bytes, origin: 'test' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(shared.isInstalledPlugin('lyrics-demo')).toBe(true)
    // 歌词链路要靠它取到实现：没有这一条，「装上了却永远盲」
    const plugin = shared.getPlugin('lyrics-demo')
    expect(plugin).toBeDefined()
    expect(typeof plugin!.lyricsSource).toBe('function')
    // 它不该凭空拥有音源能力
    expect(plugin!.search).toBeUndefined()
    expect(result.entry?.domain).toBe('lyrics')
  })
})

// ─── B 档：脚本随安装一起落盘 ────────────────────────────────

describe('脚本插件的安装（B 档）', () => {
  /** 一份脚本插件的清单字节（无声明式端点） */
  function scriptManifestBytes(extra: Record<string, unknown> = {}): Buffer {
    return Buffer.from(
      JSON.stringify({
        format: 'aurora-plugin/1',
        id: 'lx-demo',
        name: { 'zh-CN': '演示脚本源', en: 'Demo Script' },
        version: '1.0.0',
        permissions: ['network', 'script'],
        hosts: ['api.example.com'],
        script: { url: 'https://api.example.com/source.js', platforms: ['kw'] },
        ...extra,
      }),
      'utf8'
    )
  }

  /** 用一份固定的脚本正文替换网络拉取（单测不联网） */
  function mockScriptFetch(body: string) {
    scriptFetches.current = async () =>
      new Response(body, { status: 200, headers: { 'Content-Type': 'application/javascript' } })
  }

  it('安装时把脚本正文落盘（运行期只读本地副本，不回源）', async () => {
    mockScriptFetch('lx.on("request", () => {})')
    const result = await install.performInstall({ bytes: scriptManifestBytes(), origin: 'test' })
    expect(result.ok).toBe(true)

    const scriptPath = path.join(store.installedPluginsRoot(), 'lx-demo', 'script.js')
    expect(fs.existsSync(scriptPath)).toBe(true)
    expect(fs.readFileSync(scriptPath, 'utf8')).toBe('lx.on("request", () => {})')
  })

  it('清单声明了脚本哈希且不匹配 → 拒绝安装，不留半成品', async () => {
    mockScriptFetch('lx.on("request", () => {})')
    const result = await install.performInstall({
      bytes: scriptManifestBytes({ script: { url: 'https://api.example.com/s.js', sha256: 'a'.repeat(64) } }),
      origin: 'test',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toBe('AURORA_PLUGIN_SCRIPT_HASH_MISMATCH_REQUESTED')
    // 关键：磁盘上什么都没留下
    expect(fs.existsSync(path.join(store.installedPluginsRoot(), 'lx-demo'))).toBe(false)
  })

  it('清单声明的哈希匹配 → 安装成功', async () => {
    const body = 'lx.on("request", () => {})'
    mockScriptFetch(body)
    const sha = store.sha256OfBytes(Buffer.from(body, 'utf8'))
    const result = await install.performInstall({
      bytes: scriptManifestBytes({ script: { url: 'https://api.example.com/s.js', sha256: sha } }),
      origin: 'test',
    })
    expect(result.ok).toBe(true)
  })

  it('脚本拉取失败 → 整次安装失败（不留下"装上了但取不到址"的源）', async () => {
    scriptFetches.current = async () => new Response('nope', { status: 500 })
    const result = await install.performInstall({ bytes: scriptManifestBytes(), origin: 'test' })
    expect(result.ok).toBe(false)
    expect(fs.existsSync(path.join(store.installedPluginsRoot(), 'lx-demo'))).toBe(false)
    expect(shared.isInstalledPlugin('lx-demo')).toBe(false)
  })

  it('装完后脚本正文进了运行期登记（取址时宿主能拿到）', async () => {
    mockScriptFetch('lx.on("request", () => {})')
    await install.performInstall({ bytes: scriptManifestBytes(), origin: 'test' })
    expect(shared.scriptBodyFor('lx-demo')).toBe('lx.on("request", () => {})')
  })

  it('卸载后脚本正文从运行期登记里摘掉', async () => {
    mockScriptFetch('lx.on("request", () => {})')
    await install.performInstall({ bytes: scriptManifestBytes(), origin: 'test' })
    install.performUninstall('lx-demo')
    expect(shared.scriptBodyFor('lx-demo')).toBeUndefined()
  })

  it('脚本插件在目录里归为 source 域、带 resolveTrack 能力', async () => {
    mockScriptFetch('lx.on("request", () => {})')
    const result = await install.performInstall({ bytes: scriptManifestBytes(), origin: 'test' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry).toMatchObject({ domain: 'source', provenance: 'installed' })
    expect(result.entry?.capabilities).toContain('resolveTrack')
    expect(result.entry?.permissions).toEqual(expect.arrayContaining(['script']))
  })
})

describe('启动挂载：插件异常不得阻止应用启动', () => {
  /** 按磁盘上的正式目录布局写一个插件（先过校验器拿到规范化清单） */
  function writePlugin(id: string): void {
    const bytes = manifestBytes({ id })
    const parsed = shared.validatePluginManifest(JSON.parse(bytes.toString('utf8')))
    if (!parsed.ok) throw new Error(`fixture manifest invalid: ${JSON.stringify(parsed.issues)}`)
    store.writeInstalledPlugin(parsed.manifest, bytes, {
      id,
      version: '1.0.0',
      sha256: store.sha256OfBytes(bytes),
      installedAt: 1,
      origin: 'test',
    })
  }

  it('正常启动：报告里有挂载结果，没有失败记录', () => {
    writePlugin('demo')

    const report = install.mountInstalledPlugins()
    expect(report.mounted).toEqual(['demo'])
    expect(report.failures).toEqual([])
    expect(shared.getPlugin('demo')).toBeDefined()
  })

  it('扫盘抛错时返回空报告而不是抛出（否则窗口建不出来）', () => {
    // 把插件根目录换成一个普通文件：readdirSync 会 ENOTDIR，走到扫盘失败的兜底分支
    const root = store.installedPluginsRoot()
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(root), { recursive: true })
    fs.writeFileSync(root, 'not a directory')

    const report = install.mountInstalledPlugins()
    expect(report.mounted).toEqual([])
    expect(report.broken).toBe(0)
    // 关键：函数返回了而不是抛错 —— 调用点在 app.whenReady() 的同步段里
    expect(install.lastPluginStartupReport()).toEqual(report)

    fs.rmSync(root, { force: true })
  })

  it('一个坏文件不影响同批其它插件，且报告里如实计数', () => {
    writePlugin('demo')

    // 造一个坏目录：install.json 缺失 → 扫盘时进 broken，不阻断其余插件
    const badDir = path.join(store.installedPluginsRoot(), 'broken-plugin')
    fs.mkdirSync(badDir, { recursive: true })
    fs.writeFileSync(path.join(badDir, 'manifest.json'), '{}')

    const report = install.mountInstalledPlugins()
    expect(report.mounted).toEqual(['demo'])
    expect(report.broken).toBeGreaterThan(0)
    expect(shared.getPlugin('demo')).toBeDefined()
  })
})
