/**
 * 日志 IPC 注册层单测（Electron 用最小 mock 顶掉）。
 *
 * 为什么值得单独测这一层：通道名、handler 的注册顺序、以及「渲染层记录是否真的
 * 落到同一个文件出口」都不在纯逻辑里 —— 它们是**装配**。装配错了的典型表现是
 * 界面点「导出日志」返回 undefined，而这条路径只有在用户来要日志那一刻才被走到，
 * 平时任何冒烟都碰不到。所以这里把 ipcMain 换成记录器，直接调真实 handler。
 *
 * electron 的 mock 只提供本文件用到的几个方法：整份 Electron 运行时在这里是噪音，
 * 而这几个方法的行为（getPath 返回什么、isPackaged 真假）恰恰影响本层的分支。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOG_IPC } from '@aurora/shared'

/** 捕获到的 handler：按通道名存，供用例直接调用 */
const handlers = new Map<string, (...args: unknown[]) => unknown>()
/** 捕获到的单向监听（ipcMain.on） */
const listeners = new Map<string, (...args: unknown[]) => void>()
const shownInFolder = vi.fn()
const openedPath = vi.fn()

const paths = {
  userData: '',
  downloads: '',
  home: '',
}

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0-test',
    getPath: (name: string) => paths[name as keyof typeof paths] ?? '',
    isPackaged: true,
    isReady: () => true,
    getLocale: () => 'zh-CN',
    getPreferredSystemLanguages: () => ['zh-CN'],
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    on: (channel: string, fn: (...args: unknown[]) => void) => listeners.set(channel, fn),
  },
  shell: {
    showItemInFolder: (target: string) => shownInFolder(target),
    openPath: (target: string) => {
      openedPath(target)
      return Promise.resolve('')
    },
  },
}))

let tmpRoot: string
let ipcModule: typeof import('..')
let exportModule: typeof import('../export')

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-ipc-'))
  paths.userData = path.join(tmpRoot, 'userData')
  paths.downloads = path.join(tmpRoot, 'downloads')
  paths.home = path.join(tmpRoot, 'home')
  fs.mkdirSync(paths.userData, { recursive: true })
  fs.mkdirSync(paths.downloads, { recursive: true })

  handlers.clear()
  listeners.clear()
  shownInFolder.mockClear()
  openedPath.mockClear()

  // 每个用例重新导入：模块内有 install/attach 的幂等标记，跨用例共享会漏掉装配
  vi.resetModules()
  ipcModule = await import('..')
  exportModule = await import('../export')
  const loggingIpc = await import('../../ipc/logging')
  loggingIpc.registerLoggingIpc()
})

afterEach(() => {
  vi.resetModules()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

/** 先接上真实文件出口（模拟 main.ts 里 attach → register 的顺序） */
function attach(): import('../fileSink').LogFileSink {
  const sink = ipcModule.attachMainLogFile(path.join(paths.userData, 'logs'))
  if (!sink) throw new Error('file sink attach failed')
  return sink
}

describe('通道注册', () => {
  it('四个 invoke 通道 + 一个单向通道，名字全部取自 shared 的 LOG_IPC', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [LOG_IPC.bundle, LOG_IPC.exportFile, LOG_IPC.info, LOG_IPC.reveal].sort()
    )
    expect([...listeners.keys()]).toEqual([LOG_IPC.record])
  })

  it('通道名与 shared 常量逐字一致（防止有人改成裸字面量）', () => {
    // 这条断言看着像废话，实际守的是「两侧都 import 同一个常量」这条纪律：
    // 一旦有人把 'logging:export' 写死在 preload 或主进程里，改名时就会静默错位
    expect(LOG_IPC.exportFile).toBe('logging:export')
    expect(LOG_IPC.record).toBe('logging:record')
    expect(handlers.has('logging:export')).toBe(true)
  })
})

describe('info', () => {
  it('未 attach 时返回空状态而不是 undefined', () => {
    const info = handlers.get(LOG_IPC.info)!() as import('@aurora/shared').LogStorageInfo
    expect(info).toMatchObject({ files: [], totalBytes: 0 })
    expect(typeof info.dir).toBe('string')
  })

  it('attach 后反映真实目录内容与两项上限', () => {
    const sink = attach()
    sink.appendLine('one')
    sink.appendLine('two')

    const info = handlers.get(LOG_IPC.info)!() as import('@aurora/shared').LogStorageInfo
    expect(info.dir).toBe(sink.dir)
    expect(info.files.map((file) => file.name)).toEqual(['aurora.log'])
    expect(info.totalBytes).toBeGreaterThan(0)
    expect(info.maxFiles).toBe(5)
    expect(info.maxFileBytes).toBe(2 * 1024 * 1024)
  })
})

describe('record（渲染层 → 主进程落盘）', () => {
  it('渲染层记录进入**同一个文件**，与主进程记录共享同一套滚动', () => {
    const sink = attach()
    listeners.get(LOG_IPC.record)!({}, { line: 'renderer: ui warn\nat App' })

    const content = fs.readFileSync(path.join(sink.dir, 'aurora.log'), 'utf8')
    expect(content).toContain('renderer: ui warn')
    expect(content).toContain('at App')
  })

  it('非法负载一律忽略，不写文件也不抛（IPC 入参按不可信处理）', () => {
    const sink = attach()
    // attach 自己会写一条 session start（真实装配行为），基线不是空文件；
    // 这里断言的是「这几条非法负载一条都没有被写进去」
    const before = fs.readFileSync(path.join(sink.dir, 'aurora.log'), 'utf8')
    const record = listeners.get(LOG_IPC.record)!
    for (const payload of [null, undefined, {}, { line: '' }, { line: 42 }, 'string', []]) {
      expect(() => record({}, payload)).not.toThrow()
    }
    expect(fs.readFileSync(path.join(sink.dir, 'aurora.log'), 'utf8')).toBe(before)
  })

  it('超长单行先裁后脱敏，不会把主进程卡死', () => {
    const sink = attach()
    const started = Date.now()
    listeners.get(LOG_IPC.record)!({}, { line: `HEAD ${'L'.repeat(200 * 1024)} TAIL` })
    const elapsed = Date.now() - started

    // 关键回归：把 200KB 原样交给 redactText 会平方级回溯（实测 4KB≈0.1s、64KB≈29s），
    // 主进程卡几十秒 = 播放与全部 IPC 一起停。先裁后脱敏必须把耗时压到秒级以内。
    expect(elapsed).toBeLessThan(2000)

    const content = fs.readFileSync(path.join(sink.dir, 'aurora.log'), 'utf8')
    expect(content).toContain('HEAD')
    // 这一行超过单行上限，尾部被裁
    expect(content).not.toContain('TAIL')
  })

  it('长堆栈记录保留完整尾部（逐行脱敏，不整条截断）', () => {
    const sink = attach()
    // 渲染层真实形态：一条 message + 几十帧堆栈，总长远超 4096。
    // 早期实现按整条截到 4096，会把堆栈尾部整段砍掉 —— 而那恰恰是最有价值的部分。
    const frames = Array.from({ length: 200 }, (_, i) => `    at fn${i} (chunk-${i}.js:${i}:1)`)
    const line = `Error: boom ${frames.join('\n')}`
    expect(line.length).toBeGreaterThan(4096)

    listeners.get(LOG_IPC.record)!({}, { line })

    const content = fs.readFileSync(path.join(sink.dir, 'aurora.log'), 'utf8')
    expect(content).toContain('at fn0')
    expect(content).toContain('at fn199')
  })

  it('主进程侧再脱敏一次：渲染层传来的明文口令不会落盘', () => {
    const sink = attach()
    // 渲染层理论上已经脱敏过；这里模拟它没跑（被第三方脚本搞坏、老版本渲染层）
    listeners.get(LOG_IPC.record)!({}, { line: 'GET https://api.example.com/x?api_key=plain-secret-value' })

    const content = fs.readFileSync(path.join(sink.dir, 'aurora.log'), 'utf8')
    expect(content).not.toContain('plain-secret-value')
    expect(content).toContain('api_key=***')
  })
})

describe('bundle', () => {
  it('读全部文件拼成单文本包，带环境头与条目计数', () => {
    const sink = attach()
    sink.appendLine('first record')

    const result = handlers.get(LOG_IPC.bundle)!() as import('@aurora/shared').LogBundleResult
    expect(result.fileCount).toBe(1)
    expect(result.content).toContain('first record')
    expect(result.content).toContain('0.0.0-test')
    // 环境头里的来源进程固定是 main
    expect(result.content).toContain('main')
    expect(result.fileName).toMatch(/^Aurora-Music-logs-v0\.0\.0-test-\d{8}-\d{6}\.txt$/)
    expect(result.totalBytes).toBe(Buffer.byteLength(result.content, 'utf8'))
  })

  it('未 attach 时也能出包（内容只有环境头与「没有日志文件」说明）', () => {
    const result = handlers.get(LOG_IPC.bundle)!() as import('@aurora/shared').LogBundleResult
    expect(result.fileCount).toBe(0)
    expect(result.content).toContain('no log files')
  })
})

describe('exportFile', () => {
  it('落盘到下载目录并返回路径，内容与 bundle 同源', () => {
    const sink = attach()
    sink.appendLine('exported record')

    const result = handlers.get(LOG_IPC.exportFile)!() as import('@aurora/shared').LogExportResult
    expect(result.dir).toBe(paths.downloads)
    expect(path.dirname(result.filePath)).toBe(paths.downloads)
    expect(fs.existsSync(result.filePath)).toBe(true)
    const written = fs.readFileSync(result.filePath, 'utf8')
    expect(written).toContain('exported record')
    expect(result.bytes).toBe(Buffer.byteLength(written, 'utf8'))
  })

  it('连续导出两次不覆盖前一份（用户手里的证据不能被冲掉）', () => {
    attach()
    const first = handlers.get(LOG_IPC.exportFile)!() as import('@aurora/shared').LogExportResult
    const second = handlers.get(LOG_IPC.exportFile)!() as import('@aurora/shared').LogExportResult

    expect(first.filePath).not.toBe(second.filePath)
    expect(path.basename(second.filePath)).toBe(
      exportModule.candidateFileName(path.basename(first.filePath), 1)
    )
    expect(fs.existsSync(first.filePath)).toBe(true)
    expect(fs.existsSync(second.filePath)).toBe(true)
  })
})

describe('reveal', () => {
  it('日志目录内的文件可以定位', () => {
    const sink = attach()
    sink.appendLine('locatable')
    const target = path.join(sink.dir, 'aurora.log')

    handlers.get(LOG_IPC.reveal)!({}, target)
    expect(shownInFolder).toHaveBeenCalledWith(target)
  })

  it('下载目录里的本次导出文件可以定位（设置页导出后跳转）', () => {
    attach()
    const result = handlers.get(LOG_IPC.exportFile)!() as import('@aurora/shared').LogExportResult

    handlers.get(LOG_IPC.reveal)!({}, result.filePath)
    expect(shownInFolder).toHaveBeenCalledWith(result.filePath)
  })

  it('目标是目录时进入该目录，而不是选中它（否则打开的是父目录）', () => {
    const sink = attach()
    sink.appendLine('x')

    handlers.get(LOG_IPC.reveal)!({}, sink.dir)

    // 这条差异来自渲染层联调：设置页「打开日志目录」传的是目录，
    // 而 showItemInFolder 对目录会打开**父目录**并选中它 —— 用户看到 userData 而不是 logs
    expect(openedPath).toHaveBeenCalledWith(sink.dir)
    expect(shownInFolder).not.toHaveBeenCalled()
  })

  it('目标不存在时什么都不做（不弹空文件管理器）', () => {
    attach()
    const missing = path.join(paths.userData, 'logs', 'not-there.log')

    handlers.get(LOG_IPC.reveal)!({}, missing)

    expect(shownInFolder).not.toHaveBeenCalled()
    expect(openedPath).not.toHaveBeenCalled()
  })

  it('目录外的路径一律拒绝：不能让渲染层拿它当任意文件定位入口', () => {
    attach()
    const outside = path.join(tmpRoot, 'outside.txt')
    fs.writeFileSync(outside, 'x')

    handlers.get(LOG_IPC.reveal)!({}, outside)
    // 前缀相同的兄弟目录也要挡住（'/a/logs-evil' 不是 '/a/logs' 的子路径）
    const sibling = path.join(paths.userData, 'logs-evil', 'aurora.log')
    fs.mkdirSync(path.dirname(sibling), { recursive: true })
    fs.writeFileSync(sibling, 'x')
    handlers.get(LOG_IPC.reveal)!({}, sibling)

    handlers.get(LOG_IPC.reveal)!({}, 'relative/path.log')
    handlers.get(LOG_IPC.reveal)!({}, 42)

    expect(shownInFolder).not.toHaveBeenCalled()
  })

  it('目录内的符号链接指向外部时被拒绝（realpath 后再比较）', () => {
    const sink = attach()
    const outside = path.join(tmpRoot, 'secret.txt')
    fs.writeFileSync(outside, 'x')
    const link = path.join(sink.dir, 'looks-inside.log')
    try {
      fs.symlinkSync(outside, link)
    } catch {
      // 不支持符号链接的平台（Windows 非管理员）跳过：这条断言不是平台无关的
      return
    }

    handlers.get(LOG_IPC.reveal)!({}, link)
    expect(shownInFolder).not.toHaveBeenCalled()
  })
})
