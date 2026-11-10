/**
 * 局域网 HTTP 服务的真实往返测试（listen(0) 起临时端口，不硬编码主机/端口/路径）。
 *
 * 覆盖：签名 GET hello、无签名/错码/过期 401、协议版本 400、关闭态 403、
 * PUT 进收件箱（含 202 与 revision）、GET 已发布快照、空态 404、
 * 坏快照 400、未知路径 404、收件箱取走即清空、端口被占用的失败路径。
 */

import net from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SYNC_LAN_PROTOCOL_VERSION, SYNC_SNAPSHOT_FORMAT } from '@aurora/shared'
import type { SyncSnapshot } from '@aurora/shared'
import {
  LAN_SYNC_INBOX_LIMIT,
  LAN_SYNC_PATHS,
  clearLanSyncInbox,
  getLanSyncInbox,
  isLanSyncServerRunning,
  setPublishedSnapshot,
  startLanSyncServer,
  stopLanSyncServer,
  takeLanSyncInbox,
} from '../lanSyncServer'
import { createNonce, deriveKey, signRequest } from '../lanSyncAuth'

const CODE = '23456789AB'
const DEVICE_ID = '00000000-0000-0000-0000-000000000000'
const DEVICE_NAME = 'Test Desktop'

let port = 0
let enabled = true
const received: SyncSnapshot[] = []

function makeSnapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    format: SYNC_SNAPSHOT_FORMAT,
    deviceId: '11111111-1111-1111-1111-111111111111',
    deviceName: 'Peer Desktop',
    revision: 3,
    updatedAt: 1_700_000_000_000,
    playlists: [],
    ...overrides,
  }
}

interface CallOptions {
  readonly code?: string
  readonly body?: string
  readonly ts?: number
  readonly nonce?: string
  readonly proto?: number
  readonly sign?: boolean
  readonly headers?: Record<string, string>
}

/** 发一条真实 HTTP 请求（默认带合法签名） */
async function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {}
  if (options.sign !== false) {
    Object.assign(
      headers,
      signRequest(deriveKey(options.code ?? CODE), {
        method,
        path,
        ts: options.ts ?? Date.now(),
        nonce: options.nonce ?? createNonce(),
        body: options.body,
        deviceId: DEVICE_ID,
        proto: options.proto,
      }),
    )
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  Object.assign(headers, options.headers)
  return fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: options.body })
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

beforeAll(async () => {
  const handle = await startLanSyncServer({
    deviceId: DEVICE_ID,
    deviceName: DEVICE_NAME,
    getCode: () => CODE,
    // 0 = 系统分配，测试之间不会撞端口
    port: 0,
    host: '127.0.0.1',
    isEnabled: () => enabled,
    onSnapshot: (snapshot) => {
      received.push(snapshot)
    },
  })
  port = handle.port
})

afterAll(async () => {
  await stopLanSyncServer()
})

beforeEach(() => {
  enabled = true
  received.length = 0
  clearLanSyncInbox()
  setPublishedSnapshot(null)
})

describe('鉴权', () => {
  it('签名 GET /v1/hello → 200 与设备信息', async () => {
    const res = await call('GET', LAN_SYNC_PATHS.hello)
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toMatchObject({
      proto: SYNC_LAN_PROTOCOL_VERSION,
      deviceId: DEVICE_ID,
      deviceName: DEVICE_NAME,
      port,
    })
  })

  it('无签名 → 401', async () => {
    const res = await call('GET', LAN_SYNC_PATHS.hello, { sign: false })
    expect(res.status).toBe(401)
    const body = await json(res)
    expect(['auth', 'protocol']).toContain(body.code)
  })

  it('错误配对码 → 401 auth', async () => {
    const res = await call('GET', LAN_SYNC_PATHS.hello, { code: '23456789AC' })
    expect(res.status).toBe(401)
    expect(await json(res)).toEqual({ code: 'auth' })
  })

  it('时间戳超出窗口 → 401 auth', async () => {
    const res = await call('GET', LAN_SYNC_PATHS.hello, { ts: Date.now() - 400_000 })
    expect(res.status).toBe(401)
    expect(await json(res)).toEqual({ code: 'auth' })
  })

  it('重放：同一 nonce 第二次 → 401 auth', async () => {
    const nonce = createNonce()
    const first = await call('GET', LAN_SYNC_PATHS.hello, { nonce })
    expect(first.status).toBe(200)
    const second = await call('GET', LAN_SYNC_PATHS.hello, { nonce })
    expect(second.status).toBe(401)
    expect(await json(second)).toEqual({ code: 'auth' })
  })

  it('协议版本不符 → 400 protocol', async () => {
    const res = await call('GET', LAN_SYNC_PATHS.hello, {
      proto: SYNC_LAN_PROTOCOL_VERSION + 1,
    })
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ code: 'protocol' })
  })

  it('服务处于关闭态 → 403 disabled（即使签名正确）', async () => {
    enabled = false
    const res = await call('GET', LAN_SYNC_PATHS.hello)
    expect(res.status).toBe(403)
    expect(await json(res)).toEqual({ code: 'disabled' })
  })
})

describe('快照', () => {
  it('未发布过快照时 GET → 404 empty', async () => {
    const res = await call('GET', LAN_SYNC_PATHS.snapshot)
    expect(res.status).toBe(404)
    expect(await json(res)).toEqual({ code: 'empty' })
  })

  it('签名 PUT 快照 → 202 + revision，并进收件箱/触发回调', async () => {
    const snapshot = makeSnapshot()
    const res = await call('PUT', LAN_SYNC_PATHS.snapshot, {
      body: JSON.stringify({ snapshot }),
    })
    expect(res.status).toBe(202)
    expect(await json(res)).toEqual({ accepted: true, revision: snapshot.revision })

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(snapshot)
    expect(getLanSyncInbox()).toEqual([snapshot])
  })

  it('收件箱：取走即清空，再取为空', async () => {
    await call('PUT', LAN_SYNC_PATHS.snapshot, {
      body: JSON.stringify({ snapshot: makeSnapshot() }),
    })
    expect(takeLanSyncInbox()).toHaveLength(1)
    expect(takeLanSyncInbox()).toEqual([])
    expect(getLanSyncInbox()).toEqual([])
  })

  it('同设备更高 revision 覆盖旧的一份', async () => {
    for (const revision of [1, 2, 3]) {
      const res = await call('PUT', LAN_SYNC_PATHS.snapshot, {
        body: JSON.stringify({ snapshot: makeSnapshot({ revision }) }),
      })
      expect(res.status).toBe(202)
    }
    const inbox = getLanSyncInbox()
    expect(inbox).toHaveLength(1)
    expect(inbox[0].revision).toBe(3)
  })

  it('同设备旧 revision 不覆盖新的一份', async () => {
    await call('PUT', LAN_SYNC_PATHS.snapshot, {
      body: JSON.stringify({ snapshot: makeSnapshot({ revision: 9 }) }),
    })
    const res = await call('PUT', LAN_SYNC_PATHS.snapshot, {
      body: JSON.stringify({ snapshot: makeSnapshot({ revision: 4 }) }),
    })
    // 仍是 202（幂等确认），但收件箱不回退
    expect(res.status).toBe(202)
    expect(getLanSyncInbox()).toHaveLength(1)
    expect(getLanSyncInbox()[0].revision).toBe(9)
  })

  it('同设备同 revision 重复 PUT 不重复触发回调', async () => {
    const snapshot = makeSnapshot({ revision: 6 })
    const first = await call('PUT', LAN_SYNC_PATHS.snapshot, {
      body: JSON.stringify({ snapshot }),
    })
    const second = await call('PUT', LAN_SYNC_PATHS.snapshot, {
      body: JSON.stringify({ snapshot }),
    })
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(await json(second)).toEqual({ accepted: true, revision: 6 })
    // 重复推送只是对端重试：收件箱与事件都不该再动一次
    expect(received).toHaveLength(1)
    expect(getLanSyncInbox()).toHaveLength(1)
  })

  it('不同设备各留一份（按 revision 各自比较）', async () => {
    const other = makeSnapshot({
      deviceId: '22222222-2222-2222-2222-222222222222',
      revision: 12,
    })
    await call('PUT', LAN_SYNC_PATHS.snapshot, {
      body: JSON.stringify({ snapshot: makeSnapshot({ revision: 3 }) }),
    })
    await call('PUT', LAN_SYNC_PATHS.snapshot, {
      body: JSON.stringify({ snapshot: other }),
    })
    const inbox = getLanSyncInbox()
    expect(inbox).toHaveLength(2)
    expect(inbox.map((item) => item.deviceId)).toEqual([
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    ])
    expect(received).toHaveLength(2)
  })

  it('设备数超过 20 → 淘汰最久未更新的', async () => {
    for (let i = 0; i <= LAN_SYNC_INBOX_LIMIT; i += 1) {
      const res = await call('PUT', LAN_SYNC_PATHS.snapshot, {
        body: JSON.stringify({
          snapshot: makeSnapshot({ deviceId: `device-${i}`, revision: 1 }),
        }),
      })
      expect(res.status).toBe(202)
    }
    const inbox = getLanSyncInbox()
    expect(inbox).toHaveLength(LAN_SYNC_INBOX_LIMIT)
    expect(inbox[0].deviceId).toBe('device-1')
    expect(inbox[inbox.length - 1].deviceId).toBe(`device-${LAN_SYNC_INBOX_LIMIT}`)
  })

  it('格式版本不符 → 400 snapshotVersion', async () => {
    const res = await call('PUT', LAN_SYNC_PATHS.snapshot, {
      body: JSON.stringify({ snapshot: { format: 'nope' } }),
    })
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ code: 'snapshotVersion' })
  })

  it('结构损坏（playlists 不是数组）→ 400 snapshot', async () => {
    const res = await call('PUT', LAN_SYNC_PATHS.snapshot, {
      body: JSON.stringify({ snapshot: { ...makeSnapshot(), playlists: 'nope' } }),
    })
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ code: 'snapshot' })
  })

  it('歌单缺 id → 400 snapshot（整份拒绝）', async () => {
    const res = await call('PUT', LAN_SYNC_PATHS.snapshot, {
      body: JSON.stringify({
        snapshot: makeSnapshot({
          playlists: [{ name: 'x', createdAt: 1, updatedAt: 1, tracks: [] }] as never,
        }),
      }),
    })
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ code: 'snapshot' })
  })

  it('tracks 缺失 → 接受并净化成 []（老快照不崩渲染层）', async () => {
    const res = await call('PUT', LAN_SYNC_PATHS.snapshot, {
      body: JSON.stringify({
        snapshot: makeSnapshot({
          playlists: [
            { id: 'p1', name: 'Old', createdAt: 1, updatedAt: 1 },
          ] as never,
        }),
      }),
    })
    expect(res.status).toBe(202)
    const inbox = getLanSyncInbox()
    expect(inbox).toHaveLength(1)
    expect(inbox[0].playlists[0].tracks).toEqual([])
  })

  it('tracks 不是数组 → 400 snapshot', async () => {
    const res = await call('PUT', LAN_SYNC_PATHS.snapshot, {
      body: JSON.stringify({
        snapshot: makeSnapshot({
          playlists: [{ id: 'p1', name: 'Bad', createdAt: 1, updatedAt: 1, tracks: 'nope' }] as never,
        }),
      }),
    })
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ code: 'snapshot' })
  })

  it('未知 ref.kind 的曲目逐条丢弃，整份仍接受', async () => {
    const res = await call('PUT', LAN_SYNC_PATHS.snapshot, {
      body: JSON.stringify({
        snapshot: makeSnapshot({
          playlists: [
            {
              id: 'p1',
              name: 'Mixed',
              createdAt: 1,
              updatedAt: 1,
              tracks: [
                { kind: 'local', path: '/music/a.mp3', title: 'A', artist: '', album: '', duration: 0 },
                { kind: 'telepathy', title: 'From The Future' },
              ],
            },
          ] as never,
        }),
      }),
    })
    expect(res.status).toBe(202)
    const tracks = getLanSyncInbox()[0].playlists[0].tracks
    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({ kind: 'local', path: '/music/a.mp3' })
  })

  it('非 JSON 体 → 400 snapshot', async () => {
    const res = await call('PUT', LAN_SYNC_PATHS.snapshot, { body: 'not json' })
    expect(res.status).toBe(400)
  })

  it('发布后可 GET 到同一份快照', async () => {
    const snapshot = makeSnapshot({ revision: 7 })
    setPublishedSnapshot(snapshot)
    const res = await call('GET', LAN_SYNC_PATHS.snapshot)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ snapshot })
  })
})

describe('路由边界', () => {
  it('未知路径 → 404 notFound', async () => {
    const res = await call('GET', '/v1/nope')
    expect(res.status).toBe(404)
    expect(await json(res)).toEqual({ code: 'notFound' })
  })

  it('方法不符 → 405 method', async () => {
    const res = await call('POST', LAN_SYNC_PATHS.hello, { body: '{}' })
    expect(res.status).toBe(405)
    expect(await json(res)).toEqual({ code: 'method' })
  })

  it('请求体超过 5MB → 413 tooLarge', async () => {
    const res = await call('PUT', LAN_SYNC_PATHS.snapshot, {
      body: 'a'.repeat(5 * 1024 * 1024 + 64),
    })
    expect(res.status).toBe(413)
    expect(await json(res)).toEqual({ code: 'tooLarge' })
  })
})

describe('端口', () => {
  it('端口被占用且尝试次数耗尽 → 抛 EADDRINUSE', async () => {
    await stopLanSyncServer()
    expect(isLanSyncServerRunning()).toBe(false)

    const blocker = net.createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()))
    const blockedPort = (blocker.address() as net.AddressInfo).port

    try {
      await expect(
        startLanSyncServer({
          deviceId: DEVICE_ID,
          deviceName: DEVICE_NAME,
          getCode: () => CODE,
          port: blockedPort,
          host: '127.0.0.1',
          maxPortAttempts: 1,
        }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(isLanSyncServerRunning()).toBe(false)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })
})
