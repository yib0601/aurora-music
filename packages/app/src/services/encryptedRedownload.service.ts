import { encryptedAudioSearchQuery, scoreOnlineResult } from '@aurora/shared'
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
 */

/** 在线匹配总分阈值（标题分 + 歌手分，满分 2）：与歌单导入同一档，宁可漏也不要下错歌 */
const ACCEPT_SCORE = 1.4

/**
 * 单条文件的处理结局。
 *
 * - `done`：已下载并入库
 * - `no-match`：音源里搜不到足够像的条目（多数是文件名还原出的歌手/歌名不准）
 * - `no-address`：搜到了条目，但取址门面拿不到可下载地址（VIP 试听 / 直链过期）
 * - `failed`：网络/写盘/搜索异常，具体原因在 `error` 里原样透出
 */
export type RedownloadOutcome = 'done' | 'no-match' | 'no-address' | 'failed'

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
  /** 读当前配置（音源表 / 默认下载目录 / 音源质量档） */
  config: () => { sources: OnlineSourceConfig[]; downloadDir: string | null; quality: DownloadQuality }
  /** 每处理完一条回调一次，用于刷新列表行与总进度 */
  onProgress?: (done: number, total: number, result: RedownloadResult) => void
  /** 用户取消：在两条之间检查，取消后不再发起新的搜索/下载 */
  isCanceled?: () => boolean
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
      imported = Boolean(await deps.importFile(savedPath))
    } catch (err) {
      console.warn('[encryptedRedownload] 入库失败（文件已下载）:', savedPath, err)
    }
  }

  return {
    path: file.path,
    outcome: 'done',
    savedPath,
    imported,
    matchedTitle: best.title,
    matchedArtist: best.artist,
  }
}

/**
 * 批量处理加密文件（串行：下载本身是带宽瓶颈，并发只会让多首一起卡）。
 * 返回每条文件的结局，顺序与入参一致。
 */
export async function redownloadEncryptedAudio(
  files: readonly EncryptedAudioFile[],
  deps: RedownloadDeps
): Promise<RedownloadResult[]> {
  const results: RedownloadResult[] = []
  for (let i = 0; i < files.length; i++) {
    if (deps.isCanceled?.()) break
    const result = await redownloadOne(files[i], deps)
    results.push(result)
    deps.onProgress?.(i + 1, files.length, result)
  }
  return results
}
