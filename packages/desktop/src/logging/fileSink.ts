/**
 * 主进程日志的文件出口（滚动写盘）。
 *
 * 为什么这一层不放进 shared：shared 内核刻意不碰 fs —— 渲染进程在沙箱里、
 * 移动端在 WebView 里，都拿不到 Node 的文件系统。所以「记录长什么样」在 shared，
 * 「写到哪、怎么滚动」留在各端。这里只实现桌面主进程需要的那一种：
 * 固定目录 + 单文件上限 + 保留份数 + 崩溃前最后一条不丢。
 *
 * 三条纪律：
 * 1. **同步追加**（appendFileSync）：异步写盘会把最后几条留在用户态缓冲区里，进程一崩就没了，
 *    而「崩溃前最后一条」恰是排障时最想要的那一条。单条记录只有几百字节，
 *    同步写的代价（一次 open/write/close）远小于丢掉现场。
 * 2. **绝不抛错**：日志系统坏了不能拖垮播放器。磁盘满、权限不足、目录被换成普通文件……
 *    一律吞掉并让下一次写入重试；查询类方法失败就返回空结果。
 * 3. **滚动按「已有字节 + 待写字节」判定**：只看已有大小会在单条记录很大时把文件撑过上限，
 *    而上限是「这个目录不会无限长大」的承诺，破了这个承诺就等于没有上限。
 */

import fs from 'fs'
import path from 'path'
import type { LogFileInfo, LogFilePart, LogSink, LogStorageInfo } from '@aurora/shared'
import { formatRecord } from '@aurora/shared'

/** 单文件上限：2MB。够放几千条记录（含堆栈），又小到用户能随手打开 */
export const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024

/** 最多保留 5 个文件（1 个活跃 + 4 个归档），目录总占用上限约 10MB */
export const MAX_LOG_FILES = 5

/** 活跃文件名；归档名由它派生（aurora.1.log / aurora.2.log …，序号越大越旧） */
export const LOG_FILE_NAME = 'aurora.log'

const LOG_FILE_EXT = LOG_FILE_NAME.slice(LOG_FILE_NAME.lastIndexOf('.'))
const LOG_FILE_STEM = LOG_FILE_NAME.slice(0, -LOG_FILE_EXT.length)
/** 归档名识别：只认本模块的命名，目录里别的文件不参与滚动、也不会被删 */
const ARCHIVE_NAME_PATTERN = new RegExp(`^${LOG_FILE_STEM}\\.(\\d+)${LOG_FILE_EXT.replace('.', '\\.')}$`)

export interface FileSinkOptions {
  /** 日志目录（主进程传 `<userData>/logs`；单测传临时目录） */
  dir: string
  /** 单文件上限，默认 {@link MAX_LOG_FILE_BYTES}；单测用小值把滚动跑到边界 */
  maxFileBytes?: number
  /** 保留文件数（含活跃文件），默认 {@link MAX_LOG_FILES} */
  maxFiles?: number
}

/** 文件出口：既是 shared 的 {@link LogSink}，也承担查询与「追加渲染层记录」两项职责 */
export interface LogFileSink {
  /** 交给 initLogging 的 sink 函数 */
  sink: LogSink
  /** 日志目录绝对路径 */
  readonly dir: string
  readonly maxFileBytes: number
  readonly maxFiles: number
  /** 追加一行**已脱敏、已排版**的文本（渲染进程记录走这条；与 sink 共用同一套滚动） */
  appendLine(line: string): void
  /** 当前目录里的日志文件，旧 → 新 */
  listFiles(): LogFileInfo[]
  /** 读出全部日志内容（供导出包拼装），旧 → 新 */
  readParts(): LogFilePart[]
  /** 设置页展示用的目录状态 */
  storageInfo(): LogStorageInfo
}

/** 归档文件名（index 从 1 开始，越大越旧） */
function archiveFileName(index: number): string {
  return `${LOG_FILE_STEM}.${index}${LOG_FILE_EXT}`
}

/** 读文件大小；不存在 / 读不到一律按 0（首次写入时文件本来就可能不存在） */
function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/**
 * 按字节截断（不按字符）：上限是字节承诺，用字符数截断在多字节文案下仍会超限。
 *
 * 截断点可能落在多字节字符中间，末尾会出现一个替换符 —— 可以接受：
 * 日志是给人读的，不是数据交换格式，丢半个汉字远好过整个文件超限。
 */
function truncateToBytes(text: string, limit: number): string {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= limit) return text
  // 提示语用英文：这是写进**日志文件**的文本（读者是开发者），
  // 而 check-i18n 门禁会把 desktop 源码里含中文的字符串字面量判红 ——
  // 界面文案才必须走字典，日志文本不该反过来逼字典多出一堆条目。
  const notice = '\n… [record exceeded max file size, truncated]\n'
  const keep = Math.max(0, limit - Buffer.byteLength(notice, 'utf8'))
  return `${Buffer.from(text, 'utf8').subarray(0, keep).toString('utf8')}${notice}`
}

/**
 * 创建文件出口（构造期**不碰磁盘**）。
 *
 * 构造期不建目录、不 stat：主进程在 app ready 之前就要把出口接上，
 * 那时任何一次多余的磁盘访问都可能变成启动阻塞；真正的落盘代价推迟到第一条记录。
 */
export function createFileSink(options: FileSinkOptions): LogFileSink {
  const dir = options.dir
  const maxFileBytes = Math.max(1024, Math.floor(options.maxFileBytes ?? MAX_LOG_FILE_BYTES))
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? MAX_LOG_FILES))
  const currentPath = path.join(dir, LOG_FILE_NAME)

  /** 当前活跃文件字节数；null = 「还没从磁盘同步过」，首次写入时 stat */
  let currentSize: number | null = null
  /** 目录已确认存在（mkdir -p 成功过一次就不再重复系统调用；失败会清掉让下次重试） */
  let dirReady = false

  function ensureDir(): void {
    if (dirReady) return
    fs.mkdirSync(dir, { recursive: true })
    dirReady = true
  }

  /**
   * 滚动一次：删最旧的归档位，把其余归档升一号，活跃文件退位成 1 号。
   *
   * 用「序号越大越旧」（logrotate 习惯）：活跃文件永远是 aurora.log，
   * 用户打开目录时不必先判断哪个才是正在写的那个。
   */
  function rotate(): void {
    const oldest = maxFiles - 1
    if (oldest < 1) {
      // 只保留 1 个文件 = 没有归档位，直接截断，语义上仍是「上限生效」
      try {
        fs.truncateSync(currentPath, 0)
      } catch {
        // 文件不存在或不可写：截断失败不影响后续 append（append 会自己失败并吞掉）
      }
      currentSize = 0
      return
    }
    try {
      fs.rmSync(path.join(dir, archiveFileName(oldest)), { force: true })
    } catch {
      // 该归档位本来就不存在，正常情况
    }
    // 倒序改名：从最旧往新升号，避免把还没搬走的新归档覆盖掉
    for (let index = oldest - 1; index >= 1; index -= 1) {
      try {
        fs.renameSync(path.join(dir, archiveFileName(index)), path.join(dir, archiveFileName(index + 1)))
      } catch {
        // 中间某个归档位缺失（例如首次运行只有活跃文件），跳过即可
      }
    }
    try {
      fs.renameSync(currentPath, path.join(dir, archiveFileName(1)))
    } catch {
      // 活跃文件不存在（还没写过任何记录）：没有可滚的内容
    }
    currentSize = 0
  }

  function write(text: string): void {
    // 空白整行直接丢弃：渲染层把 record 的 line 归一失败、或 console 被空调用时
    // 会送进来空串/纯换行，写进文件只会在真实现场里插出无意义的空行，干扰 grep
    if (typeof text !== 'string' || text.trim() === '') return
    // 统一成「一条一行」：记录本身不带尾换行（堆栈的内嵌换行属于同一条记录），由出口补
    let body = text.endsWith('\n') ? text : `${text}\n`
    body = truncateToBytes(body, maxFileBytes)
    const size = Buffer.byteLength(body, 'utf8')

    try {
      ensureDir()
      if (currentSize === null) currentSize = sizeOf(currentPath)
      if (currentSize > 0 && currentSize + size > maxFileBytes) rotate()
      fs.appendFileSync(currentPath, body, 'utf8')
      currentSize = (currentSize ?? 0) + size
    } catch {
      // 磁盘满 / 权限不足 / 目录被替换成文件：一律吞掉。
      // 同时把缓存状态清空——下一次写入会重新确认目录、重新 stat，
      // 用户腾出空间或修好权限后能自动恢复，不需要重启应用。
      dirReady = false
      currentSize = null
    }
  }

  const sink: LogSink = (record) => write(formatRecord(record))

  function indexOfName(name: string): number | null {
    if (name === LOG_FILE_NAME) return 0
    const match = ARCHIVE_NAME_PATTERN.exec(name)
    if (!match) return null
    const index = Number(match[1])
    // 超出保留范围的归档（例如用户手工改过上限）不算本模块的文件，不展示也不删
    if (!Number.isInteger(index) || index < 1 || index >= maxFiles) return null
    return index
  }

  function listFiles(): LogFileInfo[] {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return []
    }

    const entries: Array<LogFileInfo & { index: number }> = []
    for (const name of names) {
      const index = indexOfName(name)
      if (index === null) continue
      try {
        const stat = fs.statSync(path.join(dir, name))
        // 目录/设备文件同名时跳过：本模块只产出普通文件
        if (!stat.isFile()) continue
        entries.push({ name, sizeBytes: stat.size, mtime: Math.round(stat.mtimeMs), index })
      } catch {
        // 刚被滚走 / 权限不足：跳过这一个，不影响其余文件
      }
    }

    // 旧 → 新：与导出包的分段顺序一致，界面列表和导出内容能一行行对上。
    // mtime 相同（同一毫秒内连续滚动）时用序号兜底——序号越大越旧，反过来排。
    entries.sort((a, b) => a.mtime - b.mtime || b.index - a.index)
    return entries.map(({ name, sizeBytes, mtime }) => ({ name, sizeBytes, mtime }))
  }

  function readParts(): LogFilePart[] {
    return listFiles().map(({ name, mtime }) => {
      let content = ''
      try {
        content = fs.readFileSync(path.join(dir, name), 'utf8')
      } catch {
        // 读不出来的文件仍保留一个空分段：导出包里能看到「这个文件存在但读不到」，
        // 比悄悄少一段更容易排查（多半是权限问题）
        content = ''
      }
      // mtime 必须给：shared 的 buildLogBundle 按 mtime 升序排，缺 mtime 会被当成 0 排到最前，
      // 「最新记录在最后」的顺序就反了
      return { name, mtime, content }
    })
  }

  return {
    sink,
    dir,
    maxFileBytes,
    maxFiles,
    appendLine: (line) => write(line),
    listFiles,
    readParts,
    storageInfo() {
      const files = listFiles()
      return {
        dir,
        files,
        totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
        maxFileBytes,
        maxFiles,
      }
    },
  }
}
