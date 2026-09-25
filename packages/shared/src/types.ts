/**
 * Aurora Music 歌源协议规范 v1
 *
 * 音源：本应用不内置任何音源，只定义并执行以下声明式 HTTP 协议：
 * 用户在设置页配置源（HTTP 接口地址 + 可选请求头），应用按协议调用并解析响应。
 * **一条音源可同时提供两种能力**——在线搜索（apiUrl，含 {query}）与歌单解析
 * （playlistUrl，含 {url}）；音源服务用同一套地址同时给出两种接口时，填在同一张卡片里，
 * 歌单导入即可直接使用，无需另配「歌单解析源」。
 * 歌词源：协议同上，但额外内置一个兜底歌词源（LRCLIB），外部不可调整；
 * 用户配置的歌词源优先生效，全部未命中时才回退到内置源。
 * 协议同时适用于桌面端（Electron 主进程）与移动端（WebView），实现仅有此一份。
 */

/** 在线音质档位：标准 128k / 高品质 320k / 无损 FLAC */
export type DownloadQuality = '128' | '320' | 'flac'

/** 音源配置：一个源可同时提供在线搜索与歌单解析两种能力 */
export interface OnlineSourceConfig {
  id: string
  name: string
  /**
   * 搜索接口地址，需包含 {query} 占位符（调用时替换为 URL 编码后的搜索词）；
   * 可选 {quality} 占位符（替换为用户设置的下载音质：128 / 320 / flac，
   * 源不支持该占位符时音质设置对此源无效）。
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
  apiUrl: string
  /**
   * 歌单解析接口地址，可选，需包含 {url} 占位符（调用时替换为 URL 编码后的歌单分享链接）。
   * 与 apiUrl 同属一条音源：音源服务一个地址既给搜索又给歌单解析时，两者配在一起，
   * 歌单导入直接可用。响应需为 JSON，支持数组或 { results:[] } / { data:[] } / { songs:[] }
   * / { list:[] } 包裹；可选 name 字段提供歌单标题；
   * 每项字段（宽松兼容）：title / name / songName；artist / singer / artists
   */
  playlistUrl?: string
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
  apiUrl: string
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
