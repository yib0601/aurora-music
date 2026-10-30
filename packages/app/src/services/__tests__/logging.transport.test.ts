/**
 * 日志传输链路对**真实平台适配层**的契约测试。
 *
 * 与同目录的 logging.service.test.ts 分工：
 * - 那份把平台网关整体打桩，验的是服务层的判定与形状（导出结果、能力探测、降级）；
 * - 这份**不打桩平台层**，走真实的 createDesktopPlatform / 移动端落盘模块，
 *   验的是「preload 暴露的形状能不能接上」与「移动端最后写出来的文件里有什么」。
 *
 * 为什么要单独一份文件：`vi.mock` 在整个文件内生效，把平台层打桩与真跑平台层
 * 放进同一个文件做不到。而这两组断言守的是不同层面的东西 ——
 * 前者守调用约定，后者守**最终落盘的字节**，后者才是用户真正会发出去的东西。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Capacitor 的内存文件系统桩件。
 *
 * 只实现移动端日志模块用到的五个方法（mkdir / appendFile / writeFile / readFile /
 * stat / readdir / deleteFile / getUri）。`encoding: UTF8` 时 Capacitor 的 data 是原文，
 * 非 UTF8 时是 base64 —— 日志模块显式传 UTF8，这里如实按原文处理，
 * 若模块哪天误改成 base64，断言会立刻红。
 */
const fs = vi.hoisted(() => {
  const files = new Map<string, { content: string; mtime: number }>()
  /** 外部存储是否可用：false 时模拟「没有所有文件访问权限」 */
  const state = { externalDenied: false }
  const key = (directory: string, path: string) => `${directory}:${path.replace(/^\/+/, '')}`
  return {
    files,
    state,
    key,
    api: {
      Directory: { Data: 'DATA', ExternalStorage: 'EXTERNAL_STORAGE' },
      Encoding: { UTF8: 'utf8' },
      Filesystem: {
        async mkdir() {
          // 目录在内存桩里是隐式的：只要有文件即视为目录存在
        },
        async appendFile({ path, directory, data }: { path: string; directory: string; data: string }) {
          const k = key(directory, path)
          const prev = files.get(k)
          files.set(k, { content: (prev?.content ?? '') + String(data), mtime: Date.now() })
        },
        async writeFile({ path, directory, data }: { path: string; directory: string; data: string }) {
          if (directory === 'EXTERNAL_STORAGE' && state.externalDenied) {
            throw new Error('Permission denied')
          }
          files.set(key(directory, path), { content: String(data), mtime: Date.now() })
        },
        async readFile({ path, directory }: { path: string; directory: string }) {
          const file = files.get(key(directory, path))
          if (!file) throw new Error('File does not exist')
          return { data: file.content }
        },
        async stat({ path, directory }: { path: string; directory: string }) {
          const file = files.get(key(directory, path))
          if (!file) throw new Error('File does not exist')
          return { size: file.content.length, mtime: file.mtime, type: 'file' as const }
        },
        async readdir({ path, directory }: { path: string; directory: string }) {
          const prefix = key(directory, `${path}/`)
          const names = new Set<string>()
          for (const k of files.keys()) {
            if (!k.startsWith(prefix)) continue
            const rest = k.slice(prefix.length)
            if (rest && !rest.includes('/')) names.add(rest)
          }
          return {
            files: [...names].map((name) => ({
              name,
              type: 'file' as const,
              size: files.get(prefix + name)?.content.length ?? 0,
            })),
          }
        },
        async deleteFile({ path, directory }: { path: string; directory: string }) {
          if (!files.delete(key(directory, path))) throw new Error('File does not exist')
        },
        async getUri({ path, directory }: { path: string; directory: string }) {
          const root = directory === 'DATA' ? '/data/user/0/app/files' : '/storage/emulated/0'
          return { uri: `file://${root}/${path.replace(/^\/+/, '')}` }
        },
      },
    },
  }
})

vi.mock('@capacitor/filesystem', () => fs.api)
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    convertFileSrc: (p: string) => p,
  },
  CapacitorHttp: { request: async () => ({ status: 200, data: '' }) },
}))
vi.mock('@capacitor/app', () => ({ App: { addListener: async () => ({ remove: async () => {} }) } }))
// 权限桩件：默认有「所有文件访问」，用例可改成 false 验证降级路径
vi.mock('@/services/permission', () => ({
  checkAllFilesAccess: async () => !fs.state.externalDenied,
  requestMediaPermissions: async () => true,
  openAllFilesAccessSettings: async () => {},
}))
vi.mock('@/services/update.service', () => ({ APP_VERSION: '0.0.0-test' }))
vi.mock('@/stores/localeStore', () => ({
  currentLocale: () => 'zh-CN',
  useLocaleStore: { getState: () => ({ language: 'zh-CN' }) },
}))
vi.mock('@/lib/utils', async () => ({
  isDesktop: () => false,
  isMobile: () => true,
  renderErrorMessage: (e: unknown) => String(e),
  cn: (...args: unknown[]) => args.join(' '),
  formatTime: (s: number) => String(s),
  generateId: () => 'test-id',
}))

import { createMobileLogging } from '../platform/mobile/logging'
import { createLogger } from '@aurora/shared'

const FAKE_API_KEY = '00000000-0000-0000-0000-000000000000'
const FAKE_BEARER = 'Bearer abc123def456ghi789'

beforeEach(() => {
  fs.files.clear()
  fs.state.externalDenied = false
})

describe('桌面端：preload 暴露的形状能被平台层接上', () => {
  it('sink 经真实 createDesktopPlatform 转发到 electronAPI.logging.record', async () => {
    // 用真实的 window.electronAPI 形状（与 preload 的 contextBridge 对象同构）。
    // 这里刻意不 import 真实 preload：它在主进程侧，且只需形状一致即可。
    const received: string[] = []
    ;(globalThis as any).window = {
      electronAPI: {
        logging: {
          record: (payload: { line: string }) => received.push(payload.line),
          bundle: async () => ({ fileName: 'a.txt', content: 'x', fileCount: 1, totalBytes: 1 }),
          exportFile: async () => ({ filePath: '/tmp/a.txt', dir: '/tmp', bytes: 1 }),
          reveal: async () => {},
          info: async () => ({
            dir: '/tmp',
            files: [],
            totalBytes: 0,
            maxFileBytes: 1,
            maxFiles: 2,
          }),
        },
      },
    }
    vi.resetModules()

    const platformModule = await import('../platform')
    const loggingModule = await import('../logging.service')
    // ★ 必须从**同一个模块图**取 logger：`vi.resetModules()` 之后重新 import 的
    // logging.service 持有的是它自己那份 @aurora/shared 实例（内核的 sink 配置是
    // 模块级单例）。用文件顶部静态 import 的 createLogger 会打到另一份实例上，
    // 记录投不出去 —— 这条曾让本用例假红过一次，注释在此以免下次误判为功能坏了。
    const shared = await import('@aurora/shared')
    loggingModule.initRendererLogging()

    shared.createLogger('guarded').info(`fetching with api_key=${FAKE_API_KEY}`)

    expect(received.length).toBeGreaterThan(0)
    const line = received[received.length - 1]
    // 一行完整记录：时间 + 级别 + 来源 + scope + 文案
    expect(line).toContain('[renderer] guarded:')
    expect(line).toContain('fetching with')
    // 凭据不得进入 IPC 负载
    expect(line).not.toContain(FAKE_API_KEY)
    // 平台网关确实来自真实适配层
    expect(typeof platformModule.platform.logging?.record).toBe('function')
    expect(platformModule.platform.logging?.flush).toBeTypeOf('function')
  })

  it('没有 electronAPI 时整条链路静默降级，不抛错', async () => {
    ;(globalThis as any).window = {}
    vi.resetModules()

    const loggingModule = await import('../logging.service')
    expect(() => loggingModule.initRendererLogging()).not.toThrow()
    // 没有任何落盘出口：导出与状态查询都给出不可用结论，而不是空指针
    expect(loggingModule.supportsLogExport()).toBe(false)
    await expect(loggingModule.exportLogs()).resolves.toEqual({ ok: false, reason: 'unsupported' })
    await expect(loggingModule.getLogInfo()).resolves.toBeNull()
    // 记录本身也不能抛
    expect(() => createLogger('bare').warn('no sink at all')).not.toThrow()
  })
})

describe('移动端：写盘与导出', () => {
  it('记录先入队列，flush 后按天写入应用专属目录', async () => {
    const api = createMobileLogging(() => ({
      appVersion: '0.0.0-test',
      platform: 'android',
      locale: 'zh-CN',
    }))
    api.record({ line: 'first line' })
    api.record({ line: 'second line' })
    // 攒批：未 flush 时还没有产生文件（写盘不能逐条发生，否则卡 UI）
    expect(fs.files.size).toBe(0)
    await api.flush()
    expect(fs.files.size).toBe(1)
    const [key] = [...fs.files.keys()]
    expect(key).toMatch(/renderer-\d{8}\.log$/)
    expect(fs.files.get(key)?.content).toBe('first line\nsecond line\n')
  })

  it('导出写单文本到用户可见目录，并返回可展示的绝对路径', async () => {
    const api = createMobileLogging(() => ({
      appVersion: '0.0.0-test',
      platform: 'android',
      locale: 'zh-CN',
    }))
    api.record({ line: 'boot ok' })
    const result = await api.exportFile()
    expect(result.filePath).toContain('Aurora-Music-logs-v0.0.0-test-')
    expect(result.filePath).toContain('/storage/emulated/0/Download/Aurora Music/logs/')
    expect(result.dir).toBe('/storage/emulated/0/Download/Aurora Music/logs')
    expect(result.bytes).toBeGreaterThan(0)
    // 文件真的写出来了，且内容是带环境头的完整包（环境头是排障的一半）
    const written = [...fs.files.entries()].find(([k]) => k.startsWith('EXTERNAL_STORAGE:'))
    expect(written).toBeTruthy()
    expect(written?.[1].content).toContain('boot ok')
    expect(written?.[1].content).toContain('Aurora Music diagnostic logs')
    expect(written?.[1].content).toContain('0.0.0-test')
  })

  it('无「所有文件访问」时导出落到应用专属目录并如实返回该路径', async () => {
    fs.state.externalDenied = true
    const api = createMobileLogging(() => ({
      appVersion: '0.0.0-test',
      platform: 'android',
      locale: 'zh-CN',
    }))
    api.record({ line: 'permission missing' })
    const result = await api.exportFile()
    // 不因权限失败而抛错：用户仍然拿到一个能读到的文件位置
    expect(result.filePath).toContain('/data/user/0/app/files/aurora-music/log-exports/')
    const written = [...fs.files.entries()].find(([k]) => k.startsWith('DATA:'))
    expect(written?.[1].content).toContain('permission missing')
  })

  it('★ 落盘文件里不含凭据原值（护栏：按真实写出的字节断言）', async () => {
    const api = createMobileLogging(() => ({
      appVersion: '0.0.0-test',
      platform: 'android',
      locale: 'zh-CN',
    }))
    // 走内核→sink 的真实路径：redactText 在记录创建时生效，
    // 这里用「已脱敏的行」模拟 sink 的产出（sink 的输出就是内核给的 record 排版）
    const { getLogger, formatRecord, initLogging, redactText } = await import('@aurora/shared')
    initLogging({
      sinks: [(record) => api.record({ line: redactText(formatRecord(record)) })],
      level: 'debug',
      origin: 'renderer',
    })
    getLogger('net').error(`request failed: https://api.example.com/s?q=rain&api_key=${FAKE_API_KEY}`)
    getLogger('net').warn(`auth header: Authorization: ${FAKE_BEARER}`)
    await api.exportFile()

    const written = [...fs.files.entries()].find(([k]) => k.startsWith('EXTERNAL_STORAGE:'))
    const text = written?.[1].content ?? ''
    // 这是整套日志系统的底线：用户把这份文件发给开发者时，凭据不能在里面
    expect(text).not.toContain(FAKE_API_KEY)
    expect(text).not.toContain('abc123def456ghi789')
    expect(text).toContain('***')
    // 但失败本身要留下可读信息，否则这份日志没有排障价值
    expect(text).toContain('api.example.com')
    expect(text).toContain('request failed')
  })

  it('info 汇总文件数与占用（设置页展示用）', async () => {
    const api = createMobileLogging(() => ({ appVersion: '0.0.0-test', platform: 'android' }))
    api.record({ line: 'one' })
    await api.flush()
    const info = await api.info()
    expect(info.files).toHaveLength(1)
    expect(info.totalBytes).toBeGreaterThan(0)
    expect(info.maxFileBytes).toBeGreaterThan(0)
    expect(info.maxFiles).toBeGreaterThan(0)
    expect(info.dir).toContain('aurora-music/logs')
  })

  it('空日志时导出仍然成功（“还没有日志”也是有效结论）', async () => {
    const api = createMobileLogging(() => ({ appVersion: '0.0.0-test', platform: 'android' }))
    const bundle = await api.bundle()
    expect(bundle.fileCount).toBe(0)
    // shared 的排版层给出「没有日志文件」的英文说明（bundle.ts 的输出已统一为英文）
    expect(bundle.content).toContain('no log files')
    const result = await api.exportFile()
    expect(result.bytes).toBeGreaterThan(0)
  })
})
