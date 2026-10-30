/**
 * console 与全局错误的接管。
 *
 * 为什么值得接管：
 * - 本项目现有 150+ 处 `console.warn` / `console.error` 已经写清了「哪里失败了」，
 *   它们只缺一个落盘出口。逐个改成 logger.* 是低收益高风险的大改；
 *   接管 console 让这些既有诊断**立刻进入日志包**，且以后新增代码自动受益。
 * - 用户报问题的时候，真正要的往往是「最后一次失败的原始堆栈」，而那多半来自
 *   未捕获异常 / 未处理的 rejection，没人调用 console 也不会有记录。
 *
 * 纪律：接管后**默认仍然输出到原始 console**（echo），开发期行为不变；
 * 且内核自身绝不再走 console（避免自我递归）。
 */

import { createLogger } from './logger'
import { redactText } from './redact'
import type { LogLevel } from './types'

/** 会接管的 console 方法 → 落到哪个日志级别 */
const CONSOLE_LEVELS: Record<string, LogLevel> = {
  trace: 'trace',
  debug: 'debug',
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
}

const consoleLogger = createLogger('console')

/**
 * 安全读属性：getter 可能抛错。
 *
 * 与 logger.ts 里的同名函数是**同一份逻辑**，刻意各留一份而不是抽到公共模块：
 * 它是三行代码，而两个文件的 import 关系已经够绕（capture → logger → redact），
 * 为它再加一层依赖只会让内核更难读。
 */
function safeRead<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

export interface CaptureConsoleOptions {
  /** 仍向原始 console 输出，默认 true（开发期体验不变） */
  echo?: boolean
  /** 覆盖默认的「方法 → 级别」映射 */
  levels?: Record<string, LogLevel>
  /** scope 前缀，如 'renderer'；最终 scope 形如 `<prefix>.<模块>` */
  scopePrefix?: string
  /** 已接管过的标记键：重复调用直接返回（幂等） */
  marker?: string
}

/** 已接管的标记：挂在 globalThis 上，多份模块副本也能共享（打包器可能重复内联） */
const CAPTURE_KEY = '__auroraConsoleCaptured__'

/**
 * 从 `[Foo]` 前缀提取 scope，并把前缀从文案里剥掉。
 *
 * 项目里的约定是用方括号标模块（`[Updater] 下载失败:`），直接拿来当 scope 最省事。
 * 剥掉前缀是为了避免排版后重复：`... [main] Updater: [Updater] 下载失败:`。
 */
export function splitScopePrefix(message: string): { scope: string; rest: string } {
  const match = /^\s*\[([^\]\n]{1,32})\]\s*/.exec(message)
  if (!match) return { scope: '', rest: message }
  return { scope: match[1].trim(), rest: message.slice(match[0].length) }
}

/**
 * 简化版的 console 格式串处理：只处理 `%s %d %i %f %j %o %O %c`。
 *
 * 不追求与浏览器完全一致：这些格式符在项目里用得极少，而**字符串化本身可能抛错**
 * （对象的 toString 抛、代理对象读属性抛），所以每一步都包在 try 里，
 * 出问题就退化成「值都进 detail」的形态，绝不因为格式化失败丢一条日志。
 */
export function formatConsoleArgs(args: unknown[]): { message: string; rest: unknown[] } {
  const first = args[0]
  if (typeof first !== 'string') return { message: '', rest: args }
  if (!/%[sdifjoOc]/.test(first)) return { message: first, rest: args.slice(1) }

  let index = 1
  const rest: unknown[] = []
  let message = ''
  let cursor = 0
  const specifier = /%([sdifjoOc])/g
  let match: RegExpExecArray | null
  while ((match = specifier.exec(first)) !== null) {
    message += first.slice(cursor, match.index)
    cursor = match.index + match[0].length
    const kind = match[1]
    if (kind === 'c') {
      // %c 是样式指令，参数是 CSS，不参与输出
      index += 1
      continue
    }
    if (index >= args.length) {
      // 占位符多于实参：原样保留 `%s`，与浏览器行为一致
      message += match[0]
      continue
    }
    const value = args[index]
    index += 1
    if (kind === 'j' || kind === 'o' || kind === 'O') {
      // 结构化参数交给 detail：塞进消息会把一行日志撑成几十行
      rest.push(value)
      message += `[${kind === 'j' ? 'json' : 'object'}]`
      continue
    }
    try {
      message += kind === 'd' || kind === 'i' ? String(Math.trunc(Number(value))) : String(value)
    } catch {
      rest.push(value)
      message += '[object]'
    }
  }
  message += first.slice(cursor)
  rest.push(...args.slice(index))
  return { message, rest }
}

/**
 * 接管 console（幂等）。
 *
 * 返回恢复函数（测试用；生产不恢复）。
 */
export function captureConsole(options: CaptureConsoleOptions = {}): () => void {
  const { echo = true, levels = CONSOLE_LEVELS, scopePrefix = '', marker = CAPTURE_KEY } = options
  const global = globalThis as Record<string, unknown>
  if (global[marker]) return () => {}
  global[marker] = true

  const original = new Map<string, (...args: unknown[]) => void>()
  const restore = () => {
    for (const [name, fn] of original) {
      ;(console as unknown as Record<string, unknown>)[name] = fn
    }
    original.clear()
    global[marker] = false
  }

  for (const [name, level] of Object.entries(levels)) {
    const current = (console as unknown as Record<string, unknown>)[name]
    if (typeof current !== 'function') continue
    const originalFn = (current as (...args: unknown[]) => void).bind(console)
    original.set(name, originalFn)

    ;(console as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      if (echo) {
        try {
          originalFn(...args)
        } catch {
          // 原始输出失败（例如 stdout 已关闭）不影响记录
        }
      }
      try {
        const { message, rest } = formatConsoleArgs(args)
        const { scope, rest: text } = splitScopePrefix(message)
        const composed = [scopePrefix, scope || name].filter(Boolean).join('.')
        consoleLogger.child(composed)[level](text, ...rest)
      } catch {
        // 接管层自身故障绝不影响宿主
      }
    }
  }

  return restore
}

/**
 * 把任意异常值整理成可记录的形状（Error 保留对象本身交给内核取堆栈，其它值原样）。
 *
 * 这里对 `reason.message` / `reason.name` 的读取一律走 safeRead：被 rejected 的
 * 值完全可能是「getter 会抛错的 Error」或 Proxy，读属性就抛 ——
 * 而这段代码正跑在 `unhandledrejection` 处理器里，抛出去就是「处理器自己炸」。
 */
function toErrorDetail(reason: unknown): { message: string; args: unknown[] } {
  if (reason instanceof Error) {
    const message = safeRead(() => reason.message)
    const name = safeRead(() => reason.name)
    const text = typeof message === 'string' && message ? message : typeof name === 'string' ? name : 'Error'
    return { message: redactText(text), args: [reason] }
  }
  if (typeof reason === 'string') return { message: redactText(reason), args: [] }
  return { message: 'uncaught non-error value', args: [reason] }
}

/**
 * 安装全局错误捕获。
 *
 * `kind` 决定挂在哪：主进程用 process 事件，渲染进程用 window 事件。
 * **不改变原有行为**：记录之后不退出、不阻止默认处理 ——
 * 本项目的语义是「崩溃也要把现场留在文件里」，而不是把崩溃变成静默重启。
 */
export function installErrorCapture(kind: 'main' | 'renderer'): () => void {
  const logger = createLogger('crash')
  const cleanups: Array<() => void> = []

  if (kind === 'main') {
    const onException = (error: Error) => {
      logger.fatal('uncaughtException', error)
    }
    const onRejection = (reason: unknown) => {
      const { message, args } = toErrorDetail(reason)
      logger.error(`unhandledRejection: ${message}`, ...args)
    }
    process.on('uncaughtException', onException)
    process.on('unhandledRejection', onRejection)
    cleanups.push(() => {
      process.off('uncaughtException', onException)
      process.off('unhandledRejection', onRejection)
    })
  } else {
    const onError = (event: ErrorEvent) => {
      const error = safeRead(() => event.error)
      if (error instanceof Error) {
        const message = safeRead(() => event.message) || safeRead(() => error.message) || 'unknown'
        logger.error(`window.onerror: ${redactText(String(message))}`, error)
      } else {
        logger.error(`window.onerror: ${redactText(String(safeRead(() => event.message) || 'unknown'))}`, {
          filename: safeRead(() => event.filename),
          lineno: safeRead(() => event.lineno),
          colno: safeRead(() => event.colno),
        })
      }
    }
    const onRejection = (event: PromiseRejectionEvent) => {
      const { message, args } = toErrorDetail(safeRead(() => event.reason))
      logger.error(`unhandledrejection: ${message}`, ...args)
    }
    // 资源加载失败（img/audio/script）不会冒泡到 window.error，要用捕获阶段；
    // 封面/音频加载失败是用户报得最多的一类问题，值得单独记
    const onResourceError = (event: Event) => {
      const target = safeRead(() => event.target) as (Element & { src?: string; href?: string }) | null
      if (!target || target === (window as unknown as Element)) return
      const url = safeRead(() => target.src || target.href) || ''
      if (!url) return
      const tag = safeRead(() => target.tagName?.toLowerCase()) ?? 'unknown'
      logger.warn(`resource load failed: <${tag}>`, { url })
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    window.addEventListener('error', onResourceError, true)
    cleanups.push(() => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('error', onResourceError, true)
    })
  }

  return () => cleanups.forEach((fn) => fn())
}
