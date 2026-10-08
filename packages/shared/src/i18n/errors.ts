import type { TranslateParams } from './core'
import type { MessageKey } from './messages'

/**
 * 结构化错误：让「错误」跨进程、跨语言传递时都不再依赖人写的文案。
 *
 * 背景（这段是设计依据，别删）：
 * 现状是执行器直接 `throw new Error('音源「QQ_Music」返回 HTTP 502')`，
 * 中文文案在**产生地**就被烧死，于是：
 *   - 英文界面里冒出中文错误（"Error invoking remote method ... 音源「QQ_Music」返回 HTTP 502"）；
 *   - 渲染层想翻译也不知道该翻哪一段——只能靠关键词猜（旧 messageOf 的做法），
 *     每加一条错误就得往正则表里补一条，漏一条就漏一条中文上屏。
 *
 * 新协议：错误在产生地只给「码 + 参数 + 技术细节」，文案由**显示地**按当前
 * 语言渲染。跨 Electron IPC 时自定义字段会被丢弃（实测 name 一律退化成
 * Error、message 前被拼上 "Error invoking remote method '<channel>': "），
 * 所以码与参数编码进 message 文本，接收侧解析回来。
 */

/**
 * 结构化错误载荷。
 *
 * `code` 是**消息树里的完整键路径**（不是短码 + 前缀拼接）：通用错误走
 * `errors.network.timeout`，域内错误走 `sources.error.scriptUrl`、
 * `update.error.downloadFailed`。这样每个命名空间自己拥有自己的错误文案，
 * 不需要所有域往同一张错误表里挤（那会让字典文件成为多人的写冲突热点）。
 */
export interface ErrorInfo {
  /** 消息树里的完整键路径，如 `errors.network.timeout` */
  code: string
  /** 模板参数 */
  params?: TranslateParams
  /** 原始技术信息（HTTP 状态、异常类名等）：只进日志与「详情」折叠区，不直接上屏 */
  detail?: string
}

/**
 * 错误渲染函数：**只接受合法文案键**的翻译函数。
 *
 * 为什么不用内核的 `TFunction`（键类型是通配 `string`）：
 * 函数参数是逆变的。`TFunction` 要求「能翻译任意字符串」，而应用层的
 * `AppTranslator` 只接受字典里真实存在的键（字面量联合），两者不兼容——
 * 直接把 `useT()` 传给 `translateError` 会报 TS2345，逼得每个调用点各写一个
 * `as unknown as TFunction` 断言（改造期间真实发生过 7 次）。断言一多，
 * 类型系统对文案键的保护在错误链路上就整段失效了。
 *
 * 收窄成 `MessageKey` 后的取舍：运行时来的错误码（`errors.network.timeout`
 * 这类）本身也是合法键，编译期认得出；字典里没有的码会走 `t()` 的缺键回退
 * （返回键名本身），由 `translateError` 里「返回是否等于键名」的判断兜住，
 * 不会把键名炸到界面上。
 */
export type ErrorTranslator = (key: MessageKey, params?: TranslateParams) => string

const PREFIX = 'AURORA_ERR:'

/** 语义化错误：抛出它即表示「文案交给显示端按语言渲染」 */
export class AuroraError extends Error {
  readonly code: string
  readonly params?: TranslateParams
  readonly detail?: string

  constructor(code: string, params?: TranslateParams, detail?: string) {
    super(encodeErrorInfo({ code, params, detail }))
    this.name = 'AuroraError'
    this.code = code
    this.params = params
    this.detail = detail
  }
}

export function auroraError(code: string, params?: TranslateParams, detail?: string): AuroraError {
  return new AuroraError(code, params, detail)
}

export function isAuroraError(value: unknown): value is AuroraError {
  return value instanceof AuroraError || (typeof value === 'object' && value !== null && (value as AuroraError).name === 'AuroraError')
}

/** 把载荷编码成可跨 IPC 的文本（JSON 是为了参数字典不被分隔符撕开） */
export function encodeErrorInfo(info: ErrorInfo): string {
  return `${PREFIX}${JSON.stringify({ code: info.code, params: info.params, detail: info.detail })}`
}

/** 解析编码载荷；非本协议返回 null */
export function parseErrorInfo(message: string): ErrorInfo | null {
  const index = message.indexOf(PREFIX)
  if (index < 0) return null
  const raw = message.slice(index + PREFIX.length).trim()
  try {
    const parsed = JSON.parse(raw) as ErrorInfo
    if (parsed && typeof parsed.code === 'string' && parsed.code) return parsed
    return null
  } catch {
    return null
  }
}

/**
 * 剥掉 Electron 给 remote invoke 错误拼的前缀。
 * 抽出成独立函数是因为渲染层、测试、验证脚本三处都要用同一份规则。
 */
export function stripIpcPrefix(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '').trim()
}

/** 连续剥掉 "TypeError: " / "DOMException: " 这类语言运行时前缀（最多 3 层，防脏数据死循环） */
export function stripRuntimeErrorPrefix(message: string): string {
  let current = message
  for (let i = 0; i < 3; i += 1) {
    const next = current.replace(/^(?:[A-Za-z]*Error|DOMException):\s*/, '').trim()
    if (next === current) break
    current = next
  }
  return current
}

/** 已知的底层异常 → 错误键映射（顺序即优先级） */
const NATIVE_PATTERNS: Array<{ pattern: RegExp; code: string }> = [
  // 中止：fetch 被 AbortController 打断。Electron 跨进程后会退化成裸 message
  // "The operation was aborted."，所以必须靠关键词识别，而不是 name。
  { pattern: /abort/i, code: 'errors.network.timeout' },
  { pattern: /failed to fetch|networkerror|load failed|fetch failed|err_connection|err_network/i, code: 'errors.network.unreachable' },
  { pattern: /etimedout|timeout|timed out/i, code: 'errors.network.timeout' },
  { pattern: /enotfound|eai_again|dns/i, code: 'errors.network.dns' },
  { pattern: /certificate|self signed|ssl|tls/i, code: 'errors.network.tls' },
  { pattern: /quota|enospc|no space left/i, code: 'errors.storage.full' },
  { pattern: /eacces|eperm|permission denied/i, code: 'errors.storage.permission' },
  { pattern: /enoent|not found|404/i, code: 'errors.storage.missing' },
  { pattern: /sqlite|database is locked|constraint failed/i, code: 'errors.storage.database' },
  { pattern: /decode|unsupported|not supported|invalid audio/i, code: 'errors.media.decode' },
]

/**
 * Android 原生侧的 reject 码 → 文案键。
 *
 * 原生插件（Capacitor 的 `call.reject(...)`）拿不到界面语言上下文，
 * 也不能拼句子，所以按约定只回一个**可逆的码**：
 * `update_error_httpStatus?status=404` → 键 `mobile.update.error.httpStatus` + 参数 `{status: '404'}`。
 * 规则：`mobile.` + 码里 `_` 换成 `.`；`?k=v` 用 URLSearchParams 解出作插值参数。
 *
 * 必须在关键词表（NATIVE_PATTERNS）**之前**识别，否则会踩两个坑：
 * 码里的 `httpStatus?status=404` 含 "404" 会被判成 `errors.storage.missing`
 * （界面提示「文件或目录不存在」，与真实原因毫无关系）；
 * `update_error_canceled` 里的 "cancel" 也不算超时/中止语义。
 */
export function parseNativeMobileCode(value: string): { code: string; params?: TranslateParams } | null {
  const trimmed = value.trim()
  // 码至少两段（`update_error_httpStatus`）：前缀域 + 至少一个驼峰段，段间以下划线相连
  if (!/^(?:update|media|permission)_[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z][A-Za-z0-9]*)*(?:\?[^\s]*)?$/.test(trimmed)) return null
  const [rawCode, query] = trimmed.split('?')
  const params: TranslateParams = {}
  if (query) {
    for (const [key, paramValue] of new URLSearchParams(query)) params[key] = paramValue
  }
  return {
    code: `mobile.${rawCode.replace(/_/g, '.')}`,
    params: Object.keys(params).length > 0 ? params : undefined,
  }
}

/** 归一任意异常到结构化载荷。
 *
 * 三级降级（这是「英文界面不冒中文、中文界面不冒英文栈」的兜底链）：
 *   1. 本协议的结构化错误 → 直接用码；
 *   2. 已知底层异常（中英双语关键词）→ 映射到通用码；
 *   3. 其余 → `unknown`，原始 message 进 detail，文案用通用兜底句 + 详情。
 */
export function toErrorInfo(error: unknown): ErrorInfo {
  const rawMessage = error instanceof Error ? error.message : String(error ?? '')
  const stripped = stripIpcPrefix(rawMessage)
  const cleaned = stripRuntimeErrorPrefix(stripped)

  if (isAuroraError(error)) {
    return { code: error.code, params: error.params, detail: error.detail }
  }

  const encoded = parseErrorInfo(rawMessage)
  if (encoded) {
    // 编码载荷本身可能被套了一层前缀，detail 里补上人类可读的部分
    return { code: encoded.code, params: encoded.params, detail: encoded.detail ?? (cleaned !== rawMessage ? cleaned : undefined) }
  }

  if (!cleaned) return { code: 'errors.unknown' }

  // 原生侧的可逆码优先于关键词表（理由见 parseNativeMobileCode）
  const nativeCode = parseNativeMobileCode(cleaned)
  if (nativeCode) return { code: nativeCode.code, params: nativeCode.params, detail: cleaned }

  const probe = `${cleaned} ${rawMessage}`
  for (const { pattern, code } of NATIVE_PATTERNS) {
    if (pattern.test(probe)) return { code, detail: cleaned }
  }

  // 已本地化的文本（历史遗留的中文字面量）原样透出：宁可显示中文，
  // 也不要把一句人话换成「未知错误」把信息量抹平。改造完成后这条路径应当为空，
  // 由 check-i18n.mjs 的扫描兜住。
  return { code: 'errors.raw', params: { message: cleaned }, detail: cleaned }
}

/**
 * 渲染错误文案。`t` 由调用方按当前语言注入（渲染层 useT，主进程自己的 translator）。
 * 返回的永远是一句可直接上屏的人话。
 *
 * 缺失判定用「返回是否等于键本身」：翻译器查不到会原样返回 key，
 * 这在不用把整棵字典传给本函数的前提下就能识别。
 */
export function translateError(error: unknown, t: ErrorTranslator): string {
  const info = toErrorInfo(error)
  const key = info.code as MessageKey
  const text = t(key, info.params)
  if (text !== info.code) return text
  if (info.detail) return `${t('errors.unknown')}（${info.detail}）`
  return t('errors.unknown')
}

/** 诊断串：日志与「复制详情」用，永远给技术原文（不做语言渲染） */
export function describeError(error: unknown): string {
  const info = toErrorInfo(error)
  const parts = [`code=${info.code}`]
  if (info.params && Object.keys(info.params).length > 0) parts.push(`params=${JSON.stringify(info.params)}`)
  if (info.detail) parts.push(`detail=${info.detail}`)
  return parts.join(' ')
}

/**
 * 取「可嵌进上层句子」的底层原因文本。
 *
 * 专门为 `reason` / `detail` 这类**参数位**准备，因为这里有个必须避开的坑：
 * 结构化错误的 `message` 是 `AURORA_ERR:{...}` 编码载荷，若把
 * `(err as Error).message` 直接当参数插进 `音源「{name}」请求失败（{reason}）`，
 * 用户看到的就是一坨 JSON。所以：
 *   - 有结构化信息 → 用 `detail`（人类可读的技术原文，如 `HTTP 502`）；
 *   - `errors.raw` 这类原样透出的历史文本 → 用它的文本参数；
 *   - 其余 → 兜到 `String(err)`。
 *
 * 注意这里**不做语言渲染**：参数位可能被嵌进任意语言的模板，
 * 渲染由外层那次 `translateError`/`t()` 统一负责。
 */
export function errorDetailOf(error: unknown): string {
  const info = toErrorInfo(error)
  if (info.detail) return info.detail
  const fromParams = info.params?.message
  if (typeof fromParams === 'string' && fromParams) return fromParams
  return error instanceof Error ? error.name : String(error ?? '')
}
