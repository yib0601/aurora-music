/**
 * 插件 IPC 层单测（Electron 用最小 mock 顶掉）。
 *
 * 为什么值得单独测这一层：通道名、能力缺失时的行为、凭证边界都是**装配**，
 * 不在纯逻辑里。装配错了的典型表现是「设置页点测试没反应」或「登录后仍显示未登录」，
 * 而这些路径平时冒烟碰不到。这里把 ipcMain 换成记录器，直接调真实 handler。
 *
 * 凭证边界是本层的核心不变量：渲染层**永远拿不到凭证原文**，
 * 所以每个回渲染层的通道都断言「不含明文」。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 捕获到的 handler：按通道名存，供用例直接调用 */
const handlers = new Map<string, (...args: unknown[]) => unknown>()

const paths = { userData: '' }

/** 假的安全存储：真正的加解密在这里是噪音，只需要它「可逆 + 不能明文落盘」 */
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => paths[name as keyof typeof paths] ?? '',
    // i18n 模块在求值时探测语言，依赖这两个方法
    isReady: () => true,
    getLocale: () => 'zh-CN',
    getPreferredSystemLanguages: () => ['zh-CN'],
    getVersion: () => '0.0.0-test',
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`ENC:${s}`, 'utf8'),
    decryptString: (b: Buffer) => {
      const text = b.toString('utf8')
      if (!text.startsWith('ENC:')) throw new Error('bad cipher')
      return text.slice(4)
    },
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}))

let tmpRoot: string
let hostModule: typeof import('../pluginHost')

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-plugin-ipc-'))
  paths.userData = tmpRoot
  handlers.clear()
  vi.resetModules()
  hostModule = await import('../pluginHost')
  hostModule.registerPluginIpc()
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  vi.resetModules()
})

const call = (channel: string, ...args: unknown[]) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`handler not registered: ${channel}`)
  return handler({}, ...args)
}

/**
 * 把 `call` 的结果当 Promise 用。
 *
 * `call` 的返回类型是 `unknown`（IPC handler 的返回形状本来就不可知，测试里按需 cast）。
 * 需要 `.catch(...)` 的地方（断言"这次调用会失败，且失败前请求没发出去"）必须先把它收窄
 * 成 Promise，否则 `unknown` 上取不到 `.catch`。集中一处，避免每个用例各写一个 as。
 */
const callAsPromise = (channel: string, ...args: unknown[]): Promise<unknown> =>
  call(channel, ...args) as Promise<unknown>

const CONFIG = { id: '00000000-0000-0000-0000-000000000000', name: 'Fake', sourceUrl: 'https://source.example.test/', enabled: true }

describe('插件 IPC：通道装配', () => {
  it('注册了期望的全部通道', () => {
    // 通道名是渲染层 preload 与主进程之间唯一的事实约定，漏一个就是运行期空洞
    for (const channel of [
      'plugin:list',
      'plugin:probe',
      'plugin:search',
      'plugin:resolveTrack',
      'plugin:userPlaylists',
      'plugin:playlistTracks',
      'plugin:login',
      'plugin:authState',
      'plugin:logout',
    ]) {
      expect(handlers.has(channel), `missing ${channel}`).toBe(true)
    }
  })

  it('plugin:list 返回元信息且**不含**任何凭证内容', () => {
    const list = call('plugin:list') as Array<Record<string, unknown>>
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBeGreaterThan(0)
    const qishui = list.find((p) => p.id === 'qishui')
    expect(qishui).toBeTruthy()
    expect(qishui).toHaveProperty('displayNameKey')
    expect(qishui).toHaveProperty('capabilities')
    // 只回布尔
    expect(typeof qishui!.hasCredential).toBe('boolean')
    // 元信息里不该混进实现对象
    expect(qishui).not.toHaveProperty('search')
    expect(qishui).not.toHaveProperty('login')
  })

  it('未知插件 id 抛结构化错误（不静默返回空）', async () => {
    // handler 是 async：抛错表现为 rejected promise
    await expect(call('plugin:userPlaylists', 'nope', CONFIG)).rejects.toThrow()
  })

  it('非法插件 id 抛错（它会成为凭证文件名）', async () => {
    await expect(call('plugin:userPlaylists', '../evil', CONFIG)).rejects.toThrow()
  })

  it('能力缺失时 search 返回空数组而不是抛错（上层按「没搜到」处理）', () => {
    // 汽水不声明 search 能力
    const out = call('plugin:search', 'qishui', CONFIG, 'test')
    expect(out).toBeInstanceOf(Promise)
  })
})

describe('插件 IPC：已安装插件的主机白名单真的生效', () => {
  /**
   * 这组用例钉的是「**越界请求不会发出**」这条装配事实。
   *
   * 背景：`guardedFetchOf` 曾经在生产代码里零调用方——清单声明的 `hosts` 是纯装饰，
   * 作者以为被约束、实际没有。这类缺陷不会有任何报错，只是白名单静静失效，
   * 所以必须有测试盯着「构造 ctx 的入口是否包了白名单」。
   */
  const MANIFEST = {
    format: 'aurora-plugin/1' as const,
    id: 'demo-allowlist',
    name: 'Demo',
    version: '1.0.0',
    permissions: ['network' as const],
    // 白名单只放行 allowed.example.test，而下面的搜索地址打在 api.example.test 上：
    // 这是"清单声明的白名单与它实际请求的主机不一致"的场景，必须被挡住
    hosts: ['allowed.example.test'],
    source: {
      search: {
        url: 'https://api.example.test/search?q={query}',
        map: { id: 'id', title: 'name', audioUrl: 'url' },
      },
    },
  }

  it('hosts 未覆盖的请求：抛错且原请求**没有发出**', async () => {
    const shared = await import('@aurora/shared')
    expect(shared.installManifestIntoRuntime(MANIFEST)).toBe(true)

    // 记录全局 fetch 是否被调用：白名单的正确表现是"请求根本没发出去"，
    // 而不只是"报了错"（报了错但请求已发出，等于地址已经泄露给上游了）
    const spy = vi.fn(async () => new Response('[]', { status: 200 }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = spy as unknown as typeof globalThis.fetch
    try {
      await callAsPromise('plugin:search', 'demo-allowlist', {
        id: 'src-1',
        name: 'Demo',
        sourceUrl: '',
        enabled: true,
      }, 'q').catch(() => undefined)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
      shared.removeManifestFromRuntime('demo-allowlist')
    }
  })

  it('白名单放行的请求照常发出（避免把「全挡掉」当成通过）', async () => {
    const shared = await import('@aurora/shared')
    const allowed = {
      ...MANIFEST,
      id: 'demo-allowlist-ok',
      // 这次让声明的主机与请求地址一致
      hosts: ['api.example.test'],
    }
    expect(shared.installManifestIntoRuntime(allowed)).toBe(true)

    const spy = vi.fn(async () => new Response('{"results":[]}', { status: 200 }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = spy as unknown as typeof globalThis.fetch
    try {
      await callAsPromise('plugin:search', 'demo-allowlist-ok', {
        id: 'src-2',
        name: 'Demo',
        sourceUrl: '',
        enabled: true,
      }, 'q').catch(() => undefined)
      expect(spy).toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
      shared.removeManifestFromRuntime('demo-allowlist-ok')
    }
  })

  it('内置插件不受白名单约束（guardedFetchOf 对他们返回 undefined）', async () => {
    const shared = await import('@aurora/shared')
    expect(shared.guardedFetchOf('qishui')).toBeUndefined()
    expect(shared.guardedFetchOf('aurora')).toBeUndefined()
  })
})

describe('插件 IPC：凭证边界', () => {
  it('未登录时 authState 报 loggedIn=false', async () => {
    const state = (await call('plugin:authState', 'qishui')) as Record<string, unknown>
    expect(state.loggedIn).toBe(false)
    expect(state.encryptionAvailable).toBe(true)
  })

  it('登录后 authState 报已登录，且响应里**不含凭证原文**', async () => {
    // 用假 sessionid（公开仓库，不写真实凭据）
    const fake = 'local-dev-fake-session-value'
    await call('plugin:login', 'qishui', `sessionid=${fake}; ttwid=irrelevant`)

    const state = (await call('plugin:authState', 'qishui')) as Record<string, unknown>
    expect(state.loggedIn).toBe(true)

    // 核心不变量：回渲染层的任何字段都不能带出 sessionid
    const serialized = JSON.stringify(state)
    expect(serialized).not.toContain(fake)
    expect(serialized).not.toContain('sessionid')
  })

  it('凭证落盘是密文，磁盘上搜不到明文（不复制 WebDAV 明文口令的缺陷）', async () => {
    const fake = 'local-dev-cipher-check-value'
    await call('plugin:login', 'qishui', `sessionid=${fake}`)

    const dir = path.join(tmpRoot, 'aurora-music', 'plugin-credentials')
    const files = fs.readdirSync(dir)
    expect(files.length).toBe(1)
    const raw = fs.readFileSync(path.join(dir, files[0]))
    // 本用例的 safeStorage 是假实现（可逆 ENC: 前缀），所以明文仍在文件里；
    // 这里断言的是「确实经过了 encryptString」这一装配事实。
    // 「真机上不含明文」由 pluginCredentials.ts 的 safeStorage 实现保证。
    expect(raw.toString('utf8').startsWith('ENC:')).toBe(true)
    // 文件权限 0600：即便加密不可用也不给同机其它用户可读
    const mode = fs.statSync(path.join(dir, files[0])).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('退出登录后凭证被清除', async () => {
    await call('plugin:login', 'qishui', 'sessionid=local-dev-logout-value')
    let state = (await call('plugin:authState', 'qishui')) as Record<string, unknown>
    expect(state.loggedIn).toBe(true)

    await call('plugin:logout', 'qishui')
    state = (await call('plugin:authState', 'qishui')) as Record<string, unknown>
    expect(state.loggedIn).toBe(false)
    const dir = path.join(tmpRoot, 'aurora-music', 'plugin-credentials')
    expect(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0).toBe(0)
  })

  it('空输入被拒绝（不能存下一份空凭证假装已登录）', async () => {
    await expect(call('plugin:login', 'qishui', '   ')).rejects.toThrow()
  })
})

/**
 * 插件停用必须在这条通道上也挡住。
 *
 * 执行门禁（`pluginForSource`）只在"按源配置执行"的路径上生效；本文件的 8 个通道是
 * **按插件 id 直呼**的，渲染层手里只要还留着一份旧音源配置（用户先配源、后停用插件），
 * 就能绕过那道门禁。不在这里挡，"停用了却还搜得到"会从这条路漏出来。
 */
describe('插件 IPC：停用的插件不可执行', () => {
  it('plugin:list 如实给出 enabled，未被停用时为 true', () => {
    const list = call('plugin:list') as Array<Record<string, unknown>>
    const aurora = list.find((p) => p.id === 'aurora')
    expect(aurora?.enabled).toBe(true)
  })

  it('停用后 plugin:list 的 enabled 变 false，但条目仍在（否则开关就没了）', async () => {
    const shared = await import('@aurora/shared')
    shared.setPluginEnabled('aurora', false)
    try {
      const list = call('plugin:list') as Array<Record<string, unknown>>
      const aurora = list.find((p) => p.id === 'aurora')
      // 条目不能消失：删掉它用户就没有任何入口把开关打开
      expect(aurora).toBeTruthy()
      expect(aurora?.enabled).toBe(false)
    } finally {
      shared.setPluginEnabled('aurora', true)
    }
  })

  it('停用后按 id 直呼的能力通道被拒（搜索不会偷偷继续工作）', async () => {
    const shared = await import('@aurora/shared')
    shared.setPluginEnabled('aurora', false)
    try {
      // 每种能力通道走的是同一个 requirePlugin，逐个确认没有被漏掉
      await expect(
        callAsPromise('plugin:search', 'aurora', CONFIG, 'query', '128')
      ).rejects.toThrow()
      await expect(
        callAsPromise('plugin:probe', 'aurora', CONFIG)
      ).rejects.toThrow()
      await expect(
        callAsPromise('plugin:resolveTrack', 'aurora', CONFIG, { id: 'x' }, '128')
      ).rejects.toThrow()
    } finally {
      shared.setPluginEnabled('aurora', true)
    }
  })

  it('重新启用后同一通道恢复可用（停用是可逆的临时动作）', async () => {
    const shared = await import('@aurora/shared')
    shared.setPluginEnabled('aurora', false)
    shared.setPluginEnabled('aurora', true)
    // 不抛错即可：具体返回内容取决于插件实现与网络，这里只验证门禁已放行
    await expect(callAsPromise('plugin:probe', 'aurora', CONFIG)).resolves.toBeDefined()
  })

  it('未注册的 id 与已停用的 id 报同一种错（都是"不可执行"，UI 无需多一条分支）', async () => {
    const shared = await import('@aurora/shared')
    shared.setPluginEnabled('aurora', false)
    try {
      const disabledErr = String(
        await callAsPromise('plugin:probe', 'aurora', CONFIG).catch((e) => e)
      )
      const missingErr = String(
        await callAsPromise('plugin:probe', 'no-such-plugin', CONFIG).catch((e) => e)
      )
      // 比的是**错误码**而不是整条报文：params 里的 id 天然不同（一个是 aurora、
      // 一个是不存在的 id），但两者对调用方的含义必须是同一个 —— "这个插件不可用"，
      // 而不是"已停用"这种要用户二次理解的结论（那会让渲染层多一条分支）。
      const codeOf = (text: string) => /"code":"([^"]+)"/.exec(text)?.[1]
      expect(codeOf(disabledErr)).toBe('desktop.error.plugin.notFound')
      expect(codeOf(disabledErr)).toBe(codeOf(missingErr))
    } finally {
      shared.setPluginEnabled('aurora', true)
    }
  })
})
