/**
 * `LocalizedText` 解析（清单里的展示名 / 说明）。
 *
 * ## 为什么外部插件的名字不是 `MessageKey`
 *
 * 内置插件的展示名是**字典键**（`MessageKey`，随应用语言切换，见 `../types.ts`）。
 * 外部插件是第三方写的，应用字典里**不可能**有它的键 —— 强行要求作者往我们的字典里加
 * 条目是不可能的。所以清单里存的是**字面量**（或按语言标记的字面量映射），
 * 由本文件在渲染期选一种。
 *
 * ## 选取顺序（写死在这里，避免各处各写一套）
 *
 * 1. 精确匹配当前语言（`zh-CN`）
 * 2. 主语言匹配（`zh` → 命中 `zh-CN` / `zh-TW` 中第一个）
 * 3. `en`
 * 4. 任意第一个非空值
 * 5. 空白串（调用方**必须**用 `id` 兜底 —— 显示空白的插件在列表里等于消失）
 *
 * 刻意**不做**语言协商的其它花样（`Accept-Language` 权重、脚本子标记匹配）：
 * 插件名只是几个词，多一层协商只会让"为什么显示英文"更难解释。
 */

import type { LocalizedText } from './types'

/** 语言标记归一：小写主语言 + 原样地区（`zh-CN` → `zh-CN`，`ZH_hans_cn` → `zh-hans-cn`） */
function normalizeTag(tag: string): string {
  return tag.trim().replace(/_/g, '-').toLowerCase()
}

/** 主语言：`zh-CN` → `zh`；没有地区时就是它自己 */
function primaryTag(tag: string): string {
  return normalizeTag(tag).split('-')[0]
}

/**
 * 解析 `LocalizedText`。
 *
 * @param text   清单里的值（字符串 / 语言映射 / undefined）
 * @param locale 当前界面语言（如 `zh-CN` / `en`）
 * @param fallback 全部落空时的兜底（通常传插件 `id`：**绝不让展示名为空**）
 */
export function resolveLocalized(
  text: LocalizedText | undefined,
  locale: string,
  fallback: string
): string {
  if (text === undefined || text === null) return fallback
  if (typeof text === 'string') return text.trim() || fallback

  const entries = Object.entries(text).filter(([, value]) => typeof value === 'string' && value.trim())
  if (entries.length === 0) return fallback

  const wanted = normalizeTag(locale)
  // 1) 精确匹配
  const exact = entries.find(([tag]) => normalizeTag(tag) === wanted)
  if (exact) return exact[1].trim()

  // 2) 主语言匹配（按对象里声明的顺序取第一个，保证同一份清单每次渲染结果一致）
  const wantedPrimary = primaryTag(wanted)
  const samePrimary = entries.find(([tag]) => primaryTag(tag) === wantedPrimary)
  if (samePrimary) return samePrimary[1].trim()

  // 3) 英文兜底
  const english = entries.find(([tag]) => primaryTag(tag) === 'en')
  if (english) return english[1].trim()

  // 4) 任意第一个非空值
  return entries[0][1].trim()
}

/**
 * 清单里声明的语言集合（供 UI 显示「本插件的语言」——作者可能只写了英文，
 * 中文用户看到英文名时能知道这是插件的现状而不是应用 bug）。
 */
export function declaredLocalesOf(text: LocalizedText | undefined): string[] {
  if (text === undefined || typeof text === 'string') return []
  return Object.keys(text)
}
