import { normalizeName, titleScore, artistScore, TITLE_THRESHOLD } from '@aurora/shared'
import type { Track } from '@/types'

/**
 * 音乐库歌单/榜单详情页的「时长补值」（纯函数，摆在 lib 层便于单测）。
 *
 * 背景：乐源对无权益曲目回落到兜底音源时会把条目 duration 恒写成 0（实测用户歌单
 * 「周杰伦」5/5 条如此）。时长是「元数据与实际音频是否相符」这条判据的一半，
 * 丢了它播放器只能靠实际解码时长兜底。而本地曲库对同一首歌解析出的时长是准确的，
 * 于是可以在构造可播放条目时把它借过来。
 *
 * 三条边界：
 *   - **不新增网络请求**：只在已经拿到的本地曲库上做匹配，取不到就保持 0；
 *   - **不改播放方式**：本地存在同一首歌时由 matchTracksByNames 直接换成完整本地副本
 *     （那条路在页面里更靠前），本模块只服务「本地没有同一首歌、只有一个同曲时长可借」的场景；
 *   - **不猜**：匹配不上就返回 0，交给播放器的提示音闸门按实际解码时长处理。
 */

/**
 * 库内模糊匹配的接受分（标题分 + 歌手分，满分 2）。
 *
 * 与歌单导入的 ACCEPT_SCORE 同一口径：这里只是「补一个时长」，比导入时「把这首歌
 * 绑定到本地副本」的代价低，但两者都是「同一首歌」的判定，用两套阈值没有道理。
 */
export const LIBRARY_MATCH_ACCEPT_SCORE = 1.4

/**
 * 库内候选预筛桶的键：归一化歌名的前两个字。
 *
 * 为什么要预筛：补值按歌名做模糊匹配，而歌单详情动辄几百行（实测 647 首）、曲库动辄
 * 上万首。逐对调 titleScore 是秒级卡顿（本机实测 600 行 × 5000 首耗时 8068ms），页面
 * 每次进入都会卡住。按歌名前两字分桶后只扫同桶条目，同样的量降到 300ms 级；而
 * 「前两字相同」对模糊匹配几乎不设限——normalizeName 已经去掉了标点、括号备注与大小写差异。
 *
 * 代价是前两字恰好不同的标题（例如被上游拼成「歌名-歌手」的整串标题）不会进入打分。
 * 补值本身是尽力而为：补不到就保持 0 交给闸门，不做全库扫描换那点覆盖率。
 */
export function libraryBucketKey(title: string): string {
  return normalizeName(title).slice(0, 2)
}

/** 把曲库按歌名前两字分桶，供 matchLibraryDuration 使用（每次列表构造只建一次） */
export function buildLibraryBuckets(libraryTracks: Track[]): Map<string, Track[]> {
  const buckets = new Map<string, Track[]>()
  for (const track of libraryTracks) {
    const key = libraryBucketKey(track.title)
    if (!key) continue
    const list = buckets.get(key)
    if (list) list.push(track)
    else buckets.set(key, [track])
  }
  return buckets
}

/**
 * 在本地曲库里按「歌名 + 歌手」模糊匹配一首，返回它的时长（秒）；补不到返回 0。
 *
 * 判据复用 @aurora/shared 的同一份归一化与相似度（scoreOnlineResult 的标题分 + 歌手分，
 * 标题不达标即淘汰），避免这里长出一套「差不多」的判定。
 */
export function matchLibraryDuration(
  target: { title: string; artist: string },
  buckets: Map<string, Track[]>
): number {
  const candidates = buckets.get(libraryBucketKey(target.title))
  if (!candidates) return 0
  let bestDuration = 0
  let bestScore = 0
  for (const candidate of candidates) {
    // 无时长的候选补不了值（0 是「未知」不是「0 秒」），直接跳过
    if (!(candidate.duration > 0)) continue
    const title = titleScore(candidate.title, target.title)
    if (title < TITLE_THRESHOLD) continue
    const score = title + artistScore(candidate.artist, target.artist)
    if (score > bestScore) {
      bestScore = score
      bestDuration = candidate.duration
    }
  }
  return bestScore >= LIBRARY_MATCH_ACCEPT_SCORE ? bestDuration : 0
}