/**
 * 记录的文本排版（单行 + 缩进堆栈）。
 *
 * 采用**一行一条**而不是 JSONL：用户/开发者用记事本打开就能读，
 * grep 也天然按记录命中；堆栈是多行，统一缩进在记录下方，不破坏「一条一行」的定位。
 * 时间必须是**带时区偏移**的 ISO 8601 —— 容器默认 UTC，而无偏移的时间串
 * 让人无法判断用户本地到底几点（项目约定：时间一律显式时区）。
 */

import { REDACTED } from './redact'
import type { LogRecord } from './types'

const pad = (value: number, width = 2) => String(Math.abs(value)).padStart(width, '0')

/**
 * 时间戳排版：`2026-10-30T02:15:11.123+08:00`。
 *
 * 用本地时间 + 显式偏移：用户在哪个时区，日志就显示哪个时区，
 * 偏移量又能让开发者换算回 UTC，两边都不丢信息。
 */
export function formatTimestamp(ts: number): string {
  // 入参来自外部（IPC 负载、跨进程记录），`new Date(Symbol())` 会抛 TypeError，
  // 而这里是排版路径 —— 排版抛错就丢记录。所以先判类型再构造。
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '1970-01-01T00:00:00.000+00:00'
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '1970-01-01T00:00:00.000+00:00'
  // getTimezoneOffset 是「UTC - 本地」的分钟数（东八区为 -480），取反得到东正西负
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** 堆栈缩进：每行前加两个空格，避免与「下一条记录」的时间戳列混淆 */
export function indentStack(stack: string): string {
  return stack
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

/** 单条记录 → 文本行（末尾不带换行，由 sink 决定分隔符） */
export function formatRecord(record: LogRecord): string {
  const level = record.level.toUpperCase().padEnd(5)
  const scope = record.scope ? record.scope : 'app'
  const head = `${formatTimestamp(record.ts)} ${level} [${record.origin}] ${scope}: ${record.message}`
  const withDetail = record.detail ? `${head} ${record.detail}` : head
  return record.stack ? `${withDetail}\n${indentStack(record.stack)}` : withDetail
}

/** 批量排版（主要给「内存里攒了一批再落盘」的 sink 用） */
export function formatRecords(records: LogRecord[]): string {
  return records.map((record) => `${formatRecord(record)}\n`).join('')
}

/** 打码占位符在排版层的重导出：导出实现不该自己硬编码 `***` */
export { REDACTED }
