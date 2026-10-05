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

/** 按下载音质设置挑选下载地址：源未提供多音质地址时直接用默认地址 */
export function pickDownloadUrl(track: Track, preferred: DownloadQuality): string {
  const urls = track.onlineQualityUrls
  if (urls) {
    for (const q of QUALITY_FALLBACK[preferred]) {
      if (urls[q]) return urls[q]!
    }
  }
  return track.onlineUrl!
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