/**
 * 日志内核：级别门槛、记录构造（含脱敏）、投递给 sink。
 *
 * 三条硬约束：
 * 1. **绝不抛错**：日志路径上的任何异常（脱敏遇到怪对象、sink 自己炸了）都必须被吞掉。
 *    日志系统的故障不该让播放器崩，这是它存在的意义的反面。
 * 2. **记录创建即脱敏**：见 redact.ts 顶部说明。
 * 3. **无平台依赖**：不 import fs / electron / DOM，主进程与渲染进程共用。
 */

import { safeStringify, redactText } from './redact'
import { LOG_LEVEL_ORDER, parseLogLevel } from './types'
import type { Logger, LogLevel, LogOrigin, LogRecord, LogSink, LoggingOptions } from './types'

/** 默认作用域：没有模块归属的记录（如未捕获异常）落到这里 */
const DEFAULT_SCOPE = 'app'

/** 未初始化的状态：sink 为空即「不记录」，不做任何脱敏与序列化开销 */
const config: { sinks: LogSink[]; level: LogLevel; origin: LogOrigin } = {
  sinks: [],
  level: 'info',
  origin: 'main',
}

/**
 * 初始化（可重复调用）。
 *
 * 重复调用会**替换** sink 列表：主进程启动早期先不落盘、拿到 userData 路径后再接文件，
 * 渲染进程在平台能力就绪后再接传输层，两次调用都是「换成正式出口」的语义。
 */
export function initLogging(options: LoggingOptions): void {
  config.sinks = Array.isArray(options.sinks) ? options.sinks.filter((sink) => typeof sink === 'function') : []
  config.level = parseLogLevel(options.level) ?? config.level
  config.origin = options.origin ?? config.origin
}

/** 追加 sink（保留已有的），用于「控制台 + 文件」双出口 */
export function addLogSink(sink: LogSink): void {
  if (typeof sink === 'function' && !config.sinks.includes(sink)) config.sinks.push(sink)
}

/** 是否已经有出口：热点路径可据此跳过参数序列化 */
export function isLoggingReady(): boolean {
  return config.sinks.length > 0
}

/** 当前门槛级别 */
export function getLogLevel(): LogLevel {
  return config.level
}

/** 调整门槛级别（环境变量 / 设置项在运行期变更时用） */
export function setLogLevel(level: LogLevel | string): void {
  const parsed = parseLogLevel(level)
  if (parsed) config.level = parsed
}

/** 当前来源进程 */
export function getLogOrigin(): LogOrigin {
  return config.origin
}

function enabled(level: LogLevel): boolean {
  return config.sinks.length > 0 && LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[config.level]
}

/**
 * 安全读取对象属性：getter 可能抛错。
 *
 * `error.stack` / `error.message` 都不是普通字段——第三方库、上游 SDK、
 * 甚至被代理过的对象会给它们装 getter，读一次就抛。**日志路径必须假设
 * 拿到的是恶意/畸形值**：这里读取失败就返回 undefined，绝不让异常冒出去。
 */
function safeRead<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

/**
 * 从任意值里安全取出「名字 + 消息 + 堆栈」。
 *
 * 单独成函数是因为它有真实存在的最坏情形：`installErrorCapture` 会把
 * **任何** 未捕获异常喂进来，而那个异常恰好是「message getter 抛错的 Error」时，
 * 记录构造阶段自己抛错 —— 崩溃处理器在崩溃处理中崩溃，进程直接退出（实测 exit 7），
 * 用户连一条日志都拿不到。这正是日志系统最不该失败的时刻。
 */
function describeError(error: Error): { stack?: string; name: string; message: string } {
  // 用 Object.prototype 上的原生读取作为最后兜底：即便 Error 子类重写了 getter，
  // 原型链上的访问器仍可能可用，能捞回一点是一点
  const name = safeRead(() => error.name) ?? safeRead(() => String(error)) ?? 'Error'
  const message = safeRead(() => error.message) ?? ''
  const stack = safeRead(() => error.stack)
  return {
    name: typeof name === 'string' ? name : 'Error',
    message: typeof message === 'string' ? message : String(message),
    ...(typeof stack === 'string' && stack ? { stack } : {}),
  }
}

/**
 * 构造并投递一条记录。
 *
 * `message` 允许非字符串（console.log(obj) 这类调用），此时把它并进 detail，
 * 主文案留空 —— 比强行 `String(obj)` 成 `[object Object]` 有用得多。
 *
 * **整段包在 try 里**：这是「绝不抛错」承诺的落点。记录构造要读属性、做脱敏、
 * 跑 JSON.stringify，每一项都可能被畸形输入（抛错的 getter、Proxy、循环结构）
 * 顶到异常。信号是：宁可丢这一条日志，也不能让记录本身成为新的故障源。
 */
function emit(level: LogLevel, scope: string, message: unknown, args: unknown[]): void {
  if (!enabled(level)) return

  try {
    const messageIsText = typeof message === 'string'
    const text = messageIsText ? message : ''
    const rest: unknown[] = messageIsText ? args : [message, ...args]

    const record: LogRecord = {
      ts: Date.now(),
      level,
      origin: config.origin,
      scope: scope || DEFAULT_SCOPE,
      message: redactText(text),
    }

    if (rest.length > 0) {
      // 第一个 Error 的堆栈单独存：排版时整段缩进在记录下方，比塞进一行 JSON 可读
      const error = safeRead(() => rest.find((item): item is Error => item instanceof Error)) ?? undefined
      if (error) {
        const described = describeError(error)
        const stackText = described.stack ?? `${described.name}: ${described.message}`
        record.stack = redactText(stackText)
      }
      record.detail = safeStringify(rest.length === 1 ? rest[0] : rest)
    }

    for (const sink of config.sinks) {
      try {
        sink(record)
      } catch {
        // 单个出口故障不影响其它出口，更不影响宿主进程
      }
    }
  } catch {
    // 记录构造阶段故障（畸形输入）：丢这一条。不递归、不再记日志 ——
    // 在这里记日志会把自己再带进来一次，最坏情况变成无限递归
  }
}

/** 创建带作用域的 logger（模块级常量，避免每次调用都重新拼 scope） */
export function createLogger(scope: string): Logger {
  const logger: Logger = {
    scope,
    trace: (message, ...args) => emit('trace', scope, message, args),
    debug: (message, ...args) => emit('debug', scope, message, args),
    info: (message, ...args) => emit('info', scope, message, args),
    warn: (message, ...args) => emit('warn', scope, message, args),
    error: (message, ...args) => emit('error', scope, message, args),
    fatal: (message, ...args) => emit('fatal', scope, message, args),
    child: (childScope) => createLogger(scope ? `${scope}.${childScope}` : childScope),
    enabled: (level) => enabled(level),
  }
  return logger
}

/** 取默认 logger（scope 留空 → 'app'）；等价于 createLogger('') 的便捷形式 */
export function getLogger(scope = DEFAULT_SCOPE): Logger {
  return createLogger(scope)
}

/**
 * 会话起点标记：导出的日志包里有这一行，就能一眼看出「这次启动从哪开始」，
 * 与崩溃后的最后一条记录之间的区间就是要排查的现场。
 */
export function logSessionStart(context: Record<string, unknown>): void {
  getLogger('app').info('session start', context)
}
