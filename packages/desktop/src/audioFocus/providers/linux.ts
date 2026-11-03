import { Message, sessionBus } from 'dbus-next'
import type { AudioFocusProvider, ExternalPlayer, ExternalPlaybackStatus } from '../types'

/**
 * Linux 音频焦点 provider：MPRIS over D-Bus（session bus）。
 *
 * 上层只认三件事：列出外部播放器、把某个暂停、把某个恢复。这里把它们翻译成 D-Bus 调用：
 *   - 列举：org.freedesktop.DBus.ListNames → 筛 `org.mpris.MediaPlayer2.*` → 逐个读属性
 *   - 暂停/恢复：`/org/mpris/MediaPlayer2` 上 `org.mpris.MediaPlayer2.Player` 的 Pause()/Play()
 *
 * ## 几个不能省的细节（都是实测踩出来的）
 * 1. **dbus-next 0.9.2 的 MessageBus 没有 listNames()**：列举名字必须自己拿
 *    `org.freedesktop.DBus` 的代理对象再调 `ListNames()`。
 * 2. **必须挂 `bus.on('error')`**：连接异常时 dbus-next 会 `emit('error')`，
 *    没有监听者 Node 会直接把进程崩掉（Electron 主进程一起没）。这个监听器同时
 *    充当「连接已死」的信号：丢掉 bus，下一次调用重新连。
 * 3. **必须自己做超时**：dbus-next 的方法调用没有超时参数，对端不回复（播放器卡死、
 *    bus name 刚消失但代理还没失效）时 promise 永远不 settle。轮询是 1s 一拍，
 *    不设上限会让挂起的调用越积越多。
 * 4. **单个播放器失败不能拖垮整次列举**：`Promise.allSettled` 逐个兜住。读不到
 *    PlaybackStatus 的那个直接跳过（它无法参与仲裁）；Identity 读不到则回落成 bus name。
 * 5. **不用信号订阅**：轮询 + 每次重读属性最简单，也避开 dbus-next 里 `_addMatch`
 *    这类私有 API（本仓库约定不碰下划线 API，本方案也不需要）。
 * 6. **构造不连 D-Bus**：providers/index.ts 在启动时就 new 出 provider，而那时用户
 *    可能根本没开这个功能，连接一律推迟到第一次 `list()`/`pause()`/`play()`。
 */

/** MPRIS 播放器的 bus name 前缀（只认这个前缀，避免对任意服务发方法调用） */
const MPRIS_NAME_PATTERN = /^org\.mpris\.MediaPlayer2\./
/** MPRIS 播放器对象的固定路径 */
const MPRIS_ROOT_PATH = '/org/mpris/MediaPlayer2'
const MPRIS_PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player'
const MPRIS_ROOT_INTERFACE = 'org.mpris.MediaPlayer2'
const PROPERTIES_INTERFACE = 'org.freedesktop.DBus.Properties'
const DBUS_SERVICE = 'org.freedesktop.DBus'
const DBUS_PATH = '/org/freedesktop/DBus'
/** 本应用自己的 MPRIS 名（见 mpris.ts 的 `Player({ name: 'aurora-music' })`） */
const DEFAULT_SELF_NAME = 'org.mpris.MediaPlayer2.aurora-music'
/** 兜底排除标记：本应用的名字里一定含 aurora，改 name 也不会漏排除 */
const SELF_NAME_MARKER = 'aurora'
/** 单次 D-Bus 调用超时：轮询 1s 一拍，单次调用必须远小于它 */
const DEFAULT_CALL_TIMEOUT_MS = 500
/** 建议轮询间隔：Linux 上每次列举是一串廉价的方法调用 */
const POLLING_INTERVAL_MS = 1000

/**
 * dbus-next `MessageBus` 里本 provider 用到的那一小部分。
 *
 * 单独抽出来是为了可测：单测注入假 bus 时只需实现这四个成员，不必伪造整个 MessageBus
 * （真实 `MessageBus` 结构上满足它，见 `defaultBusFactory`）。
 */
export interface LinuxBusLike {
  getProxyObject(name: string, path: string): Promise<LinuxProxyObjectLike>
  call(message: unknown): Promise<{ body?: unknown[] } | null>
  on(event: 'error', listener: (error: unknown) => void): unknown
  disconnect(): void
}

export interface LinuxProxyObjectLike {
  getInterface(name: string): LinuxClientInterfaceLike
}

/**
 * 代理接口的形状：dbus-next 按内省 XML 动态挂方法名，所以只能用索引签名描述。
 * `any` 是这一层与第三方库交界处的最小让步（调用点仍会自行判断 typeof）。
 */
export interface LinuxClientInterfaceLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [member: string]: any
}

export interface LinuxAudioFocusOptions {
  /** 追加要排除的自身 bus name（默认已排除 org.mpris.MediaPlayer2.aurora-music） */
  selfNames?: readonly string[]
  /**
   * 追加要排除的自身进程 PID（默认已含 `process.pid`）。
   *
   * 只按名字排除是不够的：Chromium/Electron 在启用媒体会话时会把页面里的播放
   * 暴露成 `org.mpris.MediaPlayer2.chromium.instance<pid>` 这类名字，里面没有
   * 品牌名，名字规则抓不到。若把它当成「外部播放器」，本应用一起播就会被自己
   * 抢占/让位，表现为刚播放就自动暂停（自激）。这里用总线上的 PID 归属兜住。
   */
  selfPids?: readonly number[]
  /** 注入 bus 工厂（单测用）；默认 dbus-next 的 `sessionBus()` */
  busFactory?: () => LinuxBusLike
  /** 单次 D-Bus 调用超时（毫秒），默认 500 */
  callTimeoutMs?: number
}

/**
 * 读属性时用的最小接口：正常走代理上的 `org.freedesktop.DBus.Properties`，
 * 内省里没列这个标准接口时退回原始方法调用（两条路都是同一个 Properties.Get）。
 */
interface PropertiesReader {
  get(iface: string, property: string): Promise<unknown>
}

/** dbus-next 的 `sessionBus()` 返回真实的 MessageBus；结构上满足 LinuxBusLike */
function defaultBusFactory(): LinuxBusLike {
  return sessionBus() as unknown as LinuxBusLike
}

/** 把 `Properties.Get` 的返回值（dbus-next 解出来的 Variant）还原成裸值 */
function unwrapVariant(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in value) {
    return (value as { value: unknown }).value
  }
  return value
}

/** PlaybackStatus 只认 MPRIS 规定的三个取值，其余按 Stopped（见下方说明） */
function toPlaybackStatus(value: unknown): ExternalPlaybackStatus {
  if (value === 'Playing' || value === 'Paused' || value === 'Stopped') return value
  // 脏数据（或对端返回空）一律当 Stopped：宁可漏一次「别人在出声」，
  // 也不要把「读不懂的状态」当成 Playing 而让自己反复让位。
  return 'Stopped'
}

/** Identity 缺失/类型不对时回落成 bus name，label 只用于日志与提示 */
function toLabel(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback
}

class LinuxAudioFocusProvider implements AudioFocusProvider {
  readonly kind = 'linux'
  readonly pollingIntervalMs = POLLING_INTERVAL_MS

  /** 当前连接；null 表示未连接（懒连接，出错/释放后置空，下一次调用重建） */
  private bus: LinuxBusLike | null = null
  private readonly busFactory: () => LinuxBusLike
  private readonly callTimeoutMs: number
  private readonly selfNames: Set<string>
  private readonly selfPids: Set<number>

  constructor(options: LinuxAudioFocusOptions = {}) {
    this.busFactory = options.busFactory ?? defaultBusFactory
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    this.selfNames = new Set(
      [DEFAULT_SELF_NAME, ...(options.selfNames ?? [])].map((name) => name.toLowerCase()),
    )
    // 显式传入时以传入值为准（单测/诊断用），默认只排除本进程
    this.selfPids = new Set(options.selfPids ?? [process.pid])
  }

  async list(): Promise<ExternalPlayer[]> {
    const names = await this.listMprisNames()
    if (names.length === 0) return []

    // 每个播放器独立兜底：任何一个卡住/抛错都只影响它自己
    const settled = await Promise.allSettled(names.map((name) => this.readPlayer(name)))
    const players: ExternalPlayer[] = []
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) players.push(result.value)
    }
    return players
  }

  async pause(id: string): Promise<void> {
    await this.invokePlayerMethod(id, 'Pause')
  }

  async play(id: string): Promise<void> {
    await this.invokePlayerMethod(id, 'Play')
  }

  async dispose(): Promise<void> {
    // 幂等：没有连接时是空操作；重复调用不会二次 disconnect
    this.dropBus()
  }

  /**
   * 列出本应用之外的 MPRIS bus name。
   *
   * 失败重试一次：轮询期间 bus 可能刚被对端关掉（比如用户在终端里重启了 pipewire-pulse
   * 之外的会话组件），丢掉旧连接重建一次就能继续，不必等下一拍。
   */
  private async listMprisNames(): Promise<string[]> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const bus = this.ensureBus()
      if (!bus) return []
      try {
        const dbusObject = await this.callWithTimeout(() =>
          bus.getProxyObject(DBUS_SERVICE, DBUS_PATH),
        )
        const dbusInterface = dbusObject.getInterface(DBUS_SERVICE)
        const reply = await this.callWithTimeout(() => dbusInterface.ListNames())
        if (!Array.isArray(reply)) return []

        const names: string[] = []
        for (const raw of reply) {
          if (typeof raw !== 'string' || !MPRIS_NAME_PATTERN.test(raw)) continue
          if (this.isSelf(raw)) continue
          // 名字规则之外的兜底：总线上这个 name 的持有者是不是我们自己（见 selfPids 注释）
          if (await this.isOwnedBySelf(dbusInterface, raw)) continue
          names.push(raw)
        }
        return names
      } catch {
        // 这一轮没问出名单：丢掉连接，下一轮重连（第二次失败就交给下一拍轮询）
        this.dropBus()
      }
    }
    return []
  }

  /**
   * 这个 bus name 的持有者是不是我们自己。
   *
   * 只按名字排除会漏：Chromium/Electron 启用媒体会话时会把页面播放暴露成
   * `org.mpris.MediaPlayer2.chromium.instance<pid>`（名字里没有品牌名）。若被当成
   * 外部播放器，本应用一起播就会被自己抢占 → 刚出声就自动暂停的自激。
   * 查不到 PID（老 D-Bus / 对端已退出 / 方法不可用）时**保留**该播放器：
   * 漏排的自己只是理论风险，误排真实播放器会让功能整块失效，两者代价不对等。
   */
  private async isOwnedBySelf(dbusInterface: LinuxClientInterfaceLike, name: string): Promise<boolean> {
    try {
      const getPid = dbusInterface.GetConnectionUnixProcessID
      if (typeof getPid !== 'function') return false
      const pid = await this.callWithTimeout(() => getPid.call(dbusInterface, name))
      return typeof pid === 'number' && this.selfPids.has(pid)
    } catch {
      return false
    }
  }

  /** 读一个播放器的状态与名字；读不到 PlaybackStatus 就跳过（无法参与仲裁） */
  private async readPlayer(id: string): Promise<ExternalPlayer | null> {
    const bus = this.ensureBus()
    if (!bus) return null

    const proxy = await this.callWithTimeout(() => bus.getProxyObject(id, MPRIS_ROOT_PATH))
    const properties = this.createPropertiesReader(bus, proxy, id)

    const [statusResult, identityResult] = await Promise.allSettled([
      this.callWithTimeout(() => properties.get(MPRIS_PLAYER_INTERFACE, 'PlaybackStatus')),
      this.callWithTimeout(() => properties.get(MPRIS_ROOT_INTERFACE, 'Identity')),
    ])

    if (statusResult.status !== 'fulfilled') return null
    return {
      id,
      label:
        identityResult.status === 'fulfilled'
          ? toLabel(unwrapVariant(identityResult.value), id)
          : id,
      status: toPlaybackStatus(unwrapVariant(statusResult.value)),
    }
  }

  /**
   * 属性读取器：优先用代理上的 `org.freedesktop.DBus.Properties`。
   *
   * 有些实现的 Introspect 不列出标准接口（MPRIS 只要求列出 Player 等业务接口），
   * 这时 `getInterface` 会抛错；退回直接构造 Properties.Get 消息，语义完全一致，
   * 也避免「因为内省不全，整个功能静默失效」。
   */
  private createPropertiesReader(
    bus: LinuxBusLike,
    proxy: LinuxProxyObjectLike,
    destination: string,
  ): PropertiesReader {
    try {
      const propertiesInterface = proxy.getInterface(PROPERTIES_INTERFACE)
      if (typeof propertiesInterface.Get === 'function') {
        return {
          get: (iface, property) =>
            Promise.resolve(propertiesInterface.Get(iface, property)) as Promise<unknown>,
        }
      }
    } catch {
      // 见方法注释：走下面的原始调用
    }
    return {
      get: (iface, property) => this.rawPropertyGet(bus, destination, iface, property),
    }
  }

  /** 不依赖内省的 `Properties.Get`：直接发方法调用 */
  private async rawPropertyGet(
    bus: LinuxBusLike,
    destination: string,
    iface: string,
    property: string,
  ): Promise<unknown> {
    const reply = await this.callWithTimeout(() =>
      bus.call(
        new Message({
          destination,
          path: MPRIS_ROOT_PATH,
          interface: PROPERTIES_INTERFACE,
          member: 'Get',
          signature: 'ss',
          body: [iface, property],
        }),
      ),
    )
    return reply?.body?.[0]
  }

  /**
   * 调 Pause()/Play()。契约要求 provider 绝不向调用方抛错：这里把所有异常吞掉，
   * 结论只是「这一拍没控住」，下一拍轮询会再试（目标已退出/已暂停也算静默成功）。
   */
  private async invokePlayerMethod(id: string, member: 'Pause' | 'Play'): Promise<void> {
    try {
      // 只对本应用之外的 MPRIS 名字发调用：id 来自 list()，这里的校验防的是
      // 上层传进任意 bus name（比如把用户配置里的字符串直接透传下来）
      if (typeof id !== 'string' || !MPRIS_NAME_PATTERN.test(id)) return

      const bus = this.ensureBus()
      if (!bus) return

      const proxy = await this.callWithTimeout(() => bus.getProxyObject(id, MPRIS_ROOT_PATH))

      let callable: (() => unknown) | null = null
      try {
        const playerInterface = proxy.getInterface(MPRIS_PLAYER_INTERFACE)
        const candidate = playerInterface[member]
        if (typeof candidate === 'function') callable = () => candidate.call(playerInterface)
      } catch {
        // 内省里没有 Player 接口：退回原始方法调用（见下）
      }

      const invoke = callable
      if (invoke) {
        await this.callWithTimeout(() => invoke())
      } else {
        await this.rawPlayerMethodCall(bus, id, member)
      }
    } catch {
      // 契约：不向调用方抛错。失败只意味着这一拍没控住
    }
  }

  /** 不依赖内省的 Pause()/Play() 调用（内省缺失/损坏时仍能控制播放器） */
  private async rawPlayerMethodCall(
    bus: LinuxBusLike,
    destination: string,
    member: 'Pause' | 'Play',
  ): Promise<void> {
    await this.callWithTimeout(() =>
      bus.call(
        new Message({
          destination,
          path: MPRIS_ROOT_PATH,
          interface: MPRIS_PLAYER_INTERFACE,
          member,
          signature: '',
          body: [],
        }),
      ),
    )
  }

  /** 取（必要时建立）session bus 连接；连不上返回 null，绝不抛错 */
  private ensureBus(): LinuxBusLike | null {
    if (this.bus) return this.bus

    let bus: LinuxBusLike
    try {
      bus = this.busFactory()
    } catch {
      // 没有图形会话 / DBUS_SESSION_BUS_ADDRESS 缺失时 dbus-next 会同步抛错
      return null
    }
    if (!bus) return null

    // 兜底监听：dbus-next 在连接异常时会 emit('error')，没人监听会让 Node 直接崩。
    // 顺便当作「连接已死」的信号，下一次调用会重新连接。
    try {
      bus.on('error', () => {
        // 只在它还是当前连接时释放：避免把已经换掉的新连接误断
        if (this.bus !== bus) return
        this.dropBus()
      })
    } catch {
      // 非 EventEmitter 的注入实现：忽略，不影响主流程
    }

    this.bus = bus
    return bus
  }

  /** 丢掉当前连接（幂等）；disconnect 本身失败也吞掉 */
  private dropBus(): void {
    const bus = this.bus
    this.bus = null
    if (!bus) return
    try {
      bus.disconnect()
    } catch {
      // 已断开的连接再断一次可能抛错，这里只是尽力释放
    }
  }

  /**
   * 给单次 D-Bus 调用套超时。
   *
   * 两个易错点：
   * - 超时后原 promise 可能仍会 settle（对端晚回）：必须挂上 then 的处理函数，
   *   否则迟到的 rejection 会变成 unhandledRejection 把进程带崩；
   * - 计时器 unref：不能让一个挂起的超时把进程/事件循环吊住（单测与 Electron 退出都会踩）。
   */
  private callWithTimeout<T>(call: () => Promise<T> | T): Promise<T> {
    const timeoutMs = this.callTimeoutMs
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        // 英文文案：这条只进主进程日志/异常链，且 scripts/check-i18n.mjs 会把
        // 字符串字面量里的中文当成「未国际化的界面文案」拦下
        reject(new Error(`D-Bus call timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()

      let pending: Promise<T>
      try {
        pending = Promise.resolve(call())
      } catch (error) {
        clearTimeout(timer)
        reject(error)
        return
      }

      pending.then(
        (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  /** 是不是本应用自己（默认名 + options.selfNames 精确匹配；含 aurora 的一律排除） */
  private isSelf(name: string): boolean {
    const normalized = name.toLowerCase()
    if (this.selfNames.has(normalized)) return true
    return normalized.includes(SELF_NAME_MARKER)
  }
}

/**
 * 构造 Linux 音频焦点 provider。
 *
 * 无副作用：构造时不连 D-Bus（见文件头第 6 条），第一次 list()/pause()/play() 才连。
 * 所有失败路径都以「空列举 / 静默成功」收场，不向调用方抛错。
 */
export function createLinuxProvider(options: LinuxAudioFocusOptions = {}): AudioFocusProvider {
  return new LinuxAudioFocusProvider(options)
}
