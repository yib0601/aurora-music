import { hostContextOf, lyricsSourceViaPlugin } from '@aurora/shared'
import type { LyricLine, LyricWord, LyricsSourceConfig } from '@/types'
import { platform } from '@/services/platform'
import { useLibraryStore } from '@/stores/libraryStore'

/**
 * 时间标签的公共片段：`mm:ss` / `mm:ss.xxx`。
 *
 * 分隔符兼容 `.` 与 `:`（老播放器导出的 LRC 里 `[00:12:50]` 与 `[00:12.50]` 都存在），
 * 分钟放宽到 1~3 位：现场版 / 播客动辄超过 99 分钟，原来的 `\d{2}` 会把整行当无标签行。
 */
const TIME_TAG_BODY = String.raw`(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?`

/** 每次解析都新建正则：这两条带 `g`，复用会把 lastIndex 状态带进下一次解析 */
function lyricTagRegex(open: string, close: string): RegExp {
  return new RegExp(`${open}${TIME_TAG_BODY}${close}`, 'g')
}

function tagToSeconds(minute: string, second: string, fraction?: string): number {
  // `.5` = 500ms、`.05` = 50ms：与 LRC 的「小数秒」语义对齐（右侧补零到三位）
  const millis = fraction ? Number.parseInt(fraction.padEnd(3, '0').slice(0, 3), 10) : 0
  return Number.parseInt(minute, 10) * 60 + Number.parseInt(second, 10) + millis / 1000
}

/**
 * 从**已剥掉行级标签**的一行里解析逐字时间轴（增强 LRC：`<mm:ss.xxx>`）。
 *
 * 词元文本保留原始空格与标点，渲染时按顺序拼回去即可还原整行 —— 不做分词，
 * 因为中文歌词的「词」边界在 LRC 里本来就没有语义，切错反而会让填充断在不该断的地方。
 *
 * 第一个尖括号之前若还有文字（`[00:12.00]La <00:12.50>la` 这种写法），
 * 它没有自己的时间戳，归并进首个词元：那一小段会跟着第一个词一起点亮，
 * 比单开一个时间未知的词元更接近原唱的听感。
 */
function parseWordTimeline(withoutLineTags: string, wordTag: RegExp): LyricWord[] | null {
  const matches = [...withoutLineTags.matchAll(wordTag)]
  if (matches.length === 0) return null

  const words: LyricWord[] = []
  const prefix = withoutLineTags.slice(0, matches[0].index ?? 0)
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    const from = (match.index ?? 0) + match[0].length
    const to =
      i + 1 < matches.length ? matches[i + 1].index ?? withoutLineTags.length : withoutLineTags.length
    // 首个词元把行首无时间戳的残留文字并进来（保留其原有空白，不做启发式补空格）
    const text = i === 0 ? prefix + withoutLineTags.slice(from, to) : withoutLineTags.slice(from, to)
    words.push({ time: tagToSeconds(match[1], match[2], match[3]), text })
  }

  // 纯空白词元（`<t>啊<t> <t>哦` 里的 `<t> `）并回前一个词的文本，而不是丢掉：
  // line.text 里那个空格必须留在渲染结果里，否则当前行（按词元渲染）与相邻行
  // （按整行渲染）的折行位置会不一致，切行时就地重排。
  const merged: LyricWord[] = []
  for (const word of words) {
    if (word.text.trim().length === 0) {
      const previous = merged[merged.length - 1]
      if (previous) previous.text += word.text
      continue
    }
    merged.push(word)
  }
  if (merged.length === 0) return null
  merged[0].text = merged[0].text.replace(/^\s+/, '')
  const last = merged[merged.length - 1]
  last.text = last.text.replace(/\s+$/, '')
  // 时间戳乱序（手写歌词常见）时钳成非降序：填充算法按相邻词元做区间，
  // 负区间会让该词元一直停在 0 或 1，看起来像「漏唱一个字」
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].time < merged[i - 1].time) merged[i].time = merged[i - 1].time
  }
  return merged
}

export function parseLRC(content: string): LyricLine[] {
  const lineTag = lyricTagRegex(String.raw`\[`, String.raw`\]`)
  const wordTag = lyricTagRegex('<', '>')
  const result: LyricLine[] = []

  let hasAnyTimeTag = false
  const pendingNoTag: string[] = []

  for (const rawLine of content.split(/\r?\n/)) {
    // 元数据行（`[ti:歌名]` / `[ar:歌手]` / `[offset:500]`）不是歌词，也不该在
    // 「整份文件都没有时间轴」时被当成纯文本歌词逐行显示出来。
    if (/^\[[a-zA-Z]+:.*\]$/.test(rawLine.trim())) continue

    const text = rawLine.replace(lineTag, '').replace(wordTag, '').trim()
    if (!text) continue

    const lineTags = [...rawLine.matchAll(lineTag)]
    const wordTags = [...rawLine.matchAll(wordTag)]

    if (lineTags.length === 0 && wordTags.length === 0) {
      // 无时间标签的行先暂存，待后续判断
      pendingNoTag.push(text)
      continue
    }

    hasAnyTimeTag = true
    if (lineTags.length > 0) {
      // 逐字时间轴只在「单一行时间戳」时才归属明确。一行多时间戳（同一句复用在
      // 多个时刻）时，尖括号里的绝对时间只会对其中一次播放正确，另一次必然错位，
      // 所以这种行退化为纯行级：宁可没有卡拉OK效果，也不让副歌那句唱早/唱晚。
      const words = lineTags.length === 1 ? parseWordTimeline(rawLine.replace(lineTag, ''), wordTag) : null
      // 行级时间戳：每个方括号标签生成一条（支持一行多时间戳）
      for (const match of lineTags) {
        result.push(withWords(tagToSeconds(match[1], match[2], match[3]), text, words))
      }
    } else {
      // 整行只有尖括号标签：首个词元的时间即行开始
      const words = parseWordTimeline(rawLine, wordTag)
      const start = words?.[0]?.time ?? tagToSeconds(wordTags[0][1], wordTags[0][2], wordTags[0][3])
      result.push(withWords(start, text, words))
    }
  }

  // 如果整个歌词没有任何时间标签，作为纯文本歌词处理
  // 按行顺序分配时间，每行间隔 5 秒（仅用于滚动定位，无实际同步意义）
  if (!hasAnyTimeTag && pendingNoTag.length > 0) {
    return pendingNoTag.map((text, idx) => ({ time: idx * 5, text, endTime: (idx + 1) * 5 }))
  }

  result.sort((a, b) => a.time - b.time)

  // 回填行结束时刻：同时间的多条（原文 + 译文）属于一组，整组共用下一条的起始时间。
  // 最后一行没有下一行，留 undefined 交给渲染层按窗口估计。
  let groupStart = 0
  while (groupStart < result.length) {
    let groupEnd = groupStart + 1
    while (groupEnd < result.length && result[groupEnd].time === result[groupStart].time) groupEnd++
    const nextTime = groupEnd < result.length ? result[groupEnd].time : undefined
    if (nextTime !== undefined) {
      for (let i = groupStart; i < groupEnd; i++) result[i].endTime = nextTime
    }
    groupStart = groupEnd
  }

  return result
}

function withWords(time: number, text: string, words: LyricWord[] | null): LyricLine {
  return words ? { time, text, words } : { time, text }
}

export function findActiveLine(lines: LyricLine[], currentTime: number): number {
  if (lines.length === 0) return -1

  let left = 0
  let right = lines.length - 1
  let result = -1

  while (left <= right) {
    const mid = Math.floor((left + right) / 2)
    if (lines[mid].time <= currentTime) {
      result = mid
      left = mid + 1
    } else {
      right = mid - 1
    }
  }

  return result
}

/**
 * 一行歌词的起止时间窗，供「整行线性填充」与高亮过渡使用。
 *
 * 末行没有下一行可借用，回落到「最后一个词元的开始 + 1.2s」（有逐字轴时），
 * 或「行首 + 6s」（普通 LRC）。窗口只影响填充速度，不参与滚动定位，
 * 因此宁可估长一点，也不要让最后一句在没播完时突然被填满。
 */
export function lyricLineWindow(lines: LyricLine[], index: number): { start: number; end: number } {
  const line = lines[index]
  if (!line) return { start: 0, end: 0 }
  const fallbackEnd =
    line.words && line.words.length > 0
      ? line.words[line.words.length - 1].time + 1.2
      : line.time + 6
  const end = line.endTime !== undefined ? line.endTime : fallbackEnd
  return { start: line.time, end: end > line.time ? end : line.time + 1 }
}

export function formatLyricTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export interface OnlineLyricsResult {
  lrc: string | null
  name: string
  artist: string
}

/**
 * 把「音源」翻成歌词执行器认识的源列表 —— 歌词能力随音源走，不再有独立的歌词源配置。
 *
 * ## 收口到插件门面（P3）
 *
 * 改造前这里直接调 `lyricEndpointOf(source)` —— 那是 **aurora 协议私有**的端点派生，
 * 于是歌词能力被绑死在一种形态上：装来的声明式插件即便在清单里声明了 `lyrics`，
 * 也永远进不了这个列表。表现为"插件明明有歌词端点却搜不到歌词"，而且没有任何报错。
 *
 * 现在统一走 `lyricsSourceViaPlugin`：插件自己回答"把哪条源交给聚合器"，
 * aurora 派生端点、声明式插件用清单里的绝对地址，上层一视同仁。
 *
 * ## 纯歌词插件**不在这里**追加（v15）
 *
 * 「已安装的纯歌词插件」没有源配置可遍历，看上去该在这里补一段
 * `installedLyricsSources()`。但那样只在**移动端**成立：桌面端的插件注册在主进程
 * （`main.ts` 的 `mountInstalledPlugins`），而本函数跑在渲染进程，注册表在那里是空的
 * —— 追加永远返回空数组，桌面端依旧取不到歌词。
 *
 * 所以那一段放在 `shared/lyricsSource.searchLyrics` 里（两端共用、且桌面端正好跑在
 * 注册表所在的主进程）。本函数只负责「源配置 → 歌词源」这一段。
 */
function lyricsSourcesFromLibrary(): LyricsSourceConfig[] {
  const { onlineSources, lyricsSources } = useLibraryStore.getState()
  const out: LyricsSourceConfig[] = []

  // 1. 用户**显式配置**的歌词源排最前（v15）。
  //
  // 为什么在派生源之前：用户填了就说明他要它优先。反过来（派生源抢先）会出现
  // 「我把歌词源改成 B 了，怎么还是 A 的歌词」—— 而 A 只是因为他还有一条音源。
  // 顺序即优先级（`firstSuccess` 按此顺序启动各档），所以这一条必须是第 1 段。
  for (const cfg of lyricsSources || []) {
    if (!cfg || cfg.enabled === false) continue
    if (!cfg.sourceUrl) continue
    out.push(cfg)
  }

  // 2. 从音源派生的歌词源（服务地址形态的音源自描述里带 `endpoints.lyric`）
  for (const source of onlineSources) {
    if (!source.enabled) continue
    // 派生不出歌词源的源直接跳过（"这个源不提供歌词"是正常情况，不是失败）
    const cfg = lyricsSourceViaPlugin(source, hostContextOf(source))
    if (!cfg) continue
    // 与显式配置的 id 撞了就跳过：同一份上游被打两遍是纯浪费，且顺序不受控
    if (out.some((item) => item.id === cfg.id)) continue
    out.push(cfg)
  }
  return out
}

export async function searchOnlineLyrics(
  query: string,
  artist?: string,
  album?: string,
  duration?: number
): Promise<OnlineLyricsResult | null> {
  if (!platform.searchLyrics) return null
  // 下传音源派生的歌词源：命中即返回；全部未命中时执行器内部回退到内置源兜底
  const sources = lyricsSourcesFromLibrary()
  try {
    return await platform.searchLyrics(query, artist, album, duration, { sources })
  } catch {
    return null
  }
}

/** loadLyricsForTrack 需要的曲目字段（结构子集，调用方直接传 Track 即可） */
export interface LyricsLoadTrack {
  id: string
  title: string
  artist: string
  album?: string
  duration?: number
}

/**
 * 已成功的歌词结果（trackId → 歌词文本）。
 * 只存非空结果：空结果（未命中 / 上游超时 / 503）不缓存，否则「一次失败」就等于
 * 「这首歌永久没歌词」，网络恢复后也不会再重试。
 */
const resolvedLyrics = new Map<string, string>()

/**
 * 进行中的加载（trackId → promise）。同一首歌并发只打一次上游：切歌来回、详情页与
 * 全屏页同时取词、React StrictMode 的开发期双挂载都会走到这里，而上游（LRCLIB
 * /api/search）实测 p90 >20s，8s 超时预算下重复请求极易落到空态。
 */
const inFlightLyrics = new Map<string, Promise<string | null>>()

/**
 * 缓存条数上限：歌词每首仅数 KB，容量不是瓶颈，但长期播放必须有界。
 * 50 首 ≈ 多数用户的日播放量，命中率与内存占用之间取平衡。
 */
const LYRICS_CACHE_LIMIT = 50

/** 缓存代数：clearLyricsCache() 递增，用于让清空之前发出的在飞结果不再回写缓存 */
let lyricsCacheGeneration = 0

/** 命中即刷新使用序（Map 插入序即使用序），淘汰从最久未用的头部开始 */
function rememberLyrics(trackId: string, lrc: string): void {
  resolvedLyrics.delete(trackId)
  resolvedLyrics.set(trackId, lrc)
  while (resolvedLyrics.size > LYRICS_CACHE_LIMIT) {
    const oldest = resolvedLyrics.keys().next().value
    if (oldest === undefined) break
    resolvedLyrics.delete(oldest)
  }
}

/** 清空歌词缓存与进行中的记录（供测试与「手动清缓存」使用） */
export function clearLyricsCache(): void {
  lyricsCacheGeneration += 1
  resolvedLyrics.clear()
  inFlightLyrics.clear()
}

/**
 * 歌词文本是否**真的能渲染出来**。
 *
 * 判据用 `parseLRC` 而不是只看 trim：UI 的唯一渲染路径就是 `setLyrics(parseLRC(text))`，
 * 因此「parseLRC 解析出 0 行」与「用户必然看到暂无歌词」是同一件事。只看 trim 会漏掉
 * 「只有时间标签而没有任何文字」这类文件 —— 它 trim 后非空，却同样一屏空白。
 *
 * 反向注意：**纯文本歌词（无时间标签）是合法的**，parseLRC 对它按行生成 5 秒间隔的
 * 时间轴，不能被判成坏文件。
 *
 * 为什么需要这道判定：早期版本会把上游返回的空白歌词写进 .lrc（shared 侧已修，但存量
 * 文件仍在盘上），而「本地读到就 return」会短路在线搜索 —— 于是每次进播放页都拿到同一份
 * 渲染不出东西的文本，且经「命中即返回」长期驻留，表现为永久空态。
 *
 * 成本：parseLRC 是纯函数、歌词仅数 KB，只在缓存命中与写回时各调一次。
 */
function isUsableLyrics(text: string | null | undefined): text is string {
  return typeof text === 'string' && text.trim().length > 0 && parseLRC(text).length > 0
}

/**
 * 真正打一次本地缓存 + 上游的加载，不带去重与结果缓存。
 *
 * 本地缓存的两端都是**尽力而为**、失败一律降级、绝不向上抛 —— 歌词的正确性来自上游，
 * 磁盘缓存只是加速手段：
 *  - 读失败（文件损坏 / 权限 / 移动端解码异常）等价于「本地没命中」，继续走在线；
 *  - 写失败（磁盘满 / 目录不可写）只 warn 并照常返回取到的歌词。
 * 若让任一端 reject，调用方拿到的是「这次加载失败」，而它们手上并没有可用信息去补救：
 * 已经成功取到的歌词会被整体丢弃，UI 落到「暂无歌词」（LyricsView 的 .then 链没有
 * catch）或永久停在「正在搜索歌词…」（详情页原实现无 catch 也无 finally）。
 */
async function loadLyricsUncached(track: LyricsLoadTrack): Promise<string | null> {
  // 1. 先读本地缓存
  if (platform.readLyrics) {
    try {
      const local = await platform.readLyrics(track.id)
      // 盘上可能是历史遗留的坏文件（空白 / 只有时间标签）：当没命中，把机会让给在线，
      // 否则这份渲染不出来的文本会永久顶着「本地缓存命中」。
      if (isUsableLyrics(local)) return local
      if (local) console.warn('[lyrics] 本地歌词文件不可用，已改走在线搜索:', track.id)
    } catch (err) {
      // 读不出来就当没缓存：一次缓存故障不该让整首歌失去取词机会
      console.warn('[lyrics] 本地缓存读取失败，改走在线搜索:', track.id, err)
    }
  }
  // 2. 在线搜索（按用户配置的歌词源，传入 album 和 duration 提高匹配精度）
  const online = await searchOnlineLyrics(track.title, track.artist, track.album, track.duration)
  const lrc = online?.lrc
  // 在线结果同样要过可用性：不可用就当没取到（返回 null 让上层按落空处理），
  // 更不能写进本地缓存 —— 那正是存量坏文件的成因，不能自己再造一批。
  // isUsableLyrics 是类型谓词，判定通过后 lrc 已收窄成 string，无需非空断言。
  if (isUsableLyrics(lrc)) {
    // 保存到本地缓存：写失败只影响下次启动的命中率，不影响本次结果
    if (platform.saveLyrics) {
      try {
        await platform.saveLyrics(lrc, track.id)
      } catch (err) {
        console.warn('[lyrics] 本地歌词缓存写入失败（不影响本次播放）:', track.id, err)
      }
    }
    return lrc
  }
  return null
}

/**
 * 取一首歌的歌词：命中结果缓存直接返回（零网络），否则复用在飞请求，最后才真正加载。
 * 刻意不写成 async 函数：并发调用必须解引用同一个 promise 对象，而 async 会把返回值
 * 再包一层，调用方拿到的就不是同一个 promise 了。
 */
export function loadLyricsForTrack(track: LyricsLoadTrack): Promise<string | null> {
  const cached = resolvedLyrics.get(track.id)
  if (cached !== undefined) {
    rememberLyrics(track.id, cached)
    return Promise.resolve(cached)
  }
  const pending = inFlightLyrics.get(track.id)
  if (pending) return pending

  const generation = lyricsCacheGeneration
  const task = loadLyricsUncached(track)
    .then((lrc) => {
      // 清空缓存的时刻点之前的在飞结果不回写，避免「清完又自己长回来」
      if (lrc && generation === lyricsCacheGeneration) rememberLyrics(track.id, lrc)
      return lrc
    })
    .finally(() => {
      // settle 后必须摘掉记录：否则一次失败会把这首歌永久卡在「进行中」，
      // 后续重试全部落回那个失败的 promise、再也不发请求
      if (inFlightLyrics.get(track.id) === task) inFlightLyrics.delete(track.id)
    })
  inFlightLyrics.set(track.id, task)
  return task
}

/**
 * 歌词加载的触发键：只由曲目 id 与外部歌词组成，刻意不含 track 对象的其他字段或引用。
 * 渲染层拿它做 effect 依赖——currentTrack 在播放中会被封面补齐（CoverImage 的
 * syncPlayerStoreCover）、取址回填、persist rehydrate 换成新对象（字段没变也只是
 * 新引用），依赖整个对象会让这些更新也重跑加载，而重跑里一次失败/超时的搜索就会把
 * 已经显示出来的歌词清成「暂无歌词」。
 */
export function lyricsLoadKey(
  track: { id: string } | null | undefined,
  lyricsText?: string
): string {
  return `${track?.id ?? ''}\u0000${lyricsText ?? ''}`
}

/**
 * 歌词结果落地取舍：只有非空结果才覆盖当前文本——一次失败/超时的搜索不得把已经
 * 显示出来的歌词清成空态。切歌该清空由调用方在 id 变化时显式做，不在这里兜。
 */
export function nextLyricsText(current: string, incoming: string | null | undefined): string {
  return typeof incoming === 'string' && incoming.length > 0 ? incoming : current
}
