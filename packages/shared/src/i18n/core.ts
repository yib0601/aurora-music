import type { Locale } from './locale'

/**
 * 翻译内核（零依赖，纯函数）。
 *
 * 设计约束（改这里之前先读一遍）：
 * 1. **字典是纯数据**：消息树只允许「字符串叶子」与「对象分支」，不允许函数值。
 *    理由：字典要同时被渲染进程（Vite/浏览器）、Electron 主进程（tsc/CJS）、
 *    移动端构建三处消费，任何闭包都会把打包器与宿主环境绑死。
 * 2. **绝不显示裸 key**：查不到就退到另一种语言，两边都没有才返回 key 本身
 *    并触发 onMissing（开发期告警 + 门禁脚本据此判红）。
 * 3. **复数走键后缀**：裸键是「other 形态」的唯一真源，需要区分单复数的语言
 *    再补 `key_one`（英文）/ `key_few` 等。这样消息树的类型只剩「string | 对象」
 *    两种形态，Path 类型推导保持简单且可穷举；中文也不必为英文的复数形式
 *    写一份值相同的冗余条目。
 * 4. **插值不隐式格式化**：`{count}` 原样替换。千分位/单位/日期一律由调用方
 *    显式走 format.ts（隐式格式化会让「3 首」变成「3 首」以外的意外形态，
 *    也会让既有断言与用户预期一起漂移）。
 */

/** 消息树：字符串叶子 + 对象分支 */
export interface MessageTree {
  readonly [key: string]: string | MessageTree
}

/** 同一种语言的全部命名空间 */
export type Dictionaries = Record<string, MessageTree>

export type TranslateParams = Record<string, string | number>

export type MissingHandler = (key: string, locale: Locale) => void

/**
 * 递归推导点号路径。`{ a: { b: 'x' } }` → `'a.b'`。
 * 深度上限由消息树本身决定：字典层级固定（命名空间 → 分组 → 词条），不会失控。
 */
export type MessageKeyOf<T> = T extends string
  ? never
  : {
      [K in keyof T & string]: T[K] extends string
        ? K
        : `${K}.${MessageKeyOf<T[K]>}`
    }[keyof T & string]

/** 一个语言下的全部合法键 */
export type MessageKey = MessageKeyOf<MessageTree>

export type TFunction = (key: MessageKey, params?: TranslateParams) => string

// Intl 实例构造是热点路径上最贵的一步（每次 new 都要解析语言与区域设置），
// 而 t() 会在虚拟列表里被逐行调用，所以一律缓存。
const pluralRulesCache = new Map<string, Intl.PluralRules>()

function pluralRulesFor(locale: Locale): Intl.PluralRules {
  const cached = pluralRulesCache.get(locale)
  if (cached) return cached
  const rules = new Intl.PluralRules(locale)
  pluralRulesCache.set(locale, rules)
  return rules
}

/** 按点号路径取叶子；中途遇到非对象或缺失一律返回 undefined */
export function lookupMessage(tree: MessageTree | undefined, key: string): string | undefined {
  if (!tree) return undefined
  let node: string | MessageTree | undefined = tree
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = node[segment]
  }
  return typeof node === 'string' ? node : undefined
}

/** 键是否存在（含复数后缀形态） */
export function hasMessage(tree: MessageTree | undefined, key: string): boolean {
  return lookupMessage(tree, key) !== undefined
}

/**
 * 插值：`{name}` / `{count}` 原样替换为参数值。
 * 未提供的参数保持原样（便于一眼看出漏传，而不是静默变成空串）。
 */
export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * 取模板：先按 Intl 复数类别找 `key_<category>`，再退 `key_other`，最后退裸 key。
 *
 * 复数只写「需要区分的语言」：中文单复数同形，字典里只留裸键；
 * 英文多一条 `xxx_one`，复数选择器会自动命中。裸键永远存在，
 * 因此 `select()` 给出 other/few/many 等类别时也必有可显示的文案。
 * 只有参数里带 number 型 count 时才走复数分支——这样 t('x', {count: 'wow'})
 * 这类脏数据不会把键查歪。
 */
export function resolveTemplate(
  tree: MessageTree | undefined,
  key: string,
  locale: Locale,
  params?: TranslateParams
): string | undefined {
  if (params && typeof params.count === 'number') {
    const category = pluralRulesFor(locale).select(params.count)
    const byCategory = lookupMessage(tree, `${key}_${category}`)
    if (byCategory !== undefined) return byCategory
  }
  return lookupMessage(tree, key)
}

export interface TranslatorOptions {
  /** 当前界面语言 */
  locale: Locale
  /** 兜底语言：当前语言缺键时改用它，仍缺才回退到裸 key */
  fallback: Locale
  /** 各语言的消息树（至少包含 locale 与 fallback 两项；缺项按空树处理） */
  dictionaries: Partial<Record<Locale, MessageTree>>
  /** 缺键回调：开发期用于告警，测试/门禁用于判红 */
  onMissing?: MissingHandler
}

/**
 * 造一个翻译函数。
 *
 * 缺键顺序：locale → fallback → 原样返回 key（绝不返回空串，空串会让界面
 * 出现「没有文字的按钮」，比露出 key 更难排查）。
 */
export function createTranslator(options: TranslatorOptions): TFunction {
  const { locale, fallback, dictionaries, onMissing } = options
  const primary = dictionaries[locale]
  const secondary = dictionaries[fallback]

  return (key: MessageKey, params?: TranslateParams): string => {
    const own = resolveTemplate(primary, key, locale, params)
    if (own !== undefined) return interpolate(own, params)

    const other = resolveTemplate(secondary, key, fallback, params)
    if (other !== undefined) {
      onMissing?.(key, locale)
      return interpolate(other, params)
    }

    onMissing?.(key, locale)
    return key
  }
}

/**
 * 收集消息树里的全部叶子键（扁平点号形式）。
 * 供字典一致性测试与门禁脚本使用：只有先能穷举，才谈得上「两边键集必须相等」。
 */
export function collectKeys(tree: MessageTree, prefix = ''): string[] {
  const keys: string[] = []
  for (const [name, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${name}` : name
    if (typeof value === 'string') keys.push(path)
    else keys.push(...collectKeys(value, path))
  }
  return keys
}

/** 取出模板里的插值占位符名（用于校验两种语言的参数集是否一致） */
export function placeholdersOf(template: string): string[] {
  return [...new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort()
}
