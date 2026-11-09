import type { Track, Playlist } from '@/types'
import { platform } from '@/services/platform'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { scoreOnlineResult, matchTracksByPaths, isSearchableSource, isDowngraded, tierRank, type AudioTier } from '@aurora/shared'
import { needsStorageResolve } from '@/lib/storageTrack'
import { pickDownloadCandidate, type DownloadCandidateInput } from '@/lib/onlineTrack'
import type { OnlineTrackSearchResult } from '@/types'

// 路径匹配（含「不得跨来源串味」的规则）实现在 @aurora/shared/src/importMatch.ts，
// 与歌单导入的按名匹配放在一起并带单测；这里原样再导出，保持既有调用方不变
export { matchTracksByPaths }

/**
 * 生成 M3U 播放列表内容
 * M3U8 格式：以 #EXTM3U 开头，每首歌用两行：
 *   #EXTINF:<duration>,<artist> - <title>
 *   <file_path>
 */
export function exportToM3U(playlist: Playlist, tracks: Track[]): string {
  const lines: string[] = ['#EXTM3U']

  for (const trackId of playlist.trackIds) {
    const track = tracks.find((t) => t.id === trackId)
    if (!track) continue
    const duration = Math.floor(track.duration)
    const title = `${track.artist} - ${track.title}`
    lines.push(`#EXTINF:${duration},${title}`)
    lines.push(track.path)
  }

  return lines.join('\n')
}

/**
 * 解析 M3U/M3U8 文件内容，返回文件路径数组
 */
export function parseM3U(content: string): string[] {
  const lines = content.split(/\r?\n/)
  const paths: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    // 跳过空行和注释行（但 #EXTINF 是元数据，跳过即可，下一行是路径）
    if (!line) continue
    if (line.startsWith('#')) continue
    paths.push(line)
  }

  return paths
}

/**
 * 触发文件下载（用于导出）
 */
export function downloadPlaylistAsM3U(playlist: Playlist, tracks: Track[]): void {
  const content = exportToM3U(playlist, tracks)
  const blob = new Blob([content], { type: 'audio/x-mpegurl' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${playlist.name}.m3u8`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * 打开文件选择器，读取 m3u/m3u8 文件
 * 返回文件内容字符串，或 null 表示取消
 */
export async function pickM3UFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      try {
        const text = await file.text()
        resolve(text)
      } catch {
        resolve(null)
      }
    }
    input.click()
  })
}

/** 播放前按需取址并发上限 */
const PLAY_RESOLVE_CONCURRENCY = 4

export interface EnsurePlayableTrackOptions {
  /**
   * 重新取址（下载场景专用）。
   *
   * 默认路径「曲目已有地址就早退」是为播放服务的：地址能用就别多打网络请求。但下载要看
   * **档位**——点下载时曲目上往往已经有一条兜底源给的低档地址（m4a / mp3），早退就等于
   * 用户设了 flac 也只下低档。所以下载路径传 reResolve=true：
   *
   * 1. 跳过「已有 onlineUrl 就早退」，先按 id 向源重取一次（服务端应按请求档位优先）；
   * 2. 按 id 拿到的仍低于请求档位时不收工，继续按名搜索（同源视角之外可能有别的无损录音）；
   * 3. 两个通道都**只接受不低于请求档位的候选**（版本 / 时长闸门照旧）；
   * 4. 一个都不合格就返回 null，让调用方保留它自己已有的候选。
   */
  reResolve?: boolean
}

/**
 * 让在线曲目可播放：本地曲目/已有地址的原样返回；
 * 导入歌单的在线曲目不持久化播放地址（会过期），用用户配置的
 * 音乐源重新搜索取最佳结果，并回填 importedTracks 供后续播放直接使用。
 * 未配置音乐源或无结果返回 null
 *
 * 优先**按源内定位信息取址**（脚本源的令牌 trackRef、自有服务协议的曲目 id onlineId）：
 * 两者定位的都是源内部的具体曲目，比「按歌名重新搜一遍」准得多 —— 同名不同版本
 * （变速版 / 翻唱 / DJ 版）在按名匹配里与目标同分，会串到别人的录音（实测见
 * @aurora/shared 的 trackResolver）；取不到再落回下面的统一搜索取址。
 *
 * 落回搜索取址时必须过 `scoreOnlineResult` 的版本标记与时长判据：全部候选都不像同一版本
 * 时返回 null（上屏取址失败），而不是退回「取第一条结果」—— 那等于把别的录音当原唱播。
 */
export async function ensurePlayableTrack(
  track: Track,
  opts?: EnsurePlayableTrackOptions
): Promise<Track | null> {
  const reResolve = opts?.reResolve === true
  /**
   * 远端媒体库曲目（移动端）：先换成"本机可播地址"。
   *
   * 桌面端这类曲目自带 `remoteUrl`（aurora-remote:// 协议代理），不会走到这里；
   * 移动端没有自定义协议，`resolveStorageAudio` 会把远端文件整首落到媒体缓存并
   * 返回本地地址。取不到（断网 / 口令失效 / 空间不足）就返回 null，
   * 由调用方按"取址失败"上屏，而不是把不可加载的坐标塞给播放器。
   */
  if (needsStorageResolve(track)) {
    const resolved = await platform
      .resolveStorageAudio?.({ sourceId: track.sourceId, path: track.path })
      .catch(() => null)
    if (!resolved?.src) return null
    return { ...track, onlineUrl: resolved.src }
  }
  // 本地曲目在磁盘上，没有「重新取址」这回事
  if (track.path) return track
  const { onlineSources, downloadQuality } = useLibraryStore.getState()
  /**
   * 这条候选**实际会被用到**的档位 —— 必须与下载器同一口径（pickDownloadCandidate）。
   *
   * 不能直接用 `inferAudioTier`：它的第一优先级是 qualityUrls 的键，而服务端按档位
   * 取址之后的典型返回是「audioUrl = 无损 .flac、qualityUrls = {'128': 本地 mp3}」，
   * 那样会被判成 128 → 闸门把真正会下载的无损地址挡掉 → 主修复失效。
   * pickDownloadCandidate 返回的 tier 正是「下载时实际会挑的那份地址」的档位。
   */
  const tierOf = (candidate: DownloadCandidateInput): AudioTier =>
    pickDownloadCandidate(candidate, downloadQuality).tier
  /** 默认路径不做档位过滤（播放只要「能播」）；只有 reResolve（下载）才按设置档位筛 */
  const acceptable = (candidate: DownloadCandidateInput): boolean =>
    !reResolve || !isDowngraded(tierOf(candidate), downloadQuality)

  /**
   * 跨源脚本取址（脚本源按平台认领）：**先于**「曲目已有地址」的早退。
   *
   * 洛雪自定义脚本大多只实现 `musicUrl`、不实现 `search`，所以搜索仍由常规音源服务
   * 负责；用户给脚本源指定平台后，同平台曲目在播放/下载时应优先交给脚本取直链
   * （更稳、或能拿到音源服务拿不到的档位）。早退位置很关键：搜索返回的 `audioUrl`
   * 往往就是上游直链，先早退会让这条路永远执行不到。
   *
   * 失败一律回落：没有候选 / 脚本取不到 / 地址非法时，下面照旧用原有地址或按名搜索。
   */
  if (platform.resolveScriptTrackAudio) {
    const viaScript = await platform.resolveScriptTrackAudio(track).catch(() => null)
    if (viaScript?.onlineUrl && acceptable(viaScript)) {
      usePlaylistStore.getState().addImportedTracks([viaScript])
      return viaScript
    }
  }

  if (!reResolve && track.onlineUrl) return track

  let viaSource: Track | null = null
  if (track.trackRef || track.onlineId) {
    viaSource = await platform.resolveTrackAudio?.(track).catch(() => null)
    // reResolve 下按 id 拿到的仍是低档时**不早退**：继续走按名搜索，
    // 另一个平台可能有无损录音（两者都不绕过下面的版本闸门）
    if (viaSource?.onlineUrl && acceptable(viaSource)) {
      usePlaylistStore.getState().addImportedTracks([viaSource])
      return viaSource
    }
  }
  // 判据与搜索面板同一口径（插件能力判定）：只看协议端点会把「只配了脚本源」当成没源可搜，
  // 那样连按名补齐都不会跑，内置聚合搜索的兜底也就永远轮不到。
  if (!onlineSources.some((s) => s.enabled && isSearchableSource(s))) {
    // 没有可搜索的源：reResolve 已拿到的按 id 候选就是唯一兜底。
    // 不能直接丢——它可能仍低于请求档位，但「128→320」这种部分提升对用户仍是改善，
    // 是否替换由调用方（runOnlineDownload）按 tierRank 判断。
    if (reResolve && viaSource?.onlineUrl) return viaSource
    return null
  }
  try {
    const results = await platform.searchOnlineTracks(
      `${track.title} ${track.artist}`.trim(),
      { sources: onlineSources, quality: downloadQuality }
    )
    /** 搜索条目 → Track（与下面的 resolved 映射同一份字段口径） */
    const toResolved = (r: OnlineTrackSearchResult): Track => ({
      ...track,
      onlineUrl: r.audioUrl,
      onlineQualityUrls: r.qualityUrls,
      // 源声明的实际档位（可能为空/认不出，统一由 inferAudioTier 归一）
      onlineQuality: r.audioQuality,
      coverUrl: r.coverUrl || track.coverUrl,
      onlineSource: r.source,
      onlineSourceName: r.sourceName,
      // 源内 id：优先存源回填的 songmid（自有服务协议），脚本源没有该字段则回落条目 id。
      // 存源内 id 是「按 id 取址」的前提（见 shared/src/trackResolver.ts）。
      onlineId: r.songmid || r.id,
      duration: track.duration || r.duration,
      // 源的条目可能只给元信息（地址按需再取），定位令牌一并带上
      trackRef: r.trackRef,
    })

    let best: OnlineTrackSearchResult | null = null
    let bestScore = 0
    let bestRank = -1
    // reResolve 专用兜底：过了版本闸门、但档位不达标的候选里，档位最高的一条
    let fallback: OnlineTrackSearchResult | null = null
    let fallbackRank = -1
    let fallbackScore = 0
    for (const r of results) {
      // 时长与专辑一并交给打分：同名不同版本（变速版 / 翻唱 / DJ 版）在「标题 + 歌手」
      // 上是满分，只有版本标记与时长能把它挡掉（判据见 shared/src/importMatch.ts）
      const score = scoreOnlineResult(r, {
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
      })
      // 0 分 = 被版本 / 时长闸门挡掉：连兜底都不能用（那等于把别人的录音当原唱）
      if (score <= 0) continue

      if (!reResolve) {
        if (score > bestScore) {
          bestScore = score
          best = r
        }
        continue
      }

      const tier = tierOf({
        onlineUrl: r.audioUrl,
        onlineQualityUrls: r.qualityUrls,
        onlineQuality: r.audioQuality,
      })
      if (!isDowngraded(tier, downloadQuality)) {
        // 达标：先按档位高者、再按匹配分高者（「优先满足所选档位」优先于「同名里最像」）
        const rank = tierRank(tier)
        if (rank > bestRank || (rank === bestRank && score > bestScore)) {
          best = r
          bestRank = rank
          bestScore = score
        }
        continue
      }
      const rank = tierRank(tier)
      if (rank > fallbackRank || (rank === fallbackRank && score > fallbackScore)) {
        fallback = r
        fallbackRank = rank
        fallbackScore = score
      }
    }

    // reResolve 没有完全达标的候选时，返回「by-id 与搜索里档位最高的一条」而不是 null：
    // 调用方只需比较 tierRank 就能决定是否替换（部分提升也生效，且不会丢已拿到的候选）
    if (!best && reResolve) {
      const viaSourceRank = viaSource?.onlineUrl ? tierRank(tierOf(viaSource)) : -1
      if (fallback && fallbackRank > viaSourceRank) {
        const fallbackResolved = toResolved(fallback)
        usePlaylistStore.getState().addImportedTracks([fallbackResolved])
        return fallbackResolved
      }
      if (viaSource?.onlineUrl) {
        usePlaylistStore.getState().addImportedTracks([viaSource])
        return viaSource
      }
    }
    // 全被闸门挡掉时**不给结果**：宁可上屏「取址失败」，也不要把同名不同版本塞进播放器。
    // 旧行为是 `best || results[0]` —— 那正是「元数据是原唱、播出来是变速版」那条路径。
    if (!best) {
      if (results.length > 0) {
        // 单行保留 console.warn( 与整句中文：i18n 门禁按行判定「日志还是界面文案」，
        // 把文案拆到下一行会被当成未国际化的界面中文（日志面向开发者，不进界面）
        console.warn(`[音源] 「${track.title} - ${track.artist}」的 ${results.length} 条结果没有可用的同版本候选（版本标记、时长或音质档位对不上），已放弃取址`)
      }
      return null
    }
    const resolved = toResolved(best)
    usePlaylistStore.getState().addImportedTracks([resolved])
    return resolved
  } catch {
    return null
  }
}

/** 批量让歌单可播放（播放全部场景）：只处理缺地址的曲目，并发 4 */
export async function resolvePlayableTracks(tracks: Track[]): Promise<Track[]> {
  const result = [...tracks]
  const jobs = tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !t.path && !t.onlineUrl)
  if (jobs.length === 0) return result
  let cursor = 0
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++]
      const resolved = await ensurePlayableTrack(job.t).catch(() => null)
      if (resolved) result[job.i] = resolved
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PLAY_RESOLVE_CONCURRENCY, jobs.length) }, () => worker())
  )
  return result
}
