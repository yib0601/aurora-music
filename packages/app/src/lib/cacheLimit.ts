import { formatNumber } from '@aurora/shared'
import { appTranslate } from '@/i18n'
import { currentLocale } from '@/stores/localeStore'

/**
 * 媒体缓存容量档位的换算与校验（纯逻辑，无 React 渲染依赖）。
 *
 * 落盘与下发给主进程的唯一载体始终是 store 的 `audioCacheLimitMB`（整数 MB），
 * 而设置页对用户展示的档位一律是 GB —— 换算只在这里发生，页面里不再散落 1024 运算，
 * 否则「输入框按 GB、落盘按 MB、胶囊按 GB」三处各写一遍，极易漂移。
 *
 * 文案与数字格式在**每次调用时**取（`appTranslate()` / `currentLocale()`）：
 * 本模块没有渲染周期，把译文缓存成模块级常量会把语言冻结在加载那一刻。
 *
 * 0 = 不限制容量（不驱逐、照常缓存）：这不是一个「容量数值」，而是一个档位标记，
 * 由 store 的专用入口写入，换算函数只负责把它展示成「不限制」，不参与钳制。
 */

/** 自定义档位下界：低于 0.5 GB 起不到缓存作用，不如直接清空 */
export const CACHE_LIMIT_MIN_GB = 0.5
/** 自定义档位上界：100 GB 已是本机磁盘量级，再大等同于不限制，引导用户选「不限制」档 */
export const CACHE_LIMIT_MAX_GB = 100

/** 一档一档的常用容量，覆盖「小内存手机 / 桌面 / 免维护」三类诉求 */
export const GB_PRESETS: readonly number[] = [1, 2, 5, 10, 50]

/** MB → GB（保留原始精度，仅做除法，展示格式化交给 formatCacheLimit） */
export function mbToGb(mb: number): number {
  return mb / 1024
}

/** GB → MB：四舍五入到整数 MB，避免浮点误差在 store 里留下 1535.99 这种值 */
export function gbToMb(gb: number): number {
  return Math.round(gb * 1024)
}

/**
 * 展示用文案：0（及非正数）→「不限制」，其余按 GB 显示并去掉多余的零。
 * 最多保留两位小数：MB 是整数，GB 最多三位小数，两位足够表达 0.5 / 1.5 这类档位，
 * 也用 `Number()` 一次抹掉 `toFixed` 补出的尾随零（1.00 → 1、0.50 → 0.5）。
 *
 * 单位符号 GB 是国际单位（两种语言同形），只有数字部分走 Intl；
 * 「不限制」是文案，走字典（见 runtime.cache.unlimited）。
 */
export function formatCacheLimit(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) return appTranslate()('runtime.cache.unlimited')
  const gb = Number(mbToGb(mb).toFixed(2))
  return `${formatNumber(gb, currentLocale())} GB`
}

/**
 * 解析输入框草稿（单位 GB）→ 落库用的 MB。
 * 返回 `null` 表示草稿不可用（空串 / 非数字 / ≤ 0 / 越界），由调用方给出非法提示，
 * 这里不做钳制：静默把用户填错的数字改成边界值，会让人以为「填 200 也能生效」。
 */
export function parseCacheLimitGbDraft(raw: string): number | null {
  const text = raw.trim()
  if (text === '') return null
  const gb = Number(text)
  if (!Number.isFinite(gb)) return null
  if (gb <= 0) return null
  if (gb < CACHE_LIMIT_MIN_GB || gb > CACHE_LIMIT_MAX_GB) return null
  return gbToMb(gb)
}