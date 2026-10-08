import { app, ipcMain } from 'electron'
import {
  DEFAULT_LOCALE,
  auroraError,
  createAppTranslator,
  describeError,
  isAuroraError,
  matchLocale,
  toErrorInfo,
  translateError,
  type AppTranslator,
  type AuroraError,
  type Locale,
  type MessageKey,
  type TFunction,
} from '@aurora/shared'

/**
 * 主进程翻译层：主进程取文案的**唯一入口**。
 *
 * 为什么需要它：托盘、原生对话框、系统通知都没有 React 树，也没有渲染进程的
 * localeStore 可读。语言只能有两条来源——
 *   1. 启动初值：`app.getLocale()` / `app.getAvailableLanguages()` 归一（纯系统语言）；
 *   2. 权威值：渲染层就绪后经 `i18n:set-locale` 同步过来（用户可能选了「跟随系统」
 *      或手动指定语言，只有渲染层知道最终结果）。
 * 第 2 条一旦到达就锁定，不再被系统语言改写。
 *
 * 回退行为与渲染层完全一致（两边都走 `createAppTranslator`）：缺键先退另一种语言，
 * 仍缺才露出裸 key；非生产构建里对缺键告警一次，避免刷屏。
 *
 * 硬规则：**不许在模块级求值文案**。这里只缓存「翻译器」，不缓存任何译文；
 * 调用方每次都要 `mainTranslate()(...)` 现取，这样切语言后拿到的就是新文案。
 */

/** 系统语言探测：Electron 未就绪或读不到时返回 null（交给调用方决定初值） */
function detectSystemLocale(): Locale | null {
  // app.getLocale() / app.getPreferredSystemLanguages() 在 ready 之前取不到系统语言
  if (!app.isReady()) return null
  try {
    // 候选顺序：系统语言偏好列表（已按用户优先级排序）→ 当前 locale。
    // matchLocale 只认 zh* / en*，其余语言返回 null 由 DEFAULT_LOCALE 兜底。
    return matchLocale([...app.getPreferredSystemLanguages(), app.getLocale()])
  } catch {
    return null
  }
}

const initialSystemLocale = detectSystemLocale()

/** 当前主进程语言 */
let locale: Locale = initialSystemLocale ?? DEFAULT_LOCALE

/** 是否已经用系统语言同步过（避免每次取文案都探测一遍） */
let systemSynced = initialSystemLocale !== null

/** 渲染层是否已同步过语言：置位后系统语言不再能改写它 */
let overriddenByRenderer = false

/** 语言变更订阅者（托盘菜单重建等） */
const listeners = new Set<(locale: Locale) => void>()

/**
 * 惰性同步系统语言。
 * 模块加载时 app 通常还没 ready（i18n.ts 被 main.ts 的 import 链提前拉起），
 * 所以真正的探测要在「第一次取文案」时补做——那时窗口即将创建，语言必须已经正确。
 */
function syncSystemLocale(): void {
  if (overriddenByRenderer || systemSynced) return
  const detected = detectSystemLocale()
  if (!detected) return
  systemSynced = true
  if (detected !== locale) locale = detected
}

/** 开发期缺键告警：同一键只报一次，与渲染层的告警策略保持一致 */
const warned = new Set<string>()

function warnMissing(key: string, missing: Locale): void {
  // 生产构建不告警：日志面向开发者，且打包后控制台无人看
  if (app.isPackaged) return
  const tag = `${missing}:${key}`
  if (warned.has(tag)) return
  warned.add(tag)
  console.warn(`[i18n] ${missing} 缺少文案：${key}（已回退到另一种语言）`)
}

/** 翻译器缓存：切语言不频繁，但错误路径可能在一次操作里取上十次 */
const translatorCache = new Map<Locale, AppTranslator>()

/**
 * 主进程翻译函数。**每次都要现调**（`mainTranslate()('x')`），不要把它存进模块级变量。
 */
export function mainTranslate(): AppTranslator {
  syncSystemLocale()
  const cached = translatorCache.get(locale)
  if (cached) return cached
  const created = createAppTranslator(locale, { onMissing: warnMissing })
  translatorCache.set(locale, created)
  return created
}

/** 当前主进程语言（诊断与测试用） */
export function getMainLocale(): Locale {
  syncSystemLocale()
  return locale
}

/**
 * 设置主进程语言（IPC 入参按不可信处理）。
 * 归一失败返回 null 并保持原语言；语言真正变化时通知订阅者重建界面元素。
 */
export function setMainLocale(input: unknown): Locale | null {
  const next = matchLocale([input])
  if (!next) return null
  // 渲染层是语言的权威来源：即使这次值与当前一致，也要锁住，防止系统语言回写
  overriddenByRenderer = true
  if (next === locale) return next
  locale = next
  for (const listener of listeners) {
    try {
      listener(next)
    } catch (err) {
      // 单个订阅者失败不能拖住其余订阅者（托盘重建 vs 未来的窗口标题等）
      console.error('[i18n] 语言变更回调失败:', err)
    }
  }
  return next
}

/** 订阅语言变更（返回退订函数）。用于托盘菜单这类「文案在构造期固化成快照」的元素。 */
export function onMainLocaleChange(listener: (locale: Locale) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 把任意异常渲染成**当前语言**的成品文案。
 * 只用于「主进程自己要把错误显示给用户」的通道（updater:error / scan:error / 探测结果），
 * 这些通道的接收侧只做透传，不会再去解码结构化载荷。
 * 跨 IPC 的 reject 一律抛 AuroraError，由渲染层 translateError 渲染。
 */
export function mainErrorText(error: unknown): string {
  // translateError 的 t 形参取「通配树路径」（shared 内核不认识具体字典），而 AppTranslator
  // 的键被收窄成应用键集——两者运行期是同一个函数，这里只做一次类型适配。
  return translateError(error, mainTranslate() as TFunction)
}

/**
 * 把任意异常归一成 AuroraError，确保跨 IPC 后仍能在显示端按语言渲染。
 * 已识别的底层异常（网络 / 磁盘 / 解码）沿用通用错误码；其余挂到 `fallback` 上，
 * 原始技术信息进 detail（只进日志与详情折叠区，不直接上屏）。
 */
export function mainErrorOf(error: unknown, fallback: MessageKey): AuroraError {
  if (isAuroraError(error)) return error
  const info = toErrorInfo(error)
  if (info.code !== 'errors.raw' && info.code !== 'errors.unknown') {
    return auroraError(info.code, info.params, info.detail)
  }
  return auroraError(fallback, undefined, describeError(error))
}

/**
 * 注册语言同步通道。
 *
 * 渲染层 `I18nProvider` 在语言确定后调用 `window.electronAPI.i18n.setLocale(locale)`，
 * 主进程据此覆盖启动初值并重建托盘菜单（订阅者负责）。
 * 用单向 send 而不是 invoke：主进程没有回执需求，渲染层那边是 `?.()` 的可选调用，
 * 给它一个可能被拒绝的 Promise 只会多出未处理的拒绝分支。
 */
export function registerI18nIpc(): void {
  ipcMain.on('i18n:set-locale', (_event, value: unknown) => {
    setMainLocale(value)
  })
}
