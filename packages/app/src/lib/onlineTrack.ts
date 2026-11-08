import { inferAudioTier, type AudioTier } from '@aurora/shared'
import type { Track, DownloadQuality } from '@/types'

/**
 * 在线曲目的下载判据与下载地址挑选。
 *
 * 抽成纯模块（而非留在 hook 里）是为了能被单测覆盖：这两处逻辑的错法都很隐蔽——
 * 判据错会让下载入口整段消失，地址挑选错会静默下到错误音质。
 */

/** 音质回退链：设置的档位不可用时，依次尝试其余档位，最终回退到源默认地址 */
const QUALITY_FALLBACK: Record<DownloadQuality, DownloadQuality[]> = {
  '128': ['128', '320', 'flac'],
  '320': ['320', 'flac', '128'],
  flac: ['flac', '320', '128'],
}

/** 多音质地址的合法键（运行时数据来自服务端 JSON，不能信类型） */
const QUALITY_KEYS: readonly DownloadQuality[] = ['128', '320', 'flac']

/** 下载候选：地址 + 这条地址的实际档位 */
export interface DownloadCandidate {
  url: string
  tier: AudioTier
}

/**
 * 挑选下载候选所需的字段（结构类型，`Track` 天然满足）。
 *
 * 放宽成结构类型是为了让**搜索结果**（`OnlineTrackSearchResult`，字段名是
 * audioUrl / qualityUrls / audioQuality）也能直接走同一口径：下载器与取址闸门
 * 必须用同一个判据，否则会出现「闸门按 A 判、下载按 B 挑」的错位。
 */
export interface DownloadCandidateInput {
  onlineUrl?: string
  onlineQualityUrls?: Partial<Record<DownloadQuality, string>>
  onlineQuality?: string
}

/** 排序用的中间结构：`fromAudioUrl` 只用于同档位内的先后（多音质地址优先） */
interface RankedCandidate extends DownloadCandidate {
  fromAudioUrl: boolean
}

/**
 * 挑选下载候选（地址 + 档位），**优先满足所选档位**。
 *
 * 为什么不能只认 `qualityUrls`：真实音源（music.lighthouses.top 实测）在请求 flac 时
 * 常常把**兜底源的有损地址**放在 `audioUrl`（C400 的 m4a / M500 的 mp3），而
 * `qualityUrls` 只有本地低档甚至为空；反过来也有服务端把无损链接放 `audioUrl`、
 * 只把本地低档放进 `qualityUrls` 的情况。只看其中一边，都会静默下到错误档位。
 *
 * 排序口径：
 * 1. 先按 `QUALITY_FALLBACK[preferred]` 链的命中顺序（首选档位最前，链尾最后）；
 * 2. 同一档位内多音质地址优先于 `audioUrl`（源按档位分过的地址比兜底地址可信）；
 * 3. 链外档位（`lossy` / `unknown`，实际只可能是 `audioUrl`）一律排最后。
 *
 * 档位推断统一交给共享模块的 `inferAudioTier`（多音质地址键 → 源声明 → 扩展名）。
 * 注意返回的 tier 是「**这条候选实际会被用到的档位**」：它优先看 qualityUrls 的键
 * （下载器确实会挑那条地址），而不是单看 audioUrl 的扩展名。
 */
export function pickDownloadCandidate(
  track: DownloadCandidateInput,
  preferred: DownloadQuality
): DownloadCandidate {
  const chain = QUALITY_FALLBACK[preferred]
  const chainIndex = (tier: AudioTier): number => {
    const index = chain.indexOf(tier as DownloadQuality)
    return index < 0 ? Number.POSITIVE_INFINITY : index
  }

  const candidates: RankedCandidate[] = []
  const urls = track.onlineQualityUrls
  if (urls) {
    for (const quality of QUALITY_KEYS) {
      const url = urls[quality]
      if (url) candidates.push({ url, tier: quality, fromAudioUrl: false })
    }
  }
  if (track.onlineUrl) {
    candidates.push({
      url: track.onlineUrl,
      tier: inferAudioTier({ declared: track.onlineQuality, url: track.onlineUrl }),
      fromAudioUrl: true,
    })
  }

  if (candidates.length === 0) return { url: track.onlineUrl ?? '', tier: 'unknown' }

  candidates.sort((a, b) => {
    const rankA = chainIndex(a.tier)
    const rankB = chainIndex(b.tier)
    if (rankA !== rankB) return rankA - rankB
    // 同档位：链内多音质地址优先；链外（只有 audioUrl 一种来源）按 audioUrl 优先兜底
    const inChain = Number.isFinite(rankA)
    return inChain
      ? Number(a.fromAudioUrl) - Number(b.fromAudioUrl)
      : Number(b.fromAudioUrl) - Number(a.fromAudioUrl)
  })

  const best = candidates[0]
  return { url: best.url, tier: best.tier }
}

/**
 * 按下载音质设置挑选下载地址（`pickDownloadCandidate` 的薄包装，保留既有调用点）。
 * 需要档位（降级判断 / 提示）时用 `pickDownloadCandidate`。
 */
export function pickDownloadUrl(track: Track, preferred: DownloadQuality): string {
  return pickDownloadCandidate(track, preferred).url
}

/**
 * 是否展示下载入口（歌曲详情页「更多」菜单 / 搜索行右键菜单共用同一判据）。
 *
 * 判据只看「是不是在线曲目」，不看当次有没有拿到播放地址：
 * - 在线曲目在「最近播放 / 导入歌单 / 播放队列」里只留元数据快照，播放地址
 *   （onlineUrl / onlineQualityUrls）按约定在落盘时被剥离——歌源直链几十分钟即过期，
 *   持久化必然失效（见 playerStore 的 stripOnlineUrl、libraryStore.addRecentPlayed）。
 *   实测重启后的持久化数据：在线条目只剩 path:"" + onlineSource + onlineId，无任何 URL。
 * - 所以拿 onlineUrl 当判据会让重启后（以及导入歌单里尚未播放过的曲目）完全没有
 *   下载入口，这正是「在线歌曲点开三个点却没有下载」的成因。地址改由下载时按需重取
 *   （见 useDownloadOnlineTrack 里的 ensurePlayableTrack）。
 *
 * 本地曲目已在磁盘上，不给下载入口。
 */
export function isDownloadableOnlineTrack(track: Track): boolean {
  // 网络存储来源（WebDAV）：曲目文件在远端曲库，下载管线（在线歌源直链）不接它，
  // 给入口只会点出一句「取不到音源」，与事实不符
  if (track.sourceId || track.remoteUrl) return false
  if (track.onlineUrl || track.onlineQualityUrls) return true
  return !!(track.onlineId || track.onlineSource || track.onlineSourceName)
}