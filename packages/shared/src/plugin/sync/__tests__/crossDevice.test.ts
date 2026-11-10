/**
 * 端到端跨设备同步（`docs/playlist-sync.md` §4 / §5 / §6 / §15.4）。
 *
 * 现有单测把每个环节都覆盖了，但"缝隙"恰恰在环节之间：
 * 插件写出去的字节，换一台设备拉回来、解析成它自己的 trackId、再合并、再写回去，
 * 最后回到第一台设备时**必须没有回弹**。这条链只要有一处口径不一致（比如 storage
 * 引用带的是对端插件 id，或本地路径没走第 2 档兜底），症状就是"每次同步都提示有更新"，
 * 而任何单点测试都发现不了。
 *
 * 两台"设备"完全用 shared 的纯函数模拟：各自的曲目集合 → `buildMatchIndex` →
 * `resolveSyncTrackRef`。远端是真起的最小 WebDAV 服务（`listen(0)`，只实现
 * PROPFIND / GET / PUT / MKCOL），不硬编码端口、主机或真实绝对路径。
 *
 * 设备侧的本地快照 = 上一次同步算出来的那份（§15.4：push 的是合并结果，
 * 不是从 store 重建的快照）；从 store 重建只在"首次建立快照"时发生一次。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { isSnapshotOfDevice, serializeSnapshot } from '../snapshot'
import { mergeSnapshots } from '../merge'
import { buildMatchIndex, resolveSyncTrackRef, toSyncTrackRef, type SyncMatchTrack } from '../trackRef'
import { webdavSyncPlugin } from '../webdavSyncPlugin'
import {
  SYNC_SNAPSHOT_FORMAT,
  type SyncedPlaylist,
  type SyncConfig,
  type SyncContext,
  type SyncSnapshot,
} from '../types'

/* ------------------------------------------------------------------ *
 * 最小 WebDAV 服务（与 webdavSyncPlugin.test.ts 同一姿态）
 * ------------------------------------------------------------------ */

let dirs: Set<string>
let files: Map<string, string>
let server: Server
let baseUrl = ''

function entryResponse(relPath: string, isDir: boolean, size: number): string {
  const resourceType = isDir ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>'
  const length = isDir ? '' : `<D:getcontentlength>${size}</D:getcontentlength>`
  return (
    `<D:response><D:href>${relPath ? `/dav/${relPath}` : '/dav/'}${isDir ? '/' : ''}</D:href>` +
    `<D:propstat><D:prop>${resourceType}${length}</D:prop>` +
    `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  )
}

function relPathOf(req: IncomingMessage): string {
  const url = new URL(req.url ?? '/', 'http://placeholder')
  let rel = decodeURIComponent(url.pathname)
  if (rel.startsWith('/dav')) rel = rel.slice('/dav'.length)
  return rel.replace(/^\/+|\/+$/g, '')
}

function childrenOf(parent: string): { fileNames: string[]; dirNames: string[] } {
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
  return { fileNames, dirNames }
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
  const rel = relPathOf(req)
  const method = (req.method ?? 'GET').toUpperCase()

  if (method === 'PROPFIND') {
    if (!dirs.has(rel)) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    const children = childrenOf(rel)
    const body =
      `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">` +
      entryResponse(rel, true, 0) +
      children.fileNames
        .map((name) => entryResponse(rel ? `${rel}/${name}` : name, false, files.get(rel ? `${rel}/${name}` : name)?.length ?? 0))
        .join('') +
      children.dirNames.map((name) => entryResponse(rel ? `${rel}/${name}` : name, true, 0)).join('') +
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
    void readBody(req).then((body) => {
      files.set(rel, body)
      res.statusCode = 201
      res.end()
    })
    return
  }

  if (method === 'MKCOL') {
    if (dirs.has(rel)) {
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
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dav`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
})

beforeEach(() => {
  dirs = new Set([''])
  files = new Map()
  config = configOf()
})

/* ------------------------------------------------------------------ *
 * 两台设备
 * ------------------------------------------------------------------ */

const NOW = 1_760_000_000_000
const SYNC_DIR = 'aurora-sync'
const STORAGE_PLUGIN = 'webdav'

/** A：本机曲库（NAS 上一首 + 本机文件 + 一首 B 上没有的） */
const A_TRACKS: SyncMatchTrack[] = [
  {
    id: 'A-nas',
    path: 'webdav:lib-a/Music/Album/Shared.mp3',
    sourceId: 'lib-a',
    title: 'Shared Song',
    artist: 'Some Artist',
    album: 'Album',
    duration: 210,
  },
  {
    id: 'A-desk',
    path: '/home/alice/Music/Same Song.mp3',
    title: 'Same Song',
    artist: 'Another Artist',
    album: '',
    duration: 200,
  },
  {
    id: 'A-ghost',
    path: '/home/alice/Music/Ghost Only.mp3',
    title: 'Ghost Only',
    artist: 'Nobody',
    album: '',
    duration: 111,
  },
]

/** B：另一台机器，NAS 挂载点不同（sourceId 不同）、本机路径也不同；没有 Ghost Only */
const B_TRACKS: SyncMatchTrack[] = [
  {
    id: 'B-nas',
    path: 'webdav:lib-b/Music/Album/Shared.mp3',
    sourceId: 'lib-b',
    title: 'Shared Song',
    artist: 'Some Artist',
    album: 'Album',
    duration: 210,
  },
  {
    id: 'B-desk',
    path: '/Users/bob/Music/Same Song.mp3',
    title: 'Same Song',
    artist: 'Another Artist',
    album: '',
    duration: 200,
  },
]

interface Device {
  readonly deviceId: string
  readonly deviceName: string
  readonly tracks: SyncMatchTrack[]
  snapshot: SyncSnapshot
}

/** 配置在 beforeAll 拿到随机端口之后才成立（端口不硬编码） */
let config: SyncConfig

function configOf(): SyncConfig {
  return {
    id: 'cfg-e2e',
    pluginId: 'webdav-sync',
    name: '跨设备测试',
    settings: { url: baseUrl, username: 'demo-user', dir: '' },
    direction: 'bidirectional',
    autoSync: false,
    enabled: true,
  }
}

function contextOf(device: Device, log?: (...args: unknown[]) => void): SyncContext {
  return {
    // 密码只放在 ctx.secrets 里，不进 settings（§6）
    fetch: globalThis.fetch as unknown as SyncContext['fetch'],
    secrets: { password: 'app-password' },
    device: { deviceId: device.deviceId, deviceName: device.deviceName },
    log: log ?? (() => {})
  }
}

/** 首次快照：从"本机 store"投影出引用（之后每次同步都用合并结果，不再重建） */
function snapshotFromStore(
  deviceId: string,
  deviceName: string,
  playlists: readonly SyncedPlaylist[]
): SyncSnapshot {
  return {
    format: SYNC_SNAPSHOT_FORMAT,
    deviceId,
    deviceName,
    revision: 1,
    updatedAt: 1_000,
    playlists,
  }
}

const refsOf = (tracks: readonly SyncMatchTrack[]) =>
  tracks.map((track) => toSyncTrackRef(track, () => STORAGE_PLUGIN))

function commutePlaylistOf(tracks: readonly SyncMatchTrack[]): SyncedPlaylist {
  return {
    id: 'pl-commute',
    name: '通勤',
    createdAt: 500,
    updatedAt: 1_000,
    tracks: refsOf(tracks),
  }
}

function devices(): { a: Device; b: Device } {
  const a: Device = {
    deviceId: 'device-aaaa',
    deviceName: '工作站',
    tracks: A_TRACKS,
    snapshot: snapshotFromStore('device-aaaa', '工作站', [commutePlaylistOf(A_TRACKS)]),
  }
  const b: Device = {
    deviceId: 'device-bbbb',
    deviceName: '笔记本',
    tracks: B_TRACKS,
    snapshot: snapshotFromStore('device-bbbb', '笔记本', []),
  }
  return { a, b }
}

/** 一次真实同步：pull（滤掉自己写的）→ merge → 落本地快照 → push 合并结果（§15.4） */
async function syncDevice(device: Device) {
  const ctx = contextOf(device)
  const pulled = await webdavSyncPlugin.pull!(config, ctx)
  const remotes = pulled.filter((snapshot) => !isSnapshotOfDevice(snapshot, device.deviceId))
  const outcome = mergeSnapshots(device.snapshot, remotes, NOW)
  device.snapshot = outcome.snapshot
  await webdavSyncPlugin.push!(config, outcome.snapshot, ctx)
  return { outcome, pulled }
}

/** 设备侧"应用快照"：把引用解析成本机的 trackId（解析不到就是 null → app 登记占位） */
function applyOn(device: Device, playlist: SyncedPlaylist): (string | null)[] {
  const index = buildMatchIndex(device.tracks, {
    online: new Map<string, string>(),
    storagePluginIdOf: () => STORAGE_PLUGIN,
  })
  return playlist.tracks.map((ref) => resolveSyncTrackRef(ref, index))
}

describe('跨设备端到端（WebDAV 往返）', () => {
  it('A 推 → B 拉：引用解析成 B 自己的 trackId（storage 命中 / 异路径同名兜底 / 落空 null）', async () => {
    const { a, b } = devices()

    await syncDevice(a)
    // 首次同步：目录原本不存在，pull 得到空数组而不是错误
    const { pulled } = await syncDevice(b)

    expect(pulled).toHaveLength(1)
    expect(pulled[0].deviceId).toBe('device-aaaa')

    const commute = b.snapshot.playlists.find((playlist) => playlist.id === 'pl-commute')
    expect(commute).toBeDefined()
    expect(commute!.tracks).toHaveLength(3)

    const ids = applyOn(b, commute!)
    // 第 3 档：同一个 NAS 相对路径，但 A/B 的 sourceId 不同 → 仍然命中 B 自己的曲目
    expect(ids[0]).toBe('B-nas')
    // 第 2 档：两台机器的绝对路径不同（/home/alice vs /Users/bob），靠同名 + 时长兜底
    expect(ids[1]).toBe('B-desk')
    // 第 5 档：B 上确实没有这首歌 → null，由 app 登记占位
    expect(ids[2]).toBeNull()

    // 解析结果绝不能混进对端的 id
    const bIds = new Set(B_TRACKS.map((track) => track.id))
    for (const id of ids) {
      if (id !== null) expect(bIds.has(id)).toBe(true)
    }
  })

  it('B 合并后再推，A 再拉合并不回弹（changed=false、内容与 revision 不变）', async () => {
    const { a, b } = devices()

    await syncDevice(a)
    const afterFirstPush = structuredClone(a.snapshot)

    const bOutcome = await syncDevice(b)
    expect(bOutcome.outcome.changed).toBe(true)
    expect(bOutcome.outcome.added).toBe(1)

    const aOutcome = await syncDevice(a)

    // 关键断言：这条链走完一圈，A 不该认为"有更新"（否则每次同步都会提示并重写一遍）
    expect(aOutcome.outcome.changed).toBe(false)
    expect(aOutcome.outcome.added).toBe(0)
    expect(aOutcome.outcome.updated).toBe(0)
    expect(aOutcome.outcome.removed).toBe(0)
    expect(a.snapshot.playlists).toEqual(afterFirstPush.playlists)
    expect(a.snapshot.revision).toBe(afterFirstPush.revision)
    expect(a.snapshot.updatedAt).toBe(afterFirstPush.updatedAt)

    // 且远端两份文件（每设备一份）都在，A 读取时只看到 B 那份
    expect([...files.keys()].sort()).toEqual(['aurora-sync/device-aaaa.json', 'aurora-sync/device-bbbb.json'])
    expect(aOutcome.pulled.map((snapshot) => snapshot.deviceId)).toEqual(['device-bbbb'])
  })

  it('墓碑跨设备传播：A 删歌单 → B 看到 deletedAt；B 回推后 A 不复活', async () => {
    const { a, b } = devices()

    await syncDevice(a)
    await syncDevice(b)

    // A 删除歌单：updatedAt 与 deletedAt 取同一个更晚的时刻
    a.snapshot = {
      ...a.snapshot,
      revision: a.snapshot.revision + 1,
      updatedAt: NOW,
      playlists: a.snapshot.playlists.map((playlist) =>
        playlist.id === 'pl-commute' ? { ...playlist, updatedAt: NOW, deletedAt: NOW } : playlist
      ),
    }
    const removeOutcome = await syncDevice(a)
    expect(removeOutcome.outcome.changed).toBe(false) // 本机先改好了，合并只是把它带出去

    const bOutcome = await syncDevice(b)
    expect(bOutcome.outcome.changed).toBe(true)
    expect(bOutcome.outcome.removed).toBe(1)

    const tombstone = b.snapshot.playlists.find((playlist) => playlist.id === 'pl-commute')
    expect(tombstone).toBeDefined()
    expect(tombstone!.deletedAt).toBe(NOW)
    // 墓碑仍带着曲目引用（便于撤销/排查），只是不再算进用户可见的活跃集合
    expect(tombstone!.tracks).toHaveLength(3)

    // A 再同步一次：不复活、也不产生新变化
    const again = await syncDevice(a)
    expect(again.outcome.changed).toBe(false)
    expect(again.outcome.added).toBe(0)
    expect(a.snapshot.playlists.find((playlist) => playlist.id === 'pl-commute')!.deletedAt).toBe(NOW)
  })

  it('坏文件不炸：坏 JSON 与旧 format 只跳过，其余快照照常拉到', async () => {
    const { a, b } = devices()

    await syncDevice(a)
    dirs.add(SYNC_DIR)
    files.set(`${SYNC_DIR}/garbage.json`, '{ 半截 json')
    files.set(
      `${SYNC_DIR}/old-format.json`,
      JSON.stringify({ format: 'aurora-playlist-sync/0', deviceId: 'device-old', playlists: [] })
    )

    const logs: unknown[][] = []
    const ctx = contextOf(b, (...args: unknown[]) => logs.push(args))
    const pulled = await webdavSyncPlugin.pull!(config, ctx)

    // 两个坏文件各记一条日志后跳过；A 那份好快照仍然解析出来
    expect(pulled).toHaveLength(1)
    expect(pulled[0].deviceId).toBe('device-aaaa')
    expect(logs).toHaveLength(2)

    // 端到端继续可用：B 照常合并并推送
    const bOutcome = await syncDevice(b)
    expect(bOutcome.outcome.changed).toBe(true)
    expect(files.has(`${SYNC_DIR}/device-bbbb.json`)).toBe(true)
    expect(JSON.parse(files.get(`${SYNC_DIR}/device-bbbb.json`)!).deviceId).toBe('device-bbbb')
    // 坏文件没有被插件顺手"修好"或覆盖
    expect(files.get(`${SYNC_DIR}/garbage.json`)).toBe('{ 半截 json')
  })

  it('三设备全量往返：A/B 收敛后第三人 C 加入也能拿到同一歌单集合', async () => {
    const { a, b } = devices()
    const c: Device = {
      deviceId: 'device-cccc',
      deviceName: '客厅',
      tracks: B_TRACKS.map((track) => ({ ...track, id: `C-${track.id.slice(2)}` })),
      snapshot: snapshotFromStore('device-cccc', '客厅', []),
    }

    await syncDevice(a)
    await syncDevice(b)
    const cOutcome = await syncDevice(c)

    expect(cOutcome.outcome.added).toBe(1)
    expect(c.snapshot.playlists.map((playlist) => playlist.id)).toEqual(['pl-commute'])

    // C 的引用解析到 C 自己的 trackId（storage 档），而不是 A/B 的
    const ids = applyOn(c, c.snapshot.playlists[0])
    expect(ids[0]).toBe('C-nas')
    expect(ids[1]).toBe('C-desk')

    // C 推完后 A 再同步：内容已收敛，没有回弹
    const aAgain = await syncDevice(a)
    expect(aAgain.outcome.changed).toBe(false)
  })
})
