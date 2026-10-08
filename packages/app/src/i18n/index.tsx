import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { createAppTranslator, htmlLangOf, type AppTranslator, type Locale } from '@aurora/shared'
import { currentLocale, resolveLocale, useLocaleStore } from '@/stores/localeStore'

/**
 * React 绑定层：把 shared 的翻译内核接到组件树与外壳副作用上。
 *
 * 三条使用路径（按优先级选）：
 *   1. 组件内：`const t = useT()` —— 语言切换会重渲染；
 *   2. 组件内的当前语言：`const locale = useLocale()`（日期/数字格式化用它）；
 *   3. store / service / 工具函数（无渲染周期）：`appTranslate()` —— 读 store 快照。
 *
 * 第 3 条是**唯一**允许在模块级之外取译文的方式：它每次读实时快照，
 * 因此不会出现「模块加载时求值、之后永远冻结」的语言粘滞。
 */

const I18nContext = createContext<AppTranslator | null>(null)

/** 开发期缺键告警：同一键只报一次，避免刷屏掩盖真正的首条缺失 */
const warned = new Set<string>()
function warnMissing(key: string, locale: Locale): void {
  // 只在 dev 构建告警。Vite 的 import.meta.env 不在 app 的 tsconfig types 里，
  // 这里用结构化断言取，避免为一个环境变量引入全局类型依赖。
  const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env
  if (!env?.DEV) return
  const tag = `${locale}:${key}`
  if (warned.has(tag)) return
  warned.add(tag)
  console.warn(`[i18n] ${locale} 缺少文案：${key}（已回退到另一种语言）`)
}

/** 本地翻译器缓存：切语言不频繁，但 appTranslate 会在事件回调里被反复调用 */
const translatorCache = new Map<Locale, AppTranslator>()

function translatorFor(locale: Locale): AppTranslator {
  const cached = translatorCache.get(locale)
  if (cached) return cached
  const created = createAppTranslator(locale, { onMissing: warnMissing })
  translatorCache.set(locale, created)
  return created
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const language = useLocaleStore((s) => s.language)
  const locale = resolveLocale(language)
  const t = translatorFor(locale)

  // 外壳副作用：<html lang> 决定字体回退、断词规则与屏幕阅读器发音；
  // data-locale 供 CSS 做语言相关的排版微调（如英文下放宽字距）。
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('lang', htmlLangOf(locale))
    root.setAttribute('data-locale', locale)
    // 主进程（托盘 / 原生对话框 / 通知）没有 React 树，语言经 IPC 同步过去
    const api = (window as unknown as { electronAPI?: { i18n?: { setLocale?: (l: string) => void } } }).electronAPI
    api?.i18n?.setLocale?.(locale)
  }, [locale])

  return <I18nContext.Provider value={t}>{children}</I18nContext.Provider>
}

/**
 * 组件内取翻译函数。
 * 没有 Provider 时不抛错而是回退到当前语言：单测与少量脱离树渲染的组件
 * （如 toast 容器）不该因为缺少 Provider 直接崩。
 */
export function useT(): AppTranslator {
  const fromContext = useContext(I18nContext)
  const language = useLocaleStore((s) => s.language)
  const locale = resolveLocale(language)
  return fromContext ?? translatorFor(locale)
}

/** 组件内取当前语言（格式化日期/数字用） */
export function useLocale(): Locale {
  const language = useLocaleStore((s) => s.language)
  return resolveLocale(language)
}

/**
 * 非组件场景的翻译入口（store / service / 事件回调 / 工具函数）。
 * 每次读 store 快照，因此永远跟着用户当前选择走。
 */
export function appTranslate(): AppTranslator {
  return translatorFor(currentLocale())
}

export { resolveLocale, useLocaleStore }
