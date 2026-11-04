import type { LyricLine } from '@/types'

/**
 * 歌词「已唱/未唱」填充计划。
 *
 * ## 为什么普通 LRC 也要切 token
 *
 * 增强 LRC 自带逐字时间轴，一个词一个 span 各按自己的区间点亮即可。普通 LRC 只有行级
 * 时间，最初的实现是「整行一个 span + 横向硬停点渐变」——单行时看着没问题，一旦折行就废：
 * 行内元素在多行碎片上的背景定位是**整块**的，第二行文字落在渐变的右半段，
 * 于是出现「第一行整行全亮、第二行整行全暗」（真机预览已复现）。
 *
 * 所以这里把普通 LRC 的整行文字切成小单元（汉字/假名/谚文逐字、拉丁按词），
 * 再按字数把「估计演唱时长」摊到每个单元上。折行后每个 span 仍然按自己的区间点亮，
 * 视觉上就是一句一句唱过去，与增强 LRC 同构。
 *
 * 估计时长只影响填充快慢，不参与滚动/换行定位，所以宁可估快点：估慢了会让整行在
 * 下一句到来时还挂着半截暗字，看起来像卡住。
 */

export interface LyricFillSegment {
  /** 该单元开始点亮的时刻（秒） */
  start: number
  /** 该单元点满的时刻（秒） */
  end: number
}

export interface LyricFillPlan {
  /** 与 segments 一一对应的文字单元；拼回去等于整行文字 */
  tokens: string[]
  segments: LyricFillSegment[]
}

/** 中文/日文歌的平均吞吐（字/秒），用于给没有逐字轴的整行估时长 */
const CHARS_PER_SECOND = 4.2
/** 一行至少铺开这么久，避免两字短句一闪而过 */
const MIN_SING_SECONDS = 0.9
/** 单元的最小权重：纯标点不能被摊成零时长，否则永远停在未唱色 */
const MIN_TOKEN_WEIGHT = 0.5
/** 增强 LRC 最后一个词元的收尾时长：它后面没有时间戳，直接借用下一行会拖得很长 */
const LAST_WORD_TAIL_SECONDS = 1.2

/** 需要逐字切分的文字（CJK：汉字 / 假名 / 谚文 / 兼容区） */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
/**
 * 可以连成「一个词」的字符：所有 Unicode 字母与数字 + 撇号（"don't" 不该被切成两半）。
 *
 * 用 `\p{L}` 而不是 `[A-Za-z]`：俄语/希腊语/越南语等**以空格分词**的文字，若被当成
 * 「其它字符」合并进前一个 token，整行会退化成 1 个 token，折行后又是「一行亮一行暗」。
 * 汉字/假名/谚文已在前面按字切走，这里的 `\p{L}` 实际只兜住这些拉丁系文字。
 * 没有空格分词的文字（泰文等）仍会被并成一个词，属于已知边界：它们本来就没有词边界信息。
 */
const WORD_CHAR_RE = /[\p{L}\p{N}'’]/u

/**
 * 把一行歌词切成填充单元。
 *
 * 空白与标点并入前一个单元而不是单独成 token：拼回去必须与原文逐字相同，
 * 否则折行位置会变（`text-wrap: balance` 会因多一个断点机会改排）。
 */
export function splitLyricTokens(text: string): string[] {
  const tokens: string[] = []
  let latin = ''

  const flushLatin = () => {
    if (latin) {
      tokens.push(latin)
      latin = ''
    }
  }
  const appendToLast = (ch: string) => {
    if (tokens.length === 0) tokens.push(ch)
    else tokens[tokens.length - 1] += ch
  }

  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      flushLatin()
      tokens.push(ch)
      continue
    }
    if (WORD_CHAR_RE.test(ch)) {
      latin += ch
      continue
    }
    // 空白与标点：并入前一个单元，保留原始排版
    flushLatin()
    appendToLast(ch)
  }
  flushLatin()
  return tokens
}

/** 单元权重 = 非空白字符数；纯标点给最小权重 */
function tokenWeight(token: string): number {
  let weight = 0
  for (const ch of token) {
    if (!/\s/.test(ch)) weight += 1
  }
  return Math.max(MIN_TOKEN_WEIGHT, weight)
}

/** 一行里「真正要唱」的字数（不含空白），用于估时长 */
function visibleChars(text: string): number {
  let count = 0
  for (const ch of text) {
    if (!/\s/.test(ch)) count += 1
  }
  return count
}

/**
 * 生成一行的填充计划。
 *
 * @param endTime 该行的结束时刻（= 下一行起点）。用于给最后一个单元封顶：
 *   没有它，「最后一句」的填充会一直延续到歌曲结束。
 */
export function buildFillPlan(line: LyricLine, endTime: number): LyricFillPlan {
  // endTime 缺失/异常时给一个可用窗口：末行也会走这里
  const lineEnd = endTime > line.time ? endTime : line.time + 4

  // 增强 LRC：词元自带时间戳，直接用
  if (line.words && line.words.length > 1) {
    const tokens = line.words.map((word) => word.text)
    const segments = line.words.map((word, index) => {
      const nextTime = line.words?.[index + 1]?.time
      const tail = Math.min(lineEnd, word.time + LAST_WORD_TAIL_SECONDS)
      return {
        start: word.time,
        end: nextTime ?? (tail > word.time ? tail : word.time + 0.4),
      }
    })
    return { tokens, segments }
  }

  // 普通 LRC：按字数摊时长
  const tokens = splitLyricTokens(line.text)
  if (tokens.length === 0) return { tokens: [line.text], segments: [{ start: line.time, end: lineEnd }] }

  const weights = tokens.map(tokenWeight)
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1
  const estimate = Math.max(MIN_SING_SECONDS, visibleChars(line.text) / CHARS_PER_SECOND)
  const duration = Math.max(0.3, Math.min(lineEnd - line.time, estimate))

  const segments: LyricFillSegment[] = []
  let consumed = 0
  for (const weight of weights) {
    const start = line.time + (duration * consumed) / totalWeight
    consumed += weight
    const end = line.time + (duration * consumed) / totalWeight
    segments.push({ start, end })
  }
  return { tokens, segments }
}
