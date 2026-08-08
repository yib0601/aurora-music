import type { Track, Playlist } from '@/types'

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
