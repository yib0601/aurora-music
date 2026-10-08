import { create } from 'zustand'
import { detectLocale, isLanguagePreference, type LanguagePreference, type Locale } from '@aurora/shared'

/**
 * 界面语言偏好。
 *
 * 独立于 libraryStore 的原因：语言是**外壳级**状态（首屏脚本、原生菜单、
 * 系统对话框都要在曲库还没 hydrate 时就知道），而 libraryStore 承载的是
 * 曲库数据与来源配置，把它俩绑在一起会让「切语言」这条路径牵连整个曲库
 * 的持久化迁移逻辑。
 *
 * 持久化形态刻意存**偏好**（`system` / `zh-CN` / `en`）而不是解析后的语言：
 * 存 `system` 的用户换到英文系统后应当自动变英文，若存解析结果就永远冻结了。
 */

/** 持久化 key：index.html 的首屏脚本按字面量读同一个 key，改名即断链 */
export const LOCALE_STORAGE_KEY = 'aurora-locale'

/** 存储格式版本：与 zustand persist 的 `{ state, version }` 形状保持一致 */
const STORAGE_VERSION = 1

export interface LocaleState {
  language: LanguagePreference
  setLanguage: (language: LanguagePreference) => void
}

/**
 * 为什么不直接用 zustand 的 persist 中间件（这段是踩过的坑，别再改回去）：
 *
 *   1. **hydrate 是异步的**。persist 的读取发生在微任务里，而语言必须在
 *      **第一次渲染之前**就确定：晚一帧就会先按默认语言渲染一棵树再重渲，
 *      用户看到中文闪一下变英文（英文用户反过来看到中文闪一下）；
 *   2. **失败是静默的**。persist 的默认存储探测在不可访问时返回 undefined 并只打
 *      一条 warn，之后所有写入被丢弃——界面照常切换，重启后偏好丢失，且不报错；
 *   3. 这里只需要「同步读一次、写入时同步落盘」这一个语义，手写二十行比配置
 *      middleware 的 hydration/merge/partialize/migrate 四个钩子更清楚。
 *
 * 读写都自带降级：存储不可用时偏好只在本次会话生效，界面功能不受影响。
 */
function readStoredLanguage(): LanguagePreference {
  try {
    const raw = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY)
    if (!raw) return 'system'
    const parsed = JSON.parse(raw) as { state?: { language?: unknown } }
    const value = parsed?.state?.language
    return isLanguagePreference(value) ? value : 'system'
  } catch {
    // JSON 损坏或 localStorage 不可访问：回到「跟随系统」，而不是让启动失败
    return 'system'
  }
}

function writeStoredLanguage(language: LanguagePreference): void {
  try {
    globalThis.localStorage?.setItem(
      LOCALE_STORAGE_KEY,
      JSON.stringify({ state: { language }, version: STORAGE_VERSION })
    )
  } catch {
    // 隐私模式 / 存储配额：不打断切换，仅本次会话生效
  }
}

/** 系统语言探测：navigator.languages 已按用户偏好排序，第一个能识别的即为系统语言 */
export function detectSystemLocale(): Locale {
  if (typeof navigator === 'undefined') return 'zh-CN'
  const languages = navigator.languages && navigator.languages.length > 0 ? navigator.languages : [navigator.language]
  return detectLocale(languages)
}

/** 偏好 → 实际语言 */
export function resolveLocale(language: LanguagePreference): Locale {
  return language === 'system' ? detectSystemLocale() : language
}

export const useLocaleStore = create<LocaleState>((set) => ({
  // 初始值同步从存储读出：首屏渲染拿到的就是最终语言，没有二次切换
  language: readStoredLanguage(),
  setLanguage: (language) => {
    // 脏值防御：偏好来自 localStorage 与设置页，任一处写入非法值都会让
    // resolveLocale 走进未定义分支，这里统一挡在入口
    if (!isLanguagePreference(language)) return
    writeStoredLanguage(language)
    set({ language })
  },
}))

/** 非组件场景（store / service / 工具函数）取当前语言 */
export function currentLocale(): Locale {
  return resolveLocale(useLocaleStore.getState().language)
}
