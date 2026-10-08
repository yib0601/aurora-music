import type { Locale } from './locale'

/**
 * 区域感知格式化（全走 Intl，不手写千分位与月份表）。
 *
 * 为什么单独成文件而不是塞进 core：
 * 格式化与翻译是两件事——翻译决定**说什么**，格式化决定**怎么写**。
 * 中文界面下也要能正确显示英文歌名里的数字/日期，反之亦然。
 */

const numberFormats = new Map<string, Intl.NumberFormat>()
const dateFormats = new Map<string, Intl.DateTimeFormat>()
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>()

function numberFormat(locale: Locale, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const cacheKey = `${locale}|${JSON.stringify(options ?? {})}`
  const cached = numberFormats.get(cacheKey)
  if (cached) return cached
  const created = new Intl.NumberFormat(locale, options)
  numberFormats.set(cacheKey, created)
  return created
}

function dateFormat(locale: Locale, options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const cacheKey = `${locale}|${JSON.stringify(options ?? {})}`
  const cached = dateFormats.get(cacheKey)
  if (cached) return cached
  const created = new Intl.DateTimeFormat(locale, options)
  dateFormats.set(cacheKey, created)
  return created
}

/** 数字（默认带千分位） */
export function formatNumber(value: number, locale: Locale, options?: Intl.NumberFormatOptions): string {
  return numberFormat(locale, options).format(value)
}

/** 百分比：入参是 0–1 的比例 */
export function formatPercent(ratio: number, locale: Locale, fractionDigits = 0): string {
  return numberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(ratio)
}

/** 日期（默认「年月日」短式） */
export function formatDate(value: Date | number, locale: Locale, options?: Intl.DateTimeFormatOptions): string {
  return dateFormat(locale, options ?? { year: 'numeric', month: 'short', day: 'numeric' }).format(value)
}

/** 时间（默认时分） */
export function formatTime(value: Date | number, locale: Locale): string {
  return dateFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(value)
}

/** 日期 + 时间 */
export function formatDateTime(value: Date | number, locale: Locale): string {
  return dateFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}

/**
 * 相对时间（"3 分钟前" / "3 minutes ago"）。
 * 由调用方给出已算好的差值，避免这里依赖「现在」而变得不可测。
 */
export function formatRelativeTime(
  value: Date | number,
  locale: Locale,
  base: Date | number = Date.now()
): string {
  const cacheKey = `${locale}|relative`
  let formatter = relativeFormats.get(cacheKey)
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
    relativeFormats.set(cacheKey, formatter)
  }
  const deltaSeconds = (new Date(value).getTime() - new Date(base).getTime()) / 1000
  const abs = Math.abs(deltaSeconds)
  if (abs < 60) return formatter.format(Math.round(deltaSeconds), 'second')
  if (abs < 3600) return formatter.format(Math.round(deltaSeconds / 60), 'minute')
  if (abs < 86400) return formatter.format(Math.round(deltaSeconds / 3600), 'hour')
  if (abs < 2592000) return formatter.format(Math.round(deltaSeconds / 86400), 'day')
  if (abs < 31536000) return formatter.format(Math.round(deltaSeconds / 2592000), 'month')
  return formatter.format(Math.round(deltaSeconds / 31536000), 'year')
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * 字节数：1024 进制 + 单位符号（KB/MB/GB）。
 * 单位符号两种语言一致，只有小数位数受语言影响（中文习惯 1 位，英文 1–2 位），
 * 因此同一份逻辑下按 locale 决定 maximumFractionDigits。
 */
export function formatBytes(bytes: number, locale: Locale): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${BYTE_UNITS[0]}`
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const digits = unitIndex === 0 ? 0 : value < 10 ? 2 : 1
  const formatted = numberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value)
  return `${formatted} ${BYTE_UNITS[unitIndex]}`
}

/**
 * 播放时长：`mm:ss` / `h:mm:ss`。
 * 刻意**不跟随语言**：这是播放器的时间码，两种语言下都用同一形态，
 * 且必须保持等宽数字，否则进度条旁的秒数会跳动。
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`
}

/**
 * 用语言自己的连接词拼接列表（"A、B 和 C" / "A, B and C"）。
 * 依赖 ES2021 的 Intl.ListFormat（Node 20 / Chromium 已全量支持）。
 */
export function formatList(items: readonly string[], locale: Locale): string {
  if (items.length === 0) return ''
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items)
}

/**
 * 文件体积的人类可读形态（用于日志与错误消息）。
 * fallback 走十进制小数，避免把「未知体积」显示成 NaN。
 */
export function formatByteCount(bytes: number | null | undefined, locale: Locale): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—'
  return formatBytes(bytes, locale)
}
