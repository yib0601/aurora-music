import type { OnlineTrackSearchResult, ParsedSong } from './types'

/**
 * 歌单导入的文本解析与匹配逻辑（纯函数，双端共用，可单测）。
 * 法律边界：本模块只处理歌名/歌手等元数据文本，不访问任何平台接口。
 */

/** 单次导入的歌曲行数上限，防止误粘超大文本拖垮 UI 与搜索 */
export const MAX_IMPORT_SONGS = 1000

/**
 * 名称归一化：小写、全角转半角、去括号内备注（(Live)/(伴奏) 等）、
 * 只保留字母/数字/中日韩文字，用于跨平台的宽松比较
 */
export function normalizeName(raw: string): string {
  return (raw || '')
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .replace(/[（(][^（()）]*[)）]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * 解析用户粘贴的纯文本歌单，每行一首「歌名 - 歌手」；
 * 无歌手的行只按标题匹配；自动剥离「1.」「01、」等序号前缀；跳过空行与 URL 行
 */
export function parsePlaylistText(text: string): ParsedSong[] {
  const songs: ParsedSong[] = []
  for (const rawLine of (text || '').split(/\r?\n/)) {
    if (songs.length >= MAX_IMPORT_SONGS) break
    let line = rawLine.trim()
    if (!line) continue
    // 跳过含链接的行（分享文案常是「描述文字 + 链接」一整行，无解析源回退时不能当歌名）
    if (/https?:\/\//i.test(line)) continue
    // 剥离序号前缀：1. / 01、/ 1) / 01：
    line = line.replace(/^\s*\d{1,3}\s*[.、)）:：]\s*/, '').trim()
    if (!line) continue
    const m = line.match(/^(.+?)\s+[-–—]\s+(.+)$/) || line.match(/^(.+?)\s*[-–—]\s*(.+)$/)
    if (m && m[1].trim() && m[2].trim()) {
      songs.push({ title: m[1].trim(), artist: m[2].trim() })
    } else {
      songs.push({ title: line, artist: '' })
    }
  }
  return songs
}

/** Sørensen–Dice 二元组相似度：0~1，完全相同为 1 */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const gramsOf = (s: string): Set<string> => {
    const grams = new Set<string>()
    if (s.length === 1) {
      grams.add(s)
      return grams
    }
    for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2))
    return grams
  }
  const ga = gramsOf(a)
  const gb = gramsOf(b)
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return (2 * inter) / (ga.size + gb.size)
}

/** 标题相似度（先归一化），包含关系视为高度相似 */
export function titleScore(titleA: string, titleB: string): number {
  const a = normalizeName(titleA)
  const b = normalizeName(titleB)
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) return Math.max(0.9, similarity(a, b))
  return similarity(a, b)
}

/**
 * 歌手相似度（先归一化）。任一方为空视为「未知」返回中性分 0.5：
 * 导入文本缺歌手时不惩罚结果，但也不加分
 */
export function artistScore(artistA: string, artistB: string): number {
  const a = normalizeName(artistA)
  const b = normalizeName(artistB)
  if (!a || !b) return 0.5
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) return 0.9
  return similarity(a, b)
}

/** 在线结果匹配阈值：标题相似度低于此值直接淘汰 */
export const TITLE_THRESHOLD = 0.82

/**
 * 在线搜索结果与目标歌曲的匹配总分：标题不达标直接 0，
 * 达标后总分 = 标题分 + 歌手分（满分 2，≥1.4 视为可靠匹配）
 */
export function scoreOnlineResult(result: OnlineTrackSearchResult, song: ParsedSong): number {
  const ts = titleScore(result.title, song.title)
  if (ts < TITLE_THRESHOLD) return 0
  return ts + artistScore(result.artist, song.artist)
}

/**
 * 把解析出的歌曲与本地曲库匹配：按归一化标题建索引，歌手归一化相等优先。
 * 返回与输入等长的数组，未匹配位置为 null；每首本地歌只会被占用一次
 */
export function matchTracksByNames<T extends { id: string; title: string; artist: string }>(
  songs: ParsedSong[],
  tracks: T[]
): Array<T | null> {
  const byTitle = new Map<string, T[]>()
  for (const t of tracks) {
    const key = normalizeName(t.title)
    if (!key) continue
    const list = byTitle.get(key)
    if (list) list.push(t)
    else byTitle.set(key, [t])
  }
  const used = new Set<string>()
  return songs.map((song) => {
    const candidates = byTitle.get(normalizeName(song.title))
    if (!candidates) return null
    const wantArtist = normalizeName(song.artist)
    for (const t of candidates) {
      if (used.has(t.id)) continue
      if (!wantArtist || normalizeName(t.artist) === wantArtist) {
        used.add(t.id)
        return t
      }
    }
    // 歌手不匹配/导入文本无歌手：标题命中也接受（取第一个未占用的）
    for (const t of candidates) {
      if (used.has(t.id)) continue
      used.add(t.id)
      return t
    }
    return null
  })
}
