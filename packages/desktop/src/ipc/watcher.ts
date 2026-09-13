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

interface FolderWatchers {
  watchers: fs.FSWatcher[]
  timer: NodeJS.Timeout | null
  maxTimer: NodeJS.Timeout | null
  onRescan: (folder: string) => void
}

const watched = new Map<string, FolderWatchers>()

export function isFolderWatched(folder: string): boolean {
  return watched.has(path.resolve(folder))
}

/** 停止监听指定目录（用户移除扫描目录 / 目录已从磁盘删除时调用） */
export function unwatchFolder(folder: string): void {
  const key = path.resolve(folder)
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
  // 重建：先释放旧 watcher，避免重复监听与句柄泄漏
  unwatchFolder(key)

  const entry: FolderWatchers = { watchers: [], timer: null, maxTimer: null, onRescan }
  watched.set(key, entry)

  const fire = () => {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    if (entry.maxTimer) { clearTimeout(entry.maxTimer); entry.maxTimer = null }
    entry.onRescan(folder)
  }
  const schedule = () => {
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
