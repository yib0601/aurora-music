import { encryptedAudioSearchQuery, mapWithConcurrency, scoreOnlineResult } from '@aurora/shared'
import type { EncryptedAudioFile, OnlineTrackSearchResult } from '@aurora/shared'
import { pickDownloadUrl } from '@/lib/onlineTrack'
import type { DownloadQuality, OnlineSourceConfig, OnlineSearchOptions, Track } from '@/types'

/**
 * 「加密音频 → 用音源重下一份明文副本」的编排。
 *
 * 为什么是重下而不是解密：加密文件（QQ 音乐 `.mflac0` / `.mgg2` 等）的解锁需要平台密钥，
 * 那条路既踩版权红线（该项目公开分发），又对 `.mgg2` 这类新方案未必可行。
 * 按名重下走的是用户**自己配置的音源**，与手动搜索下载完全同一条链路，
 * 不引入任何新能力，也不需要用户理解加密格式。
 *
 * 与 UI 解耦（依赖注入）：每次匹配/下载的失败分支都很多（源没配、取不到址、
 * 匹配不到、写盘失败），编排逻辑必须能被单测逐个走通，否则只能靠真机试。
 *
 * **批量替换**（多选 / 有界并发 / 可选清理原件）也在这里：三者都是「这一批怎么跑」的
 * 口径，放进 UI 会让同一批在不同界面上跑出不同结果。清理原件走新增的可选依赖
 * `removeSourceFile`，能力缺失时整段跳过（见下方闸门注释）。
 */

/** 在线匹配总分阈值（标题分 + 歌手分，满分 2）：与歌单导入同一档，宁可漏也不要下错歌 */
const ACCEPT_SCORE = 1.4

/**
 * 批量替换的默认并发档。
 *
 * 不支持无上限并发的原因很具体：下载本身是带宽瓶颈，且每条链路要打三次外部请求
 * （搜索 → 取址 → 拉流），并发档开大以后同一首歌的搜索与拉流会互相抢带宽，
 * 表现为「每首都慢、一首都没完成」。3 是「一条流跑满 + 搜索/取址有并行度」的经验值。
 *
 * 与旧的严格串行（1）相比，这一档的收益不是理论值：取址失败的条目（VIP 试听 /
 * 直链过期）在串行实现里会让整批白等一个来回，并发把它们与下载重叠起来。
 */
export const DEFAULT_REPLACE_CONCURRENCY = 3

/** 并发档上限：再大只会让上游音源服务限流，用户也分不清是慢还是卡死 */
export const MAX_REPLACE_CONCURRENCY = 6

/**
 * 单条文件的处理结局。
 *
 * - `done`：已下载并入库
 * - `no-match`：音源里搜不到足够像的条目（多数是文件名还原出的歌手/歌名不准）
 * - `no-address`：搜到了条目，但取址门面拿不到可下载地址（VIP 试听 / 直链过期）
 * - `failed`：网络/写盘/搜索异常，具体原因在 `error` 里原样透出
 * - `canceled`：用户点了取消，这条还没开始就被跳过（**不是失败**，不计入 failed 计数）
 */
export type RedownloadOutcome = 'done' | 'no-match' | 'no-address' | 'failed' | 'canceled'

export interface RedownloadResult {
  /** 对应的加密文件路径（UI 用来把结果贴回列表行） */
  path: string
  outcome: RedownloadOutcome
  /** 落盘路径（outcome==='done' 时才有） */
  savedPath?: string
  /** 是否成功入库；下载成功但解析失败时为 false —— 文件在磁盘上，只是没进曲库 */
  imported?: boolean
  /** 命中条目的标题/歌手，供用户核对是不是同一首（不展示源名，避免噪音） */
  matchedTitle?: string
  matchedArtist?: string
  /** outcome==='failed' 时的原始错误信息（未翻译，由显示侧决定怎么呈现） */
  error?: string

  // ─── 批量替换（replaceSource 开启后才会填）───
  /**
   * 原加密文件是否已被清理。
   *
   * 三态而不是布尔：`undefined` = 没要求清理（用户没开替换）；`true` = 已移入回收站/
   * 已删除；`false` = 要求了但没清掉（原因在 `cleanupError`）。把「没做」与「做了没成」
   * 混成一个 false，UI 就没法告诉用户「文件还在」还是「你没勾这项」。
   */
  sourceRemoved?: boolean
  /** 清理原文件失败的原因（未翻译原文） */
  cleanupError?: string
}

export interface RedownloadDeps {
  /** 在线搜索（生产实现是 platform.searchOnlineTracks） */
  search: (query: string, options?: OnlineSearchOptions) => Promise<OnlineTrackSearchResult[]>
  /** 按需取址（生产实现是 playlistIO.service 的 ensurePlayableTrack） */
  ensurePlayable: (track: Track) => Promise<Track | null>
  /** 实际下载（生产实现是 platform.downloadOnlineTrack） */
  downloadFile: (
    payload: { audioUrl: string; title: string; artist?: string; album?: string; coverUrl?: string },
    headers: Record<string, string> | undefined,
    downloadDir: string | undefined
  ) => Promise<{ savedPath: string }>
  /** 下载后解析入库（生产实现是 platform.importAudioFile；平台不提供时留空） */
  importFile?: (filePath: string) => Promise<Track | null>
  /**
   * 清理原加密文件（批量替换的「替换」那一半）。
   *
   * 平台不提供时留空 = 只下载不清理，界面上「替换原文件」这一项就不该出现
   * （而不是点下去静默什么都不做）。桌面端走 shell.trashItem（可撤销），
   * 移动端走 Filesystem.deleteFile（Android 没有统一回收站，见调用侧注释）。
   */
  removeSourceFile?: (filePath: string) => Promise<void>
  /** 读当前配置（音源表 / 默认下载目录 / 音源质量档） */
  config: () => { sources: OnlineSourceConfig[]; downloadDir: string | null; quality: DownloadQuality }
  /** 每处理完一条回调一次，用于刷新列表行与总进度（并发下回调次序 ≠ 入参次序） */
  onProgress?: (done: number, total: number, result: RedownloadResult) => void
  /** 用户取消：已开始的条目会跑完，未开始的不再启动 */
  isCanceled?: () => boolean
  /**
   * 并发档（缺省见 DEFAULT_REPLACE_CONCURRENCY，> MAX_REPLACE_CONCURRENCY 会被夹住）。
   * 传 1 即退回旧的全串行行为。
   */
  concurrency?: number
  /**
   * 下载成功并入库后，是否清理原加密文件。
   *
   * 只在 `outcome==='done'` **且** `imported!==false` 时执行：文件没进曲库就删掉原件
   * 等于让用户两头空。清理失败不翻转 outcome —— 新文件已经好好的在库里了。
   */
  replaceSource?: boolean
  /**
   * 把「批量写盘期间不要自动重扫」这件事交给平台（桌面端实现为挂起 fs.watch 触发的扫描）。
   *
   * 为什么需要：桌面端的扫描目录 watcher 对任何文件变动都按 1.5s 防抖触发**整库重扫**
   * （walkDir + 全量 stat + 全量查库）。一批 40 首的替换会连续写 40 个文件，
   * 于是整批期间重扫几乎不停地在跑，与下载抢磁盘 IO，也让每首的三次网络往返更难收敛。
   * 挂起后这些变动只被记账，整批结束（含失败/取消）时补一次扫描即可。
   *
   * 平台不提供时留空 = 不挂起，功能不受影响（只是慢一点）。
   */
  onBatchStart?: () => void | Promise<void>
  onBatchEnd?: () => void | Promise<void>
  /**
   * 每成功入库一首后回调一次，参数是入库后的曲目。
   *
   * 曲库列表在渲染层是本地副本：不主动告诉它，用户会看到「替换成功但列表还是旧的」。
   * 与 onProgress 分开是因为两者的消费者不同——进度只关心计数与结局，
   * 曲目回流要给 `addTracks` 用。
   */
  onTrackImported?: (track: Track) => void
}

/** 搜索命中 → 可下载/可播放的曲目对象（形态与歌单导入的在线条目一致） */
function toTrack(result: OnlineTrackSearchResult): Track {
  return {
    id: result.id,
    path: '',
    title: result.title,
    artist: result.artist,
    album: result.album,
    duration: result.duration,
    addedAt: Date.now(),
    playCount: 0,
    liked: false,
    onlineUrl: result.audioUrl,
    onlineQualityUrls: result.qualityUrls,
    coverUrl: result.coverUrl,
    onlineSource: result.source,
    onlineSourceName: result.sourceName,
    // 源内 id 优先（源回填了 songmid 时按它取址才不会串到同名版本）
    onlineId: result.songmid || result.id,
    trackRef: result.trackRef,
  }
}

/**
 * 在候选里挑最像的一条。
 *
 * 用共享的 `scoreOnlineResult` 而不是自己比字符串：它已经内含标题阈值、
 * 版本标记（伴奏/翻唱/remix）排除与时长容差 —— 这三条正是「按名重下」最容易下错的地方。
 */
function pickBest(results: OnlineTrackSearchResult[], file: EncryptedAudioFile): OnlineTrackSearchResult | null {
  let best: OnlineTrackSearchResult | null = null
  let bestScore = 0
  for (const r of results) {
    const score = scoreOnlineResult(r, { title: file.title, artist: file.artist })
    if (score > bestScore) {
      bestScore = score
      best = r
    }
  }
  return best && bestScore >= ACCEPT_SCORE ? best : null
}

/** 单条文件：搜索 → 匹配 → 取址 → 下载 → 入库 */
async function redownloadOne(file: EncryptedAudioFile, deps: RedownloadDeps): Promise<RedownloadResult> {
  const query = encryptedAudioSearchQuery(file)
  // 文件名连歌名都还原不出来（例如只有一个 `[mqms2].flac` 之类的纯标记名）：
  // 按名搜索必然搜不到，直接判未匹配，省掉一次无意义的网络请求
  if (!query) return { path: file.path, outcome: 'no-match' }

  const { sources, downloadDir, quality } = deps.config()

  let results: OnlineTrackSearchResult[]
  try {
    results = await deps.search(query, { sources, quality })
  } catch (err) {
    return { path: file.path, outcome: 'failed', error: err instanceof Error ? err.message : String(err) }
  }

  const best = pickBest(results, file)
  if (!best) return { path: file.path, outcome: 'no-match' }

  // 下载前必须重新取址：搜索结果的地址可能已过期，惰性取址的源根本不带地址
  let resolved: Track | null = best.audioUrl ? toTrack(best) : null
  try {
    resolved = (await deps.ensurePlayable(toTrack(best))) ?? resolved
  } catch {
    // 取址失败不直接判死：源在搜索阶段给了地址的话仍可尝试下载
  }
  if (!resolved?.onlineUrl) {
    return { path: file.path, outcome: 'no-address', matchedTitle: best.title, matchedArtist: best.artist }
  }

  const source = sources.find((s) => s.id === resolved!.onlineSource)
  let savedPath: string
  try {
    const saved = await deps.downloadFile(
      {
        audioUrl: pickDownloadUrl(resolved, quality),
        title: resolved.title,
        artist: resolved.artist,
        album: resolved.album,
        coverUrl: resolved.coverUrl,
      },
      source?.headers,
      downloadDir || undefined
    )
    savedPath = saved.savedPath
  } catch (err) {
    return {
      path: file.path,
      outcome: 'failed',
      matchedTitle: best.title,
      matchedArtist: best.artist,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // 入库失败不算下载失败：文件已经落在磁盘上，用户重扫一次目录也能看到它。
  // 这里把「已下载但没入库」如实带出去，UI 需要区分这两种结局
  let imported = false
  if (deps.importFile) {
    try {
      const track = await deps.importFile(savedPath)
      imported = Boolean(track)
      // 入库成功立刻回流给曲库：渲染层的 tracks 是本地副本，不主动追加就会
      // 出现「替换成功但列表里还是空的」，用户只能靠重扫目录自救
      if (track) deps.onTrackImported?.(track)
    } catch (err) {
      console.warn('[encryptedRedownload] 入库失败（文件已下载）:', savedPath, err)
    }
  }

  const result: RedownloadResult = {
    path: file.path,
    outcome: 'done',
    savedPath,
    imported,
    matchedTitle: best.title,
    matchedArtist: best.artist,
  }

  // 替换原件的闸门：**必须先入库**。文件解析不出元信息（imported===false）时删掉
  // 加密原件，用户就同时失去「能播的」和「原件」两样东西 —— 那种情形下宁可留着。
  if (deps.replaceSource && deps.removeSourceFile && imported && savedPath !== file.path) {
    try {
      await deps.removeSourceFile(file.path)
      result.sourceRemoved = true
    } catch (err) {
      // 清理失败不翻转 outcome：新文件已经在库里了，原件多留一份只是占空间
      console.warn('[encryptedRedownload] 清理原加密文件失败:', file.path, err)
      result.sourceRemoved = false
      result.cleanupError = err instanceof Error ? err.message : String(err)
    }
  }

  return result
}

/**
 * 批量处理加密文件（有界并发，默认 DEFAULT_REPLACE_CONCURRENCY）。
 *
 * 为什么不是全串行：一批四五十首时，串行把每一首的三次往返（搜索/取址/拉流）
 * 首尾相接，用户体感是「点了没反应」；而带宽瓶颈只约束**拉流**那一段，
 * 搜索与取址完全可以重叠。
 *
 * 为什么必须有上限：并发档开大以后同一个音源服务被 N 条链路同时打，
 * 先触发限流，接着每首都在超时里慢慢失败 —— 比串行还慢，且失败原因全是 429/超时，
 * 用户无从判断是源的问题还是文件的问题。
 *
 * 返回顺序与入参一致（mapWithConcurrency 保证）；取消时**未启动**的条目
 * 也照样返回一条 `canceled`，让 UI 能一次性把所有行画完，不必自己补空。
 */
export async function redownloadEncryptedAudio(
  files: readonly EncryptedAudioFile[],
  deps: RedownloadDeps
): Promise<RedownloadResult[]> {
  const list = files || []
  if (list.length === 0) return []

  const limit = Math.min(
    Math.max(1, Math.floor(deps.concurrency ?? DEFAULT_REPLACE_CONCURRENCY) || 1),
    MAX_REPLACE_CONCURRENCY
  )

  // 进度计数要在并发下仍然单调：用已结算条数做分母进度，而不是用下标
  let settled = 0
  try {
    // 整批挂起自动重扫：一批 40 首会连续写 40 个文件，watcher 的 1.5s 防抖会被
    // 不断重置，整批期间重扫几乎不停地在跑，与下载抢 IO。结束（含异常/取消）时恢复。
    await deps.onBatchStart?.()
    const results = await mapWithConcurrency(list, limit, async (file) => {
      // 取消判定放在 worker 开头：已启动的那几条会跑完（中断它们的代价是多写一个
      // 半截文件 + 一条已发出的下载请求），后续排队的不再开始
      if (deps.isCanceled?.()) {
        settled += 1
        const canceledResult: RedownloadResult = { path: file.path, outcome: 'canceled' }
        deps.onProgress?.(settled, list.length, canceledResult)
        return canceledResult
      }
      const result = await redownloadOne(file, deps)
      settled += 1
      deps.onProgress?.(settled, list.length, result)
      return result
    })

    return results
  } finally {
    // 必须无条件恢复：抛错时若不恢复，watcher 会一直挂着，
    // 用户之后新增的歌要等到下次启动才进库（表现为「扫描失效」）
    try {
      await deps.onBatchEnd?.()
    } catch (err) {
      console.warn('[encryptedRedownload] 恢复自动扫描失败:', err)
    }
  }
}
