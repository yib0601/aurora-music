/**
 * `webdav-sync` 插件（`docs/playlist-sync.md` §6 / §15.2）。
 *
 * 用真起一个最小 WebDAV 服务（`listen(0)` 拿随机端口）而不是打桩 `fetch`：
 * 这里最容易出错的地方恰恰在协议细节上——多状态体的 href 形态、`405` 表示目录已存在、
 * `PUT` 的状态码集合。桩掉 fetch 就只能验证"我以为的协议"，验证不了实现与协议对不对得上。
 * 服务器只实现本插件用到的四个方法（PROPFIND / GET / PUT / MKCOL），不做通用 WebDAV。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseErrorInfo, toErrorInfo } from '../../../i18n/errors'
import { webdavSyncPlugin } from '../webdavSyncPlugin'
import { serializeSnapshot } from '../snapshot'
import { SYNC_SNAPSHOT_FORMAT, type SyncConfig, type SyncContext, type SyncSnapshot } from '../types'

const AUTH_USER = 'demo-user'
const AUTH_PASSWORD = 'app-password'
const AUTH_HEADER = `Basic ${Buffer.from(`${AUTH_USER}:${AUTH_PASSWORD}`).toString('base64')}`

/** 远端目录树（键是相对 baseUrl 的路径，'' 为根） */
let dirs: Set<string>
/** 远端文件（键同上） */
let files: Map<string, string>
let putStatus: number | null
let propfindStatus: number | null
let server: Server
let baseUrl = ''

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function hrefOf(relPath: string, isDir: boolean): string {
  const path = relPath ? `/dav/${relPath}` : '/dav/'
  return isDir && !path.endsWith('/') ? `${path}/` : path
}

function entryResponse(relPath: string, isDir: boolean, size: number): string {
  const resourceType = isDir ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>'
  const length = isDir ? '' : `<D:getcontentlength>${size}</D:getcontentlength>`
  const modified = isDir ? '' : `<D:getlastmodified>${new Date(1_700_000_000_000).toUTCString()}</D:getlastmodified>`
  return (
    `<D:response><D:href>${xmlEscape(hrefOf(relPath, isDir))}</D:href><D:propstat><D:prop>` +
    `${resourceType}${length}${modified}` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  )
}

function relPathOf(req: IncomingMessage): string {
  const url = new URL(req.url ?? '/', 'http://placeholder')
  let rel = decodeURIComponent(url.pathname)
  if (rel.startsWith('/dav')) rel = rel.slice('/dav'.length)
  return rel.replace(/^\/+|\/+$/g, '')
}

function childrenOf(parent: string): { files: string[]; dirs: string[] } {
  const prefix = parent ? `${parent}/` : ''
  const fileNames: string[] = []
  const dirNames: string[] = []
  for (const key of files.keys()) {
    if (!key.startsWith(prefix)) continue
    const rest = key.slice(prefix.length)
    if (rest && !rest.includes('/')) fileNames.push(rest)
  }
  for (const key of dirs) {
    if (key === parent || !key.startsWith(prefix)) continue
    const rest = key.slice(prefix.length)
    if (rest && !rest.includes('/')) dirNames.push(rest)
  }
  return { files: fileNames, dirs: dirNames }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  if (req.headers.authorization !== AUTH_HEADER) {
    res.statusCode = 401
    res.end('unauthorized')
    return
  }
  const rel = relPathOf(req)
  const method = (req.method ?? 'GET').toUpperCase()

  if (method === 'PROPFIND') {
    if (propfindStatus !== null) {
      res.statusCode = propfindStatus
      res.end('nope')
      return
    }
    if (!dirs.has(rel)) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    const children = childrenOf(rel)
    const body =
      `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">` +
      entryResponse(rel, true, 0) +
      children.files.map((name) => entryResponse(rel ? `${rel}/${name}` : name, false, files.get(rel ? `${rel}/${name}` : name)?.length ?? 0)).join('') +
      children.dirs.map((name) => entryResponse(rel ? `${rel}/${name}` : name, true, 0)).join('') +
      `</D:multistatus>`
    res.statusCode = 207
    res.setHeader('Content-Type', 'application/xml; charset=utf-8')
    res.end(body)
    return
  }

  if (method === 'GET') {
    const body = files.get(rel)
    if (body === undefined) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    res.statusCode = 200
    res.end(body)
    return
  }

  if (method === 'PUT') {
    if (putStatus !== null) {
      res.statusCode = putStatus
      res.end('rejected')
      return
    }
    void readBody(req).then((body) => {
      files.set(rel, body)
      res.statusCode = 201
      res.end()
    })
    return
  }

  if (method === 'MKCOL') {
    if (dirs.has(rel)) {
      // 真实 WebDAV 服务器对已存在的集合返回 405，插件必须当作成功
      res.statusCode = 405
      res.end('already exists')
      return
    }
    dirs.add(rel)
    res.statusCode = 201
    res.end()
    return
  }

  res.statusCode = 501
  res.end('unsupported')
}

beforeAll(async () => {
  server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}/dav`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
})

beforeEach(() => {
  dirs = new Set([''])
  files = new Map()
  putStatus = null
  propfindStatus = null
})

function configOf(over: Partial<SyncConfig> = {}): SyncConfig {
  return {
    id: 'cfg-1',
    pluginId: 'webdav-sync',
    name: '我的 NAS',
    settings: { url: baseUrl, username: AUTH_USER, dir: '' },
    direction: 'bidirectional',
    autoSync: false,
    enabled: true,
    ...over
  }
}

function contextOf(password = AUTH_PASSWORD): SyncContext {
  return {
    fetch: globalThis.fetch as unknown as SyncContext['fetch'],
    secrets: { password },
    device: { deviceId: 'dev-self', deviceName: '本机' },
    log: () => {}
  }
}

function snapshotOf(deviceId: string, over: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    format: SYNC_SNAPSHOT_FORMAT,
    deviceId,
    deviceName: deviceId,
    revision: 1,
    updatedAt: 1_000,
    playlists: [{ id: `pl-${deviceId}`, name: deviceId, createdAt: 1, updatedAt: 2, tracks: [] }],
    ...over
  }
}

function codeOf(run: () => Promise<unknown>): Promise<string> {
  return run().then(
    () => {
      throw new Error('预期抛错，但没有抛')
    },
    (error) => toErrorInfo(error).code
  )
}

function paramsOf(run: () => Promise<unknown>): Promise<Record<string, string | number>> {
  return run().then(
    () => {
      throw new Error('预期抛错，但没有抛')
    },
    (error) => toErrorInfo(error).params ?? {}
  )
}

const pull = () => webdavSyncPlugin.pull!(configOf(), contextOf())
const push = (snapshot: SyncSnapshot) => webdavSyncPlugin.push!(configOf(), snapshot, contextOf())

describe('pull', () => {
  it('枚举目录并解析出其它设备的快照（跳过自己的文件与非 json）', async () => {
    dirs.add('aurora-sync')
    files.set('aurora-sync/dev-self.json', serializeSnapshot(snapshotOf('dev-self')))
    files.set('aurora-sync/dev-other.json', serializeSnapshot(snapshotOf('dev-other')))
    files.set('aurora-sync/notes.txt', '别当快照读')

    const snapshots = await pull()

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].deviceId).toBe('dev-other')
    expect(snapshots[0].playlists[0].id).toBe('pl-dev-other')
  })

  it('目录还不存在（404）时返回空数组，不报错——首次同步的正常状态', async () => {
    // dirs 里只有根，没有 aurora-sync
    await expect(pull()).resolves.toEqual([])
  })

  it('单个文件坏掉只跳过它，其它文件照常返回', async () => {
    dirs.add('aurora-sync')
    files.set('aurora-sync/broken.json', '{ 半截 json')
    files.set('aurora-sync/old-format.json', JSON.stringify({ format: 'aurora-playlist-sync/0', deviceId: 'dev-old', playlists: [] }))
    files.set('aurora-sync/dev-other.json', serializeSnapshot(snapshotOf('dev-other')))
    const logged: unknown[] = []
    const ctx = { ...contextOf(), log: (...args: unknown[]) => logged.push(args) }

    const snapshots = await webdavSyncPlugin.pull!(configOf(), ctx)

    expect(snapshots.map((s) => s.deviceId)).toEqual(['dev-other'])
    expect(logged.length).toBe(2)
  })

  it('认证失败映射成 sync.error.webdavAuth', async () => {
    dirs.add('aurora-sync')
    const ctx = contextOf('wrong-password')
    expect(await codeOf(() => webdavSyncPlugin.pull!(configOf(), ctx))).toBe('sync.error.webdavAuth')
  })

  it('其它 HTTP 状态映射成 sync.error.webdavStatus 并带上状态码', async () => {
    dirs.add('aurora-sync')
    propfindStatus = 500
    expect(await codeOf(pull)).toBe('sync.error.webdavStatus')
    expect((await paramsOf(pull)).status).toBe(500)
  })
})

describe('push', () => {
  it('自动创建同步目录，并把引擎给的快照原样写进 <deviceId>.json', async () => {
    const snapshot = snapshotOf('dev-self')
    await push(snapshot)

    expect(dirs.has('aurora-sync')).toBe(true)
    const written = files.get('aurora-sync/dev-self.json')
    expect(written).toBeDefined()
    // 插件不合并、不裁剪：写入内容与引擎给的快照逐字节一致
    expect(written).toBe(serializeSnapshot(snapshot))
    expect(JSON.parse(written as string).deviceId).toBe('dev-self')
  })

  it('目录已存在（MKCOL 返回 405）时仍然成功', async () => {
    dirs.add('aurora-sync')
    await expect(push(snapshotOf('dev-self'))).resolves.toBeUndefined()
    expect(files.has('aurora-sync/dev-self.json')).toBe(true)
  })

  it('PUT 失败映射成 sync.error.webdavStatus 并带状态码', async () => {
    putStatus = 507
    expect(await codeOf(() => push(snapshotOf('dev-self')))).toBe('sync.error.webdavStatus')
    expect((await paramsOf(() => push(snapshotOf('dev-self')))).status).toBe(507)
  })

  it('设备 id 里的路径分隔符不会把文件写到别的目录', async () => {
    const ctx = { ...contextOf(), device: { deviceId: 'a/b\\c', deviceName: '怪 id' } }
    await webdavSyncPlugin.push!(configOf(), snapshotOf('ignored'), ctx)
    expect(files.has('aurora-sync/a_b_c.json')).toBe(true)
  })
})

describe('probe', () => {
  it('连接正常时返回 ok', async () => {
    const result = await webdavSyncPlugin.probe!(configOf(), contextOf())
    expect(result.ok).toBe(true)
  })

  it('认证失败时 ok=false 且 message 是结构化错误信封', async () => {
    const result = await webdavSyncPlugin.probe!(configOf(), contextOf('wrong-password'))
    expect(result.ok).toBe(false)
    // probe 复用存储链路的「测试连接」，所以信封里是 core.error.webdavAuth（同一句话，
    // 用户在网络存储与同步两处看到的是同一个原因）
    expect(parseErrorInfo(result.message)?.code).toBe('core.error.webdavAuth')
  })
})
