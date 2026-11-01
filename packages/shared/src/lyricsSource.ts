import type { LyricsSourceConfig, LyricsSearchOptions, LyricsSearchResult } from './types'
import { firstSuccess } from './concurrency'
import { dropUnfilledParams, fillEndpointTemplate } from './auroraPreset'
import { fetchWithTimeout, isTimeoutError } from './fetchWithTimeout'
import { auroraError, toErrorInfo } from './i18n/errors'
// 插件启停门禁。`availability` 零依赖（纯内存表），这条 import 不引入任何环。
import { isPluginEnabled } from './plugin/availability'
// 已安装的纯歌词插件：它们没有源配置，只能由登记表把「它提供哪条歌词源」交出来。
//
// 环检查：`installed.ts` → `manifest/source.ts` → `manifest/script.ts` →
// `lxResolver.ts` / `lxHost.ts` / `sourceProbe.ts`，这条链**不回到** `lyricsSource.ts`；
// 且 `installed.ts` 对注册表的所有取用都在函数体内，模块求值期不解引用。
// 已安装的纯歌词插件：它们没有源配置，只能由登记表把「它提供哪条歌词源」交出来。
//
// ⚠️ 这里 import 的是 `installedLyricsProvider` 而不是 `plugin/installed`：
// 后者会成环（`installed` → `builtins` → `lrclibPlugin` → 本文件），且是**求值期**
// 的环 —— `lrclibPlugin` 模块体里要用 `BUILTIN_LYRICS_PLUGIN_ID`，环未闭合时它是
// `undefined`，内置插件会集体注册失败。登记表零依赖，方向反过来环就断了。
import { installedLyricsSources, installedPluginHosts } from './plugin/installedLyricsProvider'
// 歌词源 id 前缀：**唯一真源**在那份清单投影里，本层不复制字符串
import { INSTALLED_LYRICS_ID_PREFIX as INSTALLED_LYRICS_PREFIX } from './plugin/manifest/lyrics'
// 白名单判定与主机解析：**同一份实现**，不在本层重写一遍。
// 重写的后果是「插件搜索」与「插件歌词」各有一套 host 匹配口径，迟早漂移。
import { hostAllowed, hostOf } from './plugin/manifest/host'

// 统一默认请求头，可被源配置的 headers 覆盖
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'Aurora-Music (https://github.com/yib0601/aurora-music)',
  Accept: 'application/json',
}

/**
 * 内置歌词源（LRCLIB，开放免费接口，返回 syncedLyrics / plainLyrics / duration 字段，
 * 与本协议解析规则天然兼容）。
 * 外部不可调整：不进入用户配置列表、不出现在设置页，仅作为所有用户源未命中时的兜底。
 *
 * 名称用**品牌名**而不是「内置歌词源」这类中文短语：本字段是配置数据（也会出现在
 * 「歌词源「X」请求失败」这类诊断文案里），在模块级写成中文文案会把语言冻结在
 * 模块加载那一刻；品牌名与语言无关，任何界面语言下都读得通。
 */
export const BUILTIN_LYRICS_SOURCE: LyricsSourceConfig = {
  id: 'builtin-lrclib',
  name: 'LRCLIB',
  sourceUrl: 'https://lrclib.net/api/search?track_name={track}&artist_name={artist}',
  enabled: true,
}

/**
 * 内置「精确取词」源：LRCLIB 的 /api/get 精确查找，排在模糊检索兜底之前。
 *
 * 为什么值得多一次请求：/api/search 是模糊检索，实测同一首歌响应 154KB、p50 3~7s
 * （8s 预算下会超时）；/api/get 命中时只有 7.7KB、p50 1~2s，体积与延迟都低一个量级。
 * 代价是**参数必须齐**：album 不匹配时它回 404，所以它只当「快路径」，
 * 失败由聚合层按落空推进到 search 兜底。
 *
 * id 必须与模糊检索源不同——两者都要参与执行，同 id 会在过滤时被去掉一个。
 * 名称仍是品牌名（理由同上：配置数据不该把语言冻在模块加载那一刻）。
 */
export const BUILTIN_LYRICS_GET_SOURCE: LyricsSourceConfig = {
  id: 'builtin-lrclib-get',
  name: 'LRCLIB',
  sourceUrl:
    'https://lrclib.net/api/get?track_name={track}&artist_name={artist}&album_name={album}&duration={duration}',
  enabled: true,
}

/**
 * 内置源一律不参与「用户源」这一档：用户配置里出现同 id 条目会让同一条上游被
 * 打两遍（且顺序不受本模块控制，等于把优先级交给配置数据的偶然性）。
 */
const BUILTIN_LYRICS_IDS = [BUILTIN_LYRICS_GET_SOURCE.id, BUILTIN_LYRICS_SOURCE.id]

/**
 * 内置 LRCLIB 作为**插件的 id**（启停门禁、目录条目、凭证/日志都用它）。
 *
 * 与两个歌词源 id（`builtin-lrclib` / `builtin-lrclib-get`）刻意不同：
 * 那是「配置项 id」，这是「实现 id」。一个插件派生出两条源，两者粒度不同，
 * 混用会让「停用」变成「停掉其中一条」，用户完全无法预期。
 */
export const BUILTIN_LYRICS_PLUGIN_ID = 'builtin-lyrics-lrclib'


/**
 * 当前**启用**的内置歌词源（顺序：精确取词 → 模糊检索）。
 *
 * 停用判定每次现算而不是缓存：用户可能在设置页里刚把它关掉，缓存会让开关
 * 「看起来生效了但实际还在跑」——本仓一贯口径是门禁只读内存态、不做快照。
 *
 * 为什么门禁按**插件 id** 而非歌词源 id：一个插件可以派生多条歌词源
 * （LRCLIB 就是两条），开关是插件粒度的（见 `plugin/availability.ts` 的说明）。
 */
function builtinLyricsSources(): LyricsSourceConfig[] {
  if (!isPluginEnabled(BUILTIN_LYRICS_PLUGIN_ID)) return []
  return [BUILTIN_LYRICS_GET_SOURCE, BUILTIN_LYRICS_SOURCE]
}

interface LyricsCandidate {
  /** 带时间标签的同步歌词（优先） */
  synced: string | null
  /** 纯文本歌词（兜底） */
  plain: string | null
  name: string
  artist: string
  duration: number
}

/** 从响应 JSON 中容错提取候选列表：单对象视为单条候选，数组/包裹结构取数组 */
function extractItems(json: any): any[] {
  if (Array.isArray(json)) return json
  if (json && typeof json === 'object') {
    if (Array.isArray(json.results)) return json.results
    if (Array.isArray(json.data)) return json.data
    if (Array.isArray(json.songs)) return json.songs
    if (Array.isArray(json.list)) return json.list
    return [json]
  }
  return []
}

/**
 * 取一个**真的有内容**的歌词字段值，纯空白视为没有（返回 null）。
 *
 * 为什么必须 trim 判定：上游会对部分曲目返回空壳记录（实测 LRCLIB 给
 * `{"syncedLyrics":"   \n  "}`）。只判 `!value` 会把它当命中 —— 返回空白串 →
 * 调用方解析出 0 行 → UI 空态，而聚合层认为「已命中」不再回落下一个源；
 * 更糟的是这份空白会被写成本地 .lrc，此后永远走本地缓存命中 → 永久空态。
 *
 * 只用于**判定**，不改写内容：正常歌词的首尾空行与缩进都是内容的一部分，
 * 返回值始终是调用方给的原文，绝不返回 trim 过的文本。
 */
function pickLyric(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function toCandidate(item: any, fallbackName: string, fallbackArtist: string): LyricsCandidate | null {
  if (!item || typeof item !== 'object') return null
  // 逐字段判「有没有内容」，空壳字段等同于该字段不存在，于是字段名兜底链会继续往后找
  const synced = pickLyric(item.syncedLyrics) ?? pickLyric(item.lrc) ?? pickLyric(item.lyric)
  const plain = pickLyric(item.plainLyrics) ?? pickLyric(item.lyrics)
  if (!synced && !plain) return null
  return {
    synced,
    plain,
    name: String(item.trackName || item.name || item.title || fallbackName),
    artist: String(item.artistName || item.artist || item.singer || fallbackArtist),
    duration: Number(item.duration) || 0,
  }
}

/** 单个歌词源请求超时：歌词是播放的附属信息，等太久不如先出无歌词界面 */
const LYRICS_TIMEOUT_MS = 8000

/**
 * 已安装插件的歌词源 id 前缀（与 `manifest/lyrics.ts` 的 `lyricsConfigOf` 同源）。
 *
 * 两处必须是**同一个常量**而不是各写字面量：`LyricsSourceConfig` 是聚合层的最小形状，
 * 它没有「这条源属于哪个插件」的字段；前缀就是那条链路上唯一的归属信息。
 * 写错一位的后果是白名单静默失效（插件能打到任意主机，而安装确认框里列出的域名
 * 成了纸面承诺），所以这里直接 import 而不是复制字符串。
 */
const INSTALLED_LYRICS_ID_PREFIX = INSTALLED_LYRICS_PREFIX

/**
 * 已安装歌词插件的请求是否落在这份清单声明的 hosts 内。
 *
 * 只对 `plugin:` 前缀的源生效：内置源（LRCLIB）与我们自己派生出的 aurora 源
 * 都不是「第三方清单」，不该被清单规则约束。
 *
 * 越界时**抛错而不是静默跳过**：跳过会让聚合器以为"这个源没词"，继续推进下一档，
 * 用户看到的是"歌词来自别处"而完全不知道自己的插件被拦了。抛错会经
 * `searchLyrics` 的逐源 catch 打成一条带源名的 warn，日志里能查到。
 */
function assertLyricsHostAllowed(source: LyricsSourceConfig, url: string): void {
  if (!source.id.startsWith(INSTALLED_LYRICS_ID_PREFIX)) return
  const pluginId = source.id.slice(INSTALLED_LYRICS_ID_PREFIX.length)
  if (!pluginId) return
  // 清单没登记（插件已卸载 / 构造失败）时不拦：那种情况下它本就不该出现在候选里，
  // 走到这里说明是配置残留，交给请求本身失败更有诊断价值
  const hosts = installedPluginHosts(pluginId)
  if (!hosts) return
  if (hostAllowed(hosts, url)) return
  throw auroraError('core.error.lyricsHostNotAllowed', {
    name: source.name,
    reason: hostOf(url) || url,
  })
}

/**
 * 单个歌词源搜索（协议执行器核心）
 * - sourceUrl 占位符替换：{track}/{query} 歌曲名、{artist} 艺术家、{album} 专辑、{duration} 时长（秒）
 * - 取值为空的占位符**整段剔除**（不留 `artist_name=` 这种空参数），见 dropUnfilledParams
 * - 多条候选时优先带时间标签的歌词，同优先级中选时长最接近的
 */
export async function searchLyricsSource(
  source: LyricsSourceConfig,
  query: string,
  artist?: string,
  album?: string,
  duration?: number
): Promise<LyricsSearchResult | null> {
  if (!source.sourceUrl || !/\{(track|query)\}/.test(source.sourceUrl)) {
    throw auroraError('core.error.lyricsUrlNoPlaceholder', {
      name: source.name,
      track: '{track}',
      query: '{query}',
    })
  }

  // 本地曲目元信息缺项是常态（艺术家可能为空、时长可能为 0），而这些参数留成空值会被
  // 上游当成**错误**而非「没这个条件」——LRCLIB 实测 `artist_name=` 回 503 ServerOverloaded、
  // `duration=` 回 400 `cannot parse float from empty string`。所以空值一律不传该参数。
  const url = dropUnfilledParams(
    fillEndpointTemplate(source.sourceUrl, {
      track: query,
      query,
      artist: artist || '',
      album: album || '',
      duration: duration && duration > 0 ? Math.round(duration) : '',
    })
  )

  // 已安装插件的歌词请求必须过**清单声明的 hosts 白名单**。
  //
  // 为什么这条检查落在聚合器：`searchLyricsSource` 用 `fetchWithTimeout` 直连，
  // 那是「内置源 + 用户自己填的源」共用的路径，两者都不该受清单约束。
  // 而纯歌词插件在 v15 之前**根本进不了执行链**，白名单从没被真正验证过；
  // 一旦接线，安装确认框里列出的域名若不生效，那份列表就成了纸面承诺。
  //
  // 判定按源配置的 id 前缀（`lyricsConfigOf` 用 `plugin:<manifestId>` 造 id），
  // 因为 `LyricsSourceConfig` 上没有「这条源属于哪个插件」的字段 —— 加字段会让
  // 所有既有源配置与内置源都要补值，而前缀本来就是那条链路的既有约定。
  //
  // ⚠️ 这道检查必须放在 try **外面**：放里面会被下面的 catch 归成
  // 「请求失败：<主机名>」，把「被白名单拦下」这条唯一有用的信息淹掉
  // （用户看到的是"请求失败"，而真实原因是"你的插件打到了没声明的域名"）。
  assertLyricsHostAllowed(source, url)

  let resp: Response
  try {
    resp = await fetchWithTimeout(
      url,
      { headers: { ...DEFAULT_HEADERS, ...(source.headers || {}) } },
      LYRICS_TIMEOUT_MS
    )
  } catch (err) {
    if (isTimeoutError(err)) {
      throw auroraError('core.error.lyricsTimeout', { name: source.name, ms: LYRICS_TIMEOUT_MS })
    }
    // reason 取归一后的技术原文（嵌套结构化错误时 message 是编码串，不能进句子）
    const info = toErrorInfo(err)
    throw auroraError(
      'core.error.lyricsRequestFailed',
      { name: source.name, reason: info.detail || info.code },
      String(err)
    )
  }
  if (!resp.ok) throw auroraError('core.error.lyricsHttpStatus', { name: source.name, status: resp.status })

  // ─── 裸 LRC 形态：响应体本身就是歌词文本 ────────────────────────
  //
  // 放在 JSON 解析之前：这类上游返回的是 text/plain（或甚至 application/json，
  // 因为不少歌词站懒得设对 Content-Type），按 JSON 去解只会得到「不是 JSON」。
  // 判定只听 `source.format`，**不听 Content-Type** —— 后者不可靠，而清单作者
  // 声明的格式是他自己知道的确定事实（见 `DeclarativeLyricsSpec.format`）。
  if (source.format === 'lrc') {
    let text: string
    try {
      text = await resp.text()
    } catch (err) {
      if (isTimeoutError(err)) {
        throw auroraError('core.error.lyricsTimeout', { name: source.name, ms: LYRICS_TIMEOUT_MS })
      }
      // 读体失败与「不是 JSON」是两件事，这里同样要带源名与语境
      throw auroraError('core.error.lyricsNotJson', { name: source.name })
    }
    // 空壳（只有空白）按落空处理：写成命中会让这份渲染不出东西的文本进本地缓存
    if (!pickLyric(text)) return null
    return { lrc: text, name: query, artist: artist || '' }
  }

  // 读体同样纳入上面的错误映射：fetchWithTimeout 已给 body 读装了超时预算，
  // 但读体失败若在这里裸抛，用户看到的就是 TimeoutError 的编码串（无源名、无「歌词源」语境）
  let json: any
  try {
    json = (await resp.json()) as any
  } catch (err) {
    if (isTimeoutError(err)) {
      throw auroraError('core.error.lyricsTimeout', { name: source.name, ms: LYRICS_TIMEOUT_MS })
    }
    throw auroraError('core.error.lyricsNotJson', { name: source.name })
  }
  const candidates = extractItems(json)
    .map((item) => toCandidate(item, query, artist || ''))
    .filter((c): c is LyricsCandidate => c !== null)
  if (candidates.length === 0) return null

  // 选择策略：带真实同步歌词的候选加基础分；有参考时长时扣掉时长差，取总分最高者。
  // `!= null` 是刻意的：toCandidate 已保证这里的 synced 要么是有内容的字符串、要么是 null，
  // 于是「有同步歌词」这个判定与「字段有内容」完全等价——空壳 synced 拿不到那 1000 分，
  // 也就不会把带真歌词的候选（或同一条候选里的 plain）挤掉。
  const targetDur = duration && duration > 0 ? Math.round(duration) : 0
  let best = candidates[0]
  let bestScore = -Infinity
  for (const c of candidates) {
    let score = c.synced != null ? 1000 : 0
    if (targetDur > 0 && c.duration > 0) score -= Math.abs(c.duration - targetDur)
    if (score > bestScore) {
      best = c
      bestScore = score
    }
  }

  // 最终把关：选出来的这份也要真的能用，纯空白按落空返回 null，让聚合层继续推进下一档源。
  // 与 toCandidate 那道是两层意图——那道管「这条候选算不算有歌词」，这道管「选出来的能不能用」，
  // 后者兜住任何绕过前者的路径（字段名兜底链、将来新增的解析分支）。
  const lrc = pickLyric(best.synced) ?? pickLyric(best.plain)
  if (!lrc) return null
  return { lrc, name: best.name, artist: best.artist }
}

/**
 * 歌词源的对冲延迟与同时在途上限。
 *
 * 串行版的耗时会**按源数累加**：单源超时 8s（见 LYRICS_TIMEOUT_MS），用户配三个源
 * 加内置 LRCLIB 就是最坏 32s 才出「无歌词」——用户看到的只是一直没有歌词，
 * 根本不知道在等什么。对冲不改变「谁优先」，只把等待从「累加」改成「重叠」。
 *
 * 600ms 的取值依据：LRCLIB 这类公共接口的首字节实测在 200~400ms 量级，
 * 窗口低于它基本不会把「本该命中第一档」的常见情形误伤成多源并发。
 *
 * maxInFlight 给 3：每多一档在途就多一份上游请求，而歌词是播放的附属请求，
 * 不该为它把用户配的全部源一次铺开。
 */
const LYRICS_HEDGE_MS = 600
const LYRICS_MAX_IN_FLIGHT = 3

/**
 * 歌词聚合搜索：用户配置的源优先，**按配置顺序启动**，首个命中即返回；
 * 全部未命中（或未配置任何源）时回退到内置源兜底。
 * - 单源失败（网络错误/404/400/503）跳过并推进下一源
 * - 内置源固定排在末尾，外部不可调整；顺序是「精确取词 → 模糊检索」：
 *   /api/get 命中即返回（7.7KB / 1~2s），参数不匹配时它回 404，自动落到 /api/search
 *   这一档模糊检索（154KB / p50 3~7s）。宁可多一次 404，也不让常见情形先等那 154KB。
 *
 * 并发策略是**延迟对冲**而非纯竞速（见 shared/concurrency.ts）：排在前面的一档
 * 在其对冲窗口内出结果时，后面的档根本不会被启动——「用户把某个源配在第一位」
 * 这个意图因此仍是决定性的，不会被网络快慢颠倒。
 */
export async function searchLyrics(
  query: string,
  artist?: string,
  album?: string,
  duration?: number,
  options?: LyricsSearchOptions
): Promise<LyricsSearchResult | null> {
  const trimmed = (query || '').trim()
  if (!trimmed) return null
  const userSources = (options?.sources || []).filter(
    (s) => s && s.enabled && s.sourceUrl && !BUILTIN_LYRICS_IDS.includes(s.id)
  )
  // 用户源优先，末尾追加内置源。顺序即优先级：firstSuccess 按此顺序启动各档，
  // 落空（null）或抛错才会推进——「首个非空结果胜出」的语义与旧串行版完全一致。
  //
  // ## v15：内置源受插件启停门禁控制
  //
  // 改造前这两档是**无条件**追加的常量：用户既看不到它们，也没法关掉。
  // 一个老打不通的公共接口（LRCLIB 实测会回 503）会一直排在最后白等一轮超时，
  // 而设置页里根本不存在这个开关 —— 这是「隐式原始能力」的典型问题。
  //
  // 现在它们对应内置插件 `builtin-lyrics-lrclib`（见 `plugin/lrclibPlugin.ts`），
  // 出现在插件目录里、可被停用。停用后这里的追加也随之消失。
  const sources: LyricsSourceConfig[] = [
    ...userSources,
    // 已安装插件里自带歌词源的那些（纯歌词插件）。**必须在这里**而不是在渲染层的
    // `lyricsSourcesFromLibrary`：桌面端的插件注册在主进程（`mountInstalledPlugins`），
    // 而 `searchLyrics` 恰恰在主进程执行（`lyrics:search` → IPC → 这里）。
    // 放到渲染层会让桌面端永远拿到空数组，而移动端又因为两端同进程而"看起来正常"。
    ...installedLyricsSources(),
    ...builtinLyricsSources(),
  ]

  const hit = await firstSuccess(
    sources,
    async (source) => {
      try {
        return await searchLyricsSource(source, trimmed, artist, album, duration)
      } catch (err) {
        // 单源失败只记录不中断（其它源可能仍有歌词），按落空交给对冲调度推进下一档
        console.warn(`[歌词源] 「${source.name}」搜索失败:`, err)
        return null
      }
    },
    { hedgeMs: LYRICS_HEDGE_MS, maxInFlight: LYRICS_MAX_IN_FLIGHT }
  )
  return hit?.result ?? null
}
