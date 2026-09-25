import type {
  PlaylistResolverConfig,
  PlaylistParseResult,
  ParsedSong,
  OnlineSourceConfig,
} from './types'
import { fetchWithTimeout } from './fetchWithTimeout'

/**
 * 歌单解析协议执行器（与音乐源/歌词源同一架构）：
 * 应用不内置任何平台的歌单抓取逻辑，解析能力由用户自行配置的接口提供。
 *
 * 解析能力挂在**音源**上（OnlineSourceConfig.playlistUrl）：一条音源既可搜索也可解析歌单。
 * 兼容历史形态——v0.4.x 的独立「歌单解析源」（PlaylistResolverConfig）把地址放在 apiUrl，
 * 只要该地址含 {url} 占位符就同样可被解析调用（旧配置迁移期用）。
 */

/** 可承载歌单解析能力的源：新音源取 playlistUrl，历史「歌单解析源」取 apiUrl */
export type PlaylistCapableSource = OnlineSourceConfig | PlaylistResolverConfig

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
}

/** 从粘贴文本中提取第一个 http/https 链接（分享文案通常夹带描述文字） */
export function extractShareUrl(text: string): string | null {
  const m = (text || '').match(/https?:\/\/[^\s，。！？;；'")）\]】]+/i)
  return m ? m[0] : null
}

/**
 * 取一条源的歌单解析接口地址：优先 playlistUrl，其次含 {url} 的 apiUrl（历史形态）；
 * 都没有则返回空字符串（该源不具备歌单解析能力）
 */
export function playlistEndpointOf(source: PlaylistCapableSource | null | undefined): string {
  if (!source) return ''
  const explicit = (source as OnlineSourceConfig).playlistUrl
  if (typeof explicit === 'string' && explicit.includes('{url}')) return explicit
  const legacy = typeof source.apiUrl === 'string' ? source.apiUrl : ''
  return legacy.includes('{url}') ? legacy : ''
}

/** 从响应 JSON 中容错提取歌曲条目数组（与音乐源相同的包裹兼容策略） */
function extractItems(json: any): any[] {
  if (Array.isArray(json)) return json
  if (json && typeof json === 'object') {
    if (Array.isArray(json.results)) return json.results
    if (Array.isArray(json.data)) return json.data
    if (Array.isArray(json.songs)) return json.songs
    if (Array.isArray(json.list)) return json.list
    if (json.data && typeof json.data === 'object' && Array.isArray(json.data.songs)) return json.data.songs
  }
  return []
}

/** 单条目容错转 ParsedSong；无标题返回 null */
function toSong(item: any): ParsedSong | null {
  if (!item || typeof item !== 'object') return null
  const title = item.title || item.name || item.songName
  if (!title || typeof title !== 'string') return null
  let artist: any = item.artist || item.singer || ''
  if (Array.isArray(artist)) artist = artist.map((a: any) => (typeof a === 'string' ? a : a?.name || '')).join('/')
  return { title: String(title).trim(), artist: String(artist || '').trim() }
}

/**
 * 用单个源解析歌单分享链接：
 * 解析地址里的 {url} 占位符替换为 URL 编码后的链接；响应宽松解析，
 * 可选 name 字段作为歌单标题。解析不出任何歌曲时抛错
 */
export async function resolvePlaylistUrl(
  source: PlaylistCapableSource,
  shareUrl: string
): Promise<PlaylistParseResult> {
  const endpoint = playlistEndpointOf(source)
  if (!endpoint) {
    throw new Error(`音源「${source.name}」未配置歌单解析接口地址，需包含 {url} 占位符`)
  }
  const url = endpoint.replace('{url}', encodeURIComponent(shareUrl))
  const resp = await fetchWithTimeout(
    url,
    { headers: { ...DEFAULT_HEADERS, ...(source.headers || {}) } },
    15000
  )
  if (!resp.ok) throw new Error(`音源「${source.name}」返回 HTTP ${resp.status}`)
  const json = (await resp.json()) as any

  const songs: ParsedSong[] = []
  for (const item of extractItems(json)) {
    const song = toSong(item)
    if (song) songs.push(song)
  }
  if (songs.length === 0) {
    throw new Error(`音源「${source.name}」未返回任何歌曲`)
  }
  const name =
    typeof json?.name === 'string' && json.name.trim()
      ? json.name.trim()
      : typeof json?.data?.name === 'string' && json.data.name.trim()
        ? json.data.name.trim()
        : ''
  return { name, songs }
}

/**
 * 聚合解析：按配置顺序依次尝试「具备歌单解析能力且已启用」的源，第一个成功即返回；
 * 全部失败时抛最后一个错误（前端展示直白的中文提示）。
 * 传入的通常是用户在设置里配置的音源列表（playlistUrl 命中即参与解析）。
 */
export async function parsePlaylistLink(
  sources: PlaylistCapableSource[],
  shareUrl: string
): Promise<PlaylistParseResult> {
  const enabled = (sources || []).filter((s) => s && s.enabled && playlistEndpointOf(s))
  if (enabled.length === 0) {
    throw new Error('尚未配置可解析歌单的音源，请在设置页添加音源（填服务地址与密钥即可），或改用纯文本粘贴导入')
  }
  let lastError: unknown = null
  for (const source of enabled) {
    try {
      return await resolvePlaylistUrl(source, shareUrl)
    } catch (err) {
      lastError = err
      console.warn(`[歌单解析] 「${source.name}」解析失败:`, err)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('歌单解析失败')
}
