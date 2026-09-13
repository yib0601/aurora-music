/**
 * WebDAV 客户端的端到端验证：起一个真实的最小 WebDAV 服务器（PROPFIND + Range GET
 * + Basic 鉴权），验证列举、目录递归、中文/空格路径、Range 读取与鉴权是否真的能工作。
 *
 * 纯 XML 单测只能覆盖解析器的分支，覆盖不到「请求头对不对」「207 状态怎么处理」
 * 「Range 响应是否真被服务器认账」这类协议层面的问题——而真实 NAS 无法进 CI。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openWebdavRange, walkWebdavAudio, listWebdavDir, WebdavError, type LibrarySourceConfig } from '../webdav'

const USER = 'bob'
const PASS = 'p@ss word'
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`, 'utf-8').toString('base64')}`

/** 虚构的远端文件树：字节内容 = 该文件在树中的填充字节 */
const FILES: Record<string, Buffer> = {
  'Music/Album One/01 反方向的钟.mp3': Buffer.alloc(300000, 0x11),
  'Music/Album One/02 简单爱.mp3': Buffer.alloc(120000, 0x22),
  'Music/Album One/cover.jpg': Buffer.alloc(1000, 0x33),
  'Music/readme.txt': Buffer.alloc(10, 0x44),
  'Music/@eaDir/01 反方向的钟.mp3': Buffer.alloc(5000, 0x55),
  '.hidden/secret.mp3': Buffer.alloc(5000, 0x66),
}

const DIRS = new Set(['', 'Music', 'Music/Album One', 'Music/@eaDir', '.hidden', 'Empty'])

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 按 Depth: 1 语义列出某个目录的直接子项 */
function propfindBody(dir: string): string {
  const encode = (p: string) => p.split('/').map(encodeURIComponent).join('/')
  const responses: string[] = []
  const push = (rel: string, isDir: boolean, size: number) => {
    responses.push(`<D:response>
  <D:href>/dav/${encode(rel)}${isDir ? '/' : ''}</D:href>
  <D:propstat>
    <D:prop>
      <D:displayname>${xmlEscape(rel.split('/').pop() || '')}</D:displayname>
      <D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>
      <D:getcontentlength>${size}</D:getcontentlength>
      <D:getlastmodified>Wed, 01 Jan 2025 00:00:00 GMT</D:getlastmodified>
    </D:prop>
    <D:status>HTTP/1.1 200 OK</D:status>
  </D:propstat>
</D:response>`)
  }

  push(dir, true, 0)
  const prefix = dir ? `${dir}/` : ''
  for (const d of DIRS) {
    if (d === dir) continue
    if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/') && d !== '') push(d, true, 0)
  }
  for (const f of Object.keys(FILES)) {
    if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) push(f, false, FILES[f].length)
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`
}

let server: http.Server
let baseUrl = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    // 目录本身也可能不带尾部斜杠被请求
    const pathname = decodeURIComponent(url.pathname).replace(/^\/dav\/?/, '').replace(/\/$/, '')

    if (req.headers.authorization !== AUTH) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dav"' })
      res.end()
      return
    }

    if (req.method === 'PROPFIND') {
      // Depth 必须为 1：真实服务器对缺失/非法 Depth 会返回 400
      if (String(req.headers.depth) !== '1') {
        res.writeHead(400).end('Depth must be 1')
        return
      }
      if (!DIRS.has(pathname)) {
        res.writeHead(404).end()
        return
      }
      const body = propfindBody(pathname)
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
      res.end(body)
      return
    }

    if (req.method === 'GET') {
      const file = FILES[pathname]
      if (!file) {
        res.writeHead(404).end()
        return
      }
      const range = req.headers.range
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(String(range))
        if (!m) {
          res.writeHead(416).end()
          return
        }
        const start = parseInt(m[1], 10)
        const end = m[2] ? Math.min(parseInt(m[2], 10), file.length - 1) : file.length - 1
        const chunk = file.subarray(start, end + 1)
        res.writeHead(206, {
          'Content-Type': 'audio/mpeg',
          'Content-Range': `bytes ${start}-${end}/${file.length}`,
          'Content-Length': String(chunk.length),
          'Accept-Ranges': 'bytes',
        })
        res.end(chunk)
        return
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(file.length) })
      res.end(file)
      return
    }

    res.writeHead(405).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}/dav`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function cfg(overrides: Partial<LibrarySourceConfig> = {}): LibrarySourceConfig {
  return {
    id: 'lib-test',
    kind: 'webdav',
    name: '测试 NAS',
    baseUrl,
    username: USER,
    password: PASS,
    rootPath: 'Music',
    enabled: true,
    ...overrides,
  }
}

describe('WebDAV 端到端', () => {
  it('递归列举曲库：只收音频、跳过 @eaDir 与隐藏目录、还原中文与空格路径', async () => {
    const audio = await walkWebdavAudio(cfg())
    expect(audio.map((e) => e.path).sort()).toEqual([
      'Album One/01 反方向的钟.mp3',
      'Album One/02 简单爱.mp3',
    ])
    // 大小来自 getcontentlength，供扫描时「未变化则复用」判断
    expect(audio.find((e) => e.path.endsWith('简单爱.mp3'))?.size).toBe(120000)
  })

  it('目录列举返回文件与子目录，并剔除发起请求的目录自身', async () => {
    const entries = await listWebdavDir(cfg(), '')
    expect(entries.some((e) => e.isDirectory && e.name === 'Album One')).toBe(true)
    expect(entries.some((e) => !e.isDirectory && e.name === 'readme.txt')).toBe(true)
    expect(entries.some((e) => e.path === '')).toBe(false)
  })

  it('Range 读取只取请求的字节区间', async () => {
    const resp = await openWebdavRange(cfg(), 'Album One/01 反方向的钟.mp3', 0, 1023)
    expect(resp.status).toBe(206)
    expect(resp.headers.get('content-range')).toBe('bytes 0-1023/300000')
    const buf = new Uint8Array(await resp.arrayBuffer())
    expect(buf.length).toBe(1024)
    expect(buf[0]).toBe(0x11)
  })

  it('口令错误时抛出可读的鉴权错误（而不是空曲库）', async () => {
    await expect(listWebdavDir(cfg({ password: 'wrong' }), '')).rejects.toThrow(WebdavError)
    await expect(walkWebdavAudio(cfg({ password: 'wrong' }))).rejects.toThrow(/鉴权失败/)
  })

  it('根目录不存在时抛错，避免被误判成空曲库', async () => {
    await expect(walkWebdavAudio(cfg({ rootPath: 'NoSuchDir' }))).rejects.toThrow(/路径不存在/)
  })

  it('根目录可访问但无音频时返回空数组（与"连不上"区分开）', async () => {
    const audio = await walkWebdavAudio(cfg({ rootPath: 'Empty' }))
    expect(audio).toEqual([])
  })
})
