/**
 * 局域网同步的本机 HTTP 服务（主进程，`node:http`）。
 *
 * ## 信任边界
 *
 * 端口对同网段**所有**主机开放，所以每一条请求（包括 `GET /v1/hello`）都必须带
 * 当前配对码派生的 HMAC 签名（见 `lanSyncAuth.ts`）。配对码只在用户屏幕上，
 * 不进广播包、不进日志。
 *
 * 唯一的例外是一键配对的两条路由（`/v1/pair/request`、`/v1/pair/status`，见 §16.1）：
 * 发起方还没有本机码，签不出来；它们的授权闸门是应答方的**人工确认**，
 * 并且入参按不可信处理（回连地址只取 TCP 源地址）。`/v1/pair/reply` 仍走签名。
 *
 * ## 状态放哪
 *
 * 三个小状态是**模块级单例**，因为 lan:status / lan:publish 等 IPC 与 HTTP 路由
 * 必须看到同一份：已发布快照（供对端 GET）、收件箱（对端 PUT 进来的）、监听端口。
 * 进程里只允许跑一个局域网服务（端口是固定的，一台上开两个没有意义）。
 *
 * ## 收件箱语义
 *
 * `GET /v1/snapshot` 与 `PUT /v1/snapshot` 都只搬一份快照；PUT 进收件箱后由
 * 渲染层 `lan:takeInbox` 取走（取走即清空，避免同一份被重复应用）。
 *
 * 收件箱按**来源设备**去重：每台设备只留 revision 最高的一份（同 revision 重复
 * PUT 视为重试，不再触发事件）。对端在用户没打开面板时会重试推送，按条累积只会
 * 让同一台设备的旧快照把别台的挤掉；设备数上限 20，超出按 LRU 淘汰最久未更新的。
 *
 * ## 端口顺延
 *
 * 默认 45871；被占用（EADDRINUSE）才 +1 顺延，最多 20 次。其它 listen 错误
 * （权限、地址不可用）直接失败——换端口也解决不了，重试只会掩盖真实原因。
 */

import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  SYNC_LAN_PROTOCOL_VERSION,
  createLogger,
  isAuroraError,
  parseSnapshot,
} from '@aurora/shared'
import type { LanPairPeer, LanPairRequest, Logger, SyncSnapshot } from '@aurora/shared'
import { LAN_HEADERS, deriveKey, verifyRequest } from './lanSyncAuth'
import { handleLanPairRoute } from './lanSyncPair'

/** 默认监听端口（文档 §15.3 固定值；对端「端口」字段默认也是它） */
export const LAN_SYNC_DEFAULT_PORT = 45871

/** listen 顺延次数上限（含首个端口的尝试总数） */
export const LAN_SYNC_MAX_PORT_ATTEMPTS = 20

/** 单次 PUT 的请求体上限：快照几十 KB，5MB 已经是「明显不是快照」的界限 */
export const LAN_SYNC_MAX_BODY_BYTES = 5 * 1024 * 1024

/** 收件箱容量（按**设备**计：每台设备只留一份最新快照） */
export const LAN_SYNC_INBOX_LIMIT = 20

/** HTTP 路径（客户端与主进程共用同一份常量，避免两边各写一份字符串） */
export const LAN_SYNC_PATHS = {
  hello: '/v1/hello',
  snapshot: '/v1/snapshot',
} as const

export interface LanSyncServerOptions {
  readonly deviceId: string
  readonly deviceName: string
  /**
   * 当前配对码的取值器。**每个请求**调用一次并派生 key，
   * 这样用户轮换配对码后旧码立刻失效，不需要重启服务。
   */
  readonly getCode: () => string
  /** 监听端口；`0` = 由系统分配（测试用），不参与顺延 */
  readonly port?: number
  readonly host?: string
  /** 端口顺延的尝试总次数（默认 20，含首个端口） */
  readonly maxPortAttempts?: number
  /** 服务是否处于「开启」状态；关闭中收到请求回 403 disabled */
  readonly isEnabled?: () => boolean
  /** 收到一份通过校验的快照后回调（lanSync.ts 在这里推 lan:inbox 事件） */
  readonly onSnapshot?: (snapshot: SyncSnapshot) => void
  /** 收到一条新的一键配对请求（lanSync.ts 在这里推 lan:pairRequest，让渲染层弹确认框） */
  readonly onPairRequest?: (request: LanPairRequest) => void
  /** 本端拿到发起方的配对码（lanSync.ts 在这里推 lan:paired，渲染层建配置 + adopt） */
  readonly onPaired?: (peer: LanPairPeer) => void
  readonly logger?: Logger
}

export interface LanSyncServerHandle {
  readonly port: number
  readonly host: string
  /** 关掉本服务（等价 `stopLanSyncServer()`） */
  close(): Promise<void>
}

interface ServerState {
  server: http.Server | null
  port: number | null
  host: string | null
  options: LanSyncServerOptions | null
}

const state: ServerState = { server: null, port: null, host: null, options: null }

/** 已发布快照：供对端 `GET /v1/snapshot` */
let publishedSnapshot: SyncSnapshot | null = null

/**
 * 对端 PUT 进来的快照（取走即清空）。
 *
 * key = 来源 deviceId，value = 该设备 revision 最高的一份快照；Map 的插入顺序
 * 就是 LRU 顺序（每次更新先 delete 再 set，把该设备挪到队尾）。
 */
const inbox = new Map<string, SyncSnapshot>()

const log = createLogger('lan-sync.server')

/** 日志里只出现 deviceId 前缀，绝不出现配对码 */
function devicePrefix(deviceId: string): string {
  return typeof deviceId === 'string' && deviceId ? deviceId.slice(0, 8) : 'unknown'
}

/** 一份快照被拒的原因：结构不合法 / 格式版本不符（对应两种 400 code） */
export type SyncSnapshotRejection = 'snapshot' | 'snapshotVersion'

export type SyncSnapshotParseResult =
  | { readonly ok: true; readonly snapshot: SyncSnapshot }
  | { readonly ok: false; readonly reason: SyncSnapshotRejection }

/**
 * 用 shared 的 `parseSnapshot` 做**逐条**校验并归一化。
 *
 * 只验外壳（format/deviceId/playlists 是数组）挡不住坏数据：`tracks` 缺失或
 * 不是数组时，渲染层 merge 会抛 TypeError，等于让一台上古对端把本机同步搞挂。
 * `parseSnapshot` 是两端共用的唯一解析器，收件箱 / lan:publish / lan:push /
 * lan:pull 都走它，校验口径只有一份。
 */
export function parseSyncSnapshotPayload(value: unknown): SyncSnapshotParseResult {
  try {
    return { ok: true, snapshot: parseSnapshot(JSON.stringify(value)) }
  } catch (err) {
    const code = isAuroraError(err) ? err.code : ''
    return {
      ok: false,
      reason: code === 'sync.error.snapshotVersion' ? 'snapshotVersion' : 'snapshot',
    }
  }
}

/** 同 `parseSyncSnapshotPayload`，但失败时抛 shared 的结构化错误（客户端收/发用） */
export function normalizeSyncSnapshot(value: unknown): SyncSnapshot {
  const result = parseSyncSnapshotPayload(value)
  if (result.ok) return result.snapshot
  // 这里要抛带 i18n code 的 AuroraError，让渲染层能显示同一句话；
  // 直接重跑 parseSnapshot 即可复用它的错误构造。
  return parseSnapshot(JSON.stringify(value))
}

/**
 * 快照形状校验（布尔版，供「本地要不要发出去」这种只需判断的地方用）。
 *
 * 只认本版本的 `SYNC_SNAPSHOT_FORMAT`：major 不同说明对端结构不明，宁可拒绝
 * 也不能把结构不明的 JSON 当歌单灌进用户数据（文档 §5 的同一判据）。
 */
export function isSyncSnapshot(value: unknown): value is SyncSnapshot {
  return parseSyncSnapshotPayload(value).ok
}

/** 更新「本机可被拉取的快照」；传 null 表示清空（UI 关掉发布时用） */
export function setPublishedSnapshot(snapshot: SyncSnapshot | null): void {
  publishedSnapshot = snapshot
}

export function getPublishedSnapshot(): SyncSnapshot | null {
  return publishedSnapshot
}

/** 收件箱快照（拷贝，**不清空**）——推 `lan:inbox` 事件时用，让 takeInbox 仍是唯一消费者 */
export function getLanSyncInbox(): SyncSnapshot[] {
  return [...inbox.values()]
}

/** 取走收件箱（取走即清空） */
export function takeLanSyncInbox(): SyncSnapshot[] {
  const taken = [...inbox.values()]
  inbox.clear()
  return taken
}

/** 清空收件箱（测试 / 关闭服务时也可调用） */
export function clearLanSyncInbox(): void {
  inbox.clear()
}

export function getLanSyncServerPort(): number | null {
  return state.port
}

export function isLanSyncServerRunning(): boolean {
  return state.server !== null
}

class BodyTooLargeError extends Error {
  constructor() {
    super('request body too large')
    this.name = 'BodyTooLargeError'
  }
}

/**
 * 读完请求体。
 *
 * 必须**先读 body 再验签**：签名覆盖 body 的 sha256，边读边验做不到；
 * 上限 5MB 在这里兜住，超限立刻停止累积并回 413。
 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settled = true
        // 不 destroy：还要把 413 写回去；剩余字节让 Node 自己排空
        req.resume()
        reject(new BodyTooLargeError())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(Buffer.byteLength(body)))
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

function headerValue(
  headers: IncomingMessage['headers'],
  name: string,
): string | null {
  const raw = headers[name]
  if (Array.isArray(raw)) return raw[0] ?? null
  return typeof raw === 'string' ? raw : null
}

/**
 * 从 PUT 的 body 里取出快照：接受 `{ snapshot }` 包装或裸快照对象。
 *
 * 解出来的对象整份交给 `parseSyncSnapshotPayload` 校验 + 归一化，缺 `tracks`
 * 之类的老数据会被补成 `[]`，而不是原样灌进收件箱。
 */
function readSnapshotFromBody(body: Buffer): SyncSnapshotParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return { ok: false, reason: 'snapshot' }
  }
  const candidate =
    parsed && typeof parsed === 'object' && 'snapshot' in (parsed as Record<string, unknown>)
      ? (parsed as { snapshot?: unknown }).snapshot
      : parsed
  return parseSyncSnapshotPayload(candidate)
}

/**
 * 把快照放进收件箱，返回它是否是该设备的**新**快照。
 *
 * - 同设备同/低 revision（重复 PUT、乱序重试）→ 不覆盖、不触发事件；
 * - 同设备更高 revision → 覆盖并把该设备挪到 LRU 队尾；
 * - 设备数超过 20 → 淘汰最久未更新的那台（Map 的第一个 key）。
 */
function pushInbox(snapshot: SyncSnapshot): boolean {
  const existing = inbox.get(snapshot.deviceId)
  if (existing && snapshot.revision <= existing.revision) return false
  inbox.delete(snapshot.deviceId)
  inbox.set(snapshot.deviceId, snapshot)
  while (inbox.size > LAN_SYNC_INBOX_LIMIT) {
    const oldest = inbox.keys().next().value
    if (oldest === undefined) break
    inbox.delete(oldest)
  }
  return true
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: LanSyncServerOptions,
): Promise<void> {
  try {
    // 服务已关闭（关闭过程中仍有在途连接）：一律 403，不暴露任何路由细节
    if (options.isEnabled ? !options.isEnabled() : false) {
      sendJson(res, 403, { code: 'disabled' })
      return
    }

    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', 'http://lan-sync.invalid')
    const path = url.pathname

    let body: Buffer
    try {
      body = await readBody(req, LAN_SYNC_MAX_BODY_BYTES)
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { code: 'tooLarge' })
      } else {
        sendJson(res, 400, { code: 'protocol' })
      }
      return
    }

    // ── 一键配对（docs/playlist-sync.md §16）──────────────────────────
    // 必须排在通用验签**之前**：发起方此刻还没有本机配对码，签不出请求来。
    // 三条路由自己把住边界 —— request / status 免签（输入全按不可信处理），
    // reply 用本机当前配对码派生 HMAC 校验（与 §7 其它路由同一口径）。
    // 也排在协议版本头检查之前：配对协定的版本是 body 里的 `v`，与快照协议分开演进。
    const pairResult = handleLanPairRoute(
      {
        method,
        path,
        searchParams: url.searchParams,
        headers: req.headers,
        body,
        // 回连地址只信 TCP 源地址，body 里只有 port 可信（§16.2）
        remoteAddress: req.socket.remoteAddress ?? null,
      },
      {
        deviceId: options.deviceId,
        deviceName: options.deviceName,
        getCode: options.getCode,
        getPort: () => state.port ?? 0,
        onPairRequest: options.onPairRequest,
        onPaired: options.onPaired,
      },
    )
    if (pairResult) {
      sendJson(res, pairResult.status, pairResult.body)
      return
    }

    // 协议版本单独判：版本不符是 400（客户端结构没错，是版本不对），
    // 其余验签失败才是 401。缺 proto 头也算验签失败（401 protocol），
    // 这样「完全没签名的裸请求」得到的是 401 而不是 400。
    const protoHeader = headerValue(req.headers, LAN_HEADERS.proto)
    if (protoHeader !== null && protoHeader !== String(SYNC_LAN_PROTOCOL_VERSION)) {
      sendJson(res, 400, { code: 'protocol' })
      return
    }

    const verified = verifyRequest(deriveKey(options.getCode()), {
      method,
      path,
      headers: req.headers,
      body,
    })
    if (!verified.ok) {
      log.warn('request rejected', {
        device: devicePrefix(options.deviceId),
        path,
        method,
        reason: verified.reason,
      })
      sendJson(res, 401, { code: verified.reason === 'protocol' ? 'protocol' : 'auth' })
      return
    }

    if (path === LAN_SYNC_PATHS.hello) {
      if (method !== 'GET') {
        sendJson(res, 405, { code: 'method' })
        return
      }
      sendJson(res, 200, {
        proto: SYNC_LAN_PROTOCOL_VERSION,
        deviceId: options.deviceId,
        deviceName: options.deviceName,
        port: state.port ?? 0,
      })
      return
    }

    if (path === LAN_SYNC_PATHS.snapshot) {
      if (method === 'GET') {
        if (!publishedSnapshot) {
          sendJson(res, 404, { code: 'empty' })
          return
        }
        sendJson(res, 200, { snapshot: publishedSnapshot })
        return
      }

      if (method === 'PUT') {
        const result = readSnapshotFromBody(body)
        if (!result.ok) {
          sendJson(res, 400, { code: result.reason })
          return
        }
        const snapshot = result.snapshot
        const accepted = pushInbox(snapshot)
        if (accepted) {
          log.info('snapshot accepted', {
            device: devicePrefix(options.deviceId),
            from: devicePrefix(snapshot.deviceId),
            revision: snapshot.revision,
            inbox: inbox.size,
          })
          // 先落收件箱再通知：回调里会立刻读收件箱推事件，顺序反了会推空。
          // 重复 revision 不入箱也不通知：否则重试会把整份快照反复推给渲染层。
          options.onSnapshot?.(snapshot)
        }
        sendJson(res, 202, { accepted: true, revision: snapshot.revision })
        return
      }

      sendJson(res, 405, { code: 'method' })
      return
    }

    sendJson(res, 404, { code: 'notFound' })
  } catch (err) {
    log.error('request failed', {
      device: devicePrefix(options.deviceId),
      error: err instanceof Error ? err.name : typeof err,
    })
    sendJson(res, 500, { code: 'internal' })
  }
}

/** 在指定端口 listen 一次，成功时返回实际端口 */
function listenOnce(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      cleanup()
      reject(err)
    }
    const onListening = (): void => {
      cleanup()
      const address = server.address()
      resolve(address && typeof address === 'object' ? address.port : port)
    }
    const cleanup = (): void => {
      server.off('error', onError)
      server.off('listening', onListening)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function isAddrInUse(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
  )
}

/**
 * 启动本机服务。
 *
 * 端口被占用时 +1 顺延（最多 20 次尝试）；其它错误直接抛出。
 * 已在运行时重复启动会抛错——调用方（lanSync.ts）用单飞队列保证不会发生。
 */
export async function startLanSyncServer(options: LanSyncServerOptions): Promise<LanSyncServerHandle> {
  if (state.server) {
    throw new Error('lan sync server is already running')
  }

  const host = options.host ?? '0.0.0.0'
  const basePort = options.port ?? LAN_SYNC_DEFAULT_PORT
  const ephemeral = basePort === 0
  const attempts = ephemeral ? 1 : Math.max(1, options.maxPortAttempts ?? LAN_SYNC_MAX_PORT_ATTEMPTS)

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, options)
  })

  let boundPort = -1
  let lastError: unknown = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = ephemeral ? 0 : basePort + attempt
    try {
      boundPort = await listenOnce(server, candidate, host)
      break
    } catch (err) {
      lastError = err
      if (!isAddrInUse(err)) break
    }
  }

  if (boundPort < 0) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw lastError instanceof Error ? lastError : new Error('lan sync server failed to listen')
  }

  state.server = server
  state.port = boundPort
  state.host = host
  state.options = options
  log.info('http listening', {
    device: devicePrefix(options.deviceId),
    port: boundPort,
  })

  return {
    port: boundPort,
    host,
    close: () => stopLanSyncServer(),
  }
}

/** 停止本机服务（幂等）。发布快照与收件箱是内存态，保留给下次启动。 */
export async function stopLanSyncServer(): Promise<void> {
  const server = state.server
  if (!server) return
  const port = state.port
  state.server = null
  state.port = null
  state.host = null
  state.options = null

  // 有 keep-alive 连接时 close() 会等它们自然断开；先掐掉，退出/关闭才能立刻完成
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
  log.info('http stopped', { port })
}
