import fs from 'fs'
import path from 'path'

/**
 * 下载落盘「目标路径预定」：为一个即将下载的文件在目标目录里**原子地**占住一个
 * 不重名的落盘名，并给出「临时文件路径 → 最终路径」这一对坐标。
 *
 * ## 为什么需要它
 *
 * 旧实现直接写最终路径，随后嵌入封面时又整文件重写一次。下载目录常就在用户的
 * 扫描目录内，而后台扫描与下载是并行跑的，于是存在两个真实故障：
 *
 * 1. **扫描读到半截文件**：`walkDir` 撞上写了一半的 `.mp3` 就 stat + 解析，
 *    解析失败/时长读到 0:00，曲库里落下一条截断记录，且下一次扫描也不会自愈
 *    （文件大小没变就不重解析）。
 * 2. **并发下载互相覆盖**：「探测哪个名字空着」与「真正创建文件」之间隔着 await，
 *    两个并发下载可能探到同一个未被占用的名字，后写的把先写的覆盖掉。
 *
 * 本模块把这两个问题一起收掉：写入永远发生在 `*.part` 上，只有下载 + 封面嵌入
 * 全部完成后才 rename 成最终名。rename 在同目录内是原子的，因此**最终路径上
 * 从来不存在半截文件**，扫描要么看不到它，要么看到的是完整文件。
 *
 * 名字互斥不靠内存锁，而靠文件系统的 `O_EXCL`（`fs.promises.open(part, 'wx')`）：
 * 谁先把 `xxx.part` 创建出来，谁就占住了这个候选名。这天然覆盖两件内存锁要做对
 * 才成立的事——跨进程互斥，以及大小写不敏感文件系统（Windows/macOS 上
 * `A.mp3.part` 与 `a.mp3.part` 是同一个文件，第二次 open 直接 EEXIST）。
 *
 * ## 边界
 *
 * 负责：候选名生成（含 Windows MAX_PATH 截断）、`O_EXCL` 占位、提交（rename）、
 * 失败清理（unlink）。
 * 不负责：HTTP 拉流（调用方自己做）、封面嵌入（调用方在 part 文件上做）、
 * 媒体缓存登记与曲库入库（都在调用方或更上层）。
 */

/** 去重名探测的最大尝试次数：超过则回退到时间戳后缀，避免目录内同名文件极多时死循环 */
const UNIQUE_SAVE_MAX_PROBE = 9999

/** Windows 单条路径总长上限（MAX_PATH），预留扩展名与 ` (n)` 后缀余量后取的保守阈值 */
const MAX_PATH_SAFE_LENGTH = 240

/** 临时文件后缀：只有它从「不存在」变成「存在」时文件名才被真正占住 */
const PART_SUFFIX = '.part'

export interface DownloadTarget {
  /** 最终落盘路径：rename 之后才出现，之前恒不存在 */
  finalPath: string
  /** 写入用的临时路径（`finalPath + '.part'`）：下载与封面嵌入都在这上面做 */
  partPath: string
}

/**
 * 探测最终路径是否已存在。
 *
 * 用异步 access 而非 existsSync：去重发生在主进程 IPC 里，同名文件多时连续同步
 * stat 会阻塞事件循环卡住 UI。除 ENOENT 外的错误（无权限等）一律按「不存在」处理
 * —— 这一步只负责挑一个「看起来空着」的名字，真正的写入失败会由后面的写入/占位
 * 抛出来，不在这里静默吞掉真实故障。
 */
async function finalExists(target: string): Promise<boolean> {
  try {
    await fs.promises.access(target, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 以 `O_EXCL` 创建占位文件。
 *
 * `wx` 是这里的全部意义所在：它让「判断不存在」与「创建」合成一个原子操作，
 * 于是并发的预定者之间由内核裁决胜负，不需要任何应用层锁。
 * 返回 false 表示该名字已被别人（上一次下载、另一个并发下载、残留的 .part）占住，
 * 调用方继续试下一个候选；其余错误（EACCES / ENOSPC…）是真实故障，向上抛。
 */
async function claimPartFile(partPath: string): Promise<boolean> {
  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(partPath, 'wx')
    return true
  } catch (err: any) {
    if (err?.code === 'EEXIST') return false
    throw err
  } finally {
    // 占位成功即关掉 fd：真正的写入由调用方的 createWriteStream(partPath) 重新打开
    if (handle) await handle.close().catch(() => {})
  }
}

/**
 * 预定一个落盘名。
 *
 * 候选序列与旧的 `uniqueSavePath` 一致：`baseName` / `baseName (1)` / `baseName (2)`…
 * （用户已经习惯这个后缀风格，也方便和曲库里的同名版本区分）。每个候选都要过两道：
 * 最终文件不存在（避免覆盖用户已有的歌），且 `xxx.part` 能被独占创建（避免两个
 * 并发下载抢同一个名字）。第二条同时把「另一个下载正在写这个候选」也算成占用，
 * 所以并发调用必然拿到两两不同的 finalPath。
 *
 * @param dir       目标目录（必须已存在）
 * @param baseName  不含扩展名的基名
 * @param ext       含点的扩展名，如 `.mp3`
 */
export async function reserveDownloadTarget(dir: string, baseName: string, ext: string): Promise<DownloadTarget> {
  // 组装候选名并按需截断基名，确保 `dir + 名字` 不突破 MAX_PATH 安全值。
  // 截断按字符（非字节）进行，中文被截不会产生半个字符。
  const buildCandidate = (suffix: string): string => {
    const dirLen = dir.length + 1 // 分隔符
    const maxStem = Math.max(1, MAX_PATH_SAFE_LENGTH - dirLen - ext.length - suffix.length)
    const safeStem = baseName.length > maxStem ? baseName.slice(0, maxStem) : baseName
    return path.join(dir, `${safeStem}${suffix}${ext}`)
  }

  const tryCandidate = async (suffix: string): Promise<DownloadTarget | null> => {
    const finalPath = buildCandidate(suffix)
    // 最终文件已存在就换下一个名字；大小写不敏感平台不需要额外比对，
    // 因为那里的 access 本身就不区分大小写（`A.mp3` 会命中已有的 `a.mp3`）
    if (await finalExists(finalPath)) return null
    const partPath = finalPath + PART_SUFFIX
    return (await claimPartFile(partPath)) ? { finalPath, partPath } : null
  }

  for (let i = 0; i <= UNIQUE_SAVE_MAX_PROBE; i++) {
    const target = await tryCandidate(i === 0 ? '' : ` (${i})`)
    if (target) return target
  }

  // 超限回退：时间戳 + 随机短串。仍然走同一套占位逻辑（仍然原子），只是基本不可能再撞
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  for (let i = 0; i <= 10; i++) {
    const target = await tryCandidate(i === 0 ? ` (${stamp})` : ` (${stamp}-${i})`)
    if (target) return target
  }
  const last = await tryCandidate(` (${stamp}-x)`)
  // 到这里说明目录里同名文件多到离谱（或磁盘行为异常）：宁可抛错，也不能返回一个
  // 可能与别人相同的路径。message 是开发者日志而非界面文案，调用方会把它转成
  // desktop.error.download.writeFailed 展示给用户。
  if (!last) throw new Error(`无法预定落盘名: ${baseName}${ext} in ${dir}`) // i18n-exempt: 开发者日志
  return last
}

/**
 * 提交：把临时文件改名成最终名。
 *
 * 同目录 rename 是原子替换，因此最终路径**只会**以完整形态出现一次——这正是
 * 「扫描永远读不到半截音频」与「没有封面重写窗口」的来源。
 */
export async function commitDownloadTarget(partPath: string, finalPath: string): Promise<void> {
  await fs.promises.rename(partPath, finalPath)
}

/**
 * 放弃本次下载：删掉临时文件。
 *
 * best-effort：失败/不存在都不抛，因为调用点已经处在失败分支里，
 * 再抛一个错只会掩盖原始故障。残留的 `.part` 会在下次预定同名候选时
 * EEXIST 跳过，不会污染最终路径。
 */
export async function discardDownloadTarget(partPath: string): Promise<void> {
  try {
    await fs.promises.unlink(partPath)
  } catch (err: any) {
    if (err?.code !== 'ENOENT') console.warn('清理下载临时文件失败:', partPath, err)
  }
}
