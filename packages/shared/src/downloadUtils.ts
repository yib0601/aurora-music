/**
 * 在线歌曲下载工具（桌面端主进程与移动端共用）
 */

/** 生成安全文件名：去除路径分隔符与控制字符，避免路径穿越 */
export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '未知歌曲'
}

/** 从 URL 路径推断音频扩展名，未知时默认 .mp3 */
export function inferAudioExtFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const ext = pathname.slice(pathname.lastIndexOf('.')).toLowerCase()
    if (['.mp3', '.flac', '.ogg', '.wav', '.aac', '.m4a', '.opus'].includes(ext)) return ext
  } catch {
    // URL 解析失败时忽略
  }
  return '.mp3'
}
