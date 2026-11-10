/**
 * `lan-sync` 插件：局域网直连同步（`docs/playlist-sync.md` §7）。
 *
 * 插件本身**只有三个方法，全部委托给主进程桥**（`ctx.lan` / `getLanSyncBridge()`）：
 *
 * - `probe`：本机服务状态 + 广播发现（对端是否在线）；
 * - `pull`：签名 GET 对端快照；
 * - `push`：签名 PUT 本机快照。
 *
 * ## 为什么这里不做任何密码学
 *
 * HMAC 用 `node:crypto`、HTTP 服务用 `node:http`，都在主进程。渲染层拿
 * `crypto.subtle` 需要安全上下文（`app://` 是否被判安全取决于 Chromium 版本与注册参数），
 * 而且那意味着渲染层要长期持有一把「能写对端歌单」的密钥。所以：**密码学与网络在主进程，
 * 这里只搬参数**。配对码来自 `ctx.secrets.code`（凭证网关，见下），不缓存、不打印。
 *
 * ## 非桌面端
 *
 * 没有桥（`ctx.lan` 与注册表里的桥都是 `null`）→ `available()` 为 false（入口隐藏），
 * 真被调到则抛 `sync.error.lanDisabled`。
 */

import { auroraError, encodeErrorInfo, errorDetailOf, parseErrorInfo, stripIpcPrefix } from '../../i18n/errors'
import { getLanSyncBridge } from './registry'
import type {
  LanSyncBridge,
  LanSyncTarget,
  SyncConfig,
  SyncContext,
  SyncFieldDef,
  SyncPlugin,
  SyncProbeResult,
  SyncSnapshot,
} from './types'

/** 默认监听端口（被占用时主进程顺延；发现包里公布真实端口，这里只是首次添加时的预填值） */
const DEFAULT_LAN_PORT = 45871

/** 探测时等广播的时间：够一次 1s 广播周期，又不至于让"测试连接"按钮转太久 */
const DISCOVER_TIMEOUT_MS = 1500

/**
 * 声明式字段。
 *
 * `code` 的 kind 是 `password`：它不是「随便看看」的展示项，而是**能对端写入歌单的
 * 凭据**。`password` 语义意味着它由宿主写入凭证网关（桌面端 `safeStorage` / 移动端
 * 系统钥匙串），**不落 `settings` → 不落 localStorage、不进设置页副标题**；
 * 运行期由 `ctx.secrets.code` 一次性交给插件。
 *
 * 兼容：老版本把配对码写在 `settings.code` 里（明文进 localStorage），那批配置仍然可用
 * ——`codeOf()` 在 secrets 里没有值时才回退读 settings，用户打开设置页重存一次即完成迁移。
 */
const fields: readonly SyncFieldDef[] = [
  {
    key: 'host',
    labelKey: 'sync.lan.hostLabel',
    kind: 'text',
    required: true,
    placeholderKey: 'sync.lan.hostPlaceholder',
  },
  {
    key: 'port',
    labelKey: 'sync.lan.portLabel',
    kind: 'port',
    required: true,
    defaultValue: String(DEFAULT_LAN_PORT),
    hintKey: 'sync.lan.portHint',
  },
  {
    key: 'code',
    labelKey: 'sync.lan.codeLabel',
    kind: 'password',
    required: true,
    placeholderKey: 'sync.lan.codePlaceholder',
    hintKey: 'sync.lan.codeHint',
  },
]

function settingOf(config: SyncConfig, key: string): string {
  const raw = config.settings?.[key]
  if (typeof raw === 'string') return raw.trim()
  if (typeof raw === 'number') return String(raw)
  return ''
}

/**
 * 配对码：优先凭证网关（`ctx.secrets.code`），回退老配置的 `settings.code`。
 *
 * 配对码里允许有空格（用户可能按对端的四段分组抄写），统一去掉并大写。
 * 回退分支只是**兼容层**：新配置的 `code` 字段是 `password` 类型，宿主不会把它写进
 * `settings`，所以回退命中的一定是升级前的老配置。
 */
function codeOf(config: SyncConfig, ctx: SyncContext): string {
  const secret = typeof ctx.secrets?.code === 'string' ? ctx.secrets.code : ''
  const raw = secret.trim() ? secret : settingOf(config, 'code')
  return raw.replace(/\s+/g, '').toUpperCase()
}

/** 取局域网桥：`ctx.lan` 优先（宿主按次注入），其次注册表里的全局桥 */
function bridgeOf(ctx: SyncContext): LanSyncBridge | null {
  return ctx.lan ?? getLanSyncBridge()
}

function requireBridge(ctx: SyncContext): LanSyncBridge {
  const bridge = bridgeOf(ctx)
  if (!bridge) throw auroraError('sync.error.lanDisabled')
  return bridge
}

/**
 * 配置 → `LanSyncTarget`。
 *
 * 端口非法时按「连不上这台设备」报错（文案里会带 `host:port`）：用户改的就是这两个字段，
 * 再为它造一条新错误键只会让字典越来越难对齐。
 */
function targetOf(config: SyncConfig, ctx: SyncContext): LanSyncTarget {
  const host = settingOf(config, 'host')
  const rawPort = settingOf(config, 'port')
  const port = rawPort ? Number(rawPort) : DEFAULT_LAN_PORT
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw auroraError('sync.error.lanUnreachable', { host, port: rawPort || String(port) })
  }
  const code = codeOf(config, ctx)
  const peerDeviceId = settingOf(config, 'peerDeviceId')
  return { host, port, code, ...(peerDeviceId ? { peerDeviceId } : {}) }
}

/**
 * 桥的错误 → 直接抛出去。
 *
 * 桥在主进程，跨 IPC 的错误只剩 message（结构化载荷被编码在里面，且可能被 Electron
 * 拼上 `Error invoking remote method …` 前缀）。**原样透传**：显示端 `translateError`
 * 认得这个载荷，能按当前语言渲染；在这里包一层中文就把语言绑死了，也丢掉对端给的
 * `auth` / `protocol` 细分码。
 */
function bridgeErrorOf(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err ?? '')
  if (parseErrorInfo(stripIpcPrefix(message))) {
    return err instanceof Error ? err : new Error(message)
  }
  // 非结构化的失败（桥自己崩了、参数序列化失败等）：仍走结构化错误，别把英文栈糊到界面上
  const detail = errorDetailOf(err)
  return auroraError('sync.error.unknown', { reason: detail }, detail)
}

async function probe(config: SyncConfig, ctx: SyncContext): Promise<SyncProbeResult> {
  const bridge = requireBridge(ctx)
  try {
    const status = await bridge.status()
    const target = targetOf(config, ctx)
    // 对端地址填了就顺手看一眼广播：发现不到不代表失败（防火墙常挡 UDP），
    // 只把结果放进 detail 供 UI 提示，不作为 ok 的判据
    const peers = target.host ? await bridge.discover(DISCOVER_TIMEOUT_MS) : []
    return {
      ok: true,
      message: encodeErrorInfo({ code: 'sync.card.testOk' }),
      detail: JSON.stringify({ running: status.running, port: status.port, peers: peers.length }),
    }
  } catch (err) {
    return { ok: false, message: bridgeErrorOf(err).message }
  }
}

async function pull(config: SyncConfig, ctx: SyncContext): Promise<SyncSnapshot[]> {
  const bridge = requireBridge(ctx)
  try {
    return await bridge.pullPeer(targetOf(config, ctx))
  } catch (err) {
    throw bridgeErrorOf(err)
  }
}

async function push(config: SyncConfig, snapshot: SyncSnapshot, ctx: SyncContext): Promise<void> {
  const bridge = requireBridge(ctx)
  try {
    // 写入内容就是引擎算好的那份快照：插件不合并
    await bridge.pushPeer(targetOf(config, ctx), snapshot)
  } catch (err) {
    throw bridgeErrorOf(err)
  }
}

export const lanSyncPlugin: SyncPlugin = {
  id: 'lan-sync',
  displayNameKey: 'sync.plugin.lan.name',
  descriptionKey: 'sync.plugin.lan.description',
  version: '1.0.0',
  fields,
  // 非桌面端没有桥 → 入口隐藏；这是"缺依赖"而不是"配置错"
  available: () => getLanSyncBridge() !== null,
  probe,
  pull,
  push,
}
