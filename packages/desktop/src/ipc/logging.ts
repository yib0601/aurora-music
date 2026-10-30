/**
 * 日志相关的 IPC 注册（主进程侧）。
 *
 * 通道名与请求/响应形状**全部**来自 `@aurora/shared` 的 `LOG_IPC` 与 ipcContract 类型：
 * preload、渲染层、主进程三方各编译一份，靠字符串对齐必然漂移，
 * 而这条路径只在「用户来要日志」的那一刻被走到 —— 静默错位等于整套系统白做。
 *
 * 安全前提：**所有 IPC 入参都按不可信处理**（与 ipc/handlers.ts 里 dialog/scan 的做法一致）。
 * 渲染进程虽然是我们自己的代码，但它是唯一跑第三方内容（音源脚本、歌词、封面）的进程，
 * 一旦被搞坏，这里的 `reveal` 会成为「在弹出的文件管理器里定位任意路径」的入口，
 * 所以路径要过白名单，而不是直接甩给 shell。
 */

import fs from 'fs'
import path from 'path'
import { app, ipcMain, shell } from 'electron'
import { LOG_IPC, redactText, createLogger } from '@aurora/shared'
import type {
  LogAppendPayload,
  LogBundleResult,
  LogExportResult,
  LogStorageInfo,
} from '@aurora/shared'
import { getMainFileSink, mainLogDir } from '../logging'
import { MAX_LOG_FILES, MAX_LOG_FILE_BYTES } from '../logging/fileSink'
import { collectMainEnvironment } from '../logging/environment'
import { composeLogBundle, writeLogBundle } from '../logging/export'

const logger = createLogger('logging.ipc')

/**
 * 写盘前对渲染层**逐行**脱敏的单行上限（字符）。
 *
 * 按行裁、按行脱敏，而不是把整条记录（含堆栈，常常几千字符）当成一个串：
 * 逐行处理让每行的裁剪代价与长度都有界，同时**保留完整的堆栈结构** ——
 * 整条截到 4096 会把堆栈尾部砍掉，而堆栈恰恰是这类记录里最有价值的部分
 * （渲染层 logging.service 也刻意为此跳过整行二次脱敏）。整条记录的长度另由
 * {@link MAX_RECORD_CHARS} 兜住。
 *
 * 历史背景：这里最初是为了防 `redactText` 的平方级回溯（当时实测 4KB≈0.1s、64KB≈29s，
 * 喂进超长行会让主进程卡死几十秒、连播放一起停）。**根因已在 shared 内核修掉**
 * —— 改为「先裁剪再跑正则 + 量词有界」，现在任意长度都是常数时间（有回归测试）。
 * 这两层裁剪保留仍然必要：它们是「一条日志不能撑爆 2MB 上限」的边界，
 * 与回溯无关。
 */
const MAX_LINE_CHARS = 4096

/**
 * 单条渲染层记录的总长度上限（字符，约 32KB 内存）。
 *
 * 正常一条 console 记录只有几百字符；给到 32K 是留给「长堆栈」。
 * 再大就不是日志而是有人在往里灌数据 —— 那会瞬间把 2MB 的文件挤掉一批真实记录，
 * 而 fileSink 的上限是「目录不会无限长大」的承诺，不该被一条记录击穿。
 */
const MAX_RECORD_CHARS = 32 * 1024

/**
 * 导出目录：用户「下载」目录。
 *
 * 不用临时目录：用户点「导出」之后要去文件管理器里找这个文件，临时目录在多数
 * 桌面环境里等于「找不到」。读不到 downloads（少数极简 WM / 容器）时退到 home，
 * 仍然比抛错让整个按钮失效好。
 */
function exportDir(): string {
  try {
    return app.getPath('downloads')
  } catch {
    return app.getPath('home')
  }
}

/** 目录内含关系判定（用相对路径判，避免 `/a/logs-evil` 被当成长在 `/a/logs` 里） */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * reveal 的目标白名单：只允许「日志目录内的文件」与「下载目录里的本次导出文件」。
 *
 * 两条都必要：设置页既要能定位当前日志，也要能在导出成功后直接跳到导出文件。
 * 先做 realpath 再比较，防止有人用指向别处的符号链接绕过这层判断。
 */
function isAllowedRevealPath(input: string): boolean {
  if (!path.isAbsolute(input)) return false
  let target = input
  try {
    // 文件可能刚被删（用户手动清理过）：此时 realpath 抛错，退回原路径继续判断，
    // 让下面的 existsSync 给出「不存在就不做」的结论，而不是在这里静默拒绝
    target = fs.realpathSync(input)
  } catch {
    // 保持原路径
  }
  const dirs = [mainLogDir()]
  try {
    dirs.push(fs.realpathSync(exportDir()))
  } catch {
    dirs.push(exportDir())
  }
  return dirs.some((dir) => {
    let realDir = dir
    try {
      realDir = fs.realpathSync(dir)
    } catch {
      // 目录还不存在（从未写过日志）：用原路径比较
    }
    return target === realDir || isInside(target, realDir)
  })
}

/**
 * 归一渲染层传来的记录负载。
 *
 * 这里**再脱敏一次**（渲染层已经脱过）不是多余的：渲染进程是本应用里唯一加载
 * 第三方脚本的地方，主进程不能假设它的脱敏逻辑一定跑过。重复脱敏对已打码的文本
 * 是幂等的（`***` 里没有键名可命中），代价远小于「用户发来的日志里带明文凭据」。
 */
function normalizeRecordPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const line = (payload as LogAppendPayload).line
  if (typeof line !== 'string' || !line.trim()) return null

  // 整条记录先按总长粗裁一次（按字符而不是字节：日志是给人读的，
  // 按字节切可能切出半个多字节字符，留个残字比多几 KB 更碍事）
  const whole = line.length > MAX_RECORD_CHARS ? line.slice(0, MAX_RECORD_CHARS) : line

  // 逐行脱敏：每行单独过 redactText（长度已有界，见 MAX_LINE_CHARS），
  // 同时保留完整的堆栈结构 —— 整条截断会把堆栈尾部砍掉，那是最容易被需要的一段
  return whole
    .split('\n')
    .map((one) => redactText(one.length > MAX_LINE_CHARS ? one.slice(0, MAX_LINE_CHARS) : one))
    .join('\n')
}

/**
 * 未 attach 时的状态：IPC 早于文件出口注册（不应发生）也不会让界面拿到 undefined。
 *
 * 两项上限仍给真实值而不是 0：设置页会把它渲染成「单个文件上限 / 最多保留」，
 * 显示 0 MB 会让用户以为日志系统坏了。只有「当前目录里有什么」是空的 ——
 * 那部分确实没读到。
 */
function emptyStorageInfo(): LogStorageInfo {
  let dir = ''
  try {
    dir = mainLogDir()
  } catch {
    // ready 之前取不到 userData：留空串，对应用户看到「目录暂不可用」
  }
  return {
    dir,
    files: [],
    totalBytes: 0,
    maxFileBytes: MAX_LOG_FILE_BYTES,
    maxFiles: MAX_LOG_FILES,
  }
}

/**
 * 注册日志 IPC。
 *
 * 必须在 app ready 之后、且 `attachMainLogFile` 之后调用：
 * 前者的原因是 `app.getPath` / `app.getVersion` 在 ready 前不可用，
 * 后者是因为四个 handler 都要读文件出口（未 attach 时只能返回空状态）。
 */
export function registerLoggingIpc(): void {
  ipcMain.handle(LOG_IPC.info, (): LogStorageInfo => {
    const sink = getMainFileSink()
    return sink ? sink.storageInfo() : emptyStorageInfo()
  })

  ipcMain.handle(LOG_IPC.bundle, (): LogBundleResult => {
    const sink = getMainFileSink()
    // 导出时间在这一刻取一次，环境头与文件名共用同一个时间戳：
    // 分两次取会在跨秒时出现「文件名 021500、正文 021501」的错位
    const env = collectMainEnvironment(Date.now())
    const result = composeLogBundle(env, sink ? sink.readParts() : [])
    logger.debug(`bundle composed: ${result.fileCount} file(s), ${result.totalBytes} bytes`)
    return result
  })

  ipcMain.handle(LOG_IPC.exportFile, (): LogExportResult => {
    const sink = getMainFileSink()
    const env = collectMainEnvironment(Date.now())
    const result = composeLogBundle(env, sink ? sink.readParts() : [])
    // 落盘失败必须让渲染层看到（它会把错误显示给用户）：静默返回一个不存在的路径
    // 比报错糟糕得多 —— 用户会以为日志已经导出，然后去找一个不存在的文件
    const written = writeLogBundle(exportDir(), result.fileName, result.content)
    logger.info(`bundle exported: ${written.bytes} bytes`)
    return written
  })

  ipcMain.handle(LOG_IPC.reveal, (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || !isAllowedRevealPath(filePath)) return
    let isDir = false
    try {
      isDir = fs.statSync(filePath).isDirectory()
    } catch {
      // 不存在就没有可定位的东西：直接返回，不弹一个空的文件管理器
      return
    }
    // 两种目标语义不同，必须分开处理：
    // - 文件（刚导出的 .txt）→ showItemInFolder：在所在目录里**选中**它，
    //   对应「我刚导出的东西在哪」这个心智；
    // - 目录（设置页「打开日志目录」）→ openPath：进入该目录。
    //   对目录也调 showItemInFolder 的话，打开的是**父目录**（userData）并选中 logs 这个
    //   子目录 —— 用户看到的是 userData 而不是 logs，会以为按钮坏了。
    //   这条差异是渲染层联调时发现的：渲染层两处按钮共用同一个 reveal 通道，
    //   一处传文件、一处传目录，通道内必须自己分辨。
    if (isDir) {
      void shell.openPath(filePath)
    } else {
      shell.showItemInFolder(filePath)
    }
  })

  // 单向通道（ipcRenderer.send）：渲染层记录不阻塞 UI，主进程也不需要回执
  ipcMain.on(LOG_IPC.record, (_event, payload: unknown) => {
    const line = normalizeRecordPayload(payload)
    if (!line) return
    // 与主进程记录共用同一个出口 = 同一套 2MB 滚动与保留份数策略，
    // 否则界面刷屏时会把主进程写下的崩溃现场挤掉
    getMainFileSink()?.appendLine(line)
  })
}
