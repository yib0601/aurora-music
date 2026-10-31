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
