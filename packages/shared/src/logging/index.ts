/**
 * 日志内核的统一出口。
 *
 * 三端（Electron 主进程 / 渲染进程 / Android WebView）都从这里取：
 * 主进程走 `require('@aurora/shared')` 的 CJS 产物，另两处走 Vite 的 ESM 路径，
 * 所以这里只导出纯函数与类型，**不引入任何平台 API**。
 */

export { LOG_LEVEL_ORDER, parseLogLevel } from './types'
export type { LogLevel, LogOrigin, LogRecord, LogSink, Logger, LoggingConfig, LoggingOptions } from './types'

export { REDACTED, isSecretKey, redactText, redactValue, safeStringify } from './redact'
export { formatRecord, formatRecords, formatTimestamp, indentStack } from './format'
export {
  addLogSink,
  createLogger,
  getLogLevel,
  getLogOrigin,
  getLogger,
  initLogging,
  isLoggingReady,
  logSessionStart,
  setLogLevel,
} from './logger'
export { captureConsole, formatConsoleArgs, installErrorCapture, splitScopePrefix } from './capture'
export type { CaptureConsoleOptions } from './capture'
export { buildLogBundle, formatEnvironment, logBundleFileName } from './bundle'
export type { LogEnvironment, LogFilePart } from './bundle'
export { LOG_IPC } from './ipcContract'
export type {
  LogAppendPayload,
  LogBundleResult,
  LogExportResult,
  LogFileInfo,
  LoggingRendererApi,
  LogStorageInfo,
  RendererEnvironment,
} from './ipcContract'
