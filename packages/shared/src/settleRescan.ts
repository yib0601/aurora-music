/**
 * 「被静默期挡掉的加密文件」补扫调度。
 *
 * 背景：识别加密音频前要过一道「仍在下载」闸门（见 encryptedAudio 的
 * `isStillDownloading`）——名字带临时后缀、或 mtime 在 `ENCRYPTED_SETTLE_MS`
 * 内的一律不上报。这道闸门挡住的是「把平台正在写的文件移进回收站」这类事故，
 * 代价是**刚下完的那一个文件会错过本次扫描的提示**。
 *
 * 桌面端通常能被后续写盘顺手带出来：下一首的第一次 write 就会触发 watcher，
 * 那时上一首的 mtime 早过了静默期，一次全库重扫会把它们一起报上来。但**批次
 * 最后一首**不会——它写完就再没有事件了，只能等下次启动或手动重扫。移动端更彻底：
 * 根本没有目录 watcher，全靠手动重扫或重启。
 *
 * 所以扫描结束时自己安排一次「等静默期过去再看一眼」，把这条尾巴补上。
 * 判据与闸门本身共用 `ENCRYPTED_SETTLE_MS`，避免「闸门等 5s、补扫却只看 2s」
 * 这种改一处漏一处。
 */
import { ENCRYPTED_SETTLE_MS } from './encryptedAudio'

/**
 * 补扫延迟 = 静默期 + 余量。
 *
 * 余量不能省：mtime 的粒度在部分文件系统上只到秒级，扫描又可能恰好卡在静默期
 * 边界的另一侧；余量太小会让补扫同样被挡掉，白扫一轮（然后被连续上限掐死）。
 */
export const SETTLE_RESCAN_DELAY_MS = ENCRYPTED_SETTLE_MS + 2000

/**
 * 同一目录连续补扫上限。
 *
 * 到达上限说明写入方**一直在动**，这不是「漏了一个尾巴」而是「下载还没完」：
 * 桌面端此后的写盘事件每 6s 就会强制触发一次重扫（watcher 的 MAX_WAIT_MS），
 * 移动端则等用户回到前台。自己继续死循环补扫只是白耗电与 IO。
 */
export const SETTLE_RESCAN_MAX_ROUNDS = 3

export interface SettleRescanDeps {
  /**
   * 触发一次补扫。
   *
   * 调用方负责串行化（桌面端是 enqueueScan，移动端是同一条扫描队列），
   * 本模块只管「什么时候该扫」，不管并发。
   *
   * 返回 `false` 表示**这次没扫**（例如目录监听正被批量替换挂起），本模块不记账：
   * 既不计入连续上限，也不清除计数，留给下一次机会。
   */
  rescan: (folder: string) => boolean | void
  /** 覆盖默认延迟（测试用） */
  delayMs?: number
  /** 覆盖默认连续上限（测试用） */
  maxRounds?: number
}

export interface SettleRescanScheduler {
  /**
   * 本轮扫描有文件因静默期被跳过：安排一次补扫。
   *
   * 同一目录重复调用会合并成一个定时器——一批被挡的文件只需要一次补扫，
   * 而且后来的文件**不能把已定好的时刻往后推**：写入持续时每首都会被挡，
   * 若每次都重设定时器就会永远推不到头。
   */
  defer: (folder: string) => void
  /**
   * 本轮扫描没有任何文件被挡：清空该目录的连续计数。
   *
   * 必须与 defer 成对调用，否则计数只增不减，目录用满额度后补扫就永久失效
   * （表现为「这次能补上，过几天又补不上了」）。
   */
  markClean: (folder: string) => void
  /** 取消该目录的待补扫（目录被用户移除 / 已从磁盘消失时） */
  cancel: (folder: string) => void
  /** 取消全部待补扫 */
  cancelAll: () => void
  /** 该目录是否已有待补扫（诊断与测试用） */
  pending: (folder: string) => boolean
}

export function createSettleRescanScheduler(deps: SettleRescanDeps): SettleRescanScheduler {
  const delayMs = Math.max(0, deps.delayMs ?? SETTLE_RESCAN_DELAY_MS)
  const maxRounds = Math.max(1, Math.floor(deps.maxRounds ?? SETTLE_RESCAN_MAX_ROUNDS))
  /** 待补扫的目录 → 定时器 */
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * 连续「补扫之后仍被挡」的次数。
   *
   * 单独存一份而不是挂在定时器条目上：触发时条目必须立刻删除（否则新一轮
   * defer 会被自己的 `has` 判定合并掉，补扫永远不再发生），计数得跟着活下来。
   */
  const streaks = new Map<string, number>()

  const fire = (folder: string): void => {
    timers.delete(folder)
    // 计数必须在**调用 rescan 之前**推进：rescan 内部（或它同步触发的扫描）很可能
    // 立刻又 defer 一次（「补扫完发现还有文件在写」就是这个形状），那时若计数还没加，
    // defer 看到的是上一轮的额度，上限就永远差一轮。
    const prev = streaks.get(folder) ?? 0
    streaks.set(folder, prev + 1)
    let accepted: boolean | void
    try {
      accepted = deps.rescan(folder)
    } catch (err) {
      // 定时器回调里抛出的异常没有任何调用者接，Electron 主进程会直接崩。
      // 补扫是尽力而为的增强，失败只记账
      console.warn('[settleRescan] 补扫触发失败:', folder, err) // i18n-exempt: 开发者日志，不进界面
      return
    }
    // 这次其实没扫（例如监听正被挂起）：撤销计数，额度留给下次
    if (accepted === false) streaks.set(folder, prev)
  }

  return {
    defer(folder) {
      if (!folder) return
      if (timers.has(folder)) return
      if ((streaks.get(folder) ?? 0) >= maxRounds) return
      timers.set(folder, setTimeout(() => fire(folder), delayMs))
    },
    markClean(folder) {
      if (!folder) return
      streaks.delete(folder)
    },
    cancel(folder) {
      const timer = timers.get(folder)
      if (timer !== undefined) clearTimeout(timer)
      timers.delete(folder)
      streaks.delete(folder)
    },
    cancelAll() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      streaks.clear()
    },
    pending(folder) {
      return timers.has(folder)
    },
  }
}
