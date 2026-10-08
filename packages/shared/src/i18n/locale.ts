/**
 * 语言标签：内核只认这两种。
 *
 * 为什么不用「zh / zh-Hans / en-US / en-GB」全量枚举：
 * 界面语言是**产品级选择**，不是系统标签的镜像。`navigator.language` 会给出
 * zh-Hans-CN、zh-TW、en-GB、en-US… 等几十种变体，若逐个建字典，维护成本
 * 与收益完全不成比例（英式/美式拼写差异只在极少数字词上）。因此在边界处
 * 归一：任何 `zh*` 落到 zh-CN，任何 `en*` 落到 en，其余一律返回 null 交给
 * 调用方决定（回退而不是硬塞一个不匹配的界面语言）。
 */

/** 支持的语言（有序：数组顺序即设置页语言选择器的展示顺序） */
export const LOCALES = ['zh-CN', 'en'] as const

export type Locale = (typeof LOCALES)[number]

/** 未做任何设置、也匹配不到系统语言时的界面语言（项目源语言） */
export const DEFAULT_LOCALE: Locale = 'zh-CN'

/** 界面语言偏好的用户可选值：跟随系统 + 具体语言 */
export const LANGUAGE_PREFERENCES = ['system', 'zh-CN', 'en'] as const

export type LanguagePreference = (typeof LANGUAGE_PREFERENCES)[number]

/**
 * 把任意 BCP-47 标签归一到受支持的 Locale。
 * 大小写与分隔符均不敏感（`EN_us` / `zh-Hant-TW` 都能识别）。
 */
export function normalizeLocale(tag: unknown): Locale | null {
  if (typeof tag !== 'string') return null
  const primary = tag.trim().toLowerCase().replace(/_/g, '-').split('-')[0]
  if (primary === 'zh') return 'zh-CN'
  if (primary === 'en') return 'en'
  return null
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return typeof value === 'string' && (LANGUAGE_PREFERENCES as readonly string[]).includes(value)
}

/**
 * 从候选标签列表里挑第一个能归一的语言（顺序即优先级）。
 * 传入的通常是 `navigator.languages`（已按用户偏好排序）。
 * 全部落空时返回 null，由调用方决定用哪种默认（渲染层用系统默认，
 * 主进程用 Electron 的 app.getLocale()）。
 */
export function matchLocale(candidates: readonly unknown[]): Locale | null {
  for (const tag of candidates) {
    const matched = normalizeLocale(tag)
    if (matched) return matched
  }
  return null
}

/** 系统语言探测：给出界面语言（匹配不到则用 DEFAULT_LOCALE） */
export function detectLocale(candidates: readonly unknown[]): Locale {
  return matchLocale(candidates) ?? DEFAULT_LOCALE
}

/**
 * 语言名（用**该语言自身**书写）。
 * 语言选择器里必须用本语言名（"English" 而不是 "英语"）：用户看不懂当前
 * 界面语言时，唯一能自救的线索就是母语名。
 *
 * 因此这里是**语言自称（endonym）**：不随界面语言变化，也不进字典
 * （进字典等于允许它被翻译，那正好破坏了它的唯一价值）。
 * 门禁脚本的行级豁免在下面各行标注。
 */
export const LOCALE_LABELS: Record<Locale, string> = {
  'zh-CN': '简体中文', // i18n-exempt: 语言自称，不随界面语言变化
  en: 'English', // i18n-exempt: 语言自称（英文名在任何语言下都写作 English）
}

/** 语言选择器里「跟随系统」那一项在各语言下的写法 */
export const SYSTEM_LANGUAGE_LABELS: Record<Locale, string> = {
  'zh-CN': '跟随系统', // i18n-exempt: 与 LOCALE_LABELS 同层，按语言直接取用
  en: 'System language', // i18n-exempt: 同上
}

/**
 * 另一种语言（用于缺失键的兜底：任何一条文案缺失时，宁可显示另一种语言，
 * 也绝不让用户看到裸 key 或空白）。
 */
export function otherLocale(locale: Locale): Locale {
  return locale === 'zh-CN' ? 'en' : 'zh-CN'
}

/** `<html lang>` 与 `Intl.*` 用的完整标签（Locale 本身就是合法 BCP-47） */
export function htmlLangOf(locale: Locale): string {
  return locale
}
