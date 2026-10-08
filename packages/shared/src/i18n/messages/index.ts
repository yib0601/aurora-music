import type { MessageKeyOf } from '../core'
import type { LocalizedOf } from './schema'
import common from './zh-CN/common'
import nav from './zh-CN/nav'
import library from './zh-CN/library'
import player from './zh-CN/player'
import hall from './zh-CN/hall'
import search from './zh-CN/search'
import settings from './zh-CN/settings'
import sources from './zh-CN/sources'
import update from './zh-CN/update'
import errors from './zh-CN/errors'
import desktop from './zh-CN/desktop'
import mobile from './zh-CN/mobile'
import runtime from './zh-CN/runtime'
import core from './zh-CN/core'
import shell from './zh-CN/shell'

import commonEn from './en/common'
import navEn from './en/nav'
import libraryEn from './en/library'
import playerEn from './en/player'
import hallEn from './en/hall'
import searchEn from './en/search'
import settingsEn from './en/settings'
import sourcesEn from './en/sources'
import updateEn from './en/update'
import errorsEn from './en/errors'
import desktopEn from './en/desktop'
import mobileEn from './en/mobile'
import runtimeEn from './en/runtime'
import coreEn from './en/core'
import shellEn from './en/shell'

/**
 * 字典总装：**中文是源语言、是唯一真值形状**。
 *
 * 新增命名空间的三步（顺序不能反）：
 *   1. 在 zh-CN/ 与 en/ 各建一个同名文件（en 侧用 `typeof` 中文侧做类型）；
 *   2. 在这里 import 并挂进 zhCN / en 两棵树；
 *   3. 跑 `pnpm --filter @aurora/shared test` —— 一致性测试会校验键集与占位符。
 *
 * `en` 的类型标注 `typeof zhCN` 是整套方案的地基：它把「英文是否覆盖完整」
 * 从人工审查变成了编译期错误。
 */
export const zhCN = {
  common,
  nav,
  library,
  player,
  hall,
  search,
  settings,
  sources,
  update,
  errors,
  desktop,
  mobile,
  runtime,
  core,
  shell,
} as const

export const en: LocalizedOf<typeof zhCN> = {
  common: commonEn,
  nav: navEn,
  library: libraryEn,
  player: playerEn,
  hall: hallEn,
  search: searchEn,
  settings: settingsEn,
  sources: sourcesEn,
  update: updateEn,
  errors: errorsEn,
  desktop: desktopEn,
  mobile: mobileEn,
  runtime: runtimeEn,
  core: coreEn,
  shell: shellEn,
}

/** 消息树形状（所有语言共用） */
export type Messages = typeof zhCN

/**
 * 全部合法文案键（点号路径，由中文源树推导）。
 *
 * 定义在这里而不是 `i18n/index.ts`，是为了让 `errors.ts` 能引用它：
 * 结构化错误的渲染函数（`translateError`）需要「只接受合法键」的翻译函数类型，
 * 若把这个类型留在 index.ts，errors.ts 就要反向引用入口文件，形成循环依赖。
 */
export type MessageKey = MessageKeyOf<Messages>

/** 语言 → 字典。新增语言时这里会出现编译错误，是刻意的提醒 */
export const DICTIONARIES = {
  'zh-CN': zhCN,
  en,
} as const
