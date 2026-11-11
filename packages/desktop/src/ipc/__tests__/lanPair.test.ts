/**
 * 一键配对（`pair/v1`，docs/playlist-sync.md §16）的测试。
 *
 * 三层：
 * 1. **加密金标**：固定私钥/`pairId`/nonce，逐字节核对 `K` 与 `sealed`（两端实现必须
 *    完全一致，否则桌面端与 Android 互相解不开），外加 AAD/密文/长度被改后必须解不开；
 * 2. **端到端**：同进程起两台真实 HTTP 服务（`127.0.0.1` + `port: 0`，不碰固定端口），
 *    跑完「发起 → 弹窗 → 允许 → 换码 → 回执」整条链路，断言两端各自拿到对端的码；
 * 3. **失败与边界**：拒绝、未知 pairId、错码 reply、自己配自己、待确认超上限、
 *    以及 `adoptPairedCode` 落凭证（临时 userData，不碰真实用户数据）。
 *
 * 这里**不**起 UDP 发现：那是 `lanSyncDiscovery.ts` 的事，配对只走 HTTP + 状态机。
 * 所有 fixture 都是假值（deviceId 全 0 前缀、配对码是字母表里的连续字符、主机只有回环）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createECDH } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LanPairPeer, LanPairRequest, LanPairStartResult } from '@aurora/shared'

/**
 * 假 electron：`app.getPath('userData')` 指到每个测试新建的临时目录，
 * `safeStorage` 用 XOR 掩码模拟加解密（只关心「能不能安全保存」这条路径）。
 * `ipcMain.handle` 把注册的处理函数收进表里，供 adopt 测试直接调用。
 */
const env = vi.hoisted(() => ({
  dir: '',
  encryptionAvailable: true,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => env.dir },
  safeStorage: {
    isEncryptionAvailable: () => env.encryptionAvailable,
    encryptString: (text: string) =>
      Buffer.concat([Buffer.from('enc:'), Buffer.from(text, 'utf8').map((b) => b ^ 0x5a)]),
    decryptString: (cipher: Buffer) =>
      Buffer.from(cipher.subarray(4).map((b) => b ^ 0x5a)).toString('utf8'),
  },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => {
      env.handlers.set(name, handler)
    },
    on: () => undefined,
  },
}))

// 凭证读写（与主进程同一个假 electron）：用来核对 adopt 之后能不能读回
import { readSyncCredential } from '../syncCredentials'
// 金标用的加密原语（独立于被测模块，避免「自己验自己」）
import { createNonce, deriveKey, signRequest } from '../lanSyncAuth'

const HOST = '127.0.0.1'
/** 两台测试设备的身份：全 0 前缀，一眼是假值 */
const DEVICE_A = '00000000-0000-0000-0000-00000000000a'
const DEVICE_B = '00000000-0000-0000-0000-00000000000b'
const NAME_A = 'Test Peer A'
const NAME_B = 'Test Peer B'
/** 测试里的配对码：Crockford 字母表内的连续字符，明显不是真码 */
const CODE_A = '23456789AB'
const CODE_B = 'ABCDEFGHJK'
/** 一个格式合法但内容错的码（reply 用错码 → 401） */
const CODE_WRONG = 'ZZZZZZZZZZ'

const GOLDEN_PAIR_ID = '0123456789abcdef0123456789abcdef'
const GOLDEN_PRIV_A = '11'.repeat(32)
const GOLDEN_PRIV_B = '22'.repeat(32)
const GOLDEN_NONCE = Buffer.from('000102030405060708090a0b', 'hex')
/** 由上面的 priv/pub/上下文串算出的标准值（另一次独立计算的结果，钉死互通性） */
const GOLDEN_KEY_HEX = '5279839c3f5402c0673188f8adc84f316c0745817e24811808b21d16b6557ee2'
const GOLDEN_SEALED = 'AAECAwQFBgcICQoL78+9REYPxiCt9s9RoVSsBFH8PGV0bJvc9KY='

function publicKeyOf(privateHex: string): string {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(Buffer.from(privateHex, 'hex'))
  return ecdh.getPublicKey('base64', 'uncompressed')
}

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, 'hex')
}

/** 轮询等一个异步观测点（服务回调是同步触发的，但发起方的轮询是异步的） */
async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value) return value as T
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

interface PairModules {
  readonly pair: typeof import('../lanSyncPair')
  readonly server: typeof import('../lanSyncServer')
  readonly lanSync?: typeof import('../lanSync')
}

/**
 * 载入**一份独立的模块实例**。
 *
 * `lanSyncServer` 的监听状态是模块级单例（一个进程只跑一个局域网服务），所以「同一
 * 进程两台 server」只能靠两份模块注册表实现 —— 这也正是两台真机上的形态：各自一份
 * 状态机、各自的待确认表。`lanSync`（IPC 层）只挂到 A 那一份上。
 */
async function loadInstance(withIpc: boolean): Promise<PairModules> {
  vi.resetModules()
  const pair = await import('../lanSyncPair')
  const server = await import('../lanSyncServer')
  const lanSync = withIpc ? await import('../lanSync') : undefined
  return { pair, server, ...(lanSync ? { lanSync } : {}) }
}

/* ------------------------------------------------------------------ *
 * 金标：密码学
 * ------------------------------------------------------------------ */

describe('密码学（pair/v1 §16.3）', () => {
  it('公钥是非压缩 P-256 点，双向 ECDH 得到同一把 K', async () => {
    const pair = await import('../lanSyncPair')
    const pubA = publicKeyOf(GOLDEN_PRIV_A)
    const pubB = publicKeyOf(GOLDEN_PRIV_B)

    const decoded = pair.decodeLanPairPublicKey(pubA)
    expect(decoded).not.toBeNull()
    expect(decoded).toHaveLength(65)
    expect(decoded?.[0]).toBe(0x04)

    const kAB = pair.deriveLanPairKey(hexToBuffer(GOLDEN_PRIV_A), pubB)
    const kBA = pair.deriveLanPairKey(hexToBuffer(GOLDEN_PRIV_B), pubA)
    expect(kAB).not.toBeNull()
    expect(kAB?.toString('hex')).toBe(GOLDEN_KEY_HEX)
    expect(kBA?.toString('hex')).toBe(GOLDEN_KEY_HEX)
  })

  it('固定 nonce 时 sealed 逐字节确定，且能 round-trip', async () => {
    const pair = await import('../lanSyncPair')
    const key = pair.deriveLanPairKey(hexToBuffer(GOLDEN_PRIV_A), publicKeyOf(GOLDEN_PRIV_B))
    expect(key).not.toBeNull()

    const sealed = pair.sealLanPairCode(key as Buffer, GOLDEN_PAIR_ID, CODE_A, GOLDEN_NONCE)
    expect(sealed).toBe(GOLDEN_SEALED)
    // nonce(12) + 明文(10) + tag(16)
    expect(Buffer.from(sealed as string, 'base64')).toHaveLength(12 + CODE_A.length + 16)
    expect(pair.openLanPairCode(key as Buffer, GOLDEN_PAIR_ID, sealed)).toBe(CODE_A)
  })

  it('AAD（pairId）被改 → 解不开', async () => {
    const pair = await import('../lanSyncPair')
    const key = pair.deriveLanPairKey(hexToBuffer(GOLDEN_PRIV_A), publicKeyOf(GOLDEN_PRIV_B)) as Buffer
    const sealed = pair.sealLanPairCode(key, GOLDEN_PAIR_ID, CODE_A, GOLDEN_NONCE) as string
    // 同长度、不同内容的 pairId（重放到另一次配对上）
    expect(pair.openLanPairCode(key, 'fedcba9876543210fedcba9876543210', sealed)).toBeNull()
  })

  it('密文被改、被截断、换了 K 都返回 null（不抛）', async () => {
    const pair = await import('../lanSyncPair')
    const key = pair.deriveLanPairKey(hexToBuffer(GOLDEN_PRIV_A), publicKeyOf(GOLDEN_PRIV_B)) as Buffer
    const sealed = pair.sealLanPairCode(key, GOLDEN_PAIR_ID, CODE_A, GOLDEN_NONCE) as string

    const raw = Buffer.from(sealed, 'base64')
    const tampered = Buffer.from(raw)
    tampered[raw.length - 1] ^= 0xff // 动 tag
    expect(pair.openLanPairCode(key, GOLDEN_PAIR_ID, tampered.toString('base64'))).toBeNull()

    expect(
      pair.openLanPairCode(key, GOLDEN_PAIR_ID, raw.subarray(0, 20).toString('base64')),
    ).toBeNull()
    expect(pair.openLanPairCode(key, GOLDEN_PAIR_ID, 'not base64 at all !!!')).toBeNull()
    expect(pair.openLanPairCode(key, GOLDEN_PAIR_ID, '')).toBeNull()

    const otherKey = pair.deriveLanPairKey(hexToBuffer(GOLDEN_PRIV_B), publicKeyOf(GOLDEN_PRIV_B))
    if (otherKey) {
      expect(pair.openLanPairCode(otherKey, GOLDEN_PAIR_ID, sealed)).toBeNull()
    }
  })

  it('随机密钥对 round-trip，且非法公钥（压缩点/短串/非字符串）被拒', async () => {
    const pair = await import('../lanSyncPair')
    const local = pair.createLanPairKeyPair()
    const peer = pair.createLanPairKeyPair()

    const kLocal = pair.deriveLanPairKey(local.privateKey, peer.publicKey)
    const kPeer = pair.deriveLanPairKey(peer.privateKey, local.publicKey)
    expect(kLocal?.toString('hex')).toBe(kPeer?.toString('hex'))

    const sealed = pair.sealLanPairCode(kLocal as Buffer, GOLDEN_PAIR_ID, CODE_B) as string
    expect(pair.openLanPairCode(kLocal as Buffer, GOLDEN_PAIR_ID, sealed)).toBe(CODE_B)

    // 压缩点（33 字节）与随机短串都不是约定形状
    expect(pair.decodeLanPairPublicKey(Buffer.alloc(33, 4).toString('base64'))).toBeNull()
    expect(pair.decodeLanPairPublicKey(Buffer.alloc(65, 0).toString('base64'))).toBeNull()
    expect(pair.decodeLanPairPublicKey('')).toBeNull()
    expect(pair.decodeLanPairPublicKey(42)).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * 端到端：两台真实 HTTP 服务
 * ------------------------------------------------------------------ */

describe('端到端配对（两台真实服务）', () => {
  let A: PairModules
  let B: PairModules
  let portA = 0
  let portB = 0
  const pairRequests: LanPairRequest[] = []
  const pairedPeers: LanPairPeer[] = []

  beforeAll(async () => {
    A = await loadInstance(true)
    // B 拿到另一份注册表：它自己的 pending 表、自己的 lanSyncServer 单例
    B = await loadInstance(false)

    const aHandle = await A.server.startLanSyncServer({
      deviceId: DEVICE_A,
      deviceName: NAME_A,
      getCode: () => CODE_A,
      port: 0,
      host: HOST,
    })
    portA = aHandle.port

    const bHandle = await B.server.startLanSyncServer({
      deviceId: DEVICE_B,
      deviceName: NAME_B,
      getCode: () => CODE_B,
      port: 0,
      host: HOST,
      onPairRequest: (request) => {
        pairRequests.push(request)
      },
      onPaired: (peer) => {
        pairedPeers.push(peer)
      },
    })
    portB = bHandle.port

    // A 的 IPC 层只注册一次：adopt 测试直接调它注册的处理函数
    A.lanSync?.registerLanSyncIpc()
  })

  afterAll(async () => {
    await A.server.stopLanSyncServer()
    await B.server.stopLanSyncServer()
  })

  beforeEach(() => {
    // 每轮从干净的待确认表开始（TTL/上限/幂等都是按表算的）
    A.pair.resetLanPairState()
    B.pair.resetLanPairState()
    pairRequests.length = 0
    pairedPeers.length = 0
    env.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-lan-pair-'))
    env.encryptionAvailable = true
  })

  afterEach(() => {
    // 临时 userData 用完即删（凭证文件只该活在这次测试里）
    fs.rmSync(env.dir, { recursive: true, force: true })
  })

  /**
   * 在 B 侧点「允许」。
   *
   * 若这条断言失败，错误信息里带上服务端此刻对这个 `pairId` 的看法（pending / denied /
   * 404 unknown）——「状态机没拿到这条记录」和「记录被换成别的状态」是两种完全不同的
   * 故障，靠 `expected true, received false` 分辨不出来。
   */
  async function acceptOnB(pairId: string): Promise<void> {
    const result = B.pair.respondToLanPairRequest({ getCode: () => CODE_B }, pairId, true)
    if (result.accepted) return
    const res = await fetch(`http://${HOST}:${portB}/v1/pair/status?pairId=${pairId}`)
    throw new Error(
      `B 侧无法确认这次配对：respond=${JSON.stringify(result)} status=${res.status} body=${await res.text()}`,
    )
  }

  /** 以 A 的身份发起一次配对（本机码/端口显式给出，与 lanSync.ts 的装配一致） */
  function startFromA(): Promise<LanPairStartResult> {
    return A.pair.startLanPair(
      { deviceId: DEVICE_B, deviceName: NAME_B, host: HOST, port: portB },
      {
        local: {
          deviceId: DEVICE_A,
          deviceName: NAME_A,
          port: portA,
          code: CODE_A,
        },
        // 对端的确认在用例里是同步发生的：按生产间隔 1s 等一轮会让每条 e2e 白等一秒
        pollIntervalMs: 20,
      },
    )
  }

  it('A 发起 → B 弹确认 → 允许 → 两端各拿到对端码', async () => {
    expect(portA).toBeGreaterThan(0)
    expect(portB).toBeGreaterThan(0)

    const started = startFromA()
    const request = await waitFor(() => pairRequests[0])

    // 应答方看到的「对端」：地址取 TCP 源地址，port 只来自 body
    expect(request.deviceId).toBe(DEVICE_A)
    expect(request.deviceName).toBe(NAME_A)
    expect(request.host).toBe(HOST)
    expect(request.port).toBe(portA)
    expect(request.pairId).toMatch(/^[0-9a-f]{32}$/)
    expect(request.expiresAt).toBeGreaterThan(Date.now())

    await acceptOnB(request.pairId)

    const result = await started
    expect(result).toEqual({
      ok: true,
      peer: { deviceId: DEVICE_B, deviceName: NAME_B, host: HOST, port: portB },
    })

    // 发起方拿到的是 B 的码；应答方拿到的是 A 的码 —— 两端都能建配置
    expect(A.pair.peekPairedCode(DEVICE_B)).toBe(CODE_B)
    await waitFor(() => pairedPeers[0])
    expect(pairedPeers[0]).toMatchObject({ deviceId: DEVICE_A, host: HOST, port: portA })
    expect(B.pair.peekPairedCode(DEVICE_A)).toBe(CODE_A)
  })

  it('adoptPairedCode：配对换来的码落进 configId 的凭证槽，再取能被读回', async () => {
    const started = startFromA()
    const request = await waitFor(() => pairRequests[0])
    await acceptOnB(request.pairId)
    expect((await started).ok).toBe(true)

    const adopt = env.handlers.get('lan:adoptPaired')
    expect(typeof adopt).toBe('function')
    const configId = 'sync-test-config-1'

    // IPC 处理函数签名是 (_event, configId, deviceId)
    expect(await adopt?.(null, configId, DEVICE_B)).toBe(true)
    expect(readSyncCredential(configId)).toEqual({ code: CODE_B })

    // 取走即删：再 adopt 一次拿不到码（配置不会被同一把码写两次）
    expect(await adopt?.(null, configId, DEVICE_B)).toBe(false)
  })

  it('用户点「拒绝」→ 发起方拿到 denied，且没有码被暂存', async () => {
    const started = startFromA()
    const request = await waitFor(() => pairRequests[0])

    expect(B.pair.respondToLanPairRequest({ getCode: () => CODE_B }, request.pairId, false)).toEqual({
      accepted: false,
    })

    expect(await started).toEqual({ ok: false, reason: 'denied' })
    expect(A.pair.peekPairedCode(DEVICE_B)).toBeNull()
    expect(B.pair.peekPairedCode(DEVICE_A)).toBeNull()
  })

  it('本机取消等待 → cancelled（与对端拒绝 denied 分开）', async () => {
    const started = startFromA()
    const request = await waitFor(() => pairRequests[0])

    A.pair.cancelLanPair(request.pairId)
    expect(await started).toEqual({ ok: false, reason: 'cancelled' })
    // 取消后没有码被暂存
    expect(A.pair.peekPairedCode(DEVICE_B)).toBeNull()
    // 对端（另一台机器）那条请求仍是 pending：跨进程没有「撤销」通道，
    // 它由对端自己的 TTL 收尾（对端用户也可以点拒绝，或直接不理）
    const status = await fetch(`http://${HOST}:${portB}/v1/pair/status?pairId=${request.pairId}`)
    expect(await status.json()).toEqual({ state: 'pending' })
  })

  it('未知 pairId 的 status → 404 unknown（免签路由）', async () => {
    const res = await fetch(`http://${HOST}:${portB}/v1/pair/status?pairId=${'0'.repeat(32)}`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ code: 'unknown' })
  })

  it('发起方用错码 reply → 401 auth（HMAC 用本机配对码校验）', async () => {
    const { pair } = B
    const pairId = 'ab'.repeat(16)
    const keypair = pair.createLanPairKeyPair()

    const created = await fetch(`http://${HOST}:${portB}/v1/pair/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        pairId,
        deviceId: '22222222-2222-2222-2222-222222222222',
        deviceName: 'Test Peer C',
        port: portA,
        pub: keypair.publicKey,
      }),
    })
    expect(created.status).toBe(202)
    await acceptOnB(pairId)

    const replyBody = JSON.stringify({ v: 1, pairId, sealed: 'AAAA' })
    const headers = {
      ...signRequest(deriveKey(CODE_WRONG), {
        method: 'POST',
        path: '/v1/pair/reply',
        ts: Date.now(),
        nonce: createNonce(),
        body: replyBody,
        deviceId: '22222222-2222-2222-2222-222222222222',
      }),
      'content-type': 'application/json',
    }
    const res = await fetch(`http://${HOST}:${portB}/v1/pair/reply?pairId=${pairId}`, {
      method: 'POST',
      headers,
      body: replyBody,
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ code: 'auth' })
  })

  it('同一 deviceId 配自己 → self（本地前置 + 服务端兜底）', async () => {
    const local = { deviceId: DEVICE_B, deviceName: NAME_B, port: portA, code: CODE_B }
    // 对端就是自己：连请求都不发
    expect(
      await A.pair.startLanPair({ deviceId: DEVICE_B, deviceName: NAME_B, host: HOST, port: portB }, { local }),
    ).toEqual({ ok: false, reason: 'self' })

    // 服务端也兜一层：body 里的 deviceId 等于本机设备 id 直接拒
    const keypair = A.pair.createLanPairKeyPair()
    const res = await fetch(`http://${HOST}:${portB}/v1/pair/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        pairId: 'cd'.repeat(16),
        deviceId: DEVICE_B,
        deviceName: NAME_B,
        port: portA,
        pub: keypair.publicKey,
      }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: 'self' })
  })

  it('待确认超过上限 → 409 busy', async () => {
    const keypair = A.pair.createLanPairKeyPair()
    const { LAN_PAIR_MAX_PENDING } = B.pair

    for (let index = 0; index < LAN_PAIR_MAX_PENDING; index += 1) {
      const res = await fetch(`http://${HOST}:${portB}/v1/pair/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          v: 1,
          pairId: index.toString(16).padStart(32, '0'),
          deviceId: `peer-${index}`,
          deviceName: `Test Peer ${index}`,
          port: portA,
          pub: keypair.publicKey,
        }),
      })
      expect(res.status).toBe(202)
    }

    const overflow = await fetch(`http://${HOST}:${portB}/v1/pair/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        pairId: 'ef'.repeat(16),
        deviceId: 'peer-overflow',
        deviceName: 'Test Peer Overflow',
        port: portA,
        pub: keypair.publicKey,
      }),
    })
    expect(overflow.status).toBe(409)
    expect(await overflow.json()).toEqual({ code: 'busy' })
  })

  it('服务关闭时配对路由也回 403 disabled', async () => {
    let enabled = true
    const isolated = await loadInstance(false)
    const handle = await isolated.server.startLanSyncServer({
      deviceId: '00000000-0000-0000-0000-00000000000c',
      deviceName: 'Test Peer Off',
      getCode: () => CODE_A,
      port: 0,
      host: HOST,
      isEnabled: () => enabled,
    })
    try {
      enabled = false
      const res = await fetch(`http://${HOST}:${handle.port}/v1/pair/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          v: 1,
          pairId: '12'.repeat(16),
          deviceId: 'peer-off',
          deviceName: 'Test Peer Off',
          port: portA,
          pub: isolated.pair.createLanPairKeyPair().publicKey,
        }),
      })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ code: 'disabled' })
    } finally {
      await isolated.server.stopLanSyncServer()
    }
  })
})
