/**
 * 一键配对（协议 `pair/v1`，见 `docs/playlist-sync.md` §16）—— 主进程内的密码学、
 * 应答方状态机与发起方长轮询客户端。
 *
 * ## 为什么整套协议都在主进程
 *
 * 配对换回来的是**对端配对码**，它等价于「能写对端歌单」的凭据（§7）。渲染层不持有
 * 长期凭证、也不做密码学（§10 的凭证纪律）：临时 ECDH 私钥、派生出的 `K`、解出来的
 * 对端码，全部只在这个模块的进程内内存里。渲染层只拿到「配对成了」和「对端是谁」，
 * 需要落地时再调 `adoptPairedCode()`（`lanSync.ts` 的 IPC 层）把码写进配置的凭证槽。
 *
 * ## 无认证路由靠什么兜
 *
 * `/v1/pair/request` 与 `/v1/pair/status` 免签名（§16.1）——发起方此刻还没有本机码，
 * 签不出来。所以这两条路由的所有输入都按**不可信**处理：
 *
 * - 回连地址**只取 TCP 源地址**（`remoteAddress`），body 里只有 `port` 可信且必须落在
 *   1..65535；否则同网段任何人塞一个 `host` 进来，就能让本机成为连内网其它主机的跳板；
 * - `pairId` / `pub` 都先做形状校验再进状态机；`pub` 必须是 65 字节非压缩 P-256 点；
 * - **授权闸门是人的确认**，不是任何密码学前置：没有 `pairRespond(accept)` 就永远不生成
 *   应答方的密钥对，也就永远不会把本机码封出去（§16.1）；
 * - 待确认项最多 8 条、同 `deviceId` 只留一条，避免同网段被人灌爆内存/刷屏弹窗。
 *
 * ## AEAD 的 AAD 为什么是 `pairId`
 *
 * `pairId` 是发起方随机生成、双方都已知、且**每个请求都带**的 32 位 hex。把它绑进 AAD，
 * 等于给每个密文贴上「只属于这一次配对」的标签：即便同网段旁听者把 A、B 两份 `sealed`
 * 互相对调，或者把一次配对的密文重放到另一次里，解密都会直接失败（tag 校验不过），
 * 而不是解出一把能用的码。它不防 MITM（那不在威胁模型内，§16.1），但把「重放/串线」
 * 这类零成本攻击变成了失败。
 *
 * ## 码为什么留在主进程、只暂存 10 分钟
 *
 * 配对成功后，渲染层才去生成 `configId`（配置归 store 管），落地是**后面一步**的
 * `adoptPairedCode(configId, deviceId)`。所以码要在这里暂存一小段时间：10 分钟足够
 * 走完「建配置 → 存凭据」，又短到不会变成一把长期驻留内存的凭据。取走即删，
 * 过期即删，进程退出也不会留下什么。
 *
 * ## 日志纪律
 *
 * 只出现 deviceId 前 8 位与 pairId 前 8 位。配对码、`K`、私钥、`sealed` 一律不出现
 * （§16.1：「绝不进日志」），连长度也不记。
 */

import { createCipheriv, createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto'
import http from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { SYNC_LAN_PROTOCOL_VERSION, createLogger } from '@aurora/shared'
import type {
  LanPairFailureReason,
  LanPairPeer,
  LanPairRequest,
  LanPairRespondResult,
  LanPairStartResult,
} from '@aurora/shared'
import {
  createNonce,
  deriveKey,
  normalizePairCode,
  signRequest,
  verifyRequest,
} from './lanSyncAuth'

const log = createLogger('lan-sync.pair')

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 一次配对从发起到判超时的总时长（§16.5）。到点发起方放弃，双方状态都清掉 */
export const LAN_PAIR_TTL_MS = 120_000

/** 发起方查 `status` 的间隔（§16.5）。1s 在「弹窗点允许」这个尺度上足够跟手 */
export const LAN_PAIR_POLL_INTERVAL_MS = 1_000

/** 未确认的配对请求上限（§16.5）。超过回 409 busy，不让同网段刷屏 */
export const LAN_PAIR_MAX_PENDING = 8

/** 派生 `K` 的域分隔串（§16.3）：与 §7 的 `aurora-lan-sync/v1` 分开，两把 key 不可互换 */
export const LAN_PAIR_KEY_CONTEXT = 'aurora-lan-sync/pair/v1'

/** 配对路由（§16.2）。客户端与主进程共用一份常量，避免两边各写一份字符串 */
export const LAN_PAIR_PATHS = {
  request: '/v1/pair/request',
  status: '/v1/pair/status',
  reply: '/v1/pair/reply',
} as const

/** 单条 HTTP 请求的超时：局域网内 8s 还没响应就是不可达 */
export const LAN_PAIR_REQUEST_TIMEOUT_MS = 8_000

/** 换来的对端码在进程内暂存多久（够渲染层建配置 + 落凭证） */
export const LAN_PAIR_STAGED_TTL_MS = 10 * 60_000

/** `pairId` 长度：16 字节随机 hex（§16.2），既是幂等键也是 AAD */
const PAIR_ID_HEX_LENGTH = 32

/** §16.3 的 `{v:1}`：配对协议自己的版本号，与快照协议版本分开演进 */
const PAIR_BODY_VERSION = 1

/** GCM nonce 12 字节、tag 16 字节（§16.3） */
const PAIR_NONCE_BYTES = 12
const PAIR_TAG_BYTES = 16

/** P-256 非压缩点长度（0x04 + X + Y） */
const PAIR_PUBLIC_KEY_BYTES = 65

/** 配对响应体上限：三种响应都是几十字节的 JSON，64KB 已经是「明显不是它」的界限 */
const LAN_PAIR_MAX_RESPONSE_BYTES = 64 * 1024

/** `reply` 的网络层重试次数：对端可能刚好在重启，多试两次比让用户重点一次便宜 */
const LAN_PAIR_REPLY_ATTEMPTS = 3

/** `reply` 重试间隔 */
const LAN_PAIR_REPLY_RETRY_DELAY_MS = 400

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 日志里只出现前 8 位（§16.1：deviceId / pairId 都只记前缀） */
function idPrefix(value: string): string {
  return typeof value === 'string' && value ? value.slice(0, 8) : 'unknown'
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err
}

/** `pairId` 形状：16 字节随机 hex（32 字符小写） */
function isLanPairId(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${PAIR_ID_HEX_LENGTH}}$`).test(value)
}

/** 端口：body 里唯一可信的字段，必须落在 TCP 端口范围内 */
function normalizePort(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535
    ? (value as number)
    : 0
}

/** 对端自报的设备名只用于展示：控制字符会污染日志与弹窗，截到 64 字符 */
function sanitizeDeviceName(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64)
}

/**
 * 归一化 TCP 源地址。
 *
 * Node 在双栈监听时给的是 IPv4-mapped 形式（`::ffff:127.0.0.1`），
 * 这里去掉前缀；IPv6 字面量的方括号也去掉（`node:http` 的 host 参数不吃方括号）。
 * 只接受 IP 字面量：TCP 源地址本来就是 IP，出现别的东西说明环境异常，直接当无效。
 */
function normalizeRemoteAddress(value: string | null | undefined): string {
  if (typeof value !== 'string') return ''
  let host = value.trim()
  if (host.startsWith('::ffff:') && host.includes('.')) host = host.slice('::ffff:'.length)
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  return /^[0-9a-fA-F.:]+$/.test(host) ? host : ''
}

/** 解析请求体：只接受 JSON 对象，读不出就是 null（调用方回 400 invalid） */
function parseJsonObject(buffer: Buffer): Record<string, unknown> | null {
  if (!buffer || buffer.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(buffer.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 密码学（§16.3，逐字节按文档）
 * ------------------------------------------------------------------ */

/** 一次配对的临时密钥对；`privateKey` 只在进程内存里活到这次配对结束 */
export interface LanPairKeyPair {
  /** 32 字节 P-256 标量（**绝不进日志、绝不出主进程**） */
  readonly privateKey: Buffer
  /** base64 的非压缩点（65 字节，`0x04 || X || Y`），就是要递给对端的 `pub` */
  readonly publicKey: string
}

/** 生成一次配对的 ECDH 密钥对 */
export function createLanPairKeyPair(): LanPairKeyPair {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    privateKey: ecdh.getPrivateKey(),
    // 必须显式要 uncompressed：默认也是它，但这是跨端互通的前提，写死更安全
    publicKey: ecdh.getPublicKey('base64', 'uncompressed'),
  }
}

/**
 * 校验并解码对端的 `pub`。
 *
 * 只认 65 字节、首字节 `0x04` 的非压缩点：压缩点（33 字节）与 DER 编码都会被拒，
 * 免得两种实现各自解释出不同的点。真正的点在曲线上校验发生在 `computeSecret`。
 */
export function decodeLanPairPublicKey(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null
  const bytes = Buffer.from(trimmed, 'base64')
  if (bytes.length !== PAIR_PUBLIC_KEY_BYTES || bytes[0] !== 0x04) return null
  return bytes
}

/**
 * 由「本端私钥 + 对端公钥」算出这次配对用的 AES key。
 *
 * `shared = ECDH(P-256, privLocal, pubPeer)`（32 字节 X 坐标），
 * `K = HMAC-SHA256(key = shared, data = "aurora-lan-sync/pair/v1")`。
 * 失败（点不在曲线上、长度不对、私钥非法）返回 null，由调用方映射成失败原因，
 * 这里不抛。
 */
export function deriveLanPairKey(privateKey: Buffer, peerPublicKeyBase64: unknown): Buffer | null {
  const peer = decodeLanPairPublicKey(peerPublicKeyBase64)
  if (!peer || !Buffer.isBuffer(privateKey) || privateKey.length !== 32) return null
  try {
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(privateKey)
    const shared = ecdh.computeSecret(peer)
    return createHmac('sha256', shared).update(LAN_PAIR_KEY_CONTEXT).digest()
  } catch {
    return null
  }
}

/**
 * 把本机配对码封成 `sealed`。
 *
 * `sealed = base64(nonce(12) || AES-256-GCM(K, iv=nonce, aad=pairId, plaintext=码))`，
 * tag 由 Node 自己附在密文之后。`nonce` 可注入（金标测试要固定它），生产一律随机。
 * 明文就是 10 位 Crockford base32 码本身，不做二次编码（§16.3）。
 */
export function sealLanPairCode(
  key: Buffer,
  pairId: string,
  code: string,
  nonce?: Buffer,
): string | null {
  if (!isLanPairId(pairId)) return null
  const plaintext = normalizePairCode(code)
  if (!plaintext) return null
  const iv = nonce ?? randomBytes(PAIR_NONCE_BYTES)
  if (iv.length !== PAIR_NONCE_BYTES) return null
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(pairId, 'utf8'))
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64')
  } catch {
    // key 长度不对 / 参数非法：当作「解不开」，不向调用方抛
    return null
  }
}

/**
 * 解开对端的 `sealed`，返回对端配对码；任何异常都返回 null（**不抛**）。
 *
 * 严格校验：长度必须能装下 nonce + 至少 1 字节明文 + tag，且不超过「10 位码」的量级；
 * 解密后还要能归一化成合法配对码。tag 不过（AAD 被换、密文被改、key 不对）一律 null——
 * 调用方据此回 401 / 放弃这次配对。
 */
export function openLanPairCode(key: Buffer, pairId: string, sealedBase64: unknown): string | null {
  if (!isLanPairId(pairId) || typeof sealedBase64 !== 'string') return null
  const raw = Buffer.from(sealedBase64.trim(), 'base64')
  if (raw.length < PAIR_NONCE_BYTES + PAIR_TAG_BYTES + 1) return null
  if (raw.length > PAIR_NONCE_BYTES + PAIR_TAG_BYTES + 64) return null
  const iv = raw.subarray(0, PAIR_NONCE_BYTES)
  const tag = raw.subarray(raw.length - PAIR_TAG_BYTES)
  const body = raw.subarray(PAIR_NONCE_BYTES, raw.length - PAIR_TAG_BYTES)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(pairId, 'utf8'))
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    return normalizePairCode(plaintext)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 应答方状态机
 * ------------------------------------------------------------------ */

/**
 * 一条待处理配对的状态。
 *
 * `done` 是 §16.4「B 对已 done 的 pairId 直接回 200」需要的：reply 成功后不立刻删，
 * 而是标成 done 让重试幂等；条目本身仍受 TTL 清理。
 */
type LanPairPendingState = 'pending' | 'accepted' | 'denied' | 'done'

interface LanPairPendingEntry {
  readonly pairId: string
  readonly peer: LanPairPeer
  /** 对端的公钥原文（65 字节非压缩点） */
  readonly pub: Buffer
  readonly createdAt: number
  readonly expiresAt: number
  state: LanPairPendingState
  /** 用户点「允许」时才生成：没人确认过就永远不会把本机码封出去（§16.1 的授权闸门） */
  keypair?: LanPairKeyPair
  /** 本机码的密文（只对发起方私钥解得开） */
  sealed?: string
}

/**
 * 进程内的待确认配对表。
 *
 * 只有本进程的 HTTP 服务会写它（`handleLanPairRoute`），条目数被 `LAN_PAIR_MAX_PENDING`
 * 与 TTL 双重限制，所以不落盘、也不做持久化——配对是「当下两台机器都开着」的交互。
 */
const pendingPairs = new Map<string, LanPairPendingEntry>()

/** 定期清过期条目的定时器；表空即停，别让进程里挂一个永远跑着的 interval */
let pairSweeper: NodeJS.Timeout | null = null

function nowOf(context: { readonly now?: () => number }): number {
  return context.now ? context.now() : Date.now()
}

function stopPairSweeper(): void {
  if (!pairSweeper) return
  clearInterval(pairSweeper)
  pairSweeper = null
}

function ensurePairSweeper(): void {
  if (pairSweeper) return
  // unref：定时器不该拖住进程退出（Electron 关闭时窗口先没，等 120s 是不可接受的）
  pairSweeper = setInterval(() => {
    pruneExpiredPairs(Date.now())
  }, LAN_PAIR_POLL_INTERVAL_MS)
  pairSweeper.unref?.()
}

function pruneExpiredPairs(now: number): void {
  for (const [pairId, entry] of pendingPairs) {
    if (entry.expiresAt <= now) pendingPairs.delete(pairId)
  }
  if (pendingPairs.size === 0) stopPairSweeper()
}

/** 应答方路由需要的本机身份与回调 */
export interface LanPairResponderContext {
  readonly deviceId: string
  readonly deviceName: string
  /** 当前本机配对码（**每个请求现取**：轮换后旧码立即失效） */
  readonly getCode: () => string
  /** 本机 HTTP 服务端口：写进 accepted 的 status 响应，让发起方拿到真实端口 */
  readonly getPort: () => number | null
  /** 收到一条新配对请求 → 渲染层弹确认框 */
  readonly onPairRequest?: (request: LanPairRequest) => void
  /** 本端拿到了发起方的码（reply 完成）→ 渲染层建配置 + adopt */
  readonly onPaired?: (peer: LanPairPeer) => void
  /** 时钟注入（测试用；生产走 `Date.now()`） */
  readonly now?: () => number
}

/** 交给 `lanSyncServer` 的路由结果：由它统一写成 JSON */
export interface LanPairRouteResult {
  readonly status: number
  readonly body: unknown
}

/** `lanSyncServer` 收完 body 后交给配对路由的全部输入 */
export interface LanPairIncomingRequest {
  readonly method: string
  /** 只含 pathname（签名与路由都按它匹配） */
  readonly path: string
  /** `pairId` 走 query，不参与 HMAC（签名只覆盖 pathname，与 §7 一致） */
  readonly searchParams: URLSearchParams
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
  /** TCP 源地址：回连地址只认它（§16.2），绝不看 body 里的 host */
  readonly remoteAddress: string | null
}

/** `/v1/pair/request`：登记一条待确认的配对 */
function handlePairRequestRoute(
  incoming: LanPairIncomingRequest,
  context: LanPairResponderContext,
): LanPairRouteResult {
  const now = nowOf(context)
  pruneExpiredPairs(now)

  const body = parseJsonObject(incoming.body)
  if (!body || body.v !== PAIR_BODY_VERSION) return { status: 400, body: { code: 'invalid' } }

  const pairId = body.pairId
  if (!isLanPairId(pairId)) return { status: 400, body: { code: 'invalid' } }

  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : ''
  if (!deviceId || deviceId.length > 128) return { status: 400, body: { code: 'invalid' } }
  const deviceName = sanitizeDeviceName(body.deviceName)
  // body 里唯一可信的是 port；地址一律取 TCP 源地址，否则任何人都能借本机去连内网别的机器
  const port = normalizePort(body.port)
  if (port === 0) return { status: 400, body: { code: 'invalid' } }
  const pub = decodeLanPairPublicKey(body.pub)
  if (!pub) return { status: 400, body: { code: 'invalid' } }
  const host = normalizeRemoteAddress(incoming.remoteAddress)
  if (!host) return { status: 400, body: { code: 'invalid' } }

  // 同一台机器自己配自己：说明发现包里那条记录是本机（或克隆镜像），没有意义
  if (deviceId === context.deviceId) {
    log.warn('pair request from self', { pair: idPrefix(pairId) })
    return { status: 400, body: { code: 'self' } }
  }

  const existing = pendingPairs.get(pairId)
  if (existing) {
    // 幂等：发起方在 reply 失败后会拿同一个 pairId 重试，原状态回给它，不再弹第二次窗
    return { status: 202, body: { state: existing.state } }
  }

  // 同一 deviceId 只留一条：新的顶掉旧的（旧的那次由发起方自己按 TTL 收尾）
  for (const [key, entry] of pendingPairs) {
    if (entry.peer.deviceId === deviceId) {
      pendingPairs.delete(key)
      log.info('pair superseded', { from: idPrefix(deviceId), pair: idPrefix(key) })
    }
  }

  if (pendingPairs.size >= LAN_PAIR_MAX_PENDING) {
    // 上限兜住同网段刷屏：用户还没确认完的请求已经够多了
    log.warn('pair request busy', { from: idPrefix(deviceId), pending: pendingPairs.size })
    return { status: 409, body: { code: 'busy' } }
  }

  const expiresAt = now + LAN_PAIR_TTL_MS
  const entry: LanPairPendingEntry = {
    pairId,
    peer: { deviceId, deviceName, host, port },
    pub,
    createdAt: now,
    expiresAt,
    state: 'pending',
  }
  pendingPairs.set(pairId, entry)
  ensurePairSweeper()
  log.info('pair request', {
    from: idPrefix(deviceId),
    pair: idPrefix(pairId),
    pending: pendingPairs.size,
  })
  // 先入表再通知：回调里可能立刻查状态（用户秒点允许），顺序反了会查不到
  context.onPairRequest?.({ ...entry.peer, pairId, expiresAt })
  return { status: 202, body: { state: 'pending' } }
}

/**
 * 用户点了「允许 / 拒绝」。
 *
 * 只接受 `pending` 条目：重复点击沿用原结果（尤其**不能**在已 accepted 后重新生成
 * 密钥对——发起方可能已经在用上一份 `sealed` 了）。没有条目或已过期返回
 * `{ accepted:false }`，UI 上就是「这次配对已经失效」。
 */
export function respondToLanPairRequest(
  options: { readonly getCode: () => string; readonly now?: () => number },
  pairId: unknown,
  accept: boolean,
): LanPairRespondResult {
  pruneExpiredPairs(nowOf(options))
  if (!isLanPairId(pairId)) return { accepted: false }
  const entry = pendingPairs.get(pairId)
  if (!entry) return { accepted: false }

  if (entry.state !== 'pending') {
    // 幂等：已接受过就沿用，已拒/已完成就如实说「没接受」
    return { accepted: entry.state === 'accepted' || entry.state === 'done' }
  }

  if (!accept) {
    entry.state = 'denied'
    log.info('pair denied by user', { from: idPrefix(entry.peer.deviceId), pair: idPrefix(entry.pairId) })
    return { accepted: false }
  }

  const localCode = normalizePairCode(options.getCode())
  if (!localCode) {
    // 本机码都取不出来说明服务状态坏了；拒绝这次配对，而不是封一个空串过去
    log.error('pair accept failed: local code invalid', { pair: idPrefix(entry.pairId) })
    entry.state = 'denied'
    return { accepted: false }
  }

  // 到这一刻才生成密钥对：没有用户确认就永远不会有本机码的密文（§16.1）
  const keypair = createLanPairKeyPair()
  const key = deriveLanPairKey(keypair.privateKey, entry.pub.toString('base64'))
  if (!key) {
    log.warn('pair accept failed: peer public key unusable', {
      from: idPrefix(entry.peer.deviceId),
      pair: idPrefix(entry.pairId),
    })
    entry.state = 'denied'
    return { accepted: false }
  }
  const sealed = sealLanPairCode(key, entry.pairId, localCode)
  if (!sealed) {
    log.error('pair accept failed: seal failed', { pair: idPrefix(entry.pairId) })
    entry.state = 'denied'
    return { accepted: false }
  }

  entry.state = 'accepted'
  entry.keypair = keypair
  entry.sealed = sealed
  log.info('pair accepted', { from: idPrefix(entry.peer.deviceId), pair: idPrefix(entry.pairId) })
  return { accepted: true }
}

/** `/v1/pair/status?pairId=…`：发起方每秒问一次「用户点了没」 */
function handlePairStatusRoute(
  incoming: LanPairIncomingRequest,
  context: LanPairResponderContext,
): LanPairRouteResult {
  pruneExpiredPairs(nowOf(context))
  const pairId = incoming.searchParams.get('pairId')
  // 形状不对是请求写错了（不是「不认识这个 id」），用 400 与 404 unknown 分开
  if (!isLanPairId(pairId)) return { status: 400, body: { code: 'invalid' } }
  const entry = pendingPairs.get(pairId)
  if (!entry) return { status: 404, body: { code: 'unknown' } }

  if (entry.state === 'pending') return { status: 200, body: { state: 'pending' } }
  if (entry.state === 'denied') return { status: 200, body: { state: 'denied' } }

  // accepted / done：done 也回同一份 —— 发起方若丢了 reply 的响应而重试，
  // 重放同一份 `sealed` 是幂等的（只有它的私钥解得开，重放没有额外收益）
  return {
    status: 200,
    body: {
      state: 'accepted',
      deviceId: context.deviceId,
      deviceName: context.deviceName,
      port: context.getPort() ?? 0,
      pub: entry.keypair?.publicKey ?? '',
      sealed: entry.sealed ?? '',
    },
  }
}

/**
 * `/v1/pair/reply?pairId=…`：发起方带着自己的码回来，本端解出它、落暂存、通知渲染层。
 *
 * 验签放在最前：密钥就是**本机当前配对码**派生的 HMAC key —— 与其它路由同一套
 * （发起方也是用刚从这里换到的码签的，两边算出来的是同一把 key）。验签不过回 401，
 * 所以「没有本机码的公网扫描者」在这一步拿不到「这个 pairId 存不存在」的信息。
 */
function handlePairReplyRoute(
  incoming: LanPairIncomingRequest,
  context: LanPairResponderContext,
): LanPairRouteResult {
  const verified = verifyRequest(deriveKey(context.getCode()), {
    method: incoming.method,
    path: incoming.path,
    headers: incoming.headers,
    body: incoming.body,
  })
  if (!verified.ok) {
    log.warn('pair reply rejected', { reason: verified.reason })
    return {
      status: 401,
      body: { code: verified.reason === 'protocol' ? 'protocol' : 'auth' },
    }
  }

  pruneExpiredPairs(nowOf(context))
  const pairId = incoming.searchParams.get('pairId')
  const body = parseJsonObject(incoming.body)
  if (!isLanPairId(pairId)) return { status: 400, body: { code: 'invalid' } }
  if (!body || body.v !== PAIR_BODY_VERSION || body.pairId !== pairId) {
    return { status: 400, body: { code: 'invalid' } }
  }
  const sealed = typeof body.sealed === 'string' ? body.sealed : ''
  if (!sealed) return { status: 400, body: { code: 'invalid' } }

  const entry = pendingPairs.get(pairId)
  if (!entry) return { status: 404, body: { code: 'unknown' } }
  // 已完成的重复 reply：直接 200，发起方带同一个 pairId 重试不会变成错误（§16.4）
  if (entry.state === 'done') return { status: 200, body: { state: 'done' } }
  if (entry.state !== 'accepted' || !entry.keypair) {
    // 用户还没点允许（或已拒绝）就有人递 reply：状态不允许，但也不算认证失败
    return { status: 409, body: { code: 'state' } }
  }

  const key = deriveLanPairKey(entry.keypair.privateKey, entry.pub.toString('base64'))
  const code = key ? openLanPairCode(key, pairId, sealed) : null
  if (!code) {
    log.warn('pair reply unsealable', { from: idPrefix(entry.peer.deviceId), pair: idPrefix(pairId) })
    return { status: 401, body: { code: 'auth' } }
  }

  entry.state = 'done'
  log.info('paired', { from: idPrefix(entry.peer.deviceId), pair: idPrefix(pairId) })
  // 发起方的码留在本进程，等渲染层建好配置后 adoptPairedCode() 取走（§16.4 的两端建配置）
  stagePairedCode(entry.peer.deviceId, code)
  context.onPaired?.(entry.peer)
  return { status: 200, body: { state: 'done' } }
}

/**
 * 三条配对路由的统一入口。
 *
 * 不走通用验签（`/v1/pair/reply` 自带一套，另外两条按 §16.1 免签），返回 null 表示
 * 「不是配对路径」，由 `lanSyncServer` 继续走 §7 的签名路由。
 */
export function handleLanPairRoute(
  incoming: LanPairIncomingRequest,
  context: LanPairResponderContext,
): LanPairRouteResult | null {
  const path = incoming.path
  if (
    path !== LAN_PAIR_PATHS.request &&
    path !== LAN_PAIR_PATHS.status &&
    path !== LAN_PAIR_PATHS.reply
  ) {
    return null
  }
  try {
    if (path === LAN_PAIR_PATHS.request) {
      if (incoming.method !== 'POST') return { status: 405, body: { code: 'method' } }
      return handlePairRequestRoute(incoming, context)
    }
    if (path === LAN_PAIR_PATHS.status) {
      if (incoming.method !== 'GET') return { status: 405, body: { code: 'method' } }
      return handlePairStatusRoute(incoming, context)
    }
    if (incoming.method !== 'POST') return { status: 405, body: { code: 'method' } }
    return handlePairReplyRoute(incoming, context)
  } catch (err) {
    log.error('pair route failed', { path, error: errorName(err) })
    return { status: 500, body: { code: 'internal' } }
  }
}

/* ------------------------------------------------------------------ *
 * 换回来的对端码：进程内暂存（等 adoptPairedCode 取走）
 * ------------------------------------------------------------------ */

interface StagedPairedCode {
  readonly code: string
  readonly expiresAt: number
}

/**
 * `deviceId → 对端配对码` 的暂存表。
 *
 * 两端都会用到：发起方在 reply 成功后暂存对端（应答方）的码；应答方在 reply 处理里
 * 暂存发起方的码。渲染层随后各自建一条配置并调 `adoptPairedCode()` 取走。
 */
const stagedPairedCodes = new Map<string, StagedPairedCode>()

/** 暂存一把刚换来的对端码（同 deviceId 覆盖：重新配对一定用新的那把） */
export function stagePairedCode(deviceId: string, code: string): void {
  const normalized = normalizePairCode(code)
  if (!deviceId || !normalized) return
  const now = Date.now()
  for (const [key, staged] of stagedPairedCodes) {
    if (staged.expiresAt <= now) stagedPairedCodes.delete(key)
  }
  stagedPairedCodes.set(deviceId, {
    code: normalized,
    expiresAt: now + LAN_PAIR_STAGED_TTL_MS,
  })
}

/** 看一眼暂存的码（**不**删除）。取不到或已过期返回 null */
export function peekPairedCode(deviceId: string): string | null {
  const staged = stagedPairedCodes.get(deviceId)
  if (!staged) return null
  if (staged.expiresAt <= Date.now()) {
    stagedPairedCodes.delete(deviceId)
    return null
  }
  return staged.code
}

/** 取走成功后删掉暂存（重复取走会得到 null，避免同一把码落进两个配置） */
export function consumePairedCode(deviceId: string): void {
  stagedPairedCodes.delete(deviceId)
}

/* ------------------------------------------------------------------ *
 * 发起方：HTTP（node:http，不跟随重定向）+ 长轮询
 * ------------------------------------------------------------------ */

/** 发起方的本机身份：请求体要它，reply 里要封它 */
export interface LanPairLocalIdentity {
  readonly deviceId: string
  readonly deviceName: string
  /** 本机 HTTP 服务端口（§16.2 要求字段在；没开服务就没法配对） */
  readonly port: number
  /** 本机当前配对码：只在封 `sealed` 时用一次，不缓存、不落日志 */
  readonly code: string
}

export interface LanPairStartOptions {
  readonly local: LanPairLocalIdentity
  /**
   * 轮询间隔（默认 `LAN_PAIR_POLL_INTERVAL_MS`）。
   *
   * **只给测试注入**：端到端用例里对端的确认是同步发生的，按生产值 1s 等一轮会让
   * 每条用例白等 1 秒、整套多出几秒，把并行跑的全量测试挤到别的用例的超时线上。
   * 生产调用点不要传它——这里暴露出来是为了让测试跑得快，不是为了让人调参。
   */
  readonly pollIntervalMs?: number
}

/** 校验后的对端：host/port/deviceId 都可能来自渲染层，一律按不可信处理 */
interface NormalizedPairPeer {
  readonly deviceId: string
  readonly deviceName: string
  readonly host: string
  readonly port: number
}

/**
 * 归一化对端。host 只允许主机名/IP 字面量（与 `lanSync.ts` 的 `normalizeTarget` 同口径），
 * port 必须落在 1..65535。deviceId/deviceName 缺失可以容忍（发现包老版本），
 * 但 host/port 不行——那是唯一能把请求发出去的信息。
 */
function normalizePairPeer(peer: unknown): NormalizedPairPeer | null {
  if (!peer || typeof peer !== 'object') return null
  const input = peer as Partial<LanPairPeer>
  const host = typeof input.host === 'string' ? input.host.trim() : ''
  const port = normalizePort(input.port)
  if (!host || host.length > 255 || !/^[A-Za-z0-9.:\[\]_-]+$/.test(host) || port === 0) return null
  return {
    deviceId: typeof input.deviceId === 'string' ? input.deviceId.trim().slice(0, 128) : '',
    deviceName: sanitizeDeviceName(input.deviceName),
    // IPv6 字面量的方括号去掉：node:http 的 host 参数不吃方括号
    host: host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host,
    port,
  }
}

interface PairHttpRequest {
  readonly host: string
  readonly port: number
  readonly path: string
  readonly method: 'GET' | 'POST'
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

type PairHttpOutcome =
  | { readonly kind: 'response'; readonly status: number; readonly body: Record<string, unknown> | null }
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'aborted' }

/** 网络错误只留错误码（`ECONNREFUSED`），不留可能含 URL 的原始 message */
function networkReasonOf(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as NodeJS.ErrnoException).code
    if (typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code)) return code
  }
  return 'network'
}

/**
 * 发一条 JSON 请求（`node:http`，单次连接，**不跟随重定向**）。
 *
 * 用 `node:http` 而不是 `fetch`：配对是主进程里的低频短请求，`node:http` 不给重定向
 * 留任何自动行为（`fetch` 的 `manual` 也要自己记账），超时与 abort 更是直接挂在
 * socket 上。`agent: false` 让连接用完即弃，不在后台留 keep-alive socket。
 */
function requestPairJson(request: PairHttpRequest): Promise<PairHttpOutcome> {
  return new Promise<PairHttpOutcome>((resolve) => {
    let settled = false
    let client: http.ClientRequest | null = null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), request.timeoutMs)

    const finish = (outcome: PairHttpOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.signal.removeEventListener('abort', onCallerAbort)
      resolve(outcome)
    }
    const onCallerAbort = (): void => controller.abort()
    const onControllerAbort = (): void => {
      // 掐掉 socket，让 request 的 error 回调把 Promise 收尾（不让它悬着）
      client?.destroy()
    }

    request.signal.addEventListener('abort', onCallerAbort, { once: true })
    if (request.signal.aborted) onCallerAbort()
    controller.signal.addEventListener('abort', onControllerAbort, { once: true })

    const headers: Record<string, string> = { ...(request.headers ?? {}) }
    if (request.body !== undefined) {
      headers['content-type'] = headers['content-type'] ?? 'application/json'
      headers['content-length'] = String(Buffer.byteLength(request.body))
    }

    try {
      client = http.request(
        {
          host: request.host,
          port: request.port,
          path: request.path,
          method: request.method,
          headers,
          agent: false,
        },
        (response) => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            // 超上限只是不再累积，仍把状态码读出来（配对响应该只有几十字节）
            if (size <= LAN_PAIR_MAX_RESPONSE_BYTES) chunks.push(chunk)
          })
          response.on('end', () => {
            finish({
              kind: 'response',
              status: response.statusCode ?? 0,
              body: parseJsonObject(Buffer.concat(chunks)),
            })
          })
          response.on('error', () => finish({ kind: 'unreachable', reason: 'response' }))
        },
      )
      client.on('error', (err) => {
        if (request.signal.aborted) {
          finish({ kind: 'aborted' })
          return
        }
        finish({
          kind: 'unreachable',
          reason: controller.signal.aborted ? 'timeout' : networkReasonOf(err),
        })
      })
      // 建连接前就被取消（极窄的窗口）：别让这条请求真的发出去
      if (controller.signal.aborted) {
        client.destroy()
        finish({ kind: 'aborted' })
        return
      }
      client.end(request.body)
    } catch (err) {
      finish({ kind: 'unreachable', reason: networkReasonOf(err) })
    }
  })
}

/** 可被取消的等待；取消时立即 resolve，由调用方按 abort 收尾 */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, Math.max(0, ms))
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** 等一个轮询间隔；不越过这次配对的 deadline（越过了由循环顶部判 timeout） */
function waitForNextPoll(
  signal: AbortSignal,
  deadline: number,
  intervalMs: number = LAN_PAIR_POLL_INTERVAL_MS,
): Promise<void> {
  return abortableDelay(Math.min(intervalMs, deadline - Date.now()), signal)
}

/** 发起方的轮询句柄：`pairCancel` 按 target / pairId 找到它们并 abort */
interface InflightPairSession {
  readonly pairId: string
  readonly promise: Promise<LanPairStartResult>
}

/** key = `deviceId|host:port`：同一目标重复点「配对」复用同一次协商（不会开两条轮询） */
const inflightPairSessions = new Map<string, InflightPairSession>()
/** 按 pairId 索引的取消控制器 */
const inflightPairControllers = new Map<string, AbortController>()

function pairTargetKey(peer: NormalizedPairPeer): string {
  return `${peer.deviceId}|${peer.host}:${peer.port}`
}

/** 把 `request` 阶段的响应映射成失败原因；null = 可以继续去轮询 */
function mapPairRequestFailure(outcome: PairHttpOutcome): LanPairFailureReason | null {
  // aborted 只来自本机 `pairCancel`（超时走的是 unreachable/timeout 而不是 abort）：
  // 必须与 denied 分开，UI 上「我不等了」和「对端拒绝」不是同一句提示
  if (outcome.kind === 'aborted') return 'cancelled'
  if (outcome.kind === 'unreachable') return 'unreachable'
  const status = outcome.status
  const code = typeof outcome.body?.code === 'string' ? (outcome.body.code as string) : ''
  if (status === 202 || status === 200) return null
  // 409 busy：对端还有没确认完的请求
  if (status === 409) return code === 'busy' ? 'busy' : 'invalid'
  // 403 disabled：对端服务关着 —— 按 unreachable 的语义（「服务未开」）处理
  if (status === 403) return 'unreachable'
  // 404/405：对端版本太老、根本没有配对路由 → 让 UI 提示改用手动填码（§16.5）
  if (status === 404 || status === 405) return 'unsupported'
  if (status === 401) return 'auth'
  if (status === 400) {
    if (code === 'self') return 'self'
    return 'invalid'
  }
  return 'invalid'
}

/** 把 `status` 轮询结果映射成失败原因；null = 拿到了 accepted，可以去 reply */
function mapPairStatusFailure(outcome: PairHttpOutcome): LanPairFailureReason | null {
  if (outcome.kind === 'aborted') return 'cancelled'
  if (outcome.kind === 'unreachable') return 'unreachable'
  if (outcome.status === 200) return null
  // 404：对端不认识这个 pairId（重启过 / 已按 TTL 清理）——不是版本问题，而是这次协商作废
  if (outcome.status === 404) return 'invalid'
  if (outcome.status === 405) return 'unsupported'
  if (outcome.status === 401) return 'auth'
  return 'invalid'
}

interface PairReplyParams {
  readonly key: Buffer
  readonly pairId: string
  readonly peerCode: string
  readonly local: LanPairLocalIdentity
  readonly host: string
  readonly port: number
  readonly signal: AbortSignal
}

/**
 * 带**对端刚给出的码**签名，把本端码的 `sealed` 递回去。
 *
 * 返回 null 表示对端已接受（`{state:'done'}`），否则返回失败原因。网络层抖动重试
 * `LAN_PAIR_REPLY_ATTEMPTS` 次：这一步失败等于整次配对白做，值得多试两次。
 */
async function sendPairReply(params: PairReplyParams): Promise<LanPairFailureReason | null> {
  const sealed = sealLanPairCode(params.key, params.pairId, params.local.code)
  if (!sealed) return 'invalid'
  const body = JSON.stringify({ v: PAIR_BODY_VERSION, pairId: params.pairId, sealed })
  // 签名只覆盖 pathname，pairId 走 query（与 §7 的签名口径一致）
  const pathWithQuery = `${LAN_PAIR_PATHS.reply}?pairId=${params.pairId}`

  for (let attempt = 0; attempt < LAN_PAIR_REPLY_ATTEMPTS; attempt += 1) {
    if (params.signal.aborted) return 'cancelled'
    const headers = signRequest(deriveKey(params.peerCode), {
      method: 'POST',
      path: LAN_PAIR_PATHS.reply,
      ts: Date.now(),
      nonce: createNonce(),
      body,
      deviceId: params.local.deviceId,
      proto: SYNC_LAN_PROTOCOL_VERSION,
    })
    const outcome = await requestPairJson({
      host: params.host,
      port: params.port,
      path: pathWithQuery,
      method: 'POST',
      headers,
      body,
      timeoutMs: LAN_PAIR_REQUEST_TIMEOUT_MS,
      signal: params.signal,
    })

    if (outcome.kind === 'aborted') return 'cancelled'
    if (outcome.kind === 'unreachable') {
      if (attempt + 1 >= LAN_PAIR_REPLY_ATTEMPTS) return 'unreachable'
      await abortableDelay(LAN_PAIR_REPLY_RETRY_DELAY_MS, params.signal)
      continue
    }
    if (outcome.status >= 200 && outcome.status < 300) return null
    if (outcome.status === 401) return 'auth'
    if (outcome.status === 404) return 'invalid'
    if (outcome.status === 405) return 'unsupported'
    if (outcome.status >= 500) {
      if (attempt + 1 >= LAN_PAIR_REPLY_ATTEMPTS) return 'invalid'
      await abortableDelay(LAN_PAIR_REPLY_RETRY_DELAY_MS, params.signal)
      continue
    }
    return 'invalid'
  }
  return 'invalid'
}

/** 一次完整协商：登记请求 → 轮询状态 → 解出对端码 → 签名回执 → 暂存对端码 */
async function runPairSession(
  pairId: string,
  target: NormalizedPairPeer,
  local: LanPairLocalIdentity,
  signal: AbortSignal,
  pollIntervalMs: number = LAN_PAIR_POLL_INTERVAL_MS,
): Promise<LanPairStartResult> {
  const keypair = createLanPairKeyPair()
  const deadline = Date.now() + LAN_PAIR_TTL_MS
  const requestBody = JSON.stringify({
    v: PAIR_BODY_VERSION,
    pairId,
    deviceId: local.deviceId,
    deviceName: local.deviceName,
    port: local.port,
    pub: keypair.publicKey,
  })

  const created = await requestPairJson({
    host: target.host,
    port: target.port,
    path: LAN_PAIR_PATHS.request,
    method: 'POST',
    body: requestBody,
    timeoutMs: LAN_PAIR_REQUEST_TIMEOUT_MS,
    signal,
  })
  const createFailure = mapPairRequestFailure(created)
  if (createFailure) {
    log.info('pair request failed', {
      peer: idPrefix(target.deviceId),
      pair: idPrefix(pairId),
      reason: createFailure,
    })
    return { ok: false, reason: createFailure }
  }

  for (;;) {
    if (signal.aborted) return { ok: false, reason: 'cancelled' }
    if (Date.now() >= deadline) {
      log.info('pair timeout', { peer: idPrefix(target.deviceId), pair: idPrefix(pairId) })
      return { ok: false, reason: 'timeout' }
    }

    const polled = await requestPairJson({
      host: target.host,
      port: target.port,
      path: `${LAN_PAIR_PATHS.status}?pairId=${pairId}`,
      method: 'GET',
      timeoutMs: LAN_PAIR_REQUEST_TIMEOUT_MS,
      signal,
    })
    const statusFailure = mapPairStatusFailure(polled)
    if (statusFailure) {
      log.info('pair status failed', {
        peer: idPrefix(target.deviceId),
        pair: idPrefix(pairId),
        reason: statusFailure,
      })
      return { ok: false, reason: statusFailure }
    }

    const state = polled.kind === 'response' ? polled.body?.state : undefined
    if (state === 'pending') {
      // 用户还没点：等一个间隔再看（到 TTL 时循环顶部的判断会收尾）
      await waitForNextPoll(signal, deadline, pollIntervalMs)
      continue
    }
    if (state === 'denied') {
      log.info('pair denied', { peer: idPrefix(target.deviceId), pair: idPrefix(pairId) })
      return { ok: false, reason: 'denied' }
    }
    if (state !== 'accepted') {
      log.warn('pair status unknown shape', { pair: idPrefix(pairId) })
      return { ok: false, reason: 'invalid' }
    }

    const body = polled.kind === 'response' ? polled.body ?? {} : {}
    const peerDeviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : ''
    const peerDeviceName = sanitizeDeviceName(body.deviceName)
    const peerPort = normalizePort(body.port)
    const peerPub = body.pub
    const sealed = typeof body.sealed === 'string' ? body.sealed : ''
    if (!peerDeviceId || peerPort === 0 || !sealed || !decodeLanPairPublicKey(peerPub)) {
      log.warn('pair accepted payload invalid', { pair: idPrefix(pairId) })
      return { ok: false, reason: 'invalid' }
    }
    // 对端报回来的 deviceId 是本机：说明这条记录指向自己（发现缓存过期 / 克隆镜像）
    if (peerDeviceId === local.deviceId) return { ok: false, reason: 'self' }

    const key = deriveLanPairKey(keypair.privateKey, peerPub)
    if (!key) return { ok: false, reason: 'invalid' }
    const peerCode = openLanPairCode(key, pairId, sealed)
    if (!peerCode) {
      // AEAD 解不开：对端换了密钥/码，或者中间有东西动过密文 —— 归为认证失败
      log.warn('pair seal open failed', { peer: idPrefix(peerDeviceId), pair: idPrefix(pairId) })
      return { ok: false, reason: 'auth' }
    }

    const replyFailure = await sendPairReply({
      key,
      pairId,
      peerCode,
      local,
      host: target.host,
      port: target.port,
      signal,
    })
    if (replyFailure) {
      log.info('pair reply failed', {
        peer: idPrefix(peerDeviceId),
        pair: idPrefix(pairId),
        reason: replyFailure,
      })
      return { ok: false, reason: replyFailure }
    }

    // 对端码只留在主进程，等 adoptPairedCode() 取走（§16.4 / §10）
    stagePairedCode(peerDeviceId, peerCode)
    log.info('pair ok', { peer: idPrefix(peerDeviceId), pair: idPrefix(pairId) })
    return {
      ok: true,
      peer: {
        deviceId: peerDeviceId,
        deviceName: peerDeviceName || target.deviceName,
        host: target.host,
        // 用对端自报的 port：它的服务可能因端口顺延而不是发现包里的那个
        port: peerPort,
      },
    }
  }
}

/**
 * 发起配对（渲染层 `pairStart` 的实现）。
 *
 * 一直挂到出结果：成功、拒绝、超时、连不上。对同一目标（`deviceId|host:port`）重复
 * 调用**复用进行中的那次协商** —— `pairId` 是这里生成的，渲染层并不知道，所以去重键
 * 只能用目标；效果等价于「同一 pairId 不开两条轮询」，双击也不会让对端弹两个框。
 */
export function startLanPair(peer: unknown, options: LanPairStartOptions): Promise<LanPairStartResult> {
  const target = normalizePairPeer(peer)
  if (!target) return Promise.resolve({ ok: false, reason: 'invalid' })

  const local = options?.local
  if (!local || !local.deviceId || normalizePort(local.port) === 0) {
    // 本机服务没开：请求体里那个 port 是应答方回连用的，配对在这种状态下没有意义
    log.warn('pair start without local service port')
    return Promise.resolve({ ok: false, reason: 'unreachable' })
  }
  if (target.deviceId && target.deviceId === local.deviceId) {
    return Promise.resolve({ ok: false, reason: 'self' })
  }

  const targetKey = pairTargetKey(target)
  const existing = inflightPairSessions.get(targetKey)
  if (existing) return existing.promise

  const pairId = randomBytes(16).toString('hex')
  const controller = new AbortController()
  const promise = runPairSession(
    pairId,
    target,
    local,
    controller.signal,
    options?.pollIntervalMs,
  )
    // 任何意外异常都不能变成渲染层的未处理 rejection：映射成 invalid 交回 UI
    .catch((err: unknown): LanPairStartResult => {
      log.warn('pair session crashed', { pair: idPrefix(pairId), error: errorName(err) })
      return { ok: false, reason: 'invalid' }
    })
    .finally(() => {
      inflightPairSessions.delete(targetKey)
      inflightPairControllers.delete(pairId)
    })

  inflightPairSessions.set(targetKey, { pairId, promise })
  inflightPairControllers.set(pairId, controller)
  return promise
}

/**
 * 撤销未完成的配对（渲染层 `pairCancel` 的实现）。
 *
 * - 带 `pairId`：中断那一次协商，进行中的 `pairStart` 立刻以
 *   `{ ok:false, reason:'cancelled' }` 收尾（**不复用 `timeout`**：一个是「我不等了」，
 *   一个是「等到头了」，UI 文案与责任方都不同）；若本进程恰好也有这条 pairId 的待确认项
 *   （理论上不会——收到的那条 pairId 属于对端），一并标成 `denied`。
 * - 不带：取消本进程所有进行中的协商（退出/关服务时的兜底）。
 *
 * **跨进程撤不掉**：应答方那台机器上的待确认项没有「撤销」通道，它由自己的 TTL 收尾，
 * 或由对端用户点拒绝。这是 §16.1「人工确认是唯一授权闸门」的必然结果。
 *
 * 幂等：没有匹配项时什么都不做。
 */
export function cancelLanPair(pairId?: string): void {
  if (typeof pairId === 'string' && pairId) {
    inflightPairControllers.get(pairId)?.abort()
    const entry = pendingPairs.get(pairId)
    if (entry && entry.state === 'pending') {
      entry.state = 'denied'
      log.info('pair cancelled', { from: idPrefix(entry.peer.deviceId), pair: idPrefix(pairId) })
    }
    return
  }
  for (const controller of inflightPairControllers.values()) controller.abort()
}

/**
 * 清空配对相关的进程内状态（关服务 / 退出 / 测试收尾）。
 *
 * 暂存的码属于凭据材料：服务被关掉、进程要退出时一并丢掉，比留在内存里等 GC 更明确。
 * 进行中的 `pairStart` 会以 `cancelled` 收尾（abort 语义同上）。
 */
export function resetLanPairState(): void {
  pendingPairs.clear()
  stagedPairedCodes.clear()
  stopPairSweeper()
  for (const controller of inflightPairControllers.values()) controller.abort()
  inflightPairControllers.clear()
  inflightPairSessions.clear()
}
