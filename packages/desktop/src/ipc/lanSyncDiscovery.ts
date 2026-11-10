/**
 * 局域网同步的设备发现（主进程，`node:dgram`）。
 *
 * ## 为什么用 UDP 广播而不是 mDNS
 *
 * mDNS 要走组播、依赖系统解析器（Linux 上还常被 avahi 拦），而这里只需要
 * 「同网段、毫秒级、抄一段 JSON」——广播足够，且没有额外依赖。
 *
 * ## 广播包里**没有**配对码
 *
 * 包体只有 `{ kind, proto, deviceId, deviceName, port }`。配对码是抄写凭据，
 * 一旦进了广播包，同网段任何人都能拿到并推快照，那它就等于没有。
 *
 * ## 收包后的动作
 *
 * - `probe`：有人按「发现设备」，立刻 unicast 回一个 `announce`（避免依赖周期性广播）
 * - `announce`：记进 map（`deviceId` 去重，覆盖成最新一次）；`discover` 按时间窗过滤
 *
 * ## 端口冲突
 *
 * `reuseAddr: true`，允许同一台机器多个进程各绑一份（例如开发时 hot-reload 残留），
 * 代价是自己发的包自己也会收到——所以处理前先按 `deviceId` 排除自己。
 */

import dgram from 'node:dgram'
import os from 'node:os'
import { SYNC_LAN_PROTOCOL_VERSION, createLogger } from '@aurora/shared'
import type { LanPeerInfo, Logger } from '@aurora/shared'

/** 发现用 UDP 端口（与 HTTP 服务端口分开：一个广播、一个单播） */
export const LAN_SYNC_DISCOVERY_PORT = 45872

/** 周期性 announce 的间隔；UDP 丢了也能在下一轮补上 */
export const LAN_SYNC_ANNOUNCE_INTERVAL_MS = 15_000

/** discover 默认/最长等待时间 */
export const LAN_SYNC_DISCOVERY_DEFAULT_TIMEOUT_MS = 1200
export const LAN_SYNC_DISCOVERY_MAX_TIMEOUT_MS = 10_000

export interface LanSyncDiscoveryOptions {
  readonly deviceId: string
  readonly deviceName: string
  /** 本机 HTTP 服务端口；null = 服务没开，此时不广播（对端也连不上） */
  readonly getPort: () => number | null
  readonly logger?: Logger
}

type LanDiscoveryPacketKind = 'announce' | 'probe'

interface LanDiscoveryPacket {
  readonly kind: LanDiscoveryPacketKind
  readonly proto: number
  readonly deviceId: string
  readonly deviceName: string
  readonly port: number
}

interface DiscoveryState {
  socket: dgram.Socket | null
  options: LanSyncDiscoveryOptions | null
  announceTimer: ReturnType<typeof setInterval> | null
  /** deviceId → 最近一次看到的对端信息 */
  peers: Map<string, LanPeerInfo>
}

const state: DiscoveryState = {
  socket: null,
  options: null,
  announceTimer: null,
  peers: new Map(),
}

const log = createLogger('lan-sync.discovery')

function devicePrefix(deviceId: string): string {
  return typeof deviceId === 'string' && deviceId ? deviceId.slice(0, 8) : 'unknown'
}

function parsePacket(raw: Buffer): LanDiscoveryPacket | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const packet = parsed as Record<string, unknown>
  if (packet.kind !== 'announce' && packet.kind !== 'probe') return null
  if (typeof packet.proto !== 'number' || packet.proto !== SYNC_LAN_PROTOCOL_VERSION) return null
  if (typeof packet.deviceId !== 'string' || !packet.deviceId) return null
  if (typeof packet.deviceName !== 'string') return null
  if (typeof packet.port !== 'number' || !Number.isInteger(packet.port) || packet.port < 1 || packet.port > 65535) {
    return null
  }
  return {
    kind: packet.kind,
    proto: packet.proto,
    deviceId: packet.deviceId,
    deviceName: packet.deviceName,
    port: packet.port,
  }
}

/** 点分 IPv4 → 32 位整数（非法返回 null） */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << 8) | octet
  }
  return value >>> 0
}

function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.')
}

/**
 * 广播目标地址：每块网卡的子网广播地址；拿不到时退回受限广播 255.255.255.255。
 *
 * Node 的 `os.networkInterfaces()` **不提供** `broadcast` 字段（那是 Python 的
 * `ifaddrs` / C 的 `getifaddrs` 才有），所以这里按 `address | ~netmask` 自己算：
 * 子网广播能穿过部分交换机/VLAN 配置下的受限广播限制，比纯 255.255.255.255 更可靠。
 * 同时始终带上 255.255.255.255 兜底（多宿主 / 虚拟网卡算错时不至于完全发现不到）。
 * 重复目标由 Set 去重。
 */
function broadcastTargets(): string[] {
  const targets = new Set<string>(['255.255.255.255'])
  try {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family !== 'IPv4' || entry.internal) continue
        const address = ipv4ToInt(entry.address)
        const netmask = ipv4ToInt(entry.netmask)
        if (address === null || netmask === null) continue
        targets.add(intToIpv4(((address & netmask) | (~netmask >>> 0)) >>> 0))
      }
    }
  } catch {
    // 取网卡失败时保留兜底地址即可
  }
  return [...targets]
}

function sendPacket(socket: dgram.Socket, host: string, port: number, packet: LanDiscoveryPacket): void {
  const payload = Buffer.from(JSON.stringify(packet), 'utf8')
  socket.send(payload, port, host, (err) => {
    if (err) {
      // 单条广播失败很常见（某块虚拟网卡不可达），debug 级别即可
      log.debug('udp send failed', { host, port, error: err.name })
    }
  })
}

function announcePacket(deviceId: string, deviceName: string, port: number): LanDiscoveryPacket {
  return { kind: 'announce', proto: SYNC_LAN_PROTOCOL_VERSION, deviceId, deviceName, port }
}

/** 向所有广播地址发一次 announce（自身服务端口未知时跳过） */
function announce(): void {
  const { socket, options } = state
  if (!socket || !options) return
  const port = options.getPort()
  if (port === null) return
  const packet = announcePacket(options.deviceId, options.deviceName, port)
  for (const target of broadcastTargets()) {
    sendPacket(socket, target, LAN_SYNC_DISCOVERY_PORT, packet)
  }
}

function handleMessage(raw: Buffer, rinfo: { address: string; port: number }): void {
  const { socket, options } = state
  if (!socket || !options) return
  const packet = parsePacket(raw)
  if (!packet) return
  // 自己发的包也会被 reuseAddr 的 socket 收到（以及同机另一个进程）
  if (packet.deviceId === options.deviceId) return

  if (packet.kind === 'probe') {
    const port = options.getPort()
    if (port === null) return
    // 单播回去：用对端发包的源端口（它在 45872 上等），不广播，避免把整网段吵醒
    sendPacket(
      socket,
      rinfo.address,
      rinfo.port,
      announcePacket(options.deviceId, options.deviceName, port),
    )
    return
  }

  state.peers.set(packet.deviceId, {
    deviceId: packet.deviceId,
    deviceName: packet.deviceName,
    host: rinfo.address,
    port: packet.port,
    protocol: packet.proto,
    lastSeenAt: Date.now(),
  })
  log.debug('peer announced', {
    device: devicePrefix(packet.deviceId),
    host: rinfo.address,
    port: packet.port,
  })
}

function bindSocket(socket: dgram.Socket, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      cleanup()
      reject(err)
    }
    const onListening = (): void => {
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      socket.off('error', onError)
      socket.off('listening', onListening)
    }
    socket.once('error', onError)
    socket.once('listening', onListening)
    socket.bind({ port, address: '0.0.0.0', exclusive: false })
  })
}

/**
 * 启动发现服务（绑定 UDP 端口、开始周期广播）。
 *
 * 重复启动是幂等的（已经跑着就直接返回）。
 */
export async function startLanSyncDiscovery(options: LanSyncDiscoveryOptions): Promise<void> {
  if (state.socket) return
  if (options.getPort() === null) return

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  try {
    await bindSocket(socket, LAN_SYNC_DISCOVERY_PORT)
  } catch (err) {
    try {
      socket.close()
    } catch {
      /* 未进入 listening 时 close 可能抛错，忽略 */
    }
    throw err
  }

  socket.setBroadcast(true)
  socket.on('message', (raw, rinfo) => handleMessage(raw, rinfo))
  socket.on('error', (err) => log.warn('udp socket error', { error: err.name }))

  state.socket = socket
  state.options = options
  state.announceTimer = setInterval(announce, LAN_SYNC_ANNOUNCE_INTERVAL_MS)
  // 定时器不能单独把进程留住（否则托盘退出后还要等 15s）
  state.announceTimer.unref?.()

  announce()
  log.info('discovery listening', {
    device: devicePrefix(options.deviceId),
    port: LAN_SYNC_DISCOVERY_PORT,
  })
}

/** 停止发现服务（幂等）：清定时器、关 UDP socket、清机器表 */
export async function stopLanSyncDiscovery(): Promise<void> {
  if (state.announceTimer) {
    clearInterval(state.announceTimer)
    state.announceTimer = null
  }
  const socket = state.socket
  state.socket = null
  state.options = null
  state.peers.clear()
  if (!socket) return
  await new Promise<void>((resolve) => {
    try {
      socket.close(() => resolve())
    } catch {
      resolve()
    }
  })
  log.info('discovery stopped')
}

export function isLanSyncDiscoveryRunning(): boolean {
  return state.socket !== null
}

/** 当前已知的对端（不过滤时间窗，调试用） */
export function listKnownLanPeers(): LanPeerInfo[] {
  return [...state.peers.values()].map((peer) => ({ ...peer }))
}

/**
 * 发一次 probe，在 `timeoutMs` 内收集 announce，返回去重（按 deviceId）后
 * 按 `deviceName` 排序的列表。
 *
 * 服务没开时直接返回 `[]`：此时本机没有可被连的端口，对端回了 announce 也用不上，
 * 反而会让 UI 显示「发现了设备却连不上」。
 */
export async function discoverLanPeers(
  timeoutMs: number = LAN_SYNC_DISCOVERY_DEFAULT_TIMEOUT_MS,
): Promise<LanPeerInfo[]> {
  const { socket, options } = state
  if (!socket || !options) return []
  const port = options.getPort()
  if (port === null) return []

  const requested = Number.isFinite(timeoutMs) ? Math.floor(timeoutMs) : LAN_SYNC_DISCOVERY_DEFAULT_TIMEOUT_MS
  const waitMs = Math.min(Math.max(requested, 100), LAN_SYNC_DISCOVERY_MAX_TIMEOUT_MS)
  const startedAt = Date.now()

  const probe: LanDiscoveryPacket = {
    kind: 'probe',
    proto: SYNC_LAN_PROTOCOL_VERSION,
    deviceId: options.deviceId,
    deviceName: options.deviceName,
    port,
  }
  for (const target of broadcastTargets()) {
    sendPacket(socket, target, LAN_SYNC_DISCOVERY_PORT, probe)
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, waitMs)
    timer.unref?.()
  })

  return [...state.peers.values()]
    .filter((peer) => peer.lastSeenAt >= startedAt)
    .sort(
      (a, b) =>
        a.deviceName.localeCompare(b.deviceName) || a.deviceId.localeCompare(b.deviceId),
    )
    .map((peer) => ({ ...peer }))
}
