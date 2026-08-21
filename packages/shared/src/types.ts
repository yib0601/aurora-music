/**
 * Aurora Music 歌源协议规范 v1
 *
 * 本应用不内置任何音乐/歌词源，只定义并执行以下声明式 HTTP 协议：
 * 用户在设置页配置源（一个 HTTP 接口地址 + 可选请求头），应用按协议调用并解析响应。
 * 协议同时适用于桌面端（Electron 主进程）与移动端（WebView），实现仅有此一份。
 */

/** 音乐源配置 */
export interface OnlineSourceConfig {
  id: string
  name: string
  /**
   * 搜索接口地址，需包含 {query} 占位符（调用时替换为 URL 编码后的搜索词）
   * 响应需为 JSON，支持以下任一结构（容错解析）：
   *   1) 数组：[{...}]
   *   2) { results: [{...}] } / { data: [{...}] } / { data: { song: { list: [{...}] } } }
   *      / { songs: [{...}] } / { list: [{...}] }
   * 每项字段（字段名宽松兼容）：audioUrl（必填）、id、title、artist、album、
   * duration（秒）、coverUrl
   */
  apiUrl: string
  /** 附加请求头（如鉴权 Token、Referer、User-Agent），同名头覆盖默认值 */
  headers?: Record<string, string>
  enabled: boolean
}

export interface OnlineSearchOptions {
  /** 源列表（仅 enabled=true 的会被调用） */
  sources?: OnlineSourceConfig[]
}

export interface OnlineTrackSearchResult {
  id: string
  title: string
  artist: string
  album: string
  duration: number
  coverUrl?: string
  audioUrl: string
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
