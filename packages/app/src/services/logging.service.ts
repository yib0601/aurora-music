/**
 * 渲染层日志：捕获 → 传输 → 导出。
 *
 * 为什么渲染层需要自己的一套：共享内核（@aurora/shared 的 logging）只负责
 * 「记录长什么样、怎么脱敏、怎么排版」，它故意不碰文件系统与 IPC，于是
 * 「记录往哪送」这件事必须在每个宿主里各写一次。这里是渲染进程的那一份。
 *
 * 三条设计约束，都是踩过或预判过的坑：
 *
 * 1. **绝不抛错、绝不阻塞启动**：日志系统故障不能让播放器崩，也不能让首屏
 *    多等一帧。因此 init 只做同步的内存配置（挂 sink、接管 console），
 *    真正的 I/O 全部发生在「有记录要发」与「用户点导出」这两个时刻。
 *
 * 2. **传输走平台网关，不在本文件里认平台**：桌面端要经 preload 的 IPC 送主进程
 *    落盘，移动端要写 Capacitor Filesystem，Web 端根本没有落盘。这段差异属于
 *    平台适配层（services/platform），本文件只认 `platform.logging` 这个契约。
 *    好处是单测可以把网关整体打桩，不必模拟 electronAPI 与 Capacitor 两套宿主。
 *
 * 3. **脱敏在记录创建时完成，这里对整行再补一道**：内核在 emit 时已经把 message /
 *    detail / stack 都过了 redactText，理论上 sink 拿到的永远是安全的。这里仍然
 *    对最终排版的整行再过一次 —— 因为这是「凭据进入用户要发出去的文件」的
 *    最后一道闸门，成本是一条正则，收益是新增任何一条投递路径都不会绕开它。
 *    超长（带堆栈）的行会跳过这道，理由见 REPASS_LIMIT 的注释。
 *    这条决策有单测守着（见 __tests__/logging.service.test.ts 的护栏用例）。
 */
import {
  captureConsole,
  createLogger,
  formatRecord,
  initLogging,
  installErrorCapture,
  logSessionStart,
  redactText,
  type LogRecord,
  type LogSink,
  type LogStorageInfo,
} from '@aurora/shared'
import { platform } from '@/services/platform'
import { currentLocale } from '@/stores/localeStore'
import { APP_VERSION } from '@/services/update.service'

/** 渲染层自己的 logger：只用于日志系统自身的事件（导出失败等），scope 与业务码区分开 */
const log = createLogger('logging')

/**
 * 导出结果。
 *
 * 用「可判别的结果」而不是抛错：导出是用户点按钮触发的一次性动作，
 * 失败的原因（平台不支持 / 主进程拒绝 / 磁盘满）对界面的意义只有一个
 * ——弹一句提示。抛错会让每个调用点都得写 try/catch，还容易漏。
 */
export type LogExportOutcome =
  | {
      ok: true
      /** 落盘绝对路径（已脱敏，可直接展示给用户） */
      filePath: string
      /** 所在目录（reveal / 打开日志目录用） */
      dir: string
      bytes: number
    }
  | {
      ok: false
      /** unsupported：该端没有落盘能力（Web）；failed：能力在但这次没成功 */
      reason: 'unsupported' | 'failed'
    }

/** 是否开发构建：决定日志门槛（开发期要 debug，生产只留 info 及以上） */
function isDevBuild(): boolean {
  // Vite 的 import.meta.env 不在 app 的 tsconfig types 里，这里按结构化断言取，
  // 避免为一个环境变量引入全局类型依赖（与 i18n/index.tsx 的取法一致）
  const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env
  return Boolean(env?.DEV)
}

/**
 * 平台日志网关（可能不存在）。
 *
 * 每次现取而不是模块级缓存：`platform` 是单例，但日志是**最早**初始化的子系统之一，
 * 万一将来改成延迟创建平台，缓存住 undefined 会让整条链路永久失效。
 */
function gateway() {
  try {
    return platform.logging ?? null
  } catch {
    // 平台模块自身的初始化异常不该由日志系统放大成一个新错误
    return null
  }
}

/**
 * 二次脱敏的长度闸门。
 *
 * `redactText` 内部有单字符串上限（shared 的 MAX_STRING），超长输入会被截断。
 * 带堆栈的记录排版后常常超过这个长度，若照样再过一遍，代价是**丢掉堆栈尾部** ——
 * 而堆栈恰恰是这类记录里最有价值的部分。超长时跳过二次脱敏是安全的：
 * message / detail / stack 三个字段在记录创建时已各自脱敏过（见 shared 的 logger.emit），
 * 这里只是对「字段拼接后的整行」补一道闸，不是在补脱敏本身。
 */
const REPASS_LIMIT = 4096

/** 一条记录 → 单行文本（含堆栈时是多行，由 sink 侧按原样追加） */
function lineOf(record: LogRecord): string {
  try {
    const line = formatRecord(record)
    return line.length <= REPASS_LIMIT ? redactText(line) : line
  } catch {
    // 排版失败就放弃这一条：宁可丢一行日志，也不能让 sink 抛错打断内核的投递循环
    return ''
  }
}

/**
 * 传输 sink：把内核产出的记录送到平台落盘出口。
 *
 * 注意**不 await 也不回调**：桌面端是单向 IPC（fire-and-forget），移动端进内存队列
 * 由定时器攒批写盘。任何一处同步等待文件 I/O 都会直接卡住 UI 线程，
 * 而日志属于「有更好、没有也不影响功能」的那一类数据。
 */
const transportSink: LogSink = (record) => {
  const target = gateway()
  if (!target) return
  const line = lineOf(record)
  if (!line) return
  try {
    target.record({ line })
  } catch {
    // 出口自身故障（IPC 通道断了、队列满了）只丢这一条；内核也会吞，这里再兜一层
  }
}

/** 是否已经初始化过：重复调用 init 会替换 sink，但重复装 console 接管没有意义 */
let initialized = false

/**
 * 页面隐藏 / 卸载时把内存队列冲刷一次。
 *
 * 移动端的写盘是攒批的，最后一次操作往往就停在队列里 —— 而用户「遇到问题」
 * 之后的第一反应是切到别的应用去反馈，那一刻正是最需要日志已经落盘的时候。
 * 不 await：beforeunload 里没有等待异步的空间，尽力而为即可。
 */
function installFlushHooks(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const flush = () => {
    try {
      void gateway()?.flush?.()
    } catch {
      // 冲刷失败只丢队列里的最后几条，不影响页面卸载
    }
  }
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
}

/**
 * 初始化渲染层日志（幂等）。
 *
 * 必须在 ReactDOM.render 之前调用：首屏渲染期间的报错（样式/资源/数据加载失败）
 * 恰恰是用户报得最多的一类，晚一步就只能从第二次交互开始记。
 * 但也不能阻塞渲染 —— 这里只做同步的内存配置，一个字节都没写盘。
 *
 * 每一步**独立兜错**而不是整块 try：这几个步骤彼此无依赖，某一步失败
 * （例如宿主缺 window 事件、某个 API 被裁剪）不该让后面的 console 接管与
 * 会话起点记录一起失效。整块 try 曾在单测里暴露过真问题：环境缺
 * `addEventListener` 时，连「记录一条日志」的能力都没装上，却什么都看不出来。
 */
export function initRendererLogging(): void {
  if (initialized) return
  initialized = true

  // 第 1 步：挂 sink。这是唯一必须成功的一步，失败就没什么可做的了
  try {
    initLogging({
      sinks: [transportSink],
      level: isDevBuild() ? 'debug' : 'info',
      origin: 'renderer',
    })
  } catch (err) {
    // 连 sink 都挂不上时日志系统整体不可用；此时 log.* 也不会被记录，只能放弃
    log.error('renderer logging sink setup failed', err)
    return
  }

  // 第 2 步：接管现有 150+ 处 console.warn / console.error。它们已经把「哪里失败了」
  // 写清楚了，缺的只是一个落盘出口；逐个改成 logger.* 是低收益高风险的大改
  try {
    captureConsole({ scopePrefix: 'renderer' })
  } catch (err) {
    log.warn('console capture failed', err)
  }

  // 第 3 步：未捕获异常与资源加载失败不在任何 console 调用里，但往往正是最后一次
  // 失败的现场。宿主没有 window 事件（单测 / SSR / 极简 WebView）时装了也是空转
  try {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      installErrorCapture('renderer')
    }
  } catch (err) {
    log.warn('error capture failed', err)
  }

  // 第 4 步：页面隐藏时冲刷攒批队列
  try {
    installFlushHooks()
  } catch {
    // 少一次隐藏时的冲刷只意味着最后几条可能丢，不值得记一条日志（会递归）
  }

  // 第 5 步：会话起点。导出包里有一行「这次启动从哪开始」，与崩溃前最后一条记录
  // 之间的区间就是排查现场
  try {
    logSessionStart({
      version: APP_VERSION,
      platform: platform.platform,
      // 语言要在启动时就记：用户报问题时用的可能是非母语界面，文案与语言对不上会误导判断
      locale: currentLocale(),
      dev: isDevBuild(),
    })
  } catch {
    // 会话起点只是锦上添花，取不到版本/语言不该影响任何东西
  }
}

/** 该端是否具备「导出日志」能力（UI 据此隐藏入口，而不是点了之后失败） */
export function supportsLogExport(): boolean {
  return typeof gateway()?.exportFile === 'function'
}

/** 是否具备「在文件管理器中定位」能力：移动端没有对应插件，故单独判定 */
export function supportsLogReveal(): boolean {
  return typeof gateway()?.reveal === 'function'
}

/**
 * 导出日志为单个文本文件。
 *
 * 桌面端由主进程读全部日志文件、拼环境头并写进「下载」目录；移动端由
 * platform/mobile/logging.ts 用 shared 的 buildLogBundle 自拼后写入用户可见目录。
 * 两端都返回落盘路径 —— 界面要能把它展示给用户，让用户自己去发送文件。
 */
export async function exportLogs(): Promise<LogExportOutcome> {
  const target = gateway()
  if (!target) return { ok: false, reason: 'unsupported' }
  try {
    await target.flush?.()
    const result = await target.exportFile()
    if (!result || typeof result.filePath !== 'string' || !result.filePath) {
      log.warn('log export returned no path')
      return { ok: false, reason: 'failed' }
    }
    return {
      ok: true,
      filePath: result.filePath,
      dir: result.dir || '',
      bytes: typeof result.bytes === 'number' ? result.bytes : 0,
    }
  } catch (err) {
    // 失败原因（权限、磁盘满、主进程拒绝）只进日志：界面上给用户看的是一句可操作的提示
    log.error('log export failed', err)
    return { ok: false, reason: 'failed' }
  }
}

/** 日志目录状态（文件数、占用、上限）；平台不支持时返回 null 由 UI 展示空态 */
export async function getLogInfo(): Promise<LogStorageInfo | null> {
  const target = gateway()
  if (!target) return null
  try {
    return await target.info()
  } catch (err) {
    log.warn('log info failed', err)
    return null
  }
}

/**
 * 在文件管理器中定位日志。
 *
 * 优先定位刚导出的那个文件（用户的心智是「我刚导出的东西在哪」），
 * 没有导出过就打开日志目录本身。两端能力不同：桌面端走系统文件管理器，
 * 移动端没有对应插件（未安装 @capacitor/share 与任何文件管理器桥），
 * 因此调用方需先用 supportsLogReveal() 隐藏入口。
 */
export async function revealLogs(filePath?: string): Promise<boolean> {
  const target = gateway()
  if (!target?.reveal) return false
  try {
    let path = filePath
    if (!path) {
      const info = await target.info()
      path = info?.dir
    }
    if (!path) return false
    await target.reveal(path)
    return true
  } catch (err) {
    log.warn('log reveal failed', err)
    return false
  }
}

