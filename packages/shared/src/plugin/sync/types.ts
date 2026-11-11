/**
 * 歌单同步插件契约（shared 层，双端共用）。
 *
 * ## 为什么是插件
 *
 * 仓库的判据（`docs/plugin-system.md`）：凡「从谁的服务器拿数据 / 换地址」→ 插件；
 * 不联网只碰本地数据与播放器状态 → 基础能力。歌单同步横跨这条线，所以按职责切开：
 *
 * - **基础能力**（`packages/app`）：歌单模型、合并语义、曲目身份再匹配、调度、冲突提示、UI。
 *   这些与「用哪条链路」毫无关系，换 S3 / 换 FTP / 换自建服务都不该动。
 * - **插件**（本目录）：把快照字节搬进搬出——协议、鉴权、错误映射。
 *
 * 与存储插件（`../storage/types.ts`）是同一套设计语言，三处刻意保持一致：
 * 声明式 `fields`（UI 通用渲染，加协议不加 UI 分支）、`available()`（缺依赖时隐藏入口）、
 * **能力由方法存在性派生**（一份实现只允许有一种说法，不设第二份真源的 `capabilities`）。
 *
 * ## 与存储插件的两处刻意差异
 *
 * 1. **没有 `openRange`/`openStream` 那样的流式能力**：同步只搬一份 JSON 快照，
 *    不需要区间读。多造一个能力就多一套失败模式。
 * 2. **方向是一等公民**：`pull`（取对端）与 `push`（写对端）可以只实现一个
 *    （`pullOnly` 的只读分享机只实现 `pull`），能力派生会如实反映。
 *
 * ## 快照是**全量**的
 *
 * 几十个歌单、几千条曲目引用，序列化后几十 KB；增量同步要为「顺位 / 补偿 / 乱序到达」
 * 再写一套状态机，收益为零而失败模式多一倍。理由与冲突语义见 `docs/playlist-sync.md`。
 */

import type { MessageKey } from '../../i18n'

/* ------------------------------------------------------------------ *
 * 声明式字段（与 `StorageFieldDef` 同构）
 * ------------------------------------------------------------------ */

/**
 * 字段控件的类型。UI 据此选控件，**不需要知道是哪个插件**：
 * - `text`    普通单行输入
 * - `password` 口令：输入框掩码，值**不进**渲染层持久化，走主进程 safeStorage
 * - `url`     地址（带格式校验与样例提示）
 * - `path`    远端路径（相对根目录，允许空 = 根目录本身）
 */
export type SyncFieldKind = 'text' | 'password' | 'url' | 'path' | 'port'

/**
 * 一个配置字段的**声明**（纯数据、不含函数，可直接过 IPC）。
 *
 * `key` 同时是 `SyncConfig.settings` 里的键：UI 按 key 写，插件按 key 读。
 * `kind: 'password'` 的键在保存前由调用方**剥出**，不会出现在 `settings` 里。
 */
export interface SyncFieldDef {
  readonly key: string
  readonly labelKey: MessageKey
  readonly kind: SyncFieldKind
  /** 必填（缺失时 UI 不得提交） */
  readonly required?: boolean
  readonly placeholderKey?: MessageKey
  readonly hintKey?: MessageKey
  /** 默认值（首次添加配置时预填，如局域网端口 45871） */
  readonly defaultValue?: string
}

/* ------------------------------------------------------------------ *
 * 快照：跨设备唯一可比较的载体
 * ------------------------------------------------------------------ */

/**
 * 快照格式标识。`aurora-playlist-sync/<major>`：major 不同即拒绝（宁可报「版本不支持」，
 * 也不能把结构不明的 JSON 当成歌单灌进用户数据）。
 */
export const SYNC_SNAPSHOT_FORMAT = 'aurora-playlist-sync/1'

/** 局域网协议版本（发现包与 HTTP 头都带；与快照格式版本分开演进） */
export const SYNC_LAN_PROTOCOL_VERSION = 1

/** 曲目元数据：三条解析路径都要带上，用于「本机找不到」时的兜底匹配与占位显示 */
export interface SyncTrackMeta {
  readonly title: string
  readonly artist: string
  readonly album: string
  /** 秒；0 表示未知（未知**不参与**时长比对，见 `trackIdentity.ts` 的「缺证据≠相符」） */
  readonly duration: number
}

/**
 * 快照里的曲目引用。
 *
 * ## 为什么不能直接搬 `trackId` / `sourceId`
 *
 * - `trackId` 由 `uuidv4()` 生成（`packages/desktop/src/ipc/scanner.ts`），**设备相关**：
 *   同一份文件在两台机器上是两个 id。
 * - `sourceId` 是**设备本地**的音源/存储配置 id，换台机器就是另一个值。
 * - 绝对路径同理（盘符、用户名、挂载点都可能不同）。
 *
 * 所以快照里存的是「怎么把这首歌在本机再找回来」，解析顺序见 `trackRef.ts`。
 *
 * - `local`   本机绝对路径。跨设备时只作为**线索**（第 1 档：路径精确命中）；
 *             真正的主力是后面的元数据匹配。
 * - `storage` 存储库相对路径 + 插件 id（`webdav` / `sftp` / `smb`）。换设备后
 *             「同插件的相对路径」是最可靠的同一份文件判据。
 * - `meta`    只有元数据 + 可选的在线身份。来自歌单导入登记的在线曲目，
 *             或对端也没有文件只能靠元数据认领的情况。
 */
export type SyncTrackRef = SyncTrackMeta &
  (
    | { readonly kind: 'local'; readonly path: string }
    | { readonly kind: 'storage'; readonly pluginId: string; readonly relPath: string }
    | {
        readonly kind: 'meta'
        /** 在线曲目身份（如 QQ 的 songmid）；跨源不可比，仅在同一 platform 内使用 */
        readonly onlineId?: string
        /** 音源平台标记（`qq` / `netease` / …），与 `OnlineTrackSearchResult.source` 同口径 */
        readonly platform?: string
        readonly coverUrl?: string
      }
  )

/** 快照里的歌单：与 `Playlist` 同形，但成员是 `SyncTrackRef` 而不是本机 `trackId` */
export interface SyncedPlaylist {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  /** 变更时间。**合并的唯一裁决依据**（LWW），任何字段改动都必须刷新它 */
  readonly updatedAt: number
  /** 墓碑：有值表示这份歌单在 `updatedAt` 被删除；保留 90 天后清理 */
  readonly deletedAt?: number
  /** 顺序即歌单内顺序（用户手动排序过，不可重排） */
  readonly tracks: readonly SyncTrackRef[]
}

/**
 * 快照里的**一条收藏记录**：与 `SyncedPlaylist` 同构的最小单元——
 * 稳定 id + 变更时刻 + 墓碑 + 曲目引用，只是它只描述「一首歌被收藏/取消收藏」。
 *
 * ## 为什么不能把收藏做成「一条特殊歌单」
 *
 * 收藏集是无序集合，且**每次点赞都是独立的一次编辑**。若把它塞成一个
 * `SyncedPlaylist`（整条按 `updatedAt` 做 LWW），那么「手机上连点 20 首 + 电脑上点了 3 首」
 * 里较晚的那一整份集合会赢，另一端的 20 首**整体消失**——这不是「冲突时丢一侧的改动」，
 * 而是用户毫无预期的大面积丢数据。
 *
 * 所以收藏的冲突单元下沉到**每首歌**：`id` 相同的两条记录按时刻 LWW，
 * `id` 不同的记录互不影响（各自保留）。裁决都在 `merge.ts` 的 `mergeSnapshots` 里：
 * `likeMapOf` 按 `id` 选出每条记录的赢家，`compareLikeCandidates` 定全序
 * （动作时刻 → 同一毫秒判「取消」胜 → 内容串）。没有单独的 `mergeLikes` 函数。
 *
 * ## `id` 是什么
 *
 * 跨设备的「同一首歌」身份，由 `likeKeyOf(ref)` 从元数据派生（归一化歌名 + 歌手 +
 * 四舍五入到整秒的时长，三者**严格相等**），**不含** trackId / 路径 / sourceId
 * （三者都是设备相关的）。所以两台设备对同一首歌点赞/取消会用同一个 id 相遇。
 *
 * 它与 `trackIdentity.ts` 的**展示去重不是同一判据**：展示去重先按「歌名 + 歌手」分桶，
 * 再与桶内代表值比时长做 ±1s **容差聚类**（`DURATION_MATCH_TOLERANCE`，容差不传递）。
 * 两者共用同一套归一化与同样三个字段，差别只在时长判据。同一首歌的两个副本时长相差 ≤1s
 * 但取整后落在相邻两秒时，展示去重会合成 1 行、收藏身份却是 2 条——合并键必须严格相等才
 * 稳定、可逆，容差聚类给不出这样的键，所以两者刻意不共用时长判据。
 */
export interface SyncedLike {
  /** 跨设备歌曲身份（`likeKeyOf` 派生），同时是合并键 */
  readonly id: string
  /** 收藏时刻。与 `removedAt` 取大者才是这次动作的真实时刻（LWW 依据） */
  readonly likedAt: number
  /** 取消收藏时刻（墓碑）：`> likedAt` 表示当前**不**收藏；保留 90 天后清理 */
  readonly removedAt?: number
  /** 曲目引用（定位方式与歌单成员完全相同，见 `SyncTrackRef`） */
  readonly ref: SyncTrackRef
}

export interface SyncSnapshot {
  readonly format: string
  /** 设备身份（不是账号）：由主进程从 `deviceId` 取值，缺失时渲染层生成并持久化 */
  readonly deviceId: string
  /** 设备名，仅用于 UI 展示「来自哪台设备」 */
  readonly deviceName: string
  /** 本机单调计数，只用于日志与诊断，**不参与**合并裁决 */
  readonly revision: number
  readonly updatedAt: number
  readonly playlists: readonly SyncedPlaylist[]
  /**
   * 收藏记录（每条一首歌）。
   *
   * **可选**，且「字段缺失」与「空数组」语义不同：
   * - 缺失 = 对方版本还不认识收藏同步，**没有意见**（不是「对方的收藏是空的」）；
   * - `[]`   = 认识的对方、当前没有任何收藏记录。
   *
   * 合并对两者都按「没有条目」处理，所以升级期间新旧版本混跑不会互相删收藏；
   * 因此格式号仍是 `aurora-playlist-sync/1`，不为这个字段做破坏性升级
   * （升级会让对方那份旧文件整份被拒，连歌单一起停摆）。
   */
  readonly likes?: readonly SyncedLike[]
}

/* ------------------------------------------------------------------ *
 * 配置：用户建的一条同步目标
 * ------------------------------------------------------------------ */

/** 同步方向 */
export type SyncDirection = 'bidirectional' | 'pullOnly' | 'pushOnly'

export interface SyncConfig {
  /** 本机配置 id（凭证按它存，见 `docs/playlist-sync.md` §10） */
  readonly id: string
  /** 插件 id（`webdav-sync` / `lan-sync` / 将来的第三个） */
  readonly pluginId: string
  /** 用户可见的名字，如「坚果云」 */
  readonly name: string
  /** 插件字段的值。`kind:'password'` 的键**不在**这里 */
  readonly settings: Record<string, unknown>
  readonly direction: SyncDirection
  /** 是否参与自动同步（启动后 / 变更后 / 定时）；手动「立即同步」不受它限制 */
  readonly autoSync: boolean
  readonly enabled: boolean
  /** 上次成功同步时间（UI 显示「上次同步：…」） */
  readonly lastSyncAt?: number
  /**
   * 上次失败的结构化载荷（`encodeErrorInfo` 的文本，跨 IPC 安全）。
   * 存载荷而不是文案：重启后界面语言可能已经变了。
   */
  readonly lastError?: string
}

/** 口令字段的值：key 与 `SyncFieldDef.key` 对应（只在内存里活一次调用） */
export type SyncSecrets = Readonly<Record<string, string>>

/* ------------------------------------------------------------------ *
 * 局域网桥（主进程能力，仅桌面端）
 * ------------------------------------------------------------------ */

/** 发现到的对端设备 */
export interface LanPeerInfo {
  readonly deviceId: string
  readonly deviceName: string
  readonly host: string
  readonly port: number
  readonly protocol: number
  readonly lastSeenAt: number
}

/** 本机局域网服务状态 */
export interface LanSyncStatus {
  readonly running: boolean
  readonly port: number | null
  /** 配对码（10 位 Crockford base32）。**只能**给用户看/抄，不进日志、不进广播包 */
  readonly code: string
  readonly deviceId: string
  readonly deviceName: string
}

/**
 * 一次对端操作的参数。
 *
 * **没有**「长期配对密钥」这种东西：配对码本身就是唯一凭据，主进程每次按它派生
 * HMAC 密钥。配对码轮换 = 旧凭据立刻失效，不需要再维护一套密钥协商与失效状态。
 * 代价是每次同步都要把配对码读出来——它由凭证网关保存（`ctx.secrets.code`），
 * **不进 `settings`、不落 localStorage**（见 `lanSyncPlugin.ts` 的 `codeOf()`）。
 */
export interface LanSyncTarget {
  readonly host: string
  readonly port: number
  /** 对端配对码（从对端屏幕抄来）。主进程据此派生 HMAC 密钥；绝不落日志、绝不进广播包 */
  readonly code: string
  /** 已知的对端 deviceId；未知时留空，主进程从响应里学 */
  readonly peerDeviceId?: string
}

/* ------------------------------------------------------------------ *
 * 一键配对（不再手抄配对码）
 * ------------------------------------------------------------------ */

/**
 * 配对失败原因（机器可读）。
 *
 * 显示端按这个码查 i18n 键（`sync.pair.*`），**不做字符串匹配**：主进程/原生侧
 * 只说发生了什么，翻译留给渲染期（重启后界面语言可能已经变了）。
 */
export type LanPairFailureReason =
  /** 对端用户点了「拒绝」 */
  | 'denied'
  /** 等了 `LAN_PAIR_TTL_MS` 仍没有答复 */
  | 'timeout'
  /** 连不上对端（服务未开、防火墙、不在同一网段） */
  | 'unreachable'
  /** 对端版本太老：没有配对路由（404/405） */
  | 'unsupported'
  /** 对端拒绝接收配对凭据 / 解不开（AEAD 失败） */
  | 'auth'
  /** 对端就是本机（同一 deviceId） */
  | 'self'
  /** 对端已有未完成的配对请求 */
  | 'busy'
  /** 对端返回的数据结构不认识 */
  | 'invalid'
  /**
   * 本机用户自己取消了等待（关掉等待框）。
   *
   * 必须与 `denied` 分开：一个是「对端拒绝」，一个是「我不等了」，同一句提示会把
   * 责任指错人。两端宿主遇到取消都回这一个码。
   */
  | 'cancelled'

/** 一台可配对的设备：发现结果（`LanPeerInfo`）去掉时间戳后的形状 */
export interface LanPairPeer {
  readonly deviceId: string
  readonly deviceName: string
  readonly host: string
  readonly port: number
}

/**
 * 对端发来的配对请求（应答方渲染层据此弹确认框）。
 *
 * 只有**应答方**会收到它：发起方调用 `pairStart()` 后一直挂着等结果，
 * 不需要事件（详见 `docs/playlist-sync.md` §16）。
 */
export interface LanPairRequest extends LanPairPeer {
  /** 本次配对的随机 id（128 bit hex）：既是幂等键，也是 AEAD 的附加数据 */
  readonly pairId: string
  /** 过期时刻（毫秒时间戳）；到期后对端不再受理，UI 据此自动收掉弹窗 */
  readonly expiresAt: number
}

/** 发起配对的结果：成功时带回对端，渲染层据此建一条双向同步目标 */
export type LanPairStartResult =
  | { readonly ok: true; readonly peer: LanPairPeer }
  | { readonly ok: false; readonly reason: LanPairFailureReason }

/** 应答配对的结果：`accepted:false` 只表示「按了拒绝」，不代表出错 */
export interface LanPairRespondResult {
  readonly accepted: boolean
}

/**
 * 局域网同步的主进程桥。
 *
 * ## 为什么密码学与网络都在主进程
 *
 * 渲染层拿 `crypto.subtle` 要「安全上下文」（`app://` 定制协议是否被判安全取决于
 * Chromium 版本与注册参数，赌不起），而且要长期持有一个能写对端歌单的密钥。
 * 所以：**HMAC 与 HTTP 都在主进程（`node:crypto` + `node:http`）**，
 * 渲染层只调这几个方法，从不接触密钥材料。
 *
 * 非桌面端没有这个桥（`ctx.lan` 为 `undefined`），`lan-sync` 插件的 `available()`
 * 据此返回 false。
 */
export interface LanSyncBridge {
  /** 本机服务状态；未启动时 `running:false`（UI 用 state 的 code 也能显示配对码） */
  status(): Promise<LanSyncStatus>
  /** 开/关本机服务（开 = 监听端口 + 起 UDP 广播） */
  setEnabled(enabled: boolean): Promise<LanSyncStatus>
  /** 轮换配对码（旧码立即失效） */
  rotateCode(): Promise<LanSyncStatus>
  /** 收广播（`timeoutMs` 内收集，去重后返回） */
  discover(timeoutMs?: number): Promise<LanPeerInfo[]>
  /** 把本机快照交给主进程缓存，供对端 `GET /v1/snapshot` */
  publish(snapshot: SyncSnapshot): Promise<void>
  /** 取走对端 PUT 进来的快照（取走即清空，避免同一份被重复应用） */
  takeInbox(): Promise<SyncSnapshot[]>
  /** 拉对端快照（签名 GET） */
  pullPeer(target: LanSyncTarget): Promise<SyncSnapshot[]>
  /** 推本机快照到对端（签名 PUT） */
  pushPeer(target: LanSyncTarget, snapshot: SyncSnapshot): Promise<void>

  // ── 一键配对（docs/playlist-sync.md §16）────────────────────────
  /**
   * 发起配对：向对端请求 → 等对端用户点「允许」→ 协商出共享密钥 → 换回对端配对码。
   *
   * 一直挂到出结果（成功 / 拒绝 / 超时 / 连不上），长轮询在桥内部完成，
   * 渲染层不需要自己轮询。成功后对端配对码**留在宿主**，用
   * `adoptPairedCode()` 落到配置名下（配对码不进渲染层，见 §10）。
   */
  pairStart(peer: LanPairPeer): Promise<LanPairStartResult>
  /** 应答对端发来的配对请求（弹框的「允许 / 拒绝」两个按钮） */
  pairRespond(pairId: string, accept: boolean): Promise<LanPairRespondResult>
  /** 撤销未完成的配对（发起方关弹窗时调用；幂等，没有匹配项时什么都不做） */
  pairCancel(pairId?: string): Promise<void>
  /**
   * 把刚配对换来的对端配对码写进**这条配置**的凭证槽。
   *
   * 单独一步而不是让 `pairStart` 直接写：配对完成时渲染层才生成 `configId`
   * （配置归 store 管），而配对码从一开始就只该待在宿主里。
   * 返回 false 表示没有可落的码（配对过期/已被取走），调用方提示「请重新配对」。
   */
  adoptPairedCode(configId: string, deviceId: string): Promise<boolean>
}

/* ------------------------------------------------------------------ *
 * 插件契约
 * ------------------------------------------------------------------ */

/** 插件拿到的执行上下文 */
export interface SyncContext {
  /** 走宿主注入的 fetch（能力门禁在宿主侧；不要直接用 `globalThis.fetch`） */
  readonly fetch: typeof globalThis.fetch
  /** 本次配置的明文口令字段（一次调用有效，不要缓存） */
  readonly secrets: SyncSecrets
  /** 本机设备身份（快照里要填） */
  readonly device: { readonly deviceId: string; readonly deviceName: string }
  /** 日志（宿主决定去哪；插件不要直接 console） */
  readonly log?: (message: string, detail?: unknown) => void
  /** 局域网桥；非桌面端为 `undefined` */
  readonly lan?: LanSyncBridge
  readonly signal?: AbortSignal
}

/** 探测结果：`message` 是 `encodeErrorInfo` 的结构化载荷，显示端统一 `translateError` */
export interface SyncProbeResult {
  readonly ok: boolean
  readonly message: string
  /** 附加信息（如「发现 3 个设备」的数字），UI 自由渲染 */
  readonly detail?: string
}

/**
 * 同步插件。
 *
 * 能力由 `syncCapabilitiesOf()` **按方法存在性**派生（`'probe' | 'pull' | 'push'`），
 * 调用方一律 `typeof plugin.pull === 'function'` 判定，**不得**写 `kind === 'xxx'`。
 */
export interface SyncPlugin {
  /** 插件 id：`^[a-z0-9][a-z0-9._-]{0,63}$`（与其它注册表同一正则） */
  readonly id: string
  readonly displayNameKey: MessageKey
  readonly descriptionKey?: MessageKey
  readonly version: string
  /** 声明式字段（UI 通用渲染；空数组 = 无配置项，如「本机备份」类插件） */
  readonly fields: readonly SyncFieldDef[]
  /** 运行期可用性（缺依赖时 false：入口隐藏，已存配置显示「此平台不支持」） */
  available?(): boolean

  /** 连接与权限自检。不实现则视为「无法预检」，不算失败 */
  probe?(config: SyncConfig, ctx: SyncContext): Promise<SyncProbeResult>

  /**
   * 拉取**对端**快照（可以多份：WebDAV 目录里每台设备一个文件）。
   *
   * 必须遵守：
   * - 返回空数组 = 「对端还没有任何快照」（首次同步），**不是错误**；
   * - 不要返回本机 deviceId 的快照（引擎也会兜底过滤，但插件不该制造这份流量）；
   * - 失败一律 `throw auroraError('sync.error.…')`（结构化载荷，别拼中文）。
   */
  pull?(config: SyncConfig, ctx: SyncContext): Promise<SyncSnapshot[]>

  /**
   * 把合并后的本机快照写到对端。
   *
   * 必须遵守：写入内容就是 `snapshot`，**不要**在插件里再合并一次
   * （合并是基础能力的职责，两处各算一遍必然不一致）。
   */
  push?(config: SyncConfig, snapshot: SyncSnapshot, ctx: SyncContext): Promise<void>
}

/** 能力标识（UI 徽章用；**执行判定仍用方法存在性**） */
export type SyncCapability = 'probe' | 'pull' | 'push'

/** 按方法存在性派生能力（唯一真源） */
export function syncCapabilitiesOf(plugin: SyncPlugin): SyncCapability[] {
  const caps: SyncCapability[] = []
  if (typeof plugin.probe === 'function') caps.push('probe')
  if (typeof plugin.pull === 'function') caps.push('pull')
  if (typeof plugin.push === 'function') caps.push('push')
  return caps
}

/** 插件是否可用于当前平台（没有 `available()` 视为可用） */
export function syncPluginAvailable(plugin: SyncPlugin): boolean {
  if (typeof plugin.available !== 'function') return true
  try {
    return plugin.available()
  } catch {
    // 可用性判断自身抛错 → 当作不可用：宁可隐藏入口，也不给一个点进去必崩的入口
    return false
  }
}
