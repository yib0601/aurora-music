/**
 * 日志内核的类型契约。
 *
 * 分工：**本目录只管「记录长什么样、怎么脱敏、怎么排版」**，
 * 不碰文件系统、不碰 IPC、不碰 Electron —— 同一份代码要被
 * 主进程（CJS require dist）、渲染进程（Vite/ESM）、移动端 WebView 三处消费。
 * 「写到哪、怎么滚动、怎么导出」是各端各自的 sink / exporter。
 *
 * 之所以把内核放在 shared 而不是 desktop：渲染进程也必须能发记录
 * （UI 里的 console.warn、未捕获异常、React 边界），而它拿不到 Node fs。
 */

/** 日志级别，顺序即严重程度（数值越大越严重） */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

/** 记录来源进程：导出成单文件后，靠它分辨「主进程说的」还是「界面说的」 */
export type LogOrigin = 'main' | 'renderer' | 'mobile'

/**
 * 一条日志记录。
 *
 * 为什么字段是「已脱敏的字符串」而不是原始对象：
 * 记录会先过 sink 再落盘，若把活对象传下去，任何一处忘了脱敏就等于把凭据写进
 * 用户要发给开发者的文件里。**脱敏在创建记录时一次性完成**，sink 拿到的永远是安全的。
 */
export interface LogRecord {
  /** 毫秒时间戳（epoch） */
  ts: number
  level: LogLevel
  origin: LogOrigin
  /** 模块标识：updater / player / console …（由调用点或 console 前缀 `[Xxx]` 得到） */
  scope: string
  /** 已脱敏的单行主文案 */
  message: string
  /** 附加参数的序列化结果（已脱敏），通常是 JSON；没有附加参数时不出现 */
  detail?: string
  /** 错误堆栈（已脱敏）；只有参数里出现 Error 时才出现 */
  stack?: string
}

/**
 * 记录出口。
 *
 * 允许抛错：内核会吞掉 sink 的异常并继续投递给下一个 sink ——
 * 日志系统自身的故障绝不能让播放器崩溃。
 */
export type LogSink = (record: LogRecord) => void

/** 级别门槛与来源 */
export interface LoggingConfig {
  level: LogLevel
  origin: LogOrigin
}

/** 初始化参数 */
export interface LoggingOptions {
  /** 可以多个：主进程要「文件 + 控制台备份」两条路时就是两个 sink */
  sinks: LogSink[]
  /** 门槛级别，默认 info（开发期由调用方传 debug） */
  level?: LogLevel
  /** 来源进程，默认 main */
  origin?: LogOrigin
}

/** 对外暴露的 logger：级别方法 + 子作用域 */
export interface Logger {
  trace(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  fatal(message: string, ...args: unknown[]): void
  /** 派生同源子 logger（scope 拼成 `parent.child`），用于把模块层级带进日志 */
  child(scope: string): Logger
  /** 当前是否会被记录（供热点路径提前短路，避免白做脱敏与序列化） */
  enabled(level: LogLevel): boolean
  readonly scope: string
}

/** 级别数值表：比较与门槛过滤都走它，避免各处各写一份 switch */
export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

/** 从任意字符串解析级别（环境变量、设置项），不合法时返回 null 由调用方回退 */
export function parseLogLevel(value: unknown): LogLevel | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  return normalized in LOG_LEVEL_ORDER ? (normalized as LogLevel) : null
}
