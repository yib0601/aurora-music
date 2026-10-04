/**
 * 封面文件可用性判定（纯模块：只依赖 fs，不引 electron，便于单独验证）。
 *
 * 为什么需要它：库里存的 coverPath 是**磁盘路径**，而磁盘上的封面文件会被
 * 媒体缓存按配额 LRU 驱逐。驱逐链路（mediaCache → handlers 的驱逐回调 →
 * clearCoverPaths）只在主进程当前进程存活期间有效，以下情况都会留下指向
 * 已删文件的悬空路径：
 *   - 上一次运行写进库、文件随后被驱逐 / 清理；
 *   - 缓存目录被外部清掉（用户手动删、装清理工具）。
 *
 * 悬空路径的代价极高：渲染层的 CoverImage 只对「成功」与「确认无内嵌封面」
 * 两种终态做会话级缓存。主进程若把一条失效路径当成功结果返回，它会被缓存下来
 * → img 永久 404 → 组件清 coverPath 重新请求 → 又拿回同一份缓存 → 封面再也
 * 不会恢复。实测现场即右侧 Now Playing 面板与播放条退回占位图。
 *
 * 判定必须连**内容**一起看，不能只看「文件在且够大」：被截断或多方写入搞坏的
 * 封面文件同样会让 <img> 加载失败，而调用方只认「主进程说成功」，于是清记录、
 * 重取、再失败，与主进程来回踢皮球。按魔数确认它真是一张图片才能终结这类循环。
 */

import fs from 'fs'

/**
 * 封面文件体积下限（字节）。与 fetchOnlineCover 对下载内容的判定同口径：
 * 小于 100 字节不可能是一张图片，多半是半截下载或占位空文件。
 */
const MIN_COVER_BYTES = 100

/**
 * 各格式魔数。封面缓存扩展名只可能是 jpg / png / webp / gif / bmp
 * （见 scanner 的 coverExtensionFor 与 mediaCache 的 imageExtFrom），全覆盖。
 */
function looksLikeImage(head: Buffer): boolean {
  if (head.length < 4) return false
  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
  ) {
    return true
  }
  // GIF: "GIF8"
  if (head.toString('latin1', 0, 4) === 'GIF8') return true
  // BMP: "BM"
  if (head[0] === 0x42 && head[1] === 0x4d) return true
  // WebP: "RIFF" .... "WEBP"
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.length >= 12 && head.toString('latin1', 8, 12) === 'WEBP') {
    return true
  }
  return false
}

/**
 * 记录里的 coverPath 是否仍指向一张可用图片。
 * 不存在 / 非普通文件 / 体积过小 / 魔数不是图片，一律判否——
 * 判否的代价只是重新提取一次，判错的代价是封面永久空白。
 */
export function isUsableCoverFile(coverPath?: string): boolean {
  if (!coverPath) return false
  let fd: number | undefined
  try {
    const stat = fs.statSync(coverPath)
    if (!stat.isFile() || stat.size < MIN_COVER_BYTES) return false
    fd = fs.openSync(coverPath, 'r')
    const head = Buffer.alloc(12)
    const read = fs.readSync(fd, head, 0, head.length, 0)
    return looksLikeImage(head.subarray(0, read))
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* 关闭失败不影响判定结果 */
      }
    }
  }
}