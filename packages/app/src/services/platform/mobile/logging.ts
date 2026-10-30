/**
 * 移动端日志落盘与导出（Capacitor Filesystem）。
 *
 * 为什么分成「录制」与「导出」两个位置：
 * - **录制**必须永远成功，所以写应用专属目录（Directory.Data，不需要任何存储权限）。
 *   若录制路径依赖公共目录，Android 11+ 没授予「所有文件访问」时就会一条日志都留不下，
 *   而那恰恰是最需要日志的现场（权限没给、目录建不出来）。
 * - **导出**是用户主动触发的一次性动作，才值得去写公共目录（Download/Aurora Music/logs），
 *   因为它需要用户能自己用文件管理器找到；未授权时退回应用专属目录并如实返回该路径 ——
 *   宁可给一个能读到的位置，也不要因权限弹窗把导出整个挡住。
 *
 * 写入节奏：渲染层的每条记录都同步进队列，攒到阈值或隔 FLUSH_DELAY_MS 才真正写盘。
 * 逐条 await 写盘会阻塞 UI（WebView 的 Filesystem 调用是跨桥异步），而日志量在
 * 异常循环里可能瞬间上千条；攒批把桥调用次数从「每行一次」压到「每批一次」。
 * 进程被系统杀掉时不保证最后一批落盘，这是有意的取舍：日志次要，UI 流畅优先。
 */
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import {
  buildLogBundle,
  logBundleFileName,
  type LogAppendPayload,
  type LogBundleResult,
  type LogEnvironment,
  type LogExportResult,
  type LogFileInfo,
  type LogFilePart,
  type LogStorageInfo,
} from '@aurora/shared'
import { checkAllFilesAccess } from '@/services/permission'

/** 日志根目录：应用专属存储，无需权限，卸载随应用清除 */
const LOG_DIR = 'aurora-music/logs'
/** 导出目录：外部存储下用户可见位置（与下载目录同源，用户已经知道去哪找） */
const EXPORT_DIR = 'Download/Aurora Music/logs'
/** 未获「所有文件访问」时的导出退路：仍然可用，只是需要别的途径取出文件 */
const INTERNAL_EXPORT_DIR = 'aurora-music/log-exports'

/** 单文件上限：超过即停止追加，只写一行截断标记 */
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** 最多保留的文件数（按 mtime 从旧到新删） */
const MAX_FILES = 5
/** 攒够这么多行立即冲刷：异常循环里不必等定时器 */
const FLUSH_BATCH = 20
/** 静止期最长等待：日志落后 2 秒足够定位问题，再久会让「刚做的操作」不在包里 */
const FLUSH_DELAY_MS = 2000
/** 截断标记：与 shared 排版层的英文口径一致，避免同一份文件里中英混杂 */
const TRUNCATED_MARK = '(log file size limit reached; further lines were dropped)'

/**
 * 移动端能自行采集的环境信息。
 *
 * 由调用方（platform/mobile/index.ts）注入而不是在这里 import 应用模块：
 * 本模块只该知道「怎么写文件」，版本号与当前语言的取值属应用层，
 * 在这里 import 会把它和 stores / update.service 耦成环。
 */
export interface MobileLogEnvironment {
  appVersion: string
  /** Capacitor.getPlatform()：android / ios */
  platform: string
  locale?: string
  runtime?: string
  arch?: string
}

/** 待写盘的行（已由内核脱敏并排版） */
let pending: string[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
/** 串行化写盘：并发 append 会让同一文件的行交错 */
let flushChain: Promise<void> = Promise.resolve()
/** 已写过截断标记：同一文件只写一次，否则标记本身会把文件撑满 */
let truncatedNotified = false
/** 已清理过一轮旧文件：清理只需每天做一次，不必每批都 readdir */
let pruned = false

const pad = (value: number) => String(value).padStart(2, '0')

/** 日志文件名按本地日期切分：一天一个文件，排障时「哪天的」一眼可见 */
function dayFile(ts: number): string {
  const date = new Date(ts)
  return `renderer-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.log`
}

function sizeOfText(text: string): number {
  try {
    return new TextEncoder().encode(text).length
  } catch {
    // 极端环境没有 TextEncoder 时按字符数近似：只用于展示占用，不需要精确
    return text.length
  }
}

function dirOf(filePath: string): string {
  const index = filePath.lastIndexOf('/')
  return index > 0 ? filePath.slice(0, index) : filePath
}

function toNativePath(uri: string): string {
  return (uri || '').replace(/^file:\/\//, '')
}

async function ensureLogDir(): Promise<void> {
  try {
    await Filesystem.mkdir({ path: LOG_DIR, directory: Directory.Data, recursive: true })
  } catch {
    // 目录已存在时 Capacitor 会抛错，属于正常情况
  }
}

/** 文件大小；不存在或读不到时返回 null（调用方据此决定要不要建档） */
async function sizeOfLog(path: string): Promise<number | null> {
  try {
    const stat = await Filesystem.stat({ path, directory: Directory.Data })
    return typeof stat.size === 'number' ? stat.size : 0
  } catch {
    return null
  }
}

/** 列出日志文件（只认本模块的命名，避免把同目录里别的东西算进占用） */
async function listLogFiles(): Promise<LogFileInfo[]> {
  try {
    const result = await Filesystem.readdir({ path: LOG_DIR, directory: Directory.Data })
    const files: LogFileInfo[] = []
    for (const entry of result.files) {
      if (entry.type !== 'file' || !/^renderer-\d{8}\.log$/.test(entry.name)) continue
      let mtime = 0
      try {
        const stat = await Filesystem.stat({ path: `${LOG_DIR}/${entry.name}`, directory: Directory.Data })
        mtime = typeof stat.mtime === 'number' ? stat.mtime : 0
      } catch {
        // stat 失败不影响文件本身可用，mtime 留 0 由排序兜底
      }
      files.push({ name: entry.name, sizeBytes: entry.size ?? 0, mtime })
    }
    return files.sort((a, b) => a.mtime - b.mtime)
  } catch {
    return []
  }
}

/** 保留最新 MAX_FILES 个文件：数量上限比单文件上限更重要，总占用才有界 */
async function pruneOldFiles(): Promise<void> {
  const files = await listLogFiles()
  const excess = files.length - MAX_FILES
  if (excess <= 0) return
  for (const file of files.slice(0, excess)) {
    try {
      await Filesystem.deleteFile({ path: `${LOG_DIR}/${file.name}`, directory: Directory.Data })
    } catch {
      // 删不掉就留着：占用上限是尽力而为，不能因此中断写盘
    }
  }
}

async function writeLines(lines: string[]): Promise<void> {
  try {
    await ensureLogDir()
    const path = `${LOG_DIR}/${dayFile(Date.now())}`
    const size = await sizeOfLog(path)
    if (size !== null && size >= MAX_FILE_BYTES) {
      if (!truncatedNotified) {
        truncatedNotified = true
        await Filesystem.appendFile({
          path,
          directory: Directory.Data,
          data: `${TRUNCATED_MARK}\n`,
          encoding: Encoding.UTF8,
        })
      }
      return
    }
    await Filesystem.appendFile({
      path,
      directory: Directory.Data,
      data: `${lines.join('\n')}\n`,
      encoding: Encoding.UTF8,
    })
    if (!pruned) {
      pruned = true
      await pruneOldFiles()
    }
  } catch {
    // **有意静默**：console 已被渲染层日志接管，这里再打一行 warn 会被重新记录进队列，
    // 写盘持续失败��就成了「失败 → 打日志 → 再失败」的自激死循环。写盘失败只丢日志，
    // 不影响功能，代价可接受。
  }
}

/** 触发一次写盘（不等待）：满批或到点都走这里 */
function scheduleFlush(): void {
  if (pending.length >= FLUSH_BATCH) {
    void flushMobileLogs()
    return
  }
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushMobileLogs()
  }, FLUSH_DELAY_MS)
}

/**
 * 把队列里的行尽力写盘。
 *
 * 返回 Promise 供「导出前」与「页面隐藏」两类调用点等待：导出包里缺的往往正是
 * 用户刚操作的那几条，而那几条此刻还在内存队列里。
 */
export function flushMobileLogs(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const lines = pending
  pending = []
  if (lines.length === 0) return flushChain
  flushChain = flushChain.then(() => writeLines(lines))
  return flushChain
}

/** 待写盘行数（测试与信息展示用；不参与业务判断） */
export function pendingLogLineCount(): number {
  return pending.length
}

/** 读回全部日志文件内容（导出用） */
async function readLogParts(): Promise<LogFilePart[]> {
  const files = await listLogFiles()
  const parts: LogFilePart[] = []
  for (const file of files) {
    try {
      const result = await Filesystem.readFile({
        path: `${LOG_DIR}/${file.name}`,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      })
      parts.push({
        name: file.name,
        mtime: file.mtime,
        content: typeof result.data === 'string' ? result.data : '',
      })
    } catch {
      // 单个文件读失败（被系统清理、正在写）不该让整包导出失败
    }
  }
  return parts
}

/** 移动端日志能力：形状对齐 shared 的 LoggingRendererApi，另加 flush（文件写盘需要显式冲刷） */
export interface MobileLoggingApi {
  bundle(): Promise<LogBundleResult>
  exportFile(): Promise<LogExportResult>
  info(): Promise<LogStorageInfo>
  record(payload: LogAppendPayload): void
  flush(): Promise<void>
}

/**
 * 创建移动端日志能力。
 *
 * `getEnvironment` 每次导出时现取：版本号在运行期不变，但界面语言会变，
 * 冻结在创建那一刻会把环境头写错。
 */
export function createMobileLogging(getEnvironment: () => MobileLogEnvironment): MobileLoggingApi {
  /** 环境头 + 文件清单 → 单文本包（与桌面端共用 shared 的排版，避免两端格式漂移） */
  async function buildBundle(): Promise<LogBundleResult> {
    // 先把内存队列落盘：否则「刚点导出前发生的那次失败」不在包里
    await flushMobileLogs()
    const parts = await readLogParts()
    const env = getEnvironment()
    const exportedAt = Date.now()
    const totalBytes = parts.reduce((sum, part) => sum + sizeOfText(part.content), 0)
    const logEnvironment: LogEnvironment = {
      appVersion: env.appVersion,
      origin: 'mobile',
      platform: env.platform,
      arch: env.arch,
      runtime: env.runtime,
      locale: env.locale,
      exportedAt,
      coverage: `${parts.length} file(s), ${totalBytes} bytes`,
    }
    return {
      fileName: logBundleFileName(env.appVersion, exportedAt),
      content: buildLogBundle(logEnvironment, parts),
      fileCount: parts.length,
      totalBytes,
    }
  }

  return {
    record(payload) {
      // 不允许抛错：这是 sink 的底座，抛出去会打断内核的投递循环
      try {
        const line = payload?.line
        if (typeof line !== 'string' || line === '') return
        pending.push(line)
        scheduleFlush()
      } catch {
        // 队列操作本身不会失败，这里只防御未来改动
      }
    },

    flush: flushMobileLogs,

    bundle: buildBundle,

    async exportFile() {
      const bundle = await buildBundle()
      // 有「所有文件访问」才写外部存储：没有权限时 Capacitor 会直接失败，
      // 与其让用户看到「导出失败」，不如落到应用目录并如实返回路径
      const granted = await checkAllFilesAccess().catch(() => false)
      const target = granted
        ? { directory: Directory.ExternalStorage, dir: EXPORT_DIR }
        : { directory: Directory.Data, dir: INTERNAL_EXPORT_DIR }
      const path = `${target.dir}/${bundle.fileName}`
      await Filesystem.mkdir({ path: target.dir, directory: target.directory, recursive: true })
      await Filesystem.writeFile({
        path,
        directory: target.directory,
        data: bundle.content,
        encoding: Encoding.UTF8,
        recursive: true,
      })
      const { uri } = await Filesystem.getUri({ path, directory: target.directory })
      const filePath = toNativePath(uri) || path
      return { filePath, dir: dirOf(filePath), bytes: sizeOfText(bundle.content) }
    },

    async info() {
      let dir = ''
      try {
        const { uri } = await Filesystem.getUri({ path: LOG_DIR, directory: Directory.Data })
        dir = toNativePath(uri)
      } catch {
        // 取不到绝对路径不影响其它字段；UI 上只会少一行「目录」提示
      }
      const files = await listLogFiles()
      return {
        dir,
        files,
        totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
        maxFileBytes: MAX_FILE_BYTES,
        maxFiles: MAX_FILES,
      }
    },
  }
}
