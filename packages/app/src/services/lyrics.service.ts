import { lyricEndpointOf, sourceHasLyrics } from '@aurora/shared'
import type { LyricLine, LyricsSourceConfig } from '@/types'
import { platform } from '@/services/platform'
import { useLibraryStore } from '@/stores/libraryStore'

export function parseLRC(content: string): LyricLine[] {
  const lines = content.split(/\r?\n/)
  const result: LyricLine[] = []

  // 标准 LRC 方括号时间戳 [00:41.20]
  const squareTagRegex = /\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g
  // 逐字（卡拉OK）LRC 尖括号时间戳 <00:41.207>
  const angleTagRegex = /<(\d{2}):(\d{2})(?:\.(\d{1,3}))?>/g

  const toTime = (match: RegExpMatchArray) => {
    const minutes = parseInt(match[1], 10)
    const seconds = parseInt(match[2], 10)
    const millisStr = match[3] || '0'
    const millis = parseInt(millisStr.padEnd(3, '0').slice(0, 3), 10)
    return minutes * 60 + seconds + millis / 1000
  }

  let hasAnyTimeTag = false
  const pendingNoTag: string[] = []

  for (const line of lines) {
    const text = line
      .replace(squareTagRegex, '')
      .replace(angleTagRegex, '')
      .trim()
    if (!text) continue

    const squareMatches = [...line.matchAll(squareTagRegex)]
    const angleMatches = [...line.matchAll(angleTagRegex)]

    if (squareMatches.length === 0 && angleMatches.length === 0) {
      // 无时间标签的行先暂存，待后续判断
      pendingNoTag.push(text)
      continue
    }

    hasAnyTimeTag = true
    if (squareMatches.length > 0) {
      // 行级时间戳：每个方括号标签生成一条（支持一行多时间戳）
      for (const match of squareMatches) {
        result.push({ time: toTime(match), text })
      }
    } else {
      // 逐字歌词行：整行文字合并为一条完整歌词，取首个尖括号时间为行时间
      result.push({ time: toTime(angleMatches[0]), text })
    }
  }

  // 如果整个歌词没有任何时间标签，作为纯文本歌词处理
  // 按行顺序分配时间，每行间隔 5 秒（仅用于滚动定位，无实际同步意义）
  if (!hasAnyTimeTag && pendingNoTag.length > 0) {
    return pendingNoTag.map((text, idx) => ({ time: idx * 5, text }))
  }

  result.sort((a, b) => a.time - b.time)
  return result
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
 * 服务地址形态的音源由协议派生出歌词端点（服务端自描述里的 endpoints.lyric 优先，
 * 没有自描述时回落默认路径，见 shared/src/auroraPreset.ts 的 lyricEndpointOf），
 * 于是用户只填一条音源，搜索 / 歌单解析 / 歌词三种能力一起到位。
 * 派生出端点（含 {track}/{artist}/{duration} 占位符）的源才参与；顺序即音源的配置顺序。
 */
function lyricsSourcesFromLibrary(): LyricsSourceConfig[] {
  const { onlineSources } = useLibraryStore.getState()
  const out: LyricsSourceConfig[] = []
  for (const source of onlineSources) {
    if (!source.enabled) continue
    // 歌词能力按插件声明判定：没有 lyric 端点派生能力的插件自然被跳过
    // （旧实现按 kind==='lx' 硬编码跳过，加第三种形态时这里会被漏掉）
    if (!sourceHasLyrics(source)) continue
    const sourceUrl = lyricEndpointOf(source)
    if (!sourceUrl) continue
    out.push({
      id: source.id,
      name: source.name,
      sourceUrl,
      ...(source.headers ? { headers: source.headers } : {}),
      enabled: true,
    })
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
