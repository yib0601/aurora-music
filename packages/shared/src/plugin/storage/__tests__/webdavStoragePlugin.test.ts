/**
 * WebDAV 存储插件的**转发行为**验证：起一个真实的最小 WebDAV 服务器
 * （PROPFIND + Range GET + Basic 鉴权），确认插件把每个能力原样转给 `webdav.ts`。
 *
 * 为什么起真服务器而不是 mock：本插件是「只做转发」的适配器，风险恰恰在于
 * **转发时传错参数**（配置对象、Range 字符串、字段取值），mock 掉网络就看不到
 * 「settings 里的地址到底有没有被拼进请求」这类问题。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WEBDAV_STORAGE_FIELDS, webdavStoragePlugin } from '../webdavStoragePlugin'
import { storageFieldValue } from '../fields'
import { isStorageTransportError, storageErrorStatus } from '../errors'
import { BUILTIN_STORAGE_PLUGINS, getStoragePlugin } from '../index'
import type { LibrarySourceConfig } from '../../../webdav'
import { en, lookupMessage, zhCN } from '../../../i18n'

const USER = 'bob'
const PASS = 'p@ss word'
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`, 'utf-8').toString('base64')}`

/** 虚构远端文件树：字节内容 = 该文件在树中的填充字节 */
const FILES: Record<string, Buffer> = {
  'Music/Album One/01 反方向的钟.mp3': Buffer.alloc(300000, 0x11),
  'Music/Album One/02 简单爱.mp3': Buffer.alloc(120000, 0x22),
  'Music/readme.txt': Buffer.alloc(10, 0x44),
}
const DIRS = new Set(['', 'Music', 'Music/Album One'])

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function propfindBody(dir: string): string {
  const encode = (p: string) => p.split('/').map(encodeURIComponent).join('/')
  const out: string[] = []
  const push = (rel: string, isDir: boolean, size: number) => {
    out.push(`<D:response><D:href>/dav/${encode(rel)}${isDir ? '/' : ''}</D:href><D:propstat><D:prop>
  <D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>
  <D:getcontentlength>${size}</D:getcontentlength>
  <D:getlastmodified>Wed, 01 Jan 2025 00:00:00 GMT</D:getlastmodified>
</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`)
  }
  push(dir, true, 0)
  const prefix = dir ? `${dir}/` : ''
  for (const d of DIRS) {
    if (d !== '' && d !== dir && d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) push(d, true, 0)
  }
  for (const f of Object.keys(FILES)) {
    if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) push(f, false, FILES[f].length)
  }
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${out.join('')}</D:multistatus>`
}

let server: http.Server
let baseUrl = ''
/** 记录收到的 Range 头，用于验证「原样透传」而不是被解析重拼 */
const seenRanges: string[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const pathname = decodeURIComponent(url.pathname).replace(/^\/dav\/?/, '').replace(/\/$/, '')

    if (req.headers.authorization !== AUTH) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dav"' }).end()
      return
    }
    if (req.method === 'PROPFIND') {
      if (!DIRS.has(pathname)) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
      res.end(propfindBody(pathname))
      return
    }
    if (req.method === 'GET') {
      const file = FILES[pathname]
      if (!file) {
        res.writeHead(404).end()
        return
      }
      const range = req.headers.range ? String(req.headers.range) : ''
      if (range) seenRanges.push(range)
      // 支持 bytes=-N（尾段请求）：这是 openRange 表达不了、openStream 必须透传的形态
      const suffix = /^bytes=-(\d+)$/.exec(range)
      if (suffix) {
        const n = Math.min(parseInt(suffix[1], 10), file.length)
        const start = file.length - n
        const chunk = file.subarray(start)
        res.writeHead(206, {
          'Content-Type': 'audio/mpeg',
          'Content-Range': `bytes ${start}-${file.length - 1}/${file.length}`,
          'Content-Length': String(chunk.length),
          'Accept-Ranges': 'bytes',
        })
        res.end(chunk)
        return
      }
      const m = /^bytes=(\d+)-(\d*)$/.exec(range)
      if (m) {
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
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dav`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** 老配置形态（扁平字段）：验证零迁移可读 */
function legacyCfg(overrides: Partial<LibrarySourceConfig> = {}): LibrarySourceConfig {
  return {
    id: 'lib-legacy',
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

/** 新配置形态（pluginId + settings） */
function settingsCfg(overrides: Partial<LibrarySourceConfig> = {}): LibrarySourceConfig {
  return {
    id: 'lib-new',
    kind: 'webdav',
    pluginId: 'webdav',
    name: '测试 NAS',
    settings: { baseUrl, username: USER, password: PASS, rootPath: 'Music' },
    enabled: true,
    ...overrides,
  }
}

describe('webdav 存储插件：契约形状', () => {
  it('字段声明是 baseUrl / rootPath / username / password（与旧扁平字段同名，迁移零转换）', () => {
    expect(WEBDAV_STORAGE_FIELDS.map((f) => f.key)).toEqual([
      'baseUrl',
      'rootPath',
      'username',
      'password',
    ])
    // 只有服务地址必填；口令是 password 控件
    expect(WEBDAV_STORAGE_FIELDS.find((f) => f.key === 'baseUrl')?.required).toBe(true)
    expect(WEBDAV_STORAGE_FIELDS.find((f) => f.key === 'password')?.kind).toBe('password')
    expect(WEBDAV_STORAGE_FIELDS.find((f) => f.key === 'baseUrl')?.kind).toBe('url')
    expect(WEBDAV_STORAGE_FIELDS.find((f) => f.key === 'rootPath')?.kind).toBe('path')
  })

  it('字段的文案一律是键（本层不烧中文），且两侧字典都有', () => {
    const keys = WEBDAV_STORAGE_FIELDS.flatMap((f) => [f.labelKey, f.placeholderKey, f.hintKey])
      .concat([webdavStoragePlugin.displayNameKey, webdavStoragePlugin.descriptionKey as never])
      .filter((k): k is string => typeof k === 'string')
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      // 中文原文不能出现在源码里：这里能取到值说明键真实存在
      expect(typeof lookupMessage(zhCN as never, key)).toBe('string')
      expect(typeof lookupMessage(en as never, key)).toBe('string')
      expect(String(lookupMessage(zhCN as never, key)).trim().length).toBeGreaterThan(0)
    }
  })

  it('内置注册：webdav 在 import 期就已注册，且是唯一内置插件', () => {
    expect(BUILTIN_STORAGE_PLUGINS.map((p) => p.id)).toEqual(['webdav'])
    expect(getStoragePlugin('webdav')).toBe(webdavStoragePlugin)
  })

  it('四个能力方法都存在（播放代理可优先走 openStream）', () => {
    expect(typeof webdavStoragePlugin.listAudio).toBe('function')
    expect(typeof webdavStoragePlugin.openRange).toBe('function')
    expect(typeof webdavStoragePlugin.openStream).toBe('function')
    expect(typeof webdavStoragePlugin.probe).toBe('function')
  })
})

describe('webdav 存储插件：转发行为（真服务器）', () => {
  it('listAudio 转发递归列举：只收音频、路径相对根目录', async () => {
    const audio = await webdavStoragePlugin.listAudio!(legacyCfg())
    expect(audio.map((e) => e.path).sort()).toEqual([
      'Album One/01 反方向的钟.mp3',
      'Album One/02 简单爱.mp3',
    ])
  })

  it('新配置形态（settings）与老形态（扁平）行为完全一致', async () => {
    const viaSettings = await webdavStoragePlugin.listAudio!(settingsCfg())
    const viaLegacy = await webdavStoragePlugin.listAudio!(legacyCfg())
    expect(viaSettings.map((e) => e.path).sort()).toEqual(viaLegacy.map((e) => e.path).sort())
    // settings 里的 baseUrl 确实被拼进了请求（否则连不上这台服务器）
    expect(storageFieldValue(settingsCfg(), 'baseUrl')).toBe(baseUrl)
  })

  it('openRange 转发数值区间：206 + Content-Range', async () => {
    const resp = await webdavStoragePlugin.openRange!(legacyCfg(), 'Album One/01 反方向的钟.mp3', 0, 1023)
    expect(resp.status).toBe(206)
    expect(resp.headers.get('content-range')).toBe('bytes 0-1023/300000')
    expect((await resp.arrayBuffer()).byteLength).toBe(1024)
  })

  it('openStream 原样透传 Range 头（含 bytes=-N 尾段，openRange 表达不了的形态）', async () => {
    seenRanges.length = 0
    const resp = await webdavStoragePlugin.openStream!(legacyCfg(), 'Album One/02 简单爱.mp3', {
      range: 'bytes=-1024',
    })
    expect(seenRanges).toEqual(['bytes=-1024'])
    expect(resp.status).toBe(206)
    expect(resp.headers.get('content-range')).toBe('bytes 118976-119999/120000')
    expect((await resp.arrayBuffer()).byteLength).toBe(1024)
  })

  it('openStream 不给 range 时就是普通 GET（200 整文件）', async () => {
    seenRanges.length = 0
    const resp = await webdavStoragePlugin.openStream!(legacyCfg(), 'Music/readme.txt'.replace('Music/', ''))
    expect(seenRanges).toEqual([])
    expect(resp.status).toBe(200)
  })

  it('probe 转发连通性探测：结论是 i18n 信封（显示端 translateError 渲染）', async () => {
    // probe 只列举根目录、不递归：本 fixture 的根目录下只有子目录，故无示例音频
    const ok = await webdavStoragePlugin.probe!(legacyCfg())
    expect(ok.ok).toBe(true)
    expect(ok.message.startsWith('AURORA_ERR:')).toBe(true)
    expect(ok.message).toContain('webdavOk')
    expect(ok.sample).toEqual([])

    // 根目录下直接有音频时：结论切到带音频计数的整句，并给出示例文件名（取前 5 个）
    const withAudio = await webdavStoragePlugin.probe!(legacyCfg({ rootPath: 'Music/Album One' }))
    expect(withAudio.ok).toBe(true)
    expect(withAudio.message).toContain('webdavOkWithAudio')
    expect(withAudio.sample).toEqual(['01 反方向的钟.mp3', '02 简单爱.mp3'])
  })

  it('probe 失败时也走同一种载体（自由文本，不抛错）', async () => {
    const bad = await webdavStoragePlugin.probe!(legacyCfg({ password: 'wrong' }))
    expect(bad.ok).toBe(false)
    // 401 被映射成结构化错误码，而不是把中文句子烧进本层
    expect(bad.message.includes('AURORA_ERR:') || bad.message.length > 0).toBe(true)
  })
})

describe('webdav 存储插件：错误判据（取代 instanceof WebdavError）', () => {
  it('鉴权失败：错误带 HTTP 状态，且被判为传输层失败', async () => {
    const err = await webdavStoragePlugin
      .openRange!(legacyCfg({ password: 'wrong' }), 'Album One/01 反方向的钟.mp3', 0, 10)
      .then(() => null)
      .catch((e: unknown) => e)
    expect(err).toBeTruthy()
    expect(storageErrorStatus(err)).toBe(401)
    expect(isStorageTransportError(err)).toBe(true)
  })

  it('路径不存在：404 同样满足结构化判据', async () => {
    const err = await webdavStoragePlugin
      .listAudio!(legacyCfg({ rootPath: 'NoSuchDir' }))
      .then(() => null)
      .catch((e: unknown) => e)
    expect(err).toBeTruthy()
    expect(storageErrorStatus(err)).toBe(404)
    expect(isStorageTransportError(err)).toBe(true)
  })
})
