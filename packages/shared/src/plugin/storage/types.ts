/**
 * 存储插件契约（shared 层，双端共用）。
 *
 * ## 与音源插件同构，但解决的是另一类问题
 *
 * 音源插件（`../types.ts` 的 `SourcePlugin`）抽象的是「**在线**搜索 / 取址 / 歌单」——
 * 地址易失、不入库。存储插件抽象的是「**持久媒体库**」：目录列举（PROPFIND 或等价物）、
 * 按区间读字节（扫描期解析元数据）、原样字节流（播放期 Range 透传）、可用性探测。
 *
 * 改造前，这套能力被硬编码在 `webdav.ts` 与 `mediaProvider.ts` 两处，形态判定
 * （`kind === 'webdav'`）散落在设置页、主进程协议处理器、扫描 IPC 里；加第二种协议
 * 得同时改三端。现在只多一个注册表，上层一律按「能力方法是否存在」调用。
 *
 * ## 三条从既有代码里踩出来的强约束
 *
 * 1. **能力缺失用「方法不存在」表达**，调用方用 `typeof plugin.openRange === 'function'`
 *    判定，**不得**写 `kind === 'xxx'`。因此本契约**不设**第二份真源的 `capabilities`
 *    字段：能力清单一律由 `storageCapabilitiesOf()` 按方法存在性派生。
 * 2. **弱能力要能降级**：`openRange`（数值区间）与 `openStream`（原始 `Range` 头透传）
 *    不是一回事——播放器的 seek 会发 `bytes=-N`（尾段）这类非「start-end」形态的请求，
 *    数值区间顶替不了。只实现其中之一也必须可用，故两者都是可选的。
 * 3. **错误判据不许依赖具体错误类**：上层过去写 `err instanceof WebdavError`，
 *    插件化后原型链判据等于又一处形态判断。改用 `./errors.ts` 的
 *    `storageErrorStatus()` / `isStorageTransportError()` 做结构判定。
 *
 * ## 文本
 *
 * 本层不烧中文：展示名 / 字段标签一律给文案键（`MessageKey`），失败结论走
 * `encodeErrorInfo` 的结构化信封，显示端在渲染期按语言取。
 */

import type { MessageKey } from '../../i18n'
import type { LibrarySourceConfig, RemoteEntry, WalkOptions } from '../../webdav'

/**
 * 声明式字段的类型。UI 据此选控件，**不需要知道是哪个协议**：
 * - `text`     普通单行输入
 * - `password` 口令（输入框掩码；落盘与展示策略由平台层负责）
 * - `url`      地址（带地址格式校验与「服务地址」样例提示）
 * - `path`     远端路径（相对根目录，允许空 = 根目录本身）
 */
export type StorageFieldKind = 'text' | 'password' | 'url' | 'path'

/**
 * 一个配置字段的**声明**（纯数据，不含值、不含函数，可直接过 IPC）。
 *
 * `key` 同时是 `LibrarySourceConfig.settings` 里的键：UI 把用户输入按 key 写进
 * `settings`，插件按 key 读回来。**旧配置兼容**：老形态把字段摊平在配置顶层
 * （webdav 的 baseUrl / rootPath / username / password），读取时统一走
 * `storageFieldValue()`（settings 优先、顶层同名字段兜底），所以本轮不需要任何数据迁移。
 */
export interface StorageFieldDef {
  /** settings 里的键；同时是老配置顶层同名字段的键 */
  readonly key: string
  /** 字段标签文案键 */
  readonly labelKey: MessageKey
  readonly kind: StorageFieldKind
  /** 是否必填（如 webdav 的服务地址）。缺失时 UI 不得提交 */
  readonly required?: boolean
  /** 输入框占位文案键 */
  readonly placeholderKey?: MessageKey
  /** 字段说明文案键（长说明放这里，别塞进 label） */
  readonly hintKey?: MessageKey
}

/**
 * 来源可用性探测结果（设置页「测试连接」）。
 *
 * `message` 的形态：**结构化信封**（`AURORA_ERR:{code,params}`，成功的结论也走它）
 * 或平台侧自由文本；显示端统一 `translateError(message, t)` 渲染。
 * 成功与失败共用一种载体，调用方不必分支。
 */
export interface StorageProbeResult {
  ok: boolean
  /** 结论文案（结构化信封或自由文本，见上） */
  message: string
  /** 根目录下的示例文件名（插件能给才给） */
  sample?: string[]
}

/**
 * 一个存储协议插件。
 *
 * 所有能力方法都是**可选**的：不存在即表示不支持，调用方据此降级
 * （隐藏入口 / 空态 / 回落其它路径），而不是抛错、也不需要形态判断。
 */
export interface StoragePlugin {
  /** 插件唯一 id。必须匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`（同音源插件） */
  readonly id: string
  /** UI 展示名：**文案键**，渲染期 `t()` 取值 */
  readonly displayNameKey: MessageKey
  /** 一句话说明（文案键），用于设置页副标题 */
  readonly descriptionKey?: MessageKey
  /** 插件自身版本（与 App 版本无关） */
  readonly version: string
  /** 声明式字段清单：UI 通用渲染，插件不发一行业务表单代码 */
  readonly fields: readonly StorageFieldDef[]

  // ─── 能力（可选，缺失 = 不支持） ───────────────────────────────

  /** 递归列举来源中的全部音频文件（路径相对来源根目录） */
  listAudio?(config: LibrarySourceConfig, options?: WalkOptions): Promise<RemoteEntry[]>

  /**
   * 读取某个文件的一段字节（数值区间）。
   * 服务器不支持 Range 时可能返回整文件（status 200），调用方需按 status 判断。
   */
  openRange?(
    config: LibrarySourceConfig,
    relPath: string,
    start: number,
    end: number
  ): Promise<Response>

  /**
   * 原始字节流代理：`Range` 头**原样透传**（含 `bytes=-N` 这类尾段形态），
   * 响应（含 206 与 `Content-Range`）原样交给调用方。
   *
   * ## 调用方的责任边界（只此一条，别在两处各写一套）
   *
   * `aurora-remote://` 播放代理**优先走本方法**：请求头里的 `Range` 字符串原样传入，
   * 响应头（`Content-Range` / `Accept-Ranges` / `Content-Length`）原样透出。
   * 只有本方法**不存在**时，才回落到 `openRange` —— 回落时必须自己把 `Range` 头
   * 解析成数值区间，且只认得 `bytes=<start>-<end>` 形态；`bytes=-N`（尾段请求）
   * 与 `bytes=<start>-`（开区间）在回落路径上**做不到透传**，只能退化成「取到文件尾」
   * 或整文件。此差异是能力缺失的正常降级，不是错误。
   */
  openStream?(
    config: LibrarySourceConfig,
    relPath: string,
    init?: { range?: string }
  ): Promise<Response>

  /** 探测可用性：只列举根目录，不递归、不入库 */
  probe?(config: LibrarySourceConfig): Promise<StorageProbeResult>
}

/**
 * 插件能力标识（由方法存在性派生，**不是**插件自己声明的第二份真源）。
 *
 * 用途只有两个：UI 渲染能力徽章、UI 决定显示哪些入口（如「测试连接」）。
 * 调用前判定仍请用 `typeof plugin.xxx === 'function'`。
 */
export type StoragePluginCapability = 'listAudio' | 'openRange' | 'openStream' | 'probe'

/**
 * 派生出插件实际实现的能力清单。
 *
 * 与音源插件的 `plugin.capabilities` 声明式清单不同，这里**按方法存在性计算**：
 * 一份实现只能有一种说法，避免出现「徽章说有、调用时不存在」的分叉
 * （`plugin/registry.ts` 里 `hasCapability` 的注释已经把这条路标成雷区）。
 */
export function storageCapabilitiesOf(plugin: StoragePlugin): StoragePluginCapability[] {
  const capabilities: StoragePluginCapability[] = []
  if (typeof plugin?.listAudio === 'function') capabilities.push('listAudio')
  if (typeof plugin?.openRange === 'function') capabilities.push('openRange')
  if (typeof plugin?.openStream === 'function') capabilities.push('openStream')
  if (typeof plugin?.probe === 'function') capabilities.push('probe')
  return capabilities
}

/**
 * 插件元数据（**纯数据**，可安全经 IPC 传给渲染层）。
 *
 * 为什么必须单独有这么一个形状：`StoragePlugin` 上挂着函数，而 Electron IPC 走
 * structured clone，函数会直接抛 `DataCloneError`。渲染层要渲染「可添加的存储类型」
 * 列表时只能用 meta。
 */
export interface StoragePluginMeta {
  readonly id: string
  readonly displayNameKey: MessageKey
  readonly descriptionKey?: MessageKey
  readonly version: string
  /** 声明式字段（纯数据，文案一律是键而非成品句子） */
  readonly fields: readonly StorageFieldDef[]
  /** 实际实现了的能力（由方法存在性派生） */
  readonly capabilities: readonly StoragePluginCapability[]
  /**
   * 用户是否启用该插件（与音源插件的 `PluginCatalogEntry.enabled` 同一口径）。
   *
   * 这里带一份是给**添加来源时的类型选择**用的：一个已停用的协议不该出现在
   * "新增网络存储"的下拉里 —— 选它只会建出一条永远连不上的来源。
   * 已存在的来源配置不受影响（它们会以"插件未启用"的具体原因失败，
   * 用户据此去插件列表重新打开开关）。
   */
  readonly enabled: boolean
}

/**
 * 字段取值（`settings` 优先、旧配置顶层同名字段兜底）。
 *
 * 实现放在 `./fields.ts`（协议层也要用它取自己的字段，而本文件是纯契约形状，
 * 不宜被协议实现反向依赖）。这里转出，让「契约 + 取值」在同一处可发现。
 */
export { storageFieldValue, storageStringField } from './fields'
