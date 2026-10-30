/**
 * 脱敏的**端到端落盘**验证（不是只测 redactText）。
 *
 * 为什么要单独一个文件测这件事：`?key=` 曾经完全不脱敏，而当时的单元测试
 * 恰好把「`key` 不是凭据」写成了期望值 —— 缺陷被固化成测试通过，谁也没发现。
 * 守护这条线的办法只有一个：**从最终产物的字节上断言**，走完整链路
 * （logger → 文件出口 → 磁盘），而不是只调一次脱敏函数。
 *
 * 覆盖的行形态都取自项目里真实存在的调用点：
 * - `console.warn('[MediaCache] 下载失败：HTTP 404', url)`（desktop/src/ipc/mediaCache.ts）
 * - `console.warn('封面嵌入失败（不影响下载）:', track.coverUrl, err)`（desktop/src/ipc/handlers.ts）
 * - 音源端点模板里的 `&key=<API_KEY>`（shared/src/auroraPreset.ts）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildLogBundle,
  captureConsole,
  createLogger,
  formatRecord,
  initLogging,
  isSecretKey,
  redactText,
  type LogSink,
} from '../index'

/** 假凭据：一眼可辨非生产值（AGENTS.md 要求），但形态与真实凭据一致 */
const FAKE_KEY = '00000000-0000-4000-8000-000000000000'
const FAKE_TOKEN = 'tok_9f8e7d6c5b4a3210'
const FAKE_DAV_PASSWORD = 'hunter2secret'
const FAKE_COOKIE = 'session=abcdef123456'

/** 音源服务的真实端点形态：凭据参数名就是 `key` */
const AURORA_ENDPOINT = `https://source.invalid/aurora?query=x&quality=320&key=${FAKE_KEY}`
/** 封面代理形态：同样是 `?key=`，曾经漏打码的另一处 */
const COVER_URL = `https://cover.invalid/get?key=${FAKE_KEY}&size=300`

let dir: string
let restoreConsole: (() => void) | null = null

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-redact-e2e-'))
})

afterEach(() => {
  restoreConsole?.()
  restoreConsole = null
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 文件出口：与 desktop 的 fileSink 同语义（同步追加），足够验证落盘字节 */
function fileSink(targetDir: string): LogSink {
  const file = path.join(targetDir, 'aurora.log')
  // 复用内核的排版：这里要测的是「记录的最终文本」，不是自己拼一个
  return (record) => {
    fs.appendFileSync(file, `${formatRecord(record)}\n`, 'utf8')
  }
}

/** 读回磁盘上写下的全部内容 */
function readDisk(): string {
  const file = path.join(dir, 'aurora.log')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

describe('脱敏端到端：磁盘字节级', () => {
  /**
   * 最重要的那条：`?key=` 必须打码。
   *
   * 这条断言存在的理由就是它曾经不存在 —— 上一版单测里 `isSecretKey('key')` 被断言为
   * false，把「URL 里的 key 不脱敏」固化成了正确行为，于是本项目最该保护的凭据
   * （音源服务的 API_KEY 兼作 MASK_SECRET）会随用户导出的日志直接外泄。
   */
  it('音源端点里的 &key=<凭据> 不会出现在落盘文件里', () => {
    initLogging({ sinks: [fileSink(dir)], level: 'trace', origin: 'main' })
    createLogger('e2e').info(`resolved: ${AURORA_ENDPOINT}`)

    const disk = readDisk()
    expect(disk).not.toContain(FAKE_KEY)
    expect(disk).toContain('key=***')
    // 排障需要的信息要保留：非敏感参数不能被打码掉
    expect(disk).toContain('query=x')
    expect(disk).toContain('quality=320')
  })

  it('console.warn(..., url) 这条真实调用形态也脱敏（console 接管路径）', () => {
    initLogging({ sinks: [fileSink(dir)], level: 'trace', origin: 'main' })
    // echo: false —— 测试输出保持干净；接管逻辑与生产一致
    restoreConsole = captureConsole({ scopePrefix: 'main', echo: false })

    console.warn('[MediaCache] 下载失败：HTTP 404', COVER_URL)
    console.warn('封面嵌入失败（不影响下载）:', COVER_URL, new Error(`failed ${COVER_URL}`))

    const disk = readDisk()
    expect(disk).not.toContain(FAKE_KEY)
    // scope 要能从 console 前缀提取出来，否则日志无法按模块过滤
    expect(disk).toContain('MediaCache')
  })

  it('Authorization / Cookie / userinfo / 键值对四种形态都不落到磁盘', () => {
    initLogging({ sinks: [fileSink(dir)], level: 'trace', origin: 'main' })
    const log = createLogger('e2e')

    log.info(`Authorization: Bearer ${FAKE_TOKEN}`)
    log.info(`Cookie: ${FAKE_COOKIE}`)
    log.info(`dav https://davuser:${FAKE_DAV_PASSWORD}@dav.invalid/music`)
    log.info(`config api_key=${FAKE_KEY} token=${FAKE_TOKEN}`)
    log.error('request failed', new Error(`upstream 401 token=${FAKE_TOKEN}`))

    const disk = readDisk()
    for (const secret of [FAKE_KEY, FAKE_TOKEN, FAKE_DAV_PASSWORD, 'abcdef123456']) {
      expect(disk, `磁盘不得含 ${secret}`).not.toContain(secret)
    }
    expect(disk).toContain('***')
  })

  it('导出包（buildLogBundle 产物）同样不含凭据', () => {
    initLogging({ sinks: [fileSink(dir)], level: 'trace', origin: 'main' })
    createLogger('e2e').info(`endpoint ${AURORA_ENDPOINT}`)

    const bundle = buildLogBundle(
      { appVersion: '0.0.0', origin: 'main', platform: 'linux', exportedAt: 0 },
      [{ name: 'aurora.log', mtime: 0, content: readDisk() }]
    )
    expect(bundle).not.toContain(FAKE_KEY)
    expect(bundle).toContain('***')
  })

  it('脱敏是幂等的：对已打码文本再跑一次结果不变', () => {
    // 主进程会对渲染层记录再脱敏一次，这里守住「重复脱敏不会破坏已打码文本」
    const once = redactText(`x?key=${FAKE_KEY}`)
    expect(redactText(once)).toBe(once)
  })
})

describe('裸 key 的位置语义', () => {
  it('URL 语境按凭据处理，对象字段名按普通键处理', () => {
    expect(isSecretKey('key', 'url')).toBe(true)
    expect(isSecretKey('key', 'field')).toBe(false)
    // 默认从严：将来新增调用点忘传 context 时也不会放过
    expect(isSecretKey('key')).toBe(true)
  })
})
