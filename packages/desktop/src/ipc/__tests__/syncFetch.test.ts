/**
 * 主进程代发 HTTP（`sync:fetch`）的真实往返测试。
 *
 * 为什么这条通道值得单独测：打包形态渲染层 origin 是 `file://`，WebDAV 的
 * PROPFIND/PUT/MKCOL 全被 CORS 预检拦死；这条通道是唯一的出口，而它本身又能
 * 把任意请求发进内网，所以「协议白名单 / 不跟随重定向 / 超时 / 响应体上限 /
 * 日志不出现凭据」每一条都必须钉死。
 *
 * 不硬编码端口与路径：服务一律 `listen(0, '127.0.0.1')`，临时目录用 mkdtemp。
 * `electron` 必须 mock（lanSync.ts 顶层 import 了 app/safeStorage/ipcMain），
 * 且模块要在 beforeAll 里惰性 import —— desktop 的 electron tsconfig 是 CommonJS，
 * 禁顶层 await。
 */

import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LogRecord } from '@aurora/shared'

/** 所有请求都打到同一个临时 userData：真机上这里会是 Electron 的 app.getPath('userData') */
const mocks = vi.hoisted(() => ({
  userData: '',
  handle: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plain: string) => Buffer.from(plain, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8'),
  },
  ipcMain: { handle: mocks.handle },
}))

type LanSyncModule = typeof import('../lanSync')

let mod: LanSyncModule
let homeDir = ''
let initLogging: typeof import('@aurora/shared').initLogging

beforeAll(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurora-sync-fetch-'))
  mocks.userData = homeDir
  mod = await import('../lanSync')
  initLogging = (await import('@aurora/shared')).initLogging
})

afterAll(async () => {
  mod.setSyncFetchImpl(null)
  // 先把 sink 清掉，避免其它测试文件的记录被这里收走
  initLogging({ sinks: [], level: 'debug', origin: 'main' })
  await fs.rm(homeDir, { recursive: true, force: true })
})

afterEach(() => {
  mod.setSyncFetchImpl(null)
})

interface TestServer {
  readonly port: number
  readonly requests: Array<{
    method: string
    url: string
    headers: http.IncomingHttpHeaders
    body: string
  }>
  close(): Promise<void>
}

/** 起一个临时 HTTP 服务（listen(0) 由系统分配端口） */
async function serve(handler: http.RequestListener): Promise<TestServer> {
  const requests: TestServer['requests'] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      handler(req, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

function urlOf(port: number, pathname = '/dav'): string {
  return `http://127.0.0.1:${port}${pathname}`
}

describe('协议与入参校验', () => {
  it('只允许 http/https：file / ftp / 相对地址都被拒，且根本不发请求', async () => {
    const impl = vi.fn(async () => new Response('nope'))
    mod.setSyncFetchImpl(impl as never)

    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'not-a-url', '']) {
      await expect(mod.runSyncFetch({ url })).rejects.toMatchObject({ code: 'sync.error.unknown' })
    }
    expect(impl).not.toHaveBeenCalled()
  })

  it('拒绝 URL 内嵌凭据（口令不该出现在 URL / 日志 / 错误文案里）', async () => {
    await expect(
      mod.runSyncFetch({ url: 'http://user:secret@127.0.0.1:1/x' }),
    ).rejects.toMatchObject({ code: 'sync.error.unknown' })
  })

  it('拒绝 header 注入（值里带 CRLF）与 CONNECT/TRACE', async () => {
    await expect(
      mod.runSyncFetch({ url: 'http://127.0.0.1:1/x', headers: { 'x-test': 'a\r\nx-evil: 1' } }),
    ).rejects.toMatchObject({ code: 'sync.error.unknown' })
    await expect(
      mod.runSyncFetch({ url: 'http://127.0.0.1:1/x', method: 'CONNECT' }),
    ).rejects.toMatchObject({ code: 'sync.error.unknown' })
    await expect(
      mod.runSyncFetch({ url: 'http://127.0.0.1:1/x', method: 'TRACE' }),
    ).rejects.toMatchObject({ code: 'sync.error.unknown' })
  })

  it('GET/HEAD 带 body、非字符串 body、空 method 都被拒', async () => {
    for (const request of [
      { url: 'http://127.0.0.1:1/x', body: 'oops' },
      { url: 'http://127.0.0.1:1/x', method: 'HEAD', body: 'oops' },
      { url: 'http://127.0.0.1:1/x', method: 'PUT', body: { a: 1 } },
      { url: 'http://127.0.0.1:1/x', method: '  ' },
    ]) {
      await expect(mod.runSyncFetch(request)).rejects.toMatchObject({ code: 'sync.error.unknown' })
    }
  })

  it('超时归一：默认 15s，合法值保留，上限 60s，非法回默认', () => {
    expect(mod.SYNC_FETCH_DEFAULT_TIMEOUT_MS).toBe(15_000)
    expect(mod.SYNC_FETCH_MAX_TIMEOUT_MS).toBe(60_000)
    expect(mod.normalizeSyncFetchTimeout(undefined)).toBe(15_000)
    expect(mod.normalizeSyncFetchTimeout(0)).toBe(15_000)
    expect(mod.normalizeSyncFetchTimeout(-5)).toBe(15_000)
    expect(mod.normalizeSyncFetchTimeout(Number.NaN)).toBe(15_000)
    expect(mod.normalizeSyncFetchTimeout(2_500)).toBe(2_500)
    expect(mod.normalizeSyncFetchTimeout(120_000)).toBe(60_000)
  })

  it('响应体上限常量是 8MB', () => {
    expect(mod.SYNC_FETCH_MAX_BODY_BYTES).toBe(8 * 1024 * 1024)
  })

  it('method 归一为大写、header 名小写、不转发 content-length', () => {
    const normalized = mod.normalizeSyncFetchRequest({
      url: 'HTTP://Example.com:8080/dav',
      method: 'propfind',
      headers: { Authorization: 'Bearer x', 'Content-Length': '12' },
    })
    expect(normalized.method).toBe('PROPFIND')
    expect(normalized.headers.authorization).toBe('Bearer x')
    expect(normalized.headers).not.toHaveProperty('content-length')
  })
})

describe('真实往返', () => {
  it('GET：带回状态、状态文本、响应头与正文；Authorization 原样到达对端', async () => {
    const server = await serve((_req, res) => {
      res.statusCode = 201
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('X-Dav-Version', '1')
      res.end('ok-body')
    })

    try {
      const result = await mod.runSyncFetch({
        url: urlOf(server.port),
        headers: { Authorization: 'Bearer token-123', 'X-Test': 'yes' },
      })
      expect(result.status).toBe(201)
      expect(result.statusText).toBe('Created')
      expect(result.bodyText).toBe('ok-body')
      expect(result.headers['content-type']).toBe('text/plain; charset=utf-8')
      expect(result.headers['x-dav-version']).toBe('1')

      expect(server.requests).toHaveLength(1)
      expect(server.requests[0].method).toBe('GET')
      expect(server.requests[0].url).toBe('/dav')
      expect(server.requests[0].headers.authorization).toBe('Bearer token-123')
      expect(server.requests[0].headers['x-test']).toBe('yes')
    } finally {
      await server.close()
    }
  })

  it('PROPFIND + XML body 原样转发（WebDAV 的核心方法）', async () => {
    const server = await serve((_req, res) => {
      res.setHeader('Content-Type', 'application/xml')
      res.end('<multistatus />')
    })

    try {
      const body = '<?xml version="1.0"?><propfind xmlns="DAV:"/>'
      const result = await mod.runSyncFetch({
        url: urlOf(server.port, '/remote.php/dav/files/me/'),
        method: 'propfind',
        headers: { Depth: '1', 'Content-Type': 'application/xml' },
        body,
      })
      expect(result.status).toBe(200)
      expect(result.bodyText).toBe('<multistatus />')
      expect(server.requests[0].method).toBe('PROPFIND')
      expect(server.requests[0].body).toBe(body)
      expect(server.requests[0].headers.depth).toBe('1')
    } finally {
      await server.close()
    }
  })

  it('3xx 原样返回、绝不跟随重定向（对端不能把本机当跳板）', async () => {
    let redirected = 0
    const target = await serve((_req, res) => {
      redirected += 1
      res.end('should never be reached')
    })
    const source = await serve((_req, res) => {
      res.statusCode = 302
      res.setHeader('Location', urlOf(target.port))
      res.end()
    })

    try {
      const result = await mod.runSyncFetch({ url: urlOf(source.port, '/v1/snapshot') })
      expect(result.status).toBe(302)
      expect(result.headers.location).toBe(urlOf(target.port))
      expect(result.bodyText).toBe('')
      expect(source.requests).toHaveLength(1)
      expect(target.requests).toHaveLength(0)
      expect(redirected).toBe(0)
    } finally {
      await source.close()
      await target.close()
    }
  })

  it('响应体超过上限 → 结构化错误（声明了 content-length）', async () => {
    const payload = 'x'.repeat(4096)
    const server = await serve((_req, res) => {
      res.setHeader('Content-Length', String(payload.length))
      res.end(payload)
    })

    try {
      await expect(
        mod.runSyncFetch({ url: urlOf(server.port) }, { maxBodyBytes: 128 }),
      ).rejects.toMatchObject({ code: 'sync.error.unknown', detail: 'tooLarge' })
    } finally {
      await server.close()
    }
  })

  it('响应体超过上限 → 结构化错误（未声明长度、分块发）', async () => {
    const server = await serve((_req, res) => {
      res.setHeader('Content-Type', 'text/plain')
      res.write('a'.repeat(64))
      res.write('b'.repeat(4096))
      res.end()
    })

    try {
      await expect(
        mod.runSyncFetch({ url: urlOf(server.port) }, { maxBodyBytes: 128 }),
      ).rejects.toMatchObject({ code: 'sync.error.unknown', detail: 'tooLarge' })
    } finally {
      await server.close()
    }
  })

  it('超时 → webdavConnect 错误（reason 含 timeout）', async () => {
    const server = await serve((_req, res) => {
      setTimeout(() => {
        if (!res.destroyed) res.end('late')
      }, 400)
    })

    try {
      await expect(
        mod.runSyncFetch({ url: urlOf(server.port), timeoutMs: 50 }),
      ).rejects.toMatchObject({
        code: 'sync.error.webdavConnect',
        params: { reason: expect.stringContaining('timeout after 50ms') },
      })
    } finally {
      await server.close()
    }
  })

  it('连接被拒 → webdavConnect 错误（不把原始 message 抛给渲染层）', async () => {
    const server = await serve((_req, res) => res.end(''))
    const deadPort = server.port
    await server.close()

    const error = await mod
      .runSyncFetch({ url: `http://127.0.0.1:${deadPort}/x` })
      .then(() => null)
      .catch((err: unknown) => err as { code: string; params?: { name?: string } })
    expect(error?.code).toBe('sync.error.webdavConnect')
    expect(error?.params?.name).toBe(`127.0.0.1:${deadPort}`)
  })
})

describe('日志脱敏', () => {
  it('只记 method + host + status + 耗时，绝不含 Authorization / Cookie / body', async () => {
    const records: LogRecord[] = []
    initLogging({ sinks: [(record) => records.push(record)], level: 'debug', origin: 'main' })

    const server = await serve((_req, res) => res.end('done'))
    try {
      await mod.runSyncFetch({
        url: urlOf(server.port, '/secret-path?token=SUPER-SECRET-QUERY'),
        method: 'PUT',
        headers: {
          Authorization: 'Bearer SUPER-SECRET-TOKEN',
          Cookie: 'session=SUPER-SECRET-COOKIE',
        },
        body: 'SUPER-SECRET-BODY',
      })
    } finally {
      await server.close()
      initLogging({ sinks: [], level: 'debug', origin: 'main' })
    }

    const fetchRecords = records.filter((record) => record.message.includes('sync:fetch'))
    expect(fetchRecords.length).toBeGreaterThan(0)
    const joined = fetchRecords
      .map((record) => `${record.message}\n${record.detail ?? ''}\n${record.stack ?? ''}`)
      .join('\n')

    expect(joined).toContain('PUT')
    // host（含端口）是允许记的定位信息；path / query 不在其中
    expect(joined).toMatch(/127\.0\.0\.1:\d+/)
    expect(joined).toContain('200')

    // 凭据、Cookie、请求体、URL 查询串一概不许进日志
    expect(joined).not.toContain('SUPER-SECRET')
    expect(joined.toLowerCase()).not.toContain('authorization')
    expect(joined.toLowerCase()).not.toContain('cookie')

    // 时间戳以外只允许 method / host / status / ms 这几个字段
    const detail = fetchRecords[0].detail ?? ''
    expect(detail).not.toContain('secret-path')
  })
})
