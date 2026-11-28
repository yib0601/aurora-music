import fs from 'fs'
import path from 'path'

/**
 * 扫描目录文件监听：目录内任意文件/子目录增删改后，防抖触发该目录的增量重扫
 * （重扫复用 scan:start 的串行队列，自动完成新增入库与删除清理，UI 经既有
 * track:scanned / scan:complete 事件无感刷新）。
 *
 * 实现：对每个子目录递归挂 fs.watch（Windows 底层为 ReadDirectoryChangesW，
 * 句柄开销低）。重扫本身不写被监听目录，不会自触发循环；非音频文件的改动即使
 * 误触发一次重扫，未变化文件在扫描中直接复用，成本可忽略。
 */

/** 防抖间隔：批量拷贝/删除会产生大量连续事件，聚合后再触发一次重扫 */
const DEBOUNCE_MS = 1500
/** 最长等待：删除目录时 Windows 会持续数秒投递成百条事件，纯防抖会被
 *  事件流不断重置而永不触发；事件流超过该时长则强制触发一次重扫 */
const MAX_WAIT_MS = 6000
/** 单目录 watcher 上限：防止异常深/大的目录树撑爆句柄 */
const MAX_WATCHERS = 1000
/**
 * 挂起自动重扫的最长时间。
 *
 * 挂起是渲染层发起的（批量替换下载期间不想让整库重扫抢磁盘 IO），它必须能被
 * 无条件解除：渲染层崩溃、页面刷新、IPC 丢包任何一个发生，挂起状态就再也不会
 * 有人来解除，watcher 等于永久聋了——用户此后手动往扫描目录里放歌都不会进库，
 * 而且看不出任何异常。超过这个时长自动恢复，把「静默永久失效」换成「最多迟钝半小时」。
 */
const SUSPEND_MAX_MS = 30 * 60 * 1000

interface FolderWatchers {
  /** 注册时传入的原始目录字符串：重扫回调要拿它（而不是 resolve 后的 key）继续用 */
  folder: string
  watchers: fs.FSWatcher[]
  timer: NodeJS.Timeout | null
  maxTimer: NodeJS.Timeout | null
  onRescan: (folder: string) => void
}

const watched = new Map<string, FolderWatchers>()

/**
 * 挂起期间被「压住」的目录集合。
 *
 * 挂起不是为了省掉重扫，而是把 N 次重扫合并成 1 次：批量替换下载 40 首，每首落盘
 * 都要触发一次防抖重扫，十几次全库 stat + getTracksByPaths 会和下载抢磁盘 IO，
 * 让本已受限的带宽雪上加霜。而**完全不扫**同样不行——下载产生的文件本身就是要
 * 进库的。所以记下「这期间有变动」，恢复时统一补一次。
 */
const deferred = new Set<string>()

/** 挂起开始时刻（null = 未挂起）；用于 SUSPEND_MAX_MS 安全阀 */
let suspendedAt: number | null = null

export function isFolderWatched(folder: string): boolean {
  return watched.has(path.resolve(folder))
}

/** 当前是否处于「挂起自动重扫」状态 */
export function isWatchSuspended(): boolean {
  return suspendedAt !== null
}

/**
 * 挂起 / 恢复自动重扫（批量替换下载期间由渲染层经 IPC 控制）。
 *
 * 恢复时对每个**仍被监听**的 deferred 目录各补触发一次 onRescan：
 * - 「仍被监听」：挂起期间目录可能被用户移除了，它的 watcher 已经拆掉，
 *   再为它扫描会扫一个用户已经不关心的目录；
 * - 「各触发一次」：不同目录的重扫是不同任务（各自走串行队列），不能合并成一次，
 *   否则别的目录的变动要等到它下次自己变动才被看见。
 */
export function setWatchSuspended(suspended: boolean): void {
  if (suspended) {
    if (suspendedAt === null) suspendedAt = Date.now()
    return
  }
  suspendedAt = null
  const pending = [...deferred]
  deferred.clear()
  for (const key of pending) {
    const entry = watched.get(key)
    if (!entry) continue
    // 恢复时清掉该目录尚在等待中的定时器：补触发已经覆盖了它们想做的事
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    if (entry.maxTimer) { clearTimeout(entry.maxTimer); entry.maxTimer = null }
    entry.onRescan(entry.folder)
  }
  if (pending.length > 0) console.log('[Watcher] 恢复自动重扫，补触发目录数:', pending.length)
}

/** 停止监听指定目录（用户移除扫描目录 / 目录已从磁盘删除时调用） */
export function unwatchFolder(folder: string): void {
  const key = path.resolve(folder)
  // 先摘 deferred：目录已经不再监听，恢复时不该再为它补扫一次
  deferred.delete(key)
  const entry = watched.get(key)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  if (entry.maxTimer) clearTimeout(entry.maxTimer)
  for (const w of entry.watchers) {
    try { w.close() } catch {}
  }
  watched.delete(key)
  console.log('[Watcher] unwatched folder:', key)
}

/**
 * 监听指定目录（含全部子目录）。每次扫描完成后应再次调用以重建监听树——
 * 新增的子目录需要补挂 watcher，已删除子目录的失效 watcher 也一并清理。
 * @param onRescan 防抖后的重扫回调（调用方保证串行队列，不会并发扫描）
 */
export function watchFolder(folder: string, onRescan: (folder: string) => void): void {
  const key = path.resolve(folder)
  // 重建监听树不改变「这个目录有未处理的变动」这一事实：unwatchFolder 会把它从
  // deferred 摘掉，所以先记下来再补回去，否则挂起期间一旦有扫描完成重建监听树，
  // 这批变动就再也不会被补扫（表现为恢复后新歌没进库）
  const wasDeferred = deferred.has(key)
  // 重建：先释放旧 watcher，避免重复监听与句柄泄漏
  unwatchFolder(key)
  if (wasDeferred) deferred.add(key)

  const entry: FolderWatchers = { folder, watchers: [], timer: null, maxTimer: null, onRescan }
  watched.set(key, entry)

  const fire = () => {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    if (entry.maxTimer) { clearTimeout(entry.maxTimer); entry.maxTimer = null }
    entry.onRescan(folder)
  }
  const schedule = () => {
    // 挂起期间只记账，不 arm 定时器：一个定时器都不排，才真正没有重扫发生
    if (suspendedAt !== null) {
      // 先记账再判断安全阀：本次变动无论如何都要被一次重扫覆盖
      deferred.add(key)
      if (Date.now() - suspendedAt > SUSPEND_MAX_MS) {
        // 安全阀：挂起太久说明解除方已经消失了（渲染层崩溃/刷新/IPC 丢包），
        // 自动恢复并立即补扫（deferred 里的目录含本目录），避免 watcher 永久失效
        console.warn('[Watcher] 自动重扫挂起已超过上限，自动恢复:', key, `${SUSPEND_MAX_MS}ms`)
        setWatchSuspended(false)
      }
      return
    }
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(fire, DEBOUNCE_MS)
    // 事件流持续不断时防抖永不触发，用最长等待兜底
    if (!entry.maxTimer) entry.maxTimer = setTimeout(fire, MAX_WAIT_MS)
  }

  const watchDir = (dir: string) => {
    if (entry.watchers.length >= MAX_WATCHERS) return
    let watcher: fs.FSWatcher
    try {
      // 不做事件过滤：删除目录等事件无法仅凭文件名可靠识别，
      // 宁可误触发一次廉价重扫，也不漏掉增删
      watcher = fs.watch(dir, schedule)
    } catch {
      return // 目录不可读等：跳过
    }
    watcher.on('error', () => {
      // 目录被删除/重命名（尤其外部进程删除时，Windows 只发 error 不发
      // change/rename）：同样调度一次重扫以同步删除，监听树由扫描完成后的重建补齐
      schedule()
      try { watcher.close() } catch {}
      const idx = entry.watchers.indexOf(watcher)
      if (idx >= 0) entry.watchers.splice(idx, 1)
    })
    entry.watchers.push(watcher)

    let children: fs.Dirent[]
    try {
      children = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const child of children) {
      if (child.isDirectory() && !child.name.startsWith('.')) {
        watchDir(path.join(dir, child.name))
      }
    }
  }

  watchDir(key)
  console.log('[Watcher] watching folder:', key, `(${entry.watchers.length} watchers)`)
}
