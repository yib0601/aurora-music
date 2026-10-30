/**
 * 文件出口（滚动写盘）单测。
 *
 * 这一组守的是「日志目录不会无限长大」与「崩溃前的最后一条不会丢」两条承诺：
 * 前者靠滚动与保留份数，后者靠同步追加。两条都是**只在交付后才失效**的性质 ——
 * 用户报问题、我们回头找一个多 GB 的日志目录，或者发现文件里停在崩溃前 200 行之前，
 * 那时已经晚了。所以这里用真实临时目录跑真磁盘（os.tmpdir + mkdtemp），
 * 不 mock fs：mock 掉的正是这一层唯一要证明的东西。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLogging, createLogger } from '@aurora/shared'
import type { LogRecord } from '@aurora/shared'
import {
  MAX_LOG_FILES,
  MAX_LOG_FILE_BYTES,
  createFileSink,
  type LogFileSink,
} from '../fileSink'

let tmpRoot: string
let dir: string

beforeEach(() => {
  // 每个用例独立目录：滚动会删文件，共用目录会让用例互相污染
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-logs-'))
  dir = path.join(tmpRoot, 'logs')
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

/** 构造一条最小可用记录（只要 sink 关心 level/message，其余字段给足类型） */
function record(message: string, overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    ts: Date.now(),
    level: 'info',
    origin: 'main',
    scope: 'test',
    message,
    ...overrides,
  }
}

/** 目录里的日志文件名（排序后，便于断言） */
function namesIn(sink: LogFileSink): string[] {
  return sink.listFiles().map((file) => file.name)
}

function readAll(sink: LogFileSink): string {
  return sink.readParts().map((part) => part.content).join('')
}

describe('常量契约', () => {
  it('单文件 2MB、最多 5 个文件（目录上限约 10MB）', () => {
    // 这两个数是产品承诺（设置页会原样展示给用户），写死断言防止有人顺手调大
    expect(MAX_LOG_FILE_BYTES).toBe(2 * 1024 * 1024)
    expect(MAX_LOG_FILES).toBe(5)
  })
})

describe('写入与追加', () => {
  it('sink 把记录排版成单行并落盘（一条一行，末尾有换行）', () => {
    const sink = createFileSink({ dir })
    sink.sink(record('hello world'))

    const content = fs.readFileSync(path.join(dir, 'aurora.log'), 'utf8')
    expect(content).toBe(content.trimEnd() + '\n')
    expect(content.trimEnd().split('\n')).toHaveLength(1)
    expect(content).toContain('INFO')
    expect(content).toContain('[main]')
    expect(content).toContain('test: hello world')
  })

  it('接上 initLogging 后 createLogger 的记录也进同一个文件（真实装配路径）', () => {
    const sink = createFileSink({ dir })
    initLogging({ sinks: [sink.sink], level: 'debug', origin: 'main' })
    createLogger('wiring').info('from kernel')

    expect(readAll(sink)).toContain('wiring: from kernel')
    // 收尾：别让内核继续持有这个 sink 写进已删除的临时目录
    initLogging({ sinks: [], level: 'info', origin: 'main' })
  })

  it('appendLine 追加渲染层已排版的行，不改写内容、逐条换行', () => {
    const sink = createFileSink({ dir })
    sink.appendLine('renderer line one')
    sink.appendLine('renderer line two\nwith embedded stack')
    sink.appendLine('renderer line one')

    const lines = fs.readFileSync(path.join(dir, 'aurora.log'), 'utf8').trimEnd().split('\n')
    expect(lines[0]).toBe('renderer line one')
    expect(lines[1]).toBe('renderer line two')
    expect(lines[2]).toBe('with embedded stack')
    // 重复内容照原样追加：不做事后去重（去重会让「刷屏」这类现场失真）
    expect(lines[3]).toBe('renderer line one')
  })

  it('空白行被忽略，不会在文件里堆出无意义的空行', () => {
    const sink = createFileSink({ dir })
    // 空串、纯换行、纯空格三种都来自「渲染层 line 归一失败」这类路径
    sink.appendLine('')
    sink.appendLine('\n')
    sink.appendLine('   ')

    // 真的一点都没写：文件因此根本不会被创建（构造期不碰磁盘，首条写入才建目录）
    expect(sink.listFiles()).toEqual([])
    expect(sink.readParts()).toEqual([])
  })
})

describe('滚动', () => {
  it('写满 2MB 触发轮转：活跃文件退位为 aurora.1.log，新记录回到 aurora.log', () => {
    const sink = createFileSink({ dir })
    // 每条 20KB，写 120 条 = 2.4MB，必然越过 2MB 上限一次
    const chunk = 'x'.repeat(20 * 1024)
    for (let i = 0; i < 120; i += 1) sink.appendLine(`${i.toString().padStart(4, '0')} ${chunk}`)

    const names = namesIn(sink)
    expect(names).toContain('aurora.log')
    expect(names).toContain('aurora.1.log')
    // 每个文件都不超过上限（按「已有字节 + 待写字节」判定，不是事后截断）
    for (const file of sink.listFiles()) expect(file.sizeBytes).toBeLessThanOrEqual(MAX_LOG_FILE_BYTES)
  })

  it('最多保留 5 个文件，最旧的内容被删掉（小上限下跑满 6 轮以上）', () => {
    // 用小上限把「6 轮滚动」压缩到毫秒级：代码路径与 2MB 完全一致，只是阈值不同
    const sink = createFileSink({ dir, maxFileBytes: 2048 })
    const perLine = 'y'.repeat(900)

    // 每轮写 3 条（约 2.7KB > 2KB）→ 触发一次轮转；写 9 轮 = 至少 8 次轮转
    for (let generation = 0; generation < 9; generation += 1) {
      for (let i = 0; i < 3; i += 1) sink.appendLine(`GEN${generation}-${i} ${perLine}`)
    }

    const names = namesIn(sink)
    expect(names.length).toBeLessThanOrEqual(MAX_LOG_FILES)
    expect(names).toHaveLength(MAX_LOG_FILES)
    // 活跃文件 + 4 个归档位，没有 5 号归档
    expect(names).toContain('aurora.log')
    expect(names).toContain('aurora.1.log')
    expect(names).toContain('aurora.4.log')
    expect(names).not.toContain('aurora.5.log')

    // 最旧的代次已被彻底删掉；最新的留在活跃文件里
    const everything = readAll(sink)
    expect(everything).not.toContain('GEN0-')
    expect(everything).not.toContain('GEN1-')
    expect(fs.readFileSync(path.join(dir, 'aurora.log'), 'utf8')).toContain('GEN8-')

    // 总占用仍在上限内，且文件数 × 单文件上限就是目录的理论上限
    expect(sink.storageInfo().totalBytes).toBeLessThanOrEqual(MAX_LOG_FILES * 2048)
  })

  it('单条记录超过单文件上限时被截断，文件不会撑破上限', () => {
    const sink = createFileSink({ dir, maxFileBytes: 4096 })
    sink.appendLine('z'.repeat(50 * 1024))

    const [file] = sink.storageInfo().files
    expect(file.sizeBytes).toBeLessThanOrEqual(4096)
    expect(fs.readFileSync(path.join(dir, 'aurora.log'), 'utf8')).toContain('truncated')
  })

  it('文件清单旧 → 新，最后一项是活跃文件（供导出包排段用）', () => {
    const sink = createFileSink({ dir, maxFileBytes: 1024 })
    for (let generation = 0; generation < 4; generation += 1) {
      sink.appendLine(`SEG${generation} ${'w'.repeat(900)}`)
    }

    const names = namesIn(sink)
    expect(names.length).toBeGreaterThan(1)
    expect(names[names.length - 1]).toBe('aurora.log')
    // 序号越大越旧：aurora.2.log 要排在 aurora.1.log 之前
    const indexes = names.slice(0, -1).map((name) => Number(/\.(\d+)\.log$/.exec(name)?.[1]))
    expect(indexes).toEqual([...indexes].sort((a, b) => b - a))
  })
})

describe('复用与恢复', () => {
  it('重启后同一目录续写：不重置已有内容，滚动判定基准取已有字节数', () => {
    const first = createFileSink({ dir, maxFileBytes: 2048 })
    first.appendLine(`A ${'a'.repeat(900)}`)
    first.appendLine(`B ${'b'.repeat(900)}`)

    // 模拟进程重启：新的 sink 实例必须从磁盘重新同步大小，而不是从 0 开始
    const second = createFileSink({ dir, maxFileBytes: 2048 })
    second.appendLine('C '.padEnd(1200, 'c'))

    const content = fs.readFileSync(path.join(dir, 'aurora.log'), 'utf8')
    // 已有约 1.8KB + 新 1.2KB 越过 2KB 上限 → 触发轮转：整份旧内容退位到 aurora.1.log，
    // 活跃文件里只剩这次新写的那条。判定基准必须是磁盘上的真实大小（1.8KB），
    // 若新实例从 0 开始算，这里就不会轮转、A/B/C 全挤在 aurora.log 里。
    expect(content).toContain('C ccc')
    expect(content).not.toContain('A aaa')

    const archived = fs.readFileSync(path.join(dir, 'aurora.1.log'), 'utf8')
    expect(archived).toContain('A aaa')
    expect(archived).toContain('B bbb')
  })

  it('目录不可写时吞掉错误，后续写入仍能工作（用户修好权限后自动恢复）', () => {
    // 用一个「同名普通文件」占住目录路径：mkdir -p 会失败，append 也会失败
    const blocked = path.join(tmpRoot, 'blocked')
    fs.writeFileSync(blocked, 'not a directory')
    const sink = createFileSink({ dir: blocked })

    expect(() => sink.appendLine('into nowhere')).not.toThrow()
    expect(() => sink.sink(record('also nowhere'))).not.toThrow()
    // 查询类方法失败返回空结果，不抛
    expect(sink.listFiles()).toEqual([])
    expect(sink.readParts()).toEqual([])
    expect(sink.storageInfo()).toMatchObject({ dir: blocked, files: [], totalBytes: 0 })
  })

  it('目录里与命名无关的文件不参与滚动、也不会被删', () => {
    const sink = createFileSink({ dir, maxFileBytes: 1024 })
    sink.appendLine(`seed ${'s'.repeat(10)}`)
    // 用户自己放进来的文件（例如手动导出的旧包），不属于本模块的命名空间
    fs.writeFileSync(path.join(dir, 'user-notes.txt'), 'keep me')
    fs.writeFileSync(path.join(dir, 'aurora.bak.log'), 'keep me too')

    for (let generation = 0; generation < 8; generation += 1) {
      sink.appendLine(`GEN${generation} ${'g'.repeat(900)}`)
    }

    expect(fs.existsSync(path.join(dir, 'user-notes.txt'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'aurora.bak.log'))).toBe(true)
    expect(namesIn(sink).every((name) => /^aurora(\.\d+)?\.log$/.test(name))).toBe(true)
  })
})

describe('storageInfo', () => {
  it('给出目录、文件清单、总字节与两项上限', () => {
    const sink = createFileSink({ dir })
    sink.appendLine('one')
    sink.appendLine('two')

    const info = sink.storageInfo()
    expect(info.dir).toBe(dir)
    expect(info.files).toHaveLength(1)
    expect(info.files[0]).toMatchObject({ name: 'aurora.log' })
    expect(info.files[0].sizeBytes).toBeGreaterThan(0)
    // mtime 必须是正的 epoch 毫秒：shared 的 buildLogBundle 靠它排序
    expect(info.files[0].mtime).toBeGreaterThan(0)
    expect(info.totalBytes).toBe(info.files[0].sizeBytes)
    expect(info.maxFileBytes).toBe(MAX_LOG_FILE_BYTES)
    expect(info.maxFiles).toBe(MAX_LOG_FILES)
  })
})
