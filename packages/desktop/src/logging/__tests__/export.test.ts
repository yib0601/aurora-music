/**
 * 导出逻辑单测：分段顺序、导出包体积口径、重名不覆盖。
 *
 * 为什么和 fileSink 分开：`export.ts` 刻意不 import electron，就是为了这几条
 * 能在不启动 Electron 的情况下跑。其中「重名不覆盖」是唯一的破坏性风险 ——
 * 用户点两次导出、或提前把上次的包拖进下载目录，都可能撞名，
 * 覆盖掉的就是用户手里的那份证据。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { logBundleFileName, type LogEnvironment, type LogFilePart } from '@aurora/shared'
import { MAX_LOG_FILES } from '../fileSink'
import { candidateFileName, composeLogBundle, writeLogBundle } from '../export'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-export-'))
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

/** 固定时间戳：导出文件名与正文都带时间，固定值才能断言字面量 */
const EXPORTED_AT = new Date(2026, 0, 2, 3, 4, 5).getTime()

function env(overrides: Partial<LogEnvironment> = {}): LogEnvironment {
  return {
    appVersion: '0.7.3',
    origin: 'main',
    platform: 'linux',
    arch: 'x64',
    runtime: 'Electron 0.0.0-test / Chromium 0.0.0-test / Node 0.0.0-test',
    installKind: 'appimage',
    distro: 'Test Linux',
    // 语言用明显非生产的假值：断言只关心「这一行有没有被带上」
    locale: 'zh-CN',
    userDataPath: '/tmp/aurora-test-userdata',
    exportedAt: EXPORTED_AT,
    ...overrides,
  }
}

function part(name: string, mtime: number, content: string): LogFilePart {
  return { name, mtime, content }
}

describe('composeLogBundle', () => {
  it('分段按 mtime 旧 → 新排列，与传入顺序无关', () => {
    const result = composeLogBundle(env(), [
      part('aurora.log', 3000, 'NEWEST\n'),
      part('aurora.2.log', 1000, 'OLDEST\n'),
      part('aurora.1.log', 2000, 'MIDDLE\n'),
    ])

    const oldest = result.content.indexOf('OLDEST')
    const middle = result.content.indexOf('MIDDLE')
    const newest = result.content.indexOf('NEWEST')
    expect(oldest).toBeGreaterThan(0)
    expect(oldest).toBeLessThan(middle)
    expect(middle).toBeLessThan(newest)
  })

  it('环境头在最早位置，且带上了调用方给的全部字段', () => {
    const result = composeLogBundle(env(), [part('aurora.log', 1000, 'body\n')])

    const headerEnd = result.content.indexOf('body')
    expect(result.content.indexOf('Aurora Music diagnostic logs')).toBeLessThan(headerEnd)
    expect(result.content).toContain('0.7.3')
    expect(result.content).toContain('linux')
    expect(result.content).toContain('x64')
    expect(result.content).toContain('appimage')
    expect(result.content).toContain('Test Linux')
    expect(result.content).toContain('zh-CN')
    // 脱敏保证的提示必须随包发出去：用户发文件前应当被提醒一次
    expect(result.content).toContain('redacted')
  })

  it('条目数与字节数按拼好的正文算（含环境头与分隔线）', () => {
    const files = [part('aurora.1.log', 1000, 'aaa\n'), part('aurora.log', 2000, 'bbb\n')]
    const result = composeLogBundle(env(), files)

    expect(result.fileCount).toBe(2)
    expect(result.totalBytes).toBe(Buffer.byteLength(result.content, 'utf8'))
    // 正文一定比纯内容大：环境头 + 两段分隔线都要算进去
    const raw = files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0)
    expect(result.totalBytes).toBeGreaterThan(raw)
  })

  it('文件名与环境头的时间戳同源（同一次导出的时间一致）', () => {
    const result = composeLogBundle(env(), [])
    expect(result.fileName).toBe(logBundleFileName('0.7.3', EXPORTED_AT))
    // 文件名里的日期段形如 20260102-030405，与 exportedAt 对应
    expect(result.fileName).toContain('20260102-030405')
  })

  it('没有任何日志文件时给出明确说明而不是空包', () => {
    const result = composeLogBundle(env(), [])
    expect(result.fileCount).toBe(0)
    expect(result.totalBytes).toBeGreaterThan(0)
    // shared 排版层的固定措辞：出现它说明「没有文件」被如实写进了包里
    expect(result.content).toContain('no log files')
  })
})

describe('candidateFileName', () => {
  it('第 0 个候选就是原名，之后在扩展名前加 -2 / -3', () => {
    expect(candidateFileName('Aurora-Music-logs-v0.7.3-20260102-030405.txt', 0)).toBe(
      'Aurora-Music-logs-v0.7.3-20260102-030405.txt'
    )
    // 关键点：后缀必须在 .txt 之前，否则文件管理器不再按文本文件识别
    expect(candidateFileName('Aurora-Music-logs-v0.7.3-20260102-030405.txt', 1)).toBe(
      'Aurora-Music-logs-v0.7.3-20260102-030405-2.txt'
    )
    expect(candidateFileName('a.txt', 9)).toBe('a-10.txt')
  })

  it('无扩展名时退化为整体追加（不产生多余的点）', () => {
    expect(candidateFileName('noext', 1)).toBe('noext-2')
  })
})

describe('writeLogBundle', () => {
  it('写到指定目录并返回 filePath / dir / bytes', () => {
    const result = writeLogBundle(tmpRoot, 'bundle.txt', 'hello\n')

    expect(result.dir).toBe(tmpRoot)
    expect(result.filePath).toBe(path.join(tmpRoot, 'bundle.txt'))
    expect(result.bytes).toBe(Buffer.byteLength('hello\n', 'utf8'))
    expect(fs.readFileSync(result.filePath, 'utf8')).toBe('hello\n')
  })

  it('重名时不覆盖已有文件，换 -2 后缀，两次内容都在', () => {
    const first = writeLogBundle(tmpRoot, 'bundle.txt', 'FIRST\n')
    const second = writeLogBundle(tmpRoot, 'bundle.txt', 'SECOND\n')

    expect(first.filePath).not.toBe(second.filePath)
    expect(path.basename(second.filePath)).toBe('bundle-2.txt')
    // 用户原本那一份毫发无损：这是整个导出流程里唯一不可逆的动作
    expect(fs.readFileSync(first.filePath, 'utf8')).toBe('FIRST\n')
    expect(fs.readFileSync(second.filePath, 'utf8')).toBe('SECOND\n')
  })

  it('连续撞名时一路递增，不覆盖任何一份', () => {
    const paths = [
      writeLogBundle(tmpRoot, 'bundle.txt', '1\n').filePath,
      writeLogBundle(tmpRoot, 'bundle.txt', '2\n').filePath,
      writeLogBundle(tmpRoot, 'bundle.txt', '3\n').filePath,
    ]
    expect(paths.map((filePath) => path.basename(filePath))).toEqual([
      'bundle.txt',
      'bundle-2.txt',
      'bundle-3.txt',
    ])
    expect(paths.map((filePath) => fs.readFileSync(filePath, 'utf8'))).toEqual(['1\n', '2\n', '3\n'])
  })

  it('目录不存在时自动创建（下载目录可能被用户删掉）', () => {
    const target = path.join(tmpRoot, 'downloads', 'nested')
    const result = writeLogBundle(target, 'bundle.txt', 'content')

    expect(result.dir).toBe(target)
    expect(fs.existsSync(result.filePath)).toBe(true)
  })

  it('目录不可写时抛错而不是假装成功（界面必须能把这个失败显示给用户）', () => {
    // 用同名普通文件占住目录路径：mkdirSync 与 writeFileSync 都会失败
    const blocked = path.join(tmpRoot, 'blocked')
    fs.writeFileSync(blocked, 'not a directory')

    expect(() => writeLogBundle(blocked, 'bundle.txt', 'x')).toThrow()
  })
})

describe('与滚动上限的关系', () => {
  it('导出包的默认保留份额是 5 个文件（与 fileSink 的 maxFiles 对齐）', () => {
    // 两者必须一致：导出包里说「5 个文件，共 X MB」，而目录里保留的正好是这 5 个；
    // 若脱钩，用户会看到导出内容比目录里少/多一段
    expect(MAX_LOG_FILES).toBe(5)
  })
})
