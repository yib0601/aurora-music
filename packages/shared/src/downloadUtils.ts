/**
 * 在线歌曲下载工具（桌面端主进程与移动端共用）
 */

import type { DownloadQuality } from './types'

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

  // i18n-exempt: 匹配数据 —— 这个占位值与 coverMatch.PLACEHOLDER_ARTISTS 及扫描器的
  // 占位值集合同源（参与「这是不是真标题」的判定），且会作为落盘文件名，
  // 翻译它等于让同一首歌在不同界面语言下产生两个文件名
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

// ─── 音质档位推断 ────────────────────────────────────────────────
//
// 歌源对「这一条到底是不是无损」的说法常常不完整，且三处信息可能互相矛盾：
// - `qualityUrls` 的键最可信（源自己按档位分了地址），但经常只有低档、甚至为空；
// - 源声明的 `quality` 是**音频实际档位**（自带兜底的音源会把有损标成 "320"），
//   而用户请求的档位并不在此列——请求 flac 拿到 C400 的 m4a 是常态；
// - `audioUrl` 的扩展名只能说明有损/无损，说不出具体档位。
//
// 所以推断顺序固定为：多音质地址的最高档 → 源声明归一 → 地址扩展名，
// 拿不到就老实返回 unknown，绝不把「没看出是有损」当成无损。

/** 音频档位：`lossy` = 有损但具体档位未知，`unknown` = 什么都看不出来 */
export type AudioTier = 'flac' | '320' | '128' | 'lossy' | 'unknown'

/** 有损扩展名集合：能判「有损」但判不出具体档位 */
const LOSSY_EXTS = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav'])

/** 档位高低：flac > 320 > 128；有损未知与 128 同档（都是「有损」，不额外加分） */
export function tierRank(tier: AudioTier): number {
  switch (tier) {
    case 'flac':
      return 3
    case '320':
      return 2
    case '128':
    case 'lossy':
      return 1
    default:
      return 0
  }
}

/**
 * 有没有在请求档位上「降级」。
 *
 * 口径按用户能感知的档位差：请求 flac 时 320/128/有损都算降级（266k 的 AAC 也算），
 * 请求 320 时只有 128 算降级，请求 128 时没有更低档。`unknown` 一律不算降级——
 * 判不出来就别说降级，否则每一首都会挂一句提示。
 */
export function isDowngraded(actual: AudioTier, requested: DownloadQuality): boolean {
  if (requested === '128') return false
  if (requested === '320') return actual === '128'
  return actual === '320' || actual === '128' || actual === 'lossy'
}

/** 把源声明的档位字符串归一为 AudioTier；认不出的返回 null（交给后续判据） */
function normalizeDeclaredTier(declared?: string): AudioTier | null {
  const value = (declared || '').trim().toLowerCase()
  if (!value) return null
  // 无损的几种叫法：洛雪脚本常给 flac24bit / hires，自有服务给 flac
  if (value === 'flac' || value === 'flac24bit' || value === 'hires') return 'flac'
  // 256k 在实际音源里与 320 同属「高品质」一档
  if (value === '320' || value === '256') return '320'
  if (value === '128') return '128'
  return null
}

/** 取 URL 的扩展名（去查询串；解析失败时退回字符串切分） */
function extensionOfUrl(url?: string): string {
  if (!url) return ''
  let pathname = url
  try {
    pathname = new URL(url).pathname
  } catch {
    pathname = url.split(/[?#]/)[0]
  }
  const dot = pathname.lastIndexOf('.')
  return dot < 0 ? '' : pathname.slice(dot).toLowerCase()
}

/** 多音质地址里最高的那一档；没有可用地址时返回 null */
function highestQualityUrlTier(
  qualityUrls?: Partial<Record<DownloadQuality, string>>
): AudioTier | null {
  if (!qualityUrls) return null
  let best: AudioTier | null = null
  for (const key of ['128', '320', 'flac'] as const) {
    if (!qualityUrls[key]) continue
    if (!best || tierRank(key) > tierRank(best)) best = key
  }
  return best
}

/**
 * 推断一条在线音频的实际档位。
 *
 * 入参三处信息的可信度见文件开头注释；`qualityUrls` 只要有地址就按它判
 * （源自己分过档，最可信），其次才是源声明的档位与地址扩展名。
 */
export function inferAudioTier(input: {
  qualityUrls?: Partial<Record<DownloadQuality, string>>
  declared?: string
  url?: string
}): AudioTier {
  // 多音质地址：取最高档的**键**（键就是源自己标的档位）
  const fromQualityUrls = highestQualityUrlTier(input.qualityUrls)
  if (fromQualityUrls) return fromQualityUrls

  const declared = normalizeDeclaredTier(input.declared)
  if (declared) return declared

  const ext = extensionOfUrl(input.url)
  if (ext === '.flac') return 'flac'
  if (LOSSY_EXTS.has(ext)) return 'lossy'
  return 'unknown'
}
