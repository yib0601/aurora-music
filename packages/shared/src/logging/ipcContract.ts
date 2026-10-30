/**
 * 日志 IPC 契约（主进程 / preload / 渲染进程三方共用）。
 *
 * 为什么单独成文件：transmit 的两端由不同人实现（preload 在主进程侧，调用方在渲染层），
 * 通道名写错不会编译报错，只会静默返回 undefined —— 而这条路径偏偏只在「用户来要日志」
 * 的那一刻才被走到，静默失败等于白做一套系统。把通道名与请求/响应形状放进 shared，
 * 两侧都 import 同一个常量，`tsc` 就能替我们守住拼写与字段。
 *
 * 通道划分（都是 `invoke`，需要返回值）：
 * - `logging:bundle`  → 读出全部日志并拼成单文本包（不落盘，供预览/复制）
 * - `logging:export`  → 落盘到用户「下载」目录并返回路径
 * - `logging:reveal`  → 在文件管理器中定位某个文件
 * - `logging:info`    → 日志目录占用、文件列表等状态（设置页展示用）
 */

import type { LogEnvironment } from './bundle'

/** 通道名常量：唯一真源，两侧只准引用它 */
export const LOG_IPC = {
  bundle: 'logging:bundle',
  exportFile: 'logging:export',
  reveal: 'logging:reveal',
  info: 'logging:info',
  /** 渲染层 → 主进程的单向记录通道（渲染层的日志也要落到同一个文件里） */
  record: 'logging:record',
} as const

/** 日志文件清单项（设置页展示「有哪些文件、多大」） */
export interface LogFileInfo {
  name: string
  sizeBytes: number
  mtime: number
}

/** 日志目录状态 */
export interface LogStorageInfo {
  /** 日志目录绝对路径（已脱敏，供用户自行翻看） */
  dir: string
  files: LogFileInfo[]
  totalBytes: number
  /** 单文件上限（字节） */
  maxFileBytes: number
  /** 最多保留文件数 */
  maxFiles: number
}

/** `logging:bundle` 的返回：文本内容 + 元信息 */
export interface LogBundleResult {
  fileName: string
  content: string
  /** 覆盖了多少个日志文件、总字节数（用于界面上的「导出范围」提示） */
  fileCount: number
  totalBytes: number
}

/** `logging:export` 的返回：落盘位置 */
export interface LogExportResult {
  filePath: string
  /** 所在目录（用于 reveal） */
  dir: string
  bytes: number
}

/**
 * 渲染层 → 主进程的记录负载。
 *
 * 刻意用**已排版好的单行字符串**而不是结构化 LogRecord：脱敏已经在渲染进程侧完成
 * （内核在记录创建时就做了），主进程只需追加写盘，不必再理解一遍记录结构。
 * `origin` 仍然带过来，因为主进程文件里要能区分「界面说的」和「主进程说的」。
 */
export interface LogAppendPayload {
  /** 已脱敏、已排版的整行（可含内嵌换行的堆栈） */
  line: string
}

/** 渲染层收集环境信息时能自己拿到的部分；其余由主进程补 */
export type RendererEnvironment = Pick<LogEnvironment, 'locale'>

/**
 * preload 暴露给渲染层的 `window.electronAPI.logging` 形状。
 *
 * 单独成类型而不是让两侧各写一遍：preload 在主进程侧编译（CJS），
 * 调用方在渲染层编译（ESM），两边不共享类型推导链，字段漂移只会在运行期才炸，
 * 而这条路径恰好只在「用户来要日志」那一刻被走到 —— 静默失败等于这套系统白做。
 */
export interface LoggingRendererApi {
  /** 读取全部日志并拼成单文本包（不落盘） */
  bundle(): Promise<LogBundleResult>
  /** 落盘到用户「下载」目录 */
  exportFile(): Promise<LogExportResult>
  /** 在文件管理器中定位文件 */
  reveal(filePath: string): Promise<void>
  /** 日志目录状态（文件清单、占用、上限） */
  info(): Promise<LogStorageInfo>
  /** 渲染层记录 → 主进程落盘（单向 fire-and-forget，不阻塞 UI） */
  record(payload: LogAppendPayload): void
}
