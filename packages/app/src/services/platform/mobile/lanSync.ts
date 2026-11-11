/**
 * 局域网同步桥（移动端）= Capacitor 原生插件 `LanSync` 的 JS 侧。
 *
 * ## 为什么移动端也能当「服务端」
 *
 * 桌面上 HTTP 监听、UDP 广播与 HMAC 都在主进程（`node:http`/`node:dgram`）；
 * 手机没有 Node，但 Capacitor 原生层有 `ServerSocket` 与 `DatagramSocket`，
 * 于是同一套协议（`docs/playlist-sync.md` §7/§16/§17）由 Kotlin 重写一遍，
 * 渲染层看到的是**同一个** `LanSyncBridge` 接口 —— 同步引擎与 UI 不需要知道
 * 对端是桌面还是手机。
 *
 * ## 能力缺失用「桥为 null」表达
 *
 * 插件没注册（Web 端、单测 node 环境、老包）时返回 null：UI 的可用性判断看的就是
 * 桥是否为 null（与桌面端 `createLanSyncBridge` 同一口径），而不是先显示入口再报错。
 *
 * ## 口令纪律不变
 *
 * 配对码/同步凭证在原生侧（Keystore 加密落盘），JS 只拿 `{saved, encryptionAvailable}`
 * 这类状态；`getCredential` 是引擎取明文口的唯一入口，用后即弃，不进 store、不进日志。
 */

import type {
  LanPairFailureReason,
  LanPairPeer,
  LanPairRequest,
  LanPairRespondResult,
  LanPairStartResult,
  LanPeerInfo,
  LanSyncBridge,
  LanSyncStatus,
  LanSyncTarget,
  SyncSecrets,
  SyncSnapshot,
} from '@aurora/shared'

/**
 * 凭证网关的状态形状。
 *
 * 不复用 `services/platform/index.ts` 的 `CredentialResult`：那一个是桌面端的
 * 返回类型，从它 import 会让本文件与 platform/index.ts 互相依赖（后者 import 本目录），
 * 类型环在 tsc 下能过、在 vite HMR 下偶发 TDZ；本地声明三行更省事。
 */
interface CredentialState {
  saved: boolean
  encryptionAvailable: boolean
}

interface CredentialResult extends CredentialState {
  ok: boolean
}

/**
 * 原生插件的方法集合。
 *
 * 方法名与 `LanSyncPlugin.kt` 的 `@PluginMethod` **一一对应**（Capacitor 按字符串
 * 反射调用，改一边就是运行期 no such method，所以两边必须同时改）。
 */
interface LanSyncNativePlugin {
  status(): Promise<LanSyncStatus>
  setEnabled(options: { enabled: boolean }): Promise<LanSyncStatus>
  rotateCode(): Promise<LanSyncStatus>
  // 同上：Capacitor 只能 resolve JSObject，数组包进 `{ peers }`
  discover(options?: { timeoutMs?: number }): Promise<{ peers?: LanPeerInfo[] }>
  publish(options: { snapshot: SyncSnapshot }): Promise<void>
  // Capacitor 的 resolve 只接受 JSObject（不能是裸数组），所以这两条包了一层
  // `{ snapshots }`；事件 `inbox` 同理。桌面端是裸数组，差异在本文件消化。
  takeInbox(): Promise<{ snapshots?: SyncSnapshot[] }>
  pullPeer(options: { target: LanSyncTarget }): Promise<{ snapshots?: SyncSnapshot[] }>
  pushPeer(options: { target: LanSyncTarget; snapshot: SyncSnapshot }): Promise<void>
  pairStart(options: { peer: LanPairPeer }): Promise<LanPairStartResult>
  pairRespond(options: { pairId: string; accept: boolean }): Promise<LanPairRespondResult>
  pairCancel(options?: { pairId?: string }): Promise<void>
  adoptPairedCode(options: { configId: string; deviceId: string }): Promise<boolean | { adopted?: boolean }>
  saveCredential(options: {
    configId: string
    payload: Record<string, string>
  }): Promise<CredentialState & { ok?: boolean }>
  credentialState(options: { configId: string }): Promise<CredentialState>
  /** 未保存时原生侧 resolve 空 → JS 收到 undefined（≠ null，但同为 falsy） */
  getCredential(options: { configId: string }): Promise<SyncSecrets | null | undefined>
  clearCredential(options: { configId: string }): Promise<CredentialState & { ok?: boolean }>
  addListener(
    eventName: string,
    callback: (data: unknown) => void,
  ): Promise<{ remove: () => Promise<void> }>
}

/** 取原生插件；不存在（Web / 单测 / 老包）返回 null */
export function lanSyncNativePlugin(): LanSyncNativePlugin | null {
  // 单测跑在 node 环境（没有 window），这里必须容忍缺失
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  const plugin = cap?.Plugins?.LanSync as LanSyncNativePlugin | undefined
  if (!plugin || typeof plugin.status !== 'function' || typeof plugin.setEnabled !== 'function') {
    return null
  }
  return plugin
}

/** 移动端是否具备局域网同步能力（UI 与引擎都只看这一个判据） */
export function mobileLanSyncAvailable(): boolean {
  return lanSyncNativePlugin() !== null
}

/**
 * 装配 shared 的 `LanSyncBridge`。
 *
 * 一对一转发，不做业务：超时、重试、状态机全在原生侧（与桌面端把逻辑放主进程同理），
 * 渲染层只负责调用与展示。
 */
export function createMobileLanSyncBridge(): LanSyncBridge | null {
  const plugin = lanSyncNativePlugin()
  if (!plugin) return null
  return {
    status: () => plugin.status(),
    setEnabled: (enabled: boolean) => plugin.setEnabled({ enabled }),
    rotateCode: () => plugin.rotateCode(),
    discover: async (timeoutMs?: number) => {
      // 原生侧回 `{ peers }`（Capacitor 不接受裸数组）；拿不到就当没发现任何设备
      const result = await plugin.discover({ ...(timeoutMs === undefined ? {} : { timeoutMs }) })
      return Array.isArray(result?.peers) ? result.peers : []
    },
    publish: (snapshot: SyncSnapshot) => plugin.publish({ snapshot }),
    takeInbox: async () => (await plugin.takeInbox())?.snapshots ?? [],
    pullPeer: async (target: LanSyncTarget) => (await plugin.pullPeer({ target }))?.snapshots ?? [],
    pushPeer: (target: LanSyncTarget, snapshot: SyncSnapshot) => plugin.pushPeer({ target, snapshot }),
    pairStart: (peer: LanPairPeer) => plugin.pairStart({ peer }),
    pairRespond: (pairId: string, accept: boolean) => plugin.pairRespond({ pairId, accept }),
    pairCancel: async (pairId?: string) => {
      await plugin.pairCancel({ ...(pairId === undefined ? {} : { pairId }) })
    },
    adoptPairedCode: async (configId: string, deviceId: string) => {
      const result = await plugin.adoptPairedCode({ configId, deviceId })
      // 原生侧允许回 boolean 或 {adopted}：两种写法都接受，免得一边改了另一边炸
      if (typeof result === 'boolean') return result
      return result?.adopted === true
    },
  }
}

/* ------------------------------------------------------------------ *
 * 下行事件
 * ------------------------------------------------------------------ */

/**
 * 订阅一个原生事件，返回退订函数（与桌面端 `onLanSyncInbox` 同形状）。
 *
 * Capacitor 的 `addListener` 是 Promise，但 React effect 必须**同步**拿到退订函数，
 * 所以这里先返回一个「等 Promise 落地再 remove」的闭包：订阅还没建好就被退订时，
 * 落地后会立刻摘掉，不会泄漏监听器。
 */
function subscribeNative(name: string, cb: (data: unknown) => void): () => void {
  const plugin = lanSyncNativePlugin()
  if (!plugin) return () => {}
  let disposed = false
  let handle: { remove: () => Promise<void> } | null = null
  void plugin
    .addListener(name, (data) => {
      if (!disposed) cb(data)
    })
    .then((created) => {
      if (disposed) void created.remove()
      else handle = created
    })
    .catch((err) => {
      console.warn(`[LanSync] 订阅 ${name} 失败:`, err)
    })
  return () => {
    disposed = true
    void handle?.remove()
    handle = null
  }
}

/** 对端 PUT 进来的快照（原生侧已按设备去重，这里只归一成数组） */
export function onMobileLanInbox(cb: (snapshots: SyncSnapshot[]) => void): () => void {
  return subscribeNative('inbox', (payload) => {
    // 原生侧固定推 `{ snapshots: [...] }`（Capacitor 不接受裸数组负载）；
    // 仍兼容数组与单份快照，免得跨版本混跑时静默丢事件。
    if (Array.isArray(payload)) {
      cb(payload as SyncSnapshot[])
      return
    }
    if (!payload || typeof payload !== 'object') return
    const wrapped = (payload as { snapshots?: unknown }).snapshots
    if (Array.isArray(wrapped)) {
      cb(wrapped as SyncSnapshot[])
      return
    }
    // 单份快照（有 format/deviceId 才是快照，避免把别的事件当成快照）
    const single = payload as Record<string, unknown>
    if (typeof single.format === 'string' && typeof single.deviceId === 'string') {
      cb([payload as SyncSnapshot])
    }
  })
}

/** 对端发来的配对请求（渲染层弹确认框） */
export function onMobileLanPairRequest(cb: (request: LanPairRequest) => void): () => void {
  return subscribeNative('pairRequest', (payload) => {
    if (!payload || typeof payload !== 'object') return
    const request = payload as LanPairRequest
    if (typeof request.pairId === 'string' && request.pairId) cb(request)
  })
}

/** 配对完成（本机作为应答方）：负载就是共享的 `LanPairPeer` */
export function onMobileLanPaired(cb: (peer: LanPairPeer) => void): () => void {
  return subscribeNative('paired', (payload) => {
    if (!payload || typeof payload !== 'object') return
    const peer = payload as LanPairPeer
    if (typeof peer.deviceId === 'string' && peer.deviceId) cb(peer)
  })
}

/**
 * 配对失败原因是**枚举**，原生侧可能给出本版本不认识的码（跨版本混跑）。
 *
 * 认不出来的一律归 `invalid`：显示端按「对端返回的数据无法识别，请升级」提示，
 * 比把未知码原样塞进 i18n 拼出一个空串要好。
 */
const KNOWN_PAIR_REASONS: ReadonlySet<LanPairFailureReason> = new Set([
  'denied',
  'timeout',
  'unreachable',
  'unsupported',
  'auth',
  'self',
  'busy',
  'invalid',
  'cancelled',
])

export function normalizePairStartResult(raw: unknown): LanPairStartResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'invalid' }
  const result = raw as { ok?: unknown; peer?: unknown; reason?: unknown }
  if (result.ok === true && result.peer && typeof result.peer === 'object') {
    return { ok: true, peer: result.peer as LanPairPeer }
  }
  const reason = typeof result.reason === 'string' ? (result.reason as LanPairFailureReason) : 'invalid'
  return { ok: false, reason: KNOWN_PAIR_REASONS.has(reason) ? reason : 'invalid' }
}

/* ------------------------------------------------------------------ *
 * 同步凭证网关（移动端）
 * ------------------------------------------------------------------ */

/**
 * 移动端的同步凭证存储。
 *
 * 与桌面端 `sync:credential:*` 通道同契约，只是落到原生侧：Keystore 加密的
 * JSON（`configId → { code }`）存在应用私有目录，密钥不可导出。
 * 方法缺失（老包）时如实回报「不可用」，**不假装保存成功** —— 否则用户会以为
 * 配对码存住了，下一次同步才发现连不上。
 */
export function mobileSyncCredentialGateway() {
  const plugin = lanSyncNativePlugin()
  const unavailable = { ok: false, saved: false, encryptionAvailable: false }
  return {
    async saveCredential(configId: string, payload: Record<string, string>): Promise<CredentialResult> {
      if (!plugin || typeof plugin.saveCredential !== 'function') return unavailable
      const result = await plugin.saveCredential({ configId, payload })
      return { ok: result?.ok !== false, saved: result?.saved === true, encryptionAvailable: result?.encryptionAvailable !== false }
    },
    async credentialState(configId: string): Promise<CredentialState> {
      if (!plugin || typeof plugin.credentialState !== 'function') {
        return { saved: false, encryptionAvailable: false }
      }
      const state = await plugin.credentialState({ configId })
      return {
        saved: state?.saved === true,
        encryptionAvailable: state?.encryptionAvailable !== false,
      }
    },
    async clearCredential(configId: string): Promise<CredentialResult> {
      if (!plugin || typeof plugin.clearCredential !== 'function') return unavailable
      const result = await plugin.clearCredential({ configId })
      return { ok: result?.ok !== false, saved: result?.saved === true, encryptionAvailable: result?.encryptionAvailable !== false }
    },
    async getCredential(configId: string): Promise<Readonly<Record<string, string>> | null> {
      if (!plugin || typeof plugin.getCredential !== 'function') return null
      const secrets = await plugin.getCredential({ configId })
      if (!secrets || typeof secrets !== 'object') return null
      return secrets as Record<string, string>
    },
  }
}

/**
 * 移动端设备身份：局域网服务生成并持久化（重启不变，LWW 并列判定要靠它稳定）。
 *
 * 服务没开也能问：`status()` 只读身份、不启动监听。取不到时抛错而不是编一个随机
 * deviceId——随机身份每次启动都变，会让「同一台设备」在对端眼里变成新设备，
 * 合并裁决跟着失真。
 */
export async function mobileDeviceIdentity(): Promise<{ deviceId: string; deviceName: string }> {
  const plugin = lanSyncNativePlugin()
  if (!plugin) throw new Error('lan-sync plugin unavailable')
  const status = await plugin.status()
  const deviceId = typeof status?.deviceId === 'string' ? status.deviceId : ''
  const deviceName = typeof status?.deviceName === 'string' && status.deviceName ? status.deviceName : 'Android'
  if (!deviceId) throw new Error('lan-sync device identity unavailable')
  return { deviceId, deviceName }
}
