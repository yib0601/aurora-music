import {
  createTranslator,
  type MissingHandler,
  type MessageKeyOf,
  type MessageTree,
  type TranslateParams,
} from './core'
import { DICTIONARIES, type MessageKey, type Messages } from './messages'
import { DEFAULT_LOCALE, otherLocale, type Locale } from './locale'

/**
 * i18n 公开入口（渲染进程、Electron 主进程、移动端桥共用同一份）。
 *
 * 分层：
 *   locale.ts  语言标签归一与探测（纯数据）
 *   core.ts    翻译内核（插值 / 复数 / 回退）
 *   format.ts  Intl 格式化（数字、日期、字节、时长）
 *   errors.ts  结构化错误（码 + 参数 + 细节）
 *   messages/  字典（中文为源，英文由编译器校验覆盖度）
 */

export {
  LOCALES,
  DEFAULT_LOCALE,
  LANGUAGE_PREFERENCES,
  LOCALE_LABELS,
  SYSTEM_LANGUAGE_LABELS,
  normalizeLocale,
  isLocale,
  isLanguagePreference,
  matchLocale,
  detectLocale,
  otherLocale,
  htmlLangOf,
} from './locale'
export type { Locale, LanguagePreference } from './locale'

export {
  lookupMessage,
  hasMessage,
  interpolate,
  resolveTemplate,
  createTranslator,
  collectKeys,
  placeholdersOf,
} from './core'
export type { MessageTree, TranslateParams, MissingHandler, TFunction } from './core'

export {
  formatNumber,
  formatPercent,
  formatDate,
  formatTime,
  formatDateTime,
  formatRelativeTime,
  formatBytes,
  formatDuration,
  formatList,
  formatByteCount,
} from './format'

export {
  AuroraError,
  auroraError,
  isAuroraError,
  encodeErrorInfo,
  parseErrorInfo,
  stripIpcPrefix,
  stripRuntimeErrorPrefix,
  toErrorInfo,
  parseNativeMobileCode,
  translateError,
  describeError,
  errorDetailOf,
} from './errors'
export type { ErrorInfo, ErrorTranslator } from './errors'

export { zhCN, en, DICTIONARIES } from './messages'
export type { Messages, MessageKey } from './messages'


/** 应用侧翻译函数：键受编译期约束，拼错键名过不了 tsc */
export type AppTranslator = (key: MessageKey, params?: TranslateParams) => string

export interface AppTranslatorOptions {
  /** 兜底语言；默认取「另一种语言」，保证任何缺键都有可读文案 */
  fallback?: Locale
  /** 缺键回调：开发期告警 / 门禁脚本判红 */
  onMissing?: MissingHandler
}

/**
 * 造一个受类型约束的翻译函数。
 * 渲染层与主进程都从这里拿 t，保证两条链路的回退行为完全一致。
 */
export function createAppTranslator(locale: Locale, options: AppTranslatorOptions = {}): AppTranslator {
  const fallback = options.fallback ?? otherLocale(locale)
  const translator = createTranslator({
    locale,
    fallback,
    dictionaries: DICTIONARIES as Partial<Record<Locale, MessageTree>>,
    onMissing: options.onMissing,
  })
  // createTranslator 的键类型是通配树路径（内核不认识具体字典），
  // 这里收窄成应用键集；越界键在编译期已被 MessageKey 拦住。
  return translator as AppTranslator
}

/** 默认语言下的翻译函数（无状态场景：日志、非组件模块的兜底） */
export function translateDefault(key: MessageKey, params?: TranslateParams): string {
  return createAppTranslator(DEFAULT_LOCALE)(key, params)
}
