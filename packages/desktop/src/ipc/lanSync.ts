/**
 * 局域网同步的 IPC 入口 + 设备身份 + 配对码 + 对端收发（主进程）。
 *
 * ## 与其它 ipc 模块的分工
 *
 * - `lanSyncAuth.ts`   密码学原语（配对码归一化 / key 派生 / 签名 / 验签）
 * - `lanSyncServer.ts` 本机 HTTP 服务（监听、路由、收件箱）
 * - `lanSyncDiscovery.ts` UDP 广播发现
 * - 本文件             把三者接到 IPC 上：状态、开关、轮换、发现、发布、拉、推、取收件箱，
 *                      以及设备身份与配对码的落盘。
 *
 * ## 两个持久化
 *
 * - **设备身份** `<userData>/device.json`：`{ deviceId, deviceName }`，0600 + tmp rename。
 *   必须持久化——deviceId 是快照里的设备身份，每次启动都变的话对端会把同一台机器
 *   看成无数台，歌单会被反复当成「新设备的快照」。
 * - **配对码** `<userData>/lan-sync.json`：优先 `safeStorage` 加密后落盘。
 *   **加密不可用时只留内存**（每次启动重新生成）：配对码本身就是凭据，写明文
 *   等于把凭据摊在磁盘上。`LanSyncStatus` 里没有「是否已持久化」字段，
 *   所以这里只靠行为如实（不落盘）与日志记录，不对 UI 宣称「已保存」。
 *
 * ## 信任边界
 *
 * 配对码与派生 key **绝不进日志、绝不进 IPC 之外的任何地方**；日志只出现
 * deviceId 前缀、端口、状态与错误分类。拉/推对端时 `target.code` 只在派生 key
 * 时用一次，不缓存、不落盘。
 *
 * ## 服务默认关闭
 *
 * `main.ts` 的 whenReady 不自动启动服务：监听端口 + UDP 广播是用户可见的网络行为，
 * 必须由 UI（设置 → 局域网同步 → 开启）显式触发。`shutdownLanSync()` 在
 * before-quit 里收尾（关 HTTP、关 UDP、清定时器）。
 */

import { app, ipcMain, safeStorage } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'node:crypto'
import { auroraError, createLogger, isAuroraError } from '@aurora/shared'
import { SYNC_LAN_PROTOCOL_VERSION } from '@aurora/shared'
import type {
  LanPeerInfo,
  LanSyncStatus,
  LanSyncTarget,
  SyncSecrets,
  SyncSnapshot,
} from '@aurora/shared'
import {
  createNonce,
  deriveKey,
  generatePairCode,
  normalizePairCode,
  signRequest,
} from './lanSyncAuth'
import {
  LAN_SYNC_PATHS,
  getLanSyncInbox,
  getLanSyncServerPort,
  normalizeSyncSnapshot,
  setPublishedSnapshot,
  startLanSyncServer,
  stopLanSyncServer,
  takeLanSyncInbox,
} from './lanSyncServer'
import {
  discoverLanPeers,
  startLanSyncDiscovery,
  stopLanSyncDiscovery,
} from './lanSyncDiscovery'
import {
  clearSyncCredential,
  readSyncCredential,
  saveSyncCredential,
  syncCredentialState,
} from './syncCredentials'

const log = createLogger('lan-sync')

/** 对端请求超时：局域网内 8s 足够；超时按「不可达」处理 */
const PEER_REQUEST_TIMEOUT_MS = 8000

/** `sendToRenderer` 由 handlers.ts 注入（窗口可能已销毁，发送端自己兜） */
export type LanSendToRenderer = (channel: string, ...args: unknown[]) => void

/* ------------------------------------------------------------------ *
 * 设备身份
 * ------------------------------------------------------------------ */

interface DeviceIdentity {
  readonly deviceId: string
  readonly deviceName: string
}

let identity: DeviceIdentity | null = null

function deviceFilePath(): string {
  return path.join(app.getPath('userData'), 'device.json')
}

/** 与 pluginCredentials 同法：0600 + 先写 tmp 再 rename，避免半截文件 */
function writeFileAtomic(target: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  fs.renameSync(tmp, target)
  try {
    fs.chmodSync(target, 0o600)
  } catch {
    // FAT / 部分网络盘不支持 chmod；不因此失败
  }
}

function readDeviceIdentity(): DeviceIdentity | null {
  let raw: string
  try {
    raw = fs.readFileSync(deviceFilePath(), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceIdentity>
    if (typeof parsed.deviceId !== 'string' || parsed.deviceId.length < 8) return null
    return {
      deviceId: parsed.deviceId,
      deviceName:
        typeof parsed.deviceName === 'string' && parsed.deviceName
          ? parsed.deviceName
          : defaultDeviceName(),
    }
  } catch {
    return null
  }
}

function defaultDeviceName(): string {
  try {
    return os.hostname() || 'Aurora Music'
  } catch {
    return 'Aurora Music'
  }
}

/** 惰性初始化（首次 status 调用时）：读文件，没有就生成并落盘 */
function ensureIdentity(): DeviceIdentity {
  if (identity) return identity
  const stored = readDeviceIdentity()
  if (stored) {
    identity = stored
    return stored
  }
  const created: DeviceIdentity = {
    deviceId: randomUUID(),
    deviceName: defaultDeviceName(),
  }
  identity = created
  try {
    writeFileAtomic(deviceFilePath(), JSON.stringify(created, null, 2))
  } catch (err) {
    // 写不了盘也要能跑（本次会话内 deviceId 仍稳定）；下次启动会换一个 id
    log.warn('device identity persist failed', { error: errorName(err) })
  }
  log.info('device identity created', { device: devicePrefix(created.deviceId) })
  return created
}

function devicePrefix(deviceId: string): string {
  return typeof deviceId === 'string' && deviceId ? deviceId.slice(0, 8) : 'unknown'
}

/* ------------------------------------------------------------------ *
 * 配对码
 * ------------------------------------------------------------------ */

let pairCode: string | null = null

function pairCodeFilePath(): string {
  return path.join(app.getPath('userData'), 'lan-sync.json')
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** 读已持久化的配对码（只在能加密时才读） */
function readPersistedPairCode(): string | null {
  if (!encryptionAvailable()) return null
  let cipher: Buffer
  try {
    cipher = fs.readFileSync(pairCodeFilePath())
  } catch {
    return null
  }
  try {
    const json = safeStorage.decryptString(cipher)
    const parsed = JSON.parse(json) as { code?: unknown }
    return normalizePairCode(parsed?.code)
  } catch {
    // 系统密钥变了（换机器 / 重装 / keyring 重置）或文件损坏：删掉，重新生成
    try {
      fs.unlinkSync(pairCodeFilePath())
    } catch {
      /* 删不掉也不影响下次读 */
    }
    return null
  }
}

function persistPairCode(code: string): void {
  if (!encryptionAvailable()) return
  try {
    const cipher = safeStorage.encryptString(JSON.stringify({ code }))
    writeFileAtomic(pairCodeFilePath(), cipher)
  } catch (err) {
    // 落盘失败仍然可用（内存里这份就是本次会话的真实凭据），下次启动会重新生成
    log.warn('pair code persist failed', { error: errorName(err) })
  }
}

/** 惰性初始化配对码：优先读密文，否则生成（能加密才落盘） */
function ensurePairCode(): string {
  if (pairCode) return pairCode
  const stored = readPersistedPairCode()
  if (stored) {
    pairCode = stored
    return stored
  }
  const generated = generatePairCode()
  pairCode = generated
  if (encryptionAvailable()) persistPairCode(generated)
  else log.info('pair code kept in memory only (encryption unavailable)')
  return generated
}

/** 当前配对码（服务端每个请求取一次 → 轮换后旧码立刻失效） */
function currentPairCode(): string {
  return ensurePairCode()
}

/* ------------------------------------------------------------------ *
 * 运行状态
 * ------------------------------------------------------------------ */

let running = false

/** 串行化开关/轮换：并发调用 setEnabled 时不能出现两个 http server */
let opChain: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = opChain.then(task, task)
  // 队列本身不能因为某次失败而卡死
  opChain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

function currentStatus(): LanSyncStatus {
  const device = ensureIdentity()
  return {
    running,
    port: running ? getLanSyncServerPort() : null,
    code: ensurePairCode(),
    deviceId: device.deviceId,
    deviceName: device.deviceName,
  }
}

/** 开/关本机服务（开 = HTTP 监听 + UDP 广播）。失败时回到关闭状态并返回 running:false */
async function setEnabled(enabled: boolean): Promise<LanSyncStatus> {
  return enqueue(async () => {
    const device = ensureIdentity()

    if (!enabled) {
      await stopLanSyncDiscovery()
      await stopLanSyncServer()
      running = false
      log.info('service disabled')
      return currentStatus()
    }

    if (running) return currentStatus()

    try {
      await startLanSyncServer({
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        // 每请求现取：rotateCode 后旧码立即失效，不需要重启服务
        getCode: currentPairCode,
        onSnapshot: () => {
          // 推一份拷贝；清空由渲染层 lan:takeInbox 负责（事件丢了还能取）
          sendToRenderer('lan:inbox', getLanSyncInbox())
        },
      })
      await startLanSyncDiscovery({
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        getPort: () => getLanSyncServerPort(),
      })
      running = true
      log.info('service enabled', {
        device: devicePrefix(device.deviceId),
        port: getLanSyncServerPort(),
      })
    } catch (err) {
      // 端口被占满 / UDP 绑不上：不半开着跑，回滚成关闭状态
      log.warn('service enable failed', {
        device: devicePrefix(device.deviceId),
        error: errorName(err),
      })
      await stopLanSyncDiscovery().catch(() => undefined)
      await stopLanSyncServer().catch(() => undefined)
      running = false
    }
    return currentStatus()
  })
}

/** 轮换配对码：服务端下一请求即用新码，旧码立刻失效 */
async function rotateCode(): Promise<LanSyncStatus> {
  return enqueue(async () => {
    const next = generatePairCode()
    pairCode = next
    persistPairCode(next)
    log.info('pair code rotated', { device: devicePrefix(ensureIdentity().deviceId) })
    return currentStatus()
  })
}

/* ------------------------------------------------------------------ *
 * 对端收发（签名 HTTP）
 * ------------------------------------------------------------------ */

interface NormalizedTarget {
  readonly host: string
  readonly port: number
  readonly code: string
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err
}

/** 校验并归一化 LanSyncTarget（host/port/code 都来自渲染层，按不可信处理） */
function normalizeTarget(target: LanSyncTarget | undefined): NormalizedTarget {
  const host = typeof target?.host === 'string' ? target.host.trim() : ''
  const port = Number(target?.port)
  if (!host || !/^[A-Za-z0-9.:\[\]_-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw auroraError('sync.error.lanUnreachable', {
      host: host || '?',
      port: Number.isFinite(port) ? port : 0,
    })
  }
  const code = normalizePairCode(target?.code)
  if (!code) {
    // 码非法等于「凭据不对」，与对端 401 归为同一类，UI 提示「检查配对码」
    throw auroraError('sync.error.lanAuth')
  }
  return { host, port, code }
}

function peerUrl(target: NormalizedTarget): string {
  // IPv6 字面量要加方括号，否则 URL 解析会把地址当主机名
  const host = target.host.includes(':') && !target.host.startsWith('[') ? `[${target.host}]` : target.host
  return `http://${host}:${target.port}${LAN_SYNC_PATHS.snapshot}`
}

async function readJsonSafe(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await res.text()
    if (!text) return null
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 发一条签名的 GET/PUT 到对端；网络层失败（含超时）统一转 lanUnreachable */
async function signedPeerRequest(
  target: NormalizedTarget,
  init: { method: 'GET' | 'PUT'; body?: string },
): Promise<Response> {
  const device = ensureIdentity()
  const key = deriveKey(target.code)
  const headers: Record<string, string> = signRequest(key, {
    method: init.method,
    path: LAN_SYNC_PATHS.snapshot,
    ts: Date.now(),
    nonce: createNonce(),
    body: init.body,
    deviceId: device.deviceId,
    proto: SYNC_LAN_PROTOCOL_VERSION,
  })
  if (init.body !== undefined) headers['content-type'] = 'application/json'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PEER_REQUEST_TIMEOUT_MS)
  try {
    return await fetch(peerUrl(target), {
      method: init.method,
      headers,
      body: init.body,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

/** 把对端的非 2xx 响应映射成结构化错误 */
async function throwPeerStatusError(res: Response, target: NormalizedTarget): Promise<never> {
  const payload = await readJsonSafe(res)
  const code = typeof payload?.code === 'string' ? payload.code : ''
  if (res.status === 401 || code === 'auth') {
    throw auroraError('sync.error.lanAuth')
  }
  if (res.status === 403 || code === 'disabled') {
    throw auroraError('sync.error.lanDisabled')
  }
  if (res.status === 400 && code === 'protocol') {
    throw auroraError('sync.error.lanProtocol', { protocol: SYNC_LAN_PROTOCOL_VERSION })
  }
  if (res.status === 413 || code === 'tooLarge') {
    throw auroraError('sync.error.snapshotInvalid', { file: `${target.host}:${target.port}` })
  }
  throw auroraError('sync.error.unknown', { reason: `HTTP ${res.status}` })
}

/** 拉对端快照：404（对端还没发布）是正常空态，返回 [] */
async function pullFromPeer(target: LanSyncTarget | undefined): Promise<SyncSnapshot[]> {
  const normalized = normalizeTarget(target)
  let res: Response
  try {
    res = await signedPeerRequest(normalized, { method: 'GET' })
  } catch (err) {
    log.warn('pull unreachable', {
      host: normalized.host,
      port: normalized.port,
      error: errorName(err),
    })
    throw auroraError('sync.error.lanUnreachable', { host: normalized.host, port: normalized.port })
  }

  if (res.status === 404) {
    await readJsonSafe(res)
    log.info('pull empty', { host: normalized.host, port: normalized.port })
    return []
  }
  if (!res.ok) {
    log.warn('pull rejected', {
      host: normalized.host,
      port: normalized.port,
      status: res.status,
    })
    await throwPeerStatusError(res, normalized)
  }

  const payload = await readJsonSafe(res)
  const snapshot = payload && 'snapshot' in payload ? payload.snapshot : null
  let parsed: SyncSnapshot
  try {
    // 对端快照在交给渲染层之前先按 shared 的解析器归一化：外壳合法但缺 tracks
    // 的老快照会让渲染层 merge 抛 TypeError（见 docs/verify-playlist-sync.md S-5）。
    parsed = normalizeSyncSnapshot(snapshot)
  } catch (err) {
    log.warn('pull snapshot invalid', {
      host: normalized.host,
      port: normalized.port,
      error: errorName(err),
    })
    throw err
  }
  log.info('pull ok', {
    host: normalized.host,
    port: normalized.port,
    revision: parsed.revision,
  })
  return [parsed]
}

/**
 * 推本机快照到对端（签名 PUT，原样发——合并是渲染层引擎的职责，主进程不掺和）。
 */
async function pushToPeer(target: LanSyncTarget | undefined, snapshot: SyncSnapshot): Promise<void> {
  // 校验 + 归一化（补缺省的 tracks 等），**不合并**：合并是渲染层引擎的职责。
  // 主进程只保证「发出去的是一份对端一定能解析的快照」。
  const payload = normalizeSyncSnapshot(snapshot)
  const normalized = normalizeTarget(target)
  const body = JSON.stringify({ snapshot: payload })

  let res: Response
  try {
    res = await signedPeerRequest(normalized, { method: 'PUT', body })
  } catch (err) {
    log.warn('push unreachable', {
      host: normalized.host,
      port: normalized.port,
      error: errorName(err),
    })
    throw auroraError('sync.error.lanUnreachable', { host: normalized.host, port: normalized.port })
  }

  if (!res.ok) {
    log.warn('push rejected', {
      host: normalized.host,
      port: normalized.port,
      status: res.status,
    })
    await throwPeerStatusError(res, normalized)
  }
  // 消费掉响应体，避免 keep-alive 连接悬着
  await readJsonSafe(res)
  log.info('push ok', {
    host: normalized.host,
    port: normalized.port,
    revision: payload.revision,
  })
}

/* ------------------------------------------------------------------ *
 * 发布 / 收件箱 / 发现
 * ------------------------------------------------------------------ */

function publishSnapshot(snapshot: SyncSnapshot): void {
  // 校验 + 归一化：别把缺 tracks 的旧结构挂出去让对端解析失败
  const normalized = normalizeSyncSnapshot(snapshot)
  // 只缓存，不合并：合并由渲染层引擎负责（两处各算一遍必然不一致）
  setPublishedSnapshot(normalized)
  log.info('snapshot published', {
    device: devicePrefix(ensureIdentity().deviceId),
    revision: normalized.revision,
  })
}

async function discover(timeoutMs?: number): Promise<LanPeerInfo[]> {
  const peers = await discoverLanPeers(
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : undefined,
  )
  log.info('discover done', { peers: peers.length })
  return peers
}

/* ------------------------------------------------------------------ *
 * 主进程代发 HTTP（sync:fetch）
 * ------------------------------------------------------------------ */

/*
 * 为什么需要它：打包形态下渲染层是 `loadFile`（origin = `file://`，见
 * main.ts:203/:224-228），而 WebDAV 的 PROPFIND/PUT/MKCOL 全部触发 CORS 预检；
 * 绝大多数 WebDAV 服务不返回 ACAO，于是发布形态下同步完全不可用。
 * 扫描当年因同一个原因搬进了主进程（librarySource.ts:3-8），这里同理。
 *
 * 安全边界（渲染层是可信的，但这条通道能把任意请求发进内网，仍按不可信输入处理）：
 * - 只允许 http/https，绝不跟随重定向（3xx 原样返回，避免被对端引去别的地址）；
 * - 默认 15s / 上限 60s；响应体上限 8MB；
 * - 日志只记 method + host + status + 耗时，**绝不记** Authorization/Cookie/body。
 */

/** 默认超时：WebDAV 一次 PROPFIND 常在秒级，15s 足够 */
export const SYNC_FETCH_DEFAULT_TIMEOUT_MS = 15_000

/** 超时上限：调用方可以要更长，但不能把渲染层 IPC 挂住几分钟 */
export const SYNC_FETCH_MAX_TIMEOUT_MS = 60_000

/** 响应体上限：快照 JSON 几十 KB，8MB 已经是「明显不是快照」的界限 */
export const SYNC_FETCH_MAX_BODY_BYTES = 8 * 1024 * 1024

/** 渲染层发来的代发请求（字段都可省略，method 默认 GET） */
export interface SyncFetchRequest {
  readonly url: string
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  /** 文本请求体（WebDAV 的 XML / JSON 都是文本；不接二进制，避免额外编码约定） */
  readonly body?: string | null
  readonly timeoutMs?: number
}

/** 代发结果：3xx 也原样返回（`redirect: 'manual'`），由调用方决定怎么处理 */
export interface SyncFetchResponse {
  readonly status: number
  readonly statusText: string
  readonly headers: Record<string, string>
  readonly bodyText: string
}

/** 真正发请求的实现（测试注入；默认用主进程全局 fetch，不受 CORS 约束） */
export type SyncFetchImpl = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string
    signal: AbortSignal
    redirect: 'manual'
  },
) => Promise<Response>

let syncFetchImpl: SyncFetchImpl | null = null

/** 测试注入点：传 null 恢复默认（全局 fetch） */
export function setSyncFetchImpl(impl: SyncFetchImpl | null): void {
  syncFetchImpl = impl
}

function activeFetch(): SyncFetchImpl {
  return syncFetchImpl ?? ((url, init) => fetch(url, init))
}

interface NormalizedFetchRequest {
  readonly url: URL
  readonly method: string
  readonly headers: Record<string, string>
  readonly body?: string
  readonly timeoutMs: number
}

/** 请求头里由 Node 自己算的，渲染层传了也不转发（避免 content-length 与实际不符） */
const UNSETTABLE_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'expect',
])

/** HTTP method 的 RFC 7230 token 形状 */
const METHOD_TOKEN = /^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]{0,31}$/

/** 不允许代发的 method：CONNECT 是隧道语义，TRACE 会回显请求头（含 Authorization） */
const FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK'])

function invalidFetchRequest(reason: string): never {
  throw auroraError('sync.error.unknown', { reason })
}

/** 超时归一：非法值回默认，合法值夹在 [1, 60s] */
export function normalizeSyncFetchTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return SYNC_FETCH_DEFAULT_TIMEOUT_MS
  }
  return Math.min(Math.floor(value), SYNC_FETCH_MAX_TIMEOUT_MS)
}

/** 递增的 header 值/名里出现 CRLF 就是 header 注入，直接拒 */
function assertHeaderSafe(name: string, value: string): void {
  if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
    invalidFetchRequest('request headers must not contain CR/LF')
  }
}

/**
 * 校验并归一化一条代发请求。失败一律抛 `sync.error.unknown`：
 * 这类错误是渲染层写出了非法请求（bug），不是用户能修的网络问题。
 */
export function normalizeSyncFetchRequest(raw: unknown): NormalizedFetchRequest {
  if (!raw || typeof raw !== 'object') {
    invalidFetchRequest('request must be an object')
  }
  const input = raw as Partial<SyncFetchRequest>

  if (typeof input.url !== 'string' || input.url.trim() === '') {
    invalidFetchRequest('url is required')
  }
  let url: URL
  try {
    url = new URL(input.url.trim())
  } catch {
    invalidFetchRequest('url is not a valid absolute URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    invalidFetchRequest(`unsupported protocol ${url.protocol.replace(':', '')}`)
  }
  // URL 里的 userinfo 会把口令带进 URL（进而可能进日志/错误文案），一律拒
  if (url.username || url.password) {
    invalidFetchRequest('credentials in url are not allowed')
  }

  const rawMethod = input.method === undefined ? 'GET' : input.method
  if (typeof rawMethod !== 'string' || !METHOD_TOKEN.test(rawMethod.trim())) {
    invalidFetchRequest('invalid method')
  }
  const method = rawMethod.trim().toUpperCase()
  if (FORBIDDEN_METHODS.has(method)) {
    invalidFetchRequest(`method ${method} is not allowed`)
  }

  const headers: Record<string, string> = {}
  const rawHeaders = input.headers
  if (rawHeaders !== undefined && rawHeaders !== null) {
    if (typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
      invalidFetchRequest('headers must be an object')
    }
    for (const [name, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        invalidFetchRequest(`header ${name} must be a string`)
      }
      assertHeaderSafe(name, value)
      const key = name.trim().toLowerCase()
      if (!key) invalidFetchRequest('header name is empty')
      if (UNSETTABLE_REQUEST_HEADERS.has(key)) continue
      headers[key] = value
    }
  }

  const rawBody = input.body
  if (rawBody !== undefined && rawBody !== null && typeof rawBody !== 'string') {
    invalidFetchRequest('body must be a string')
  }
  const body = typeof rawBody === 'string' ? rawBody : undefined
  const bodyless = method === 'GET' || method === 'HEAD'
  if (bodyless && body !== undefined) {
    invalidFetchRequest(`${method} must not carry a body`)
  }

  return {
    url,
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    timeoutMs: normalizeSyncFetchTimeout(input.timeoutMs),
  }
}

/** 网络错误只留错误码（`ECONNREFUSED`），不留可能含 URL 的原始 message */
function networkReasonOf(err: unknown): string {
  if (err && typeof err === 'object') {
    const cause = (err as { cause?: unknown }).cause
    if (cause && typeof cause === 'object') {
      const code = (cause as { code?: unknown }).code
      if (typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code)) return code
    }
  }
  return 'request failed'
}

function fetchErrorDetail(err: unknown): string | undefined {
  const reason = networkReasonOf(err)
  return reason === 'request failed' ? undefined : reason
}

/**
 * 读响应体，超过 `limit` 就抛错。
 *
 * 先看 content-length 能省掉一场读盘；没声明时边读边累加（对端可以不声明长度）。
 */
async function readBodyCapped(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => undefined)
    throw auroraError(
      'sync.error.unknown',
      { reason: `response body exceeds ${limit} bytes` },
      'tooLarge',
    )
  }
  if (!res.body) {
    const text = await res.text()
    if (Buffer.byteLength(text, 'utf8') > limit) {
      throw auroraError(
        'sync.error.unknown',
        { reason: `response body exceeds ${limit} bytes` },
        'tooLarge',
      )
    }
    return text
  }

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || value.byteLength === 0) continue
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      throw auroraError(
        'sync.error.unknown',
        { reason: `response body exceeds ${limit} bytes` },
        'tooLarge',
      )
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value
  })
  return out
}

/**
 * 代发一条 HTTP 请求（`sync:fetch` 的实现）。
 *
 * 返回结构化结果而不是抛「网络错误」给渲染层自己猜：状态码、头、正文原样带回，
 * 由 WebDAV 适配器决定 401/404/3xx 的语义。
 */
export async function runSyncFetch(
  raw: unknown,
  limits: { readonly maxBodyBytes?: number } = {},
): Promise<SyncFetchResponse> {
  const request = normalizeSyncFetchRequest(raw)
  const host = request.url.host
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeoutMs)

  try {
    const res = await activeFetch()(request.url.toString(), {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: controller.signal,
      // 绝不跟随：3xx 原样返回，否则对端可以把本机当跳板去请求任意地址
      redirect: 'manual',
    })
    const bodyText = await readBodyCapped(res, limits.maxBodyBytes ?? SYNC_FETCH_MAX_BODY_BYTES)
    log.info('sync:fetch', {
      method: request.method,
      host,
      status: res.status,
      ms: Date.now() - startedAt,
    })
    return {
      status: res.status,
      statusText: res.statusText,
      headers: headersToRecord(res.headers),
      bodyText,
    }
  } catch (err) {
    if (isAuroraError(err)) throw err
    const timedOut = controller.signal.aborted
    log.warn('sync:fetch failed', {
      method: request.method,
      host,
      error: timedOut ? 'timeout' : 'network',
      ms: Date.now() - startedAt,
    })
    throw auroraError(
      'sync.error.webdavConnect',
      {
        name: host,
        reason: timedOut
          ? `timeout after ${request.timeoutMs}ms`
          : networkReasonOf(err),
      },
      fetchErrorDetail(err),
    )
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ *
 * IPC 注册
 * ------------------------------------------------------------------ */

/** 由 handlers.ts 注入；模块级的可变引用只在注册时赋一次 */
let sendToRenderer: LanSendToRenderer = () => undefined

function channel<T>(name: string, handler: (...args: unknown[]) => Promise<T> | T): void {
  ipcMain.handle(name, async (_event, ...args: unknown[]) => handler(...args))
}

/** 注册局域网同步相关 IPC（handlers.ts 的 registerIpcHandlers 里调用一次） */
export function registerLanSyncIpc(send?: LanSendToRenderer): void {
  if (send) sendToRenderer = send

  // ── 设备身份 ──────────────────────────────────────────────────
  channel('sync:device', () => {
    const device = ensureIdentity()
    return { deviceId: device.deviceId, deviceName: device.deviceName }
  })

  // ── 同步配置的凭据（按配置 id 存；safeStorage 加密）──────────────
  channel('sync:credential:save', (configId, payload) =>
    saveSyncCredential(String(configId ?? ''), payload),
  )
  channel('sync:credential:state', (configId) => syncCredentialState(String(configId ?? '')))
  channel('sync:credential:clear', (configId) => {
    clearSyncCredential(String(configId ?? ''))
  })
  channel('sync:credential:get', (configId): SyncSecrets | null =>
    readSyncCredential(String(configId ?? '')),
  )

  // ── 本机服务 ──────────────────────────────────────────────────
  channel('lan:status', () => currentStatus())
  channel('lan:setEnabled', (enabled) => setEnabled(enabled === true))
  channel('lan:rotateCode', () => rotateCode())
  channel('lan:discover', (timeoutMs) => discover(typeof timeoutMs === 'number' ? timeoutMs : undefined))
  channel('lan:publish', (snapshot) => {
    publishSnapshot(snapshot as SyncSnapshot)
  })
  channel('lan:pull', (target) => pullFromPeer(target as LanSyncTarget | undefined))
  channel('lan:push', (target, snapshot) =>
    pushToPeer(target as LanSyncTarget | undefined, snapshot as SyncSnapshot),
  )
  channel('lan:takeInbox', () => takeLanSyncInbox())

  // ── 主进程代发 HTTP（WebDAV 绕开 file:// 的 CORS 预检）────────────
  channel('sync:fetch', (request) => runSyncFetch(request))
}

/**
 * 退出前收尾：关 HTTP 服务、关 UDP socket、清定时器。
 *
 * 同步返回一个 Promise，由 main.ts 的 before-quit 直接调用（不阻塞退出等待）：
 * `server.close()` 已经先 `closeAllConnections()`，不会拖住进程；即使没关完，
 * 进程退出时 OS 会回收监听端口。
 */
export function shutdownLanSync(): void {
  running = false
  void (async () => {
    try {
      await stopLanSyncDiscovery()
      await stopLanSyncServer()
    } catch (err) {
      log.warn('shutdown failed', { error: errorName(err) })
    }
    log.info('shutdown complete')
  })()
}
