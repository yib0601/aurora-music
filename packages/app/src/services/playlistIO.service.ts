import type { Track, Playlist } from '@/types'
import { platform } from '@/services/platform'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { scoreOnlineResult } from '@aurora/shared'
import type { OnlineTrackSearchResult } from '@/types'

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
 * 根据文件路径数组，从音乐库中匹配对应的 Track
 * 匹配规则：track.path 完全匹配，或 track.path 以 path 结尾，或 path 以 track.path 结尾
 */
export function matchTracksByPaths(paths: string[], tracks: Track[]): Track[] {
  const matched: Track[] = []
  const usedIds = new Set<string>()

  for (const filePath of paths) {
    // 标准化路径比较
    const normalized = filePath.replace(/\\/g, '/').toLowerCase()

    const track = tracks.find((t) => {
      if (usedIds.has(t.id)) return false
      const trackPath = t.path.replace(/\\/g, '/').toLowerCase()
      return (
        trackPath === normalized ||
        trackPath.endsWith('/' + normalized.split('/').pop()!) ||
        normalized.endsWith('/' + trackPath.split('/').pop()!)
      )
    })

    if (track) {
      matched.push(track)
      usedIds.add(track.id)
    }
  }

  return matched
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

/**
 * 让在线曲目可播放：本地曲目/已有地址的原样返回；
 * 导入歌单的在线曲目不持久化播放地址（会过期），用用户配置的
 * 音乐源重新搜索取最佳结果，并回填 importedTracks 供后续播放直接使用。
 * 未配置音乐源或无结果返回 null
 */
export async function ensurePlayableTrack(track: Track): Promise<Track | null> {
  if (track.path || track.onlineUrl) return track
  const { onlineSources, downloadQuality } = useLibraryStore.getState()
  if (!onlineSources.some((s) => s.enabled && s.apiUrl)) return null
  try {
    const results = await platform.searchOnlineTracks(
      `${track.title} ${track.artist}`.trim(),
      { sources: onlineSources, quality: downloadQuality }
    )
    let best: OnlineTrackSearchResult | null = null
    let bestScore = 0
    for (const r of results) {
      const score = scoreOnlineResult(r, { title: track.title, artist: track.artist })
      if (score > bestScore) {
        bestScore = score
        best = r
      }
    }
    const r = best || results[0]
    if (!r) return null
    const resolved: Track = {
      ...track,
      onlineUrl: r.audioUrl,
      onlineQualityUrls: r.qualityUrls,
      coverUrl: r.coverUrl || track.coverUrl,
      onlineSource: r.source,
      onlineSourceName: r.sourceName,
      onlineId: r.id,
      duration: track.duration || r.duration,
    }
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
