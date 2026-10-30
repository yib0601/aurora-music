/**
 * 主进程日志装配：把 shared 的日志内核接到「文件出口 + console 接管 + 全局错误捕获」上。
 *
 * 时序是这一层唯一真正的难点：
 * - 文件出口需要 `app.getPath('userData')/logs`，而它**必须先 ready**；
 * - 但 ready 之前主进程已经在打日志了（协议注册、单实例锁、X11 后端探测都在 ready 前），
 *   这些恰好是启动期故障的现场。
 *
 * 取舍：**ready 前用内存缓冲**（只留最近若干条），ready 后一次性 flush 到文件再写
 * `session start`。之所以不做「先写临时目录再搬迁」：临时目录在打包形态下未必可写
 * （AppImage 的 squashfs、Windows 的安装目录），为了几百条启动日志引入一条
 * 可能失败的搬迁路径不划算；而真正会丢的只是「ready 之前就崩溃」这一种情况，
 * 那时控制台还有 echo 输出（开发期）或系统 journal（打包后），并非完全没有线索。
 */

import path from 'path'
import { app } from 'electron'
import {
  captureConsole,
  createLogger,
  formatRecord,
  initLogging,
  installErrorCapture,
  logSessionStart,
} from '@aurora/shared'
import type { LogRecord } from '@aurora/shared'
import { createFileSink, type LogFileSink } from './fileSink'
import { collectMainEnvironment } from './environment'

const logger = createLogger('logging')

/** 启动期缓冲区容量：够覆盖 ready 前的启动流程，又不至于在无出口时把内存吃满 */
const PRE_READY_BUFFER_LIMIT = 500

/**
 * ready 前的记录缓冲（已排版文本，含渲染层追加的原始行）。
 *
 * 存**排版后的文本**而不是 LogRecord：flush 时与「渲染层记录」走同一条 appendLine 路径，
 * 两种来源自然保持先后顺序，不必在出口里区分类型。
 */
const pending: string[] = []
/** 被容量上限挤掉的条数（flush 时补一条说明，避免读者以为日志从头就在这里） */
let droppedFromBuffer = 0

/** 文件出口；null = 尚未 attach（ready 前）或 attach 失败 */
let fileSink: LogFileSink | null = null

/** 装配是否已完成（幂等标记：main.ts 与测试都可能多调一次） */
let installed = false
let attached = false

/** 日志目录：固定 `<userData>/logs`，不提供任何覆盖开关（用户要找日志时才不会猜错位置） */
export function mainLogDir(): string {
  return path.join(app.getPath('userData'), 'logs')
}

/** 取文件出口（IPC 层用它读文件清单 / 追加渲染层记录）；未 attach 时返回 null */
export function getMainFileSink(): LogFileSink | null {
  return fileSink
}

/**
 * 缓冲出口：ready 前的记录先落这里。
 *
 * 与文件出口同为 sink 形态，`initLogging` 只认 sink 列表，装配时直接换掉即可。
 * 超过容量后丢**最旧**的：崩溃现场总是在最新那一端，丢老的比丢新的合理。
 */
function bufferSink(record: LogRecord): void {
  pending.push(formatRecord(record))
  while (pending.length > PRE_READY_BUFFER_LIMIT) {
    pending.shift()
    droppedFromBuffer += 1
  }
}

/**
 * 第一步：尽早调用（main.ts 的模块级，早于 app.whenReady）。
 *
 * 做三件事：接管 console（项目里 150+ 处 console.warn/error 立刻有了落盘出口）、
 * 接管全局错误（崩溃/未处理 rejection 必须留下堆栈）、接上缓冲出口。
 * 顺序不能反：先接管 console，之后的装配自身日志才进得来。
 */
export function installMainLogging(): void {
  if (installed) return
  installed = true

  // 级别：开发期 debug（要看到装配细节），打包后 info。
  // 不用 trace 兜底：trace 在打包后只会把文件迅速撑满，而它记录的多是逐帧/逐请求的噪音。
  initLogging({
    sinks: [bufferSink],
    level: app.isPackaged ? 'info' : 'debug',
    origin: 'main',
  })

  // scopePrefix 用 'main'：最终 scope 形如 main.console.Updater，
  // 导出包里一眼能看出「这条是主进程控制台打的」，与渲染层的 renderer.* 区分开。
  captureConsole({ scopePrefix: 'main' })

  // installErrorCapture 自己会注册 process.on('uncaughtException'/'unhandledRejection')。
  // main.ts 里原有的两个 process.on 兜底**已删除**（见该文件注释）：两套并存会让
  // 同一次崩溃产生两条记录（一条来自这里，一条来自原兜底的 console.error 再被 console 接管），
  // 排障时容易误判「崩了两次」。
  installErrorCapture('main')

  logger.debug('logging kernel installed (buffered until app ready)')
}

/**
 * 第二步：app ready 后调用，接上真正的文件出口。
 *
 * 返回文件出口；创建失败（目录不可写等）返回 null —— 此时仍保留内存缓冲出口，
 * 应用照常运行，只是没有落盘。**不抛错**：日志装不上不是不能启动的理由。
 */
export function attachMainLogFile(dir = mainLogDir()): LogFileSink | null {
  if (attached && fileSink) return fileSink
  attached = true
  try {
    fileSink = createFileSink({ dir })
    // 换掉缓冲出口：initLogging 是「替换 sinks」语义，正好用来做「切换到正式出口」
    initLogging({
      sinks: [fileSink.sink],
      level: app.isPackaged ? 'info' : 'debug',
      origin: 'main',
    })

    // 先 flush 启动期缓冲，再写 session start：文件的读取顺序就是时间顺序，
    // 「session start」应当出现在启动日志之后，读者才能看到「这行之前发生了什么」。
    if (droppedFromBuffer > 0) {
      fileSink.appendLine(`[buffer] dropped ${droppedFromBuffer} pre-ready record(s) over the limit`)
    }
    for (const line of pending) fileSink.appendLine(line)
    pending.length = 0
    droppedFromBuffer = 0

    // 环境信息只在启动这一条写一次：它同时给「导出的环境头」和「会话起点」用，
    // 两处同源，避免导出包里的版本号与日志正文对不上。
    // 展开成匿名对象再传：logSessionStart 的形参是 Record<string, unknown>，
    // 而 LogEnvironment 是具名接口（没有索引签名），直接传会判类型不兼容。
    logSessionStart({ ...collectMainEnvironment(Date.now()) })
    logger.debug(`log file attached: ${dir}`)
    return fileSink
  } catch (err) {
    // 保留缓冲出口继续跑：至少开发期控制台还能看到
    fileSink = null
    logger.error('failed to attach log file sink', err)
    return null
  }
}

/**
 * 关闭日志（before-quit 调用）。
 *
 * **实际不做事**：所有写入都是同步 `appendFileSync`，调用返回时数据已经在内核页缓存里，
 * 进程退出不会丢（除非是 kill -9 或断电，那与是否 flush 无关）。
 * 保留这个函数是为了让 main.ts 的退出路径有明确挂点 —— 将来若改成异步/批量写，
 * 只改这里即可，不必回头找调用点。
 */
export function closeMainLogging(): void {
  if (!fileSink) return
  logger.debug('logging closed (synchronous sink: nothing to flush)')
}
