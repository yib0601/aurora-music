/**
 * Aurora Music 歌源协议规范 v1
 *
 * 音源：本应用不内置任何音源，只定义并执行以下声明式 HTTP 协议：
 * 用户在设置页配置源（每个源一条地址 + 可选请求头），应用按协议调用并解析响应。
 * **一条音源可同时提供两种能力**——在线搜索（含 {query}）与歌单解析（含 {url}）；
 * 音源服务用同一套地址同时给出两种接口时，填在同一张卡片里，
 * 歌单导入即可直接使用，无需另配「歌单解析源」。
 * **标准音源**：只填一条链接（服务地址，密钥可写在链接里），端点由 auroraPreset.ts
 * 在执行时解析组装（searchEndpointOf / playlistEndpointOf），不预先固化到配置里；
 * 支持服务端自描述（GET / 的 endpoints），用户不必手写占位符。
 * 歌词源：协议同上，但额外内置一个兜底歌词源（LRCLIB），外部不可调整；
 * 用户配置的歌词源优先生效，全部未命中时才回退到内置源。
 * 协议同时适用于桌面端（Electron 主进程）与移动端（WebView），实现仅有此一份。
 */

/** 在线音质档位：标准 128k / 高品质 320k / 无损 FLAC */
export type DownloadQuality = '128' | '320' | 'flac'

/**
 * 音源形态：
 * - `aurora`（缺省）：本应用自有协议（服务地址自组装端点 / 用户手写的接口模板）；
 * - `lx`：洛雪音乐（lx-music-desktop / lx-music-mobile）的用户自定义音源脚本，
 *   sourceUrl 填脚本链接，脚本在客户端沙箱里加载执行（见 lxHost.ts）。
 *   脚本源多数只有「取址」能力（无公共搜索接口），搜索由本应用自己做。
 */
export type OnlineSourceKind = 'aurora' | 'lx'

/**
 * 洛雪脚本源的曲目定位信息：脚本多数只有 musicUrl（取址）而没有搜索接口，
 * 因此曲目由本应用搜索得到（音源服务的 search，或脚本自带的 search 能力），
 * 重取直链时把这份定位信息原样回喂脚本（脚本按自己的字段取 id）。
 */
export interface LxTrackRef {
  /** 洛雪音源（脚本）id */
  sourceId: string
  /** 平台标识（kw / kg / tx / wy / mg / git …） */
  platform: string
  /** 脚本返回的原始曲目对象（原样回传，脚本按自己的字段名取值） */
  meta: Record<string, unknown>
}

/** 音源配置：一个源可同时提供在线搜索与歌单解析两种能力 */
export interface OnlineSourceConfig {
  id: string
  name: string
  /** 源形态，缺省视为 aurora（老配置不写该字段） */
  kind?: OnlineSourceKind
  /**
   * 音源地址：用户填的那条链接，也是本配置唯一的事实源。
   * 端点地址在执行时才解析组装（见 auroraPreset.ts 的 searchEndpointOf / playlistEndpointOf）：
   *   - 服务地址（裸域名 / …/aurora 端点 / 带 ?key= 密钥）→ 由软件按协议组装端点；
   *   - 含 {query} 等占位符的接口模板 → 原样使用。
   * 调用时 {query} 替换为 URL 编码后的搜索词；可选 {quality} 占位符
   * （替换为用户设置的下载音质：128 / 320 / flac，源不支持该占位符时音质设置对此源无效）。
   * 留空表示该源只用于歌单解析、不参与在线搜索。
   * 响应需为 JSON，支持以下任一结构（容错解析）：
   *   1) 数组：[{...}]
   *   2) { results: [{...}] } / { data: [{...}] } / { data: { song: { list: [{...}] } } }
   *      / { songs: [{...}] } / { list: [{...}] }
   * 每项字段（字段名宽松兼容）：audioUrl（必填）、id、title、artist、album、
   * duration（秒）、coverUrl；
   * 可选多音质地址：qualityUrls 对象（{ "128": url, "320": url, "flac": url }）
   * 或扁平字段 url_128 / url_320 / url_flac 等，下载时按音质设置挑选；
   * 可选 quality（该条音频实际音质声明）/ qualitySource（音频实际来源后端标识），
   * 用于可疑音源校正与行内展示
   */
  sourceUrl: string
  /**
   * 歌单解析接口地址（可选，需含 {url} 占位符）。
   * 服务地址形态的该端点由软件派生，无需填写；只有接口模板形态（第三方解析服务）才手填。
   * 与 sourceUrl 同属一条音源：音源服务一个地址既给搜索又给歌单解析时，歌单导入直接可用。
   * 响应需为 JSON，支持数组或 { results:[] } / { data:[] } / { songs:[] } / { list:[] } 包裹；
   * 可选 name 字段提供歌单标题；
   * 每项字段（宽松兼容）：title / name / songName；artist / singer / artists
   */
  playlistUrl?: string
  /**
   * 服务端自描述的端点模板缓存（设置页「测试连接」读到才有）：
   * 服务端改路径或参数名时客户端无需改配置；读到之前按默认约定组装。
   * 前两项是既有能力（搜索 / 歌单解析），后三项由「在线音乐」使用（推荐歌单 / 榜单列表 / 榜单详情）。
   */
  endpoints?: {
    search?: string
    playlist?: string
    recommend?: string
    toplists?: string
    toplist?: string
  }
  /** 附加请求头（如鉴权 Token、Referer、User-Agent），同名头覆盖默认值 */
  headers?: Record<string, string>
  enabled: boolean
}

export interface OnlineSearchOptions {
  /** 源列表（仅 enabled=true 的会被调用） */
  sources?: OnlineSourceConfig[]
  /** 下载音质设置：替换源地址中的 {quality} 占位符（不含占位符的源不受影响） */
  quality?: DownloadQuality
}

export interface OnlineTrackSearchResult {
  id: string
  title: string
  artist: string
  album: string
  duration: number
  coverUrl?: string
  audioUrl: string
  /** 多音质地址（源提供时才有；键为音质档位 128 / 320 / flac） */
  qualityUrls?: Partial<Record<DownloadQuality, string>>
  /** 音频实际来源后端标识（源提供 qualitySource 字段时才有） */
  audioSource?: string
  /** 源对该条音频的音质声明（源提供 quality 字段时才有） */
  audioQuality?: string
  /** 来源标识（源配置的 id） */
  source: string
  /** 来源展示名（源配置的 name） */
  sourceName: string
  /**
   * 洛雪脚本源的取址定位信息（kind='lx' 的源才有）。
   * 带该字段的条目 `audioUrl` 可能为空串——脚本源的直链必须回喂脚本按需取
   * （见 lxHost.resolveLxSourceUrl），搜索阶段不取址。
   */
  lx?: LxTrackRef
}

// ─── 在线音乐（在线推荐歌单 / 排行榜，只读浏览） ─────────────────
// 与「在线搜索」并列的第三类只读能力：应用仍然不内置任何平台抓取器，
// 数据由用户配置的音源服务按协议提供（见 QQ_Music 的 /aurora/recommend 等端点）。
// 在线音乐只做浏览：点开的歌单/榜单是**临时集合**，不落库、不下载；
// 播放按需取址（本地有同曲播本地，否则按名搜索取在线地址）。

/** 推荐歌单条目（服务端 `list[]`） */
export interface RecommendPlaylist {
  /** 歌单号（可回传给歌单解析端点，按 id 取全量曲目） */
  id: string
  name: string
  coverUrl?: string
  /** 播放量（服务端提供时才有） */
  listenNum?: number
  /** 创建者名 */
  creatorName?: string
  createTime?: string
  /** 来源标识（源配置的 id） */
  source: string
  sourceName: string
}

/** 榜单预览曲目（服务端 `toplists[].songs[]`，通常无 songmid，仅用于展示） */
export interface ToplistPreviewSong {
  rank: number
  title: string
  artist: string
  coverUrl?: string
}

/** 榜单条目（服务端 `groups[].toplists[]`） */
export interface ToplistBrief {
  /** 榜单 id（topId），回传给榜单详情端点 */
  id: number
  name: string
  updateTime?: string
  period?: string
  listenNum?: number
  coverUrl?: string
  /** 预览曲目（服务端 preview=0 时为空数组） */
  songs: ToplistPreviewSong[]
}

/** 榜单分组（巅峰榜 / 地区榜 / …） */
export interface ToplistGroup {
  groupId?: number
  groupName: string
  toplists: ToplistBrief[]
}

/** 榜单详情曲目（服务端 `songs[]`；带 songmid，供将来精确取址） */
export interface ToplistSong {
  rank: number
  title: string
  artist: string
  album: string
  duration: number
  coverUrl?: string
  /** 歌曲 mid（服务端提供时才有） */
  songmid?: string
}

/** 在线音乐浏览请求参数 */
export interface MusicHallOptions {
  /** 推荐歌单：分类 id（默认全部） */
  categoryId?: string
  /** 推荐歌单：排序 id */
  sortId?: string
  page?: number
  limit?: number
  /** 榜单列表：每个榜单预览曲目数（0 = 不返回） */
  preview?: number
  /** 榜单详情：topId */
  id?: number | string
}

/** 在线音乐端点取值（源配置与之结构兼容，供执行器判定能力） */
export interface MusicHallSourceInput {
  sourceUrl?: string
  endpoints?: { recommend?: string; toplists?: string; toplist?: string } | null
  headers?: Record<string, string>
  enabled?: boolean
}

/** 在线音乐数据来源（一条音源 = 一个服务端） */
export interface MusicHallSource extends MusicHallSourceInput {
  id: string
  name: string
}

/** 歌词源配置 */
export interface LyricsSourceConfig {
  id: string
  name: string
  /**
   * 歌词接口地址，支持以下占位符（均替换为 URL 编码后的值）：
   *   {track} 或 {query} 歌曲名 / {artist} 艺术家 / {album} 专辑 / {duration} 时长（秒）
   * 响应需为 JSON，支持：单对象 / 数组 / {results:[]} / {data:[]} / {songs:[]} / {list:[]}
   * 每项字段（宽松兼容）：歌词 = syncedLyrics || lrc || lyric || plainLyrics || lyrics；
   * 名称 = trackName || name || title；艺术家 = artistName || artist || singer；duration（秒）
   * 多条结果时优先带时间标签的歌词，其次时长最接近的
   */
  sourceUrl: string
  /** 附加请求头（同名头覆盖默认值） */
  headers?: Record<string, string>
  enabled: boolean
}

export interface LyricsSearchOptions {
  /** 源列表（按配置顺序依次尝试，仅 enabled=true 的会被调用） */
  sources?: LyricsSourceConfig[]
}

export interface LyricsSearchResult {
  /** 歌词文本（LRC 格式，可能带时间标签） */
  lrc: string
  name: string
  artist: string
}

// ─── 歌单导入协议 ─────────────────────────────────────────────
// 应用不内置任何平台的歌单抓取器：分享链接解析由用户配置的**音源**
// （OnlineSourceConfig.playlistUrl，与音乐源/歌词源同一免责架构）完成；
// 纯文本导入完全在本地解析、零网络请求。

/**
 * 独立歌单解析源配置（**历史形态，已并入音源**）：
 * v0.4.x 之前的「歌单解析源」独立列表用它持久化，现已并入 OnlineSourceConfig.playlistUrl。
 * 保留该类型只为读取旧配置做一次性迁移（见 libraryStore 的 persist migrate），
 * 新配置一律写入 OnlineSourceConfig。
 */
export interface PlaylistResolverConfig {
  id: string
  name: string
  /**
   * 解析接口地址，需包含 {url} 占位符（调用时替换为 URL 编码后的歌单链接）。
   * 响应需为 JSON，支持数组或 { results:[] } / { data:[] } / { songs:[] } / { list:[] } 包裹；
   * 可选 name 字段提供歌单标题。
   * 每项字段（宽松兼容）：title / name / songName；artist / singer / artists
   */
  apiUrl: string
  /** 附加请求头（如鉴权 Token），同名头覆盖默认值 */
  headers?: Record<string, string>
  enabled: boolean
}

/** 导入流程中解析出的单首歌曲（仅元数据，不含任何音频地址） */
export interface ParsedSong {
  title: string
  artist: string
}

/** 歌单解析源的解析结果 */
export interface PlaylistParseResult {
  /** 歌单标题（源未提供时为空字符串） */
  name: string
  songs: ParsedSong[]
}
