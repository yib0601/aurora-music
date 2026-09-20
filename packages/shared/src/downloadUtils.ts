/**
 * 在线歌曲下载工具（桌面端主进程与移动端共用）
 */

/** 文件名按 UTF-8 字节计的安全上限，给扩展名与去重后缀留余量 */
export const MAX_FILENAME_BYTES = 180

/** Windows 保留设备名（比较时忽略大小写与扩展名） */
const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
])

/** 全角非法字符 → 半角，避免跨平台行为不一致与「艺术家 - 歌名」分隔符歧义 */
const FULL_WIDTH_MAP: Record<string, string> = {
  '：': ':',
  '？': '?',
  '＊': '*',
  '＂': '"',
  '＜': '<',
  '＞': '>',
  '｜': '|',
  '／': '/',
  '＼': '\\',
}

function replaceWithFullWidthMap(char: string): string {
  return FULL_WIDTH_MAP[char] ?? '_'
}

/** 按 UTF-8 字节数截断，且不切断多字节字符（不会产生 U+FFFD） */
function truncateToBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= maxBytes) return text
  let result = ''
  let bytes = 0
  for (const char of text) {
    const size = encoder.encode(char).length
    if (bytes + size > maxBytes) break
    result += char
    bytes += size
  }
  return result
}

/**
 * 生成安全文件名：跨平台可落盘、与扫描/匹配结果一致。
 *
 * 处理顺序：
 * 1. Unicode 归一化为 NFC（macOS 返回 NFD 时与扫描用的 NFC 不等，导致扫不到/重复入库）；
 * 2. 全角非法字符归一为半角后，与路径分隔符、控制字符一并替换为 `_`，防路径穿越；
 * 3. 去掉结尾的点与空格（Windows 会静默去掉，导致落盘名与数据库不一致）；
 * 4. 规避 Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含带扩展名形式）；
 * 5. 按 UTF-8 字节数截断到 MAX_FILENAME_BYTES，不切断多字节字符；
 * 6. 空结果回退 `'未知歌曲'`。
 */
export function sanitizeFileName(name: string): string {
  const normalized = name.normalize('NFC')

  const replaced = normalized
    .replace(/[：？＊＂＜＞｜／＼]/g, replaceWithFullWidthMap)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')

  // 先去掉首尾空白与控制字符残留，再去掉结尾的点与空格（Windows 静默丢弃）
  let cleaned = replaced.trim().replace(/[. ]+$/, '').trim()

  // 保留设备名判定：忽略扩展名，例如 `CON.mp3` 同样非法
  const baseName = cleaned.split('.')[0].toUpperCase()
  if (WINDOWS_RESERVED_NAMES.has(baseName)) cleaned = `_${cleaned}`

  // 截断后可能重新出现结尾的点或空格，需再清一次
  cleaned = truncateToBytes(cleaned, MAX_FILENAME_BYTES).replace(/[. ]+$/, '').trim()

  return cleaned || '未知歌曲'
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
