import type { PlaylistParseResult, ParsedSong } from './types'
import type { SourceEndpointInput } from './auroraPreset'
import { playlistEndpointOf } from './auroraPreset'
import { fetchWithTimeout } from './fetchWithTimeout'

/**
 * 歌单解析协议执行器（与音乐源/歌词源同一架构）：
 * 应用不内置任何平台的歌单抓取逻辑，解析能力由用户自行配置的接口提供。
 *
 * 解析能力挂在**音源**上：一条音源既可搜索也可解析歌单。端点地址交给 auroraPreset 的
 * playlistEndpointOf 在执行时解析——服务地址形态由协议派生，接口模板形态取手填地址，
 * 本模块不关心它是怎么来的。
 */

/** 可承载歌单解析能力的源：只要求端点解析与请求所需的字段（OnlineSourceConfig 与之兼容） */
export type PlaylistCapableSource = SourceEndpointInput & {
  name?: string
  headers?: Record<string, string>
  enabled?: boolean
}

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
  const label = source.name || '音源'
  if (!endpoint) {
    throw new Error(`音源「${label}」未配置歌单解析接口地址，需包含 {url} 占位符`)
  }
  const url = endpoint.replace('{url}', encodeURIComponent(shareUrl))
  const resp = await fetchWithTimeout(
    url,
    { headers: { ...DEFAULT_HEADERS, ...(source.headers || {}) } },
    15000
  )
  if (!resp.ok) throw new Error(`音源「${label}」返回 HTTP ${resp.status}`)
  const json = (await resp.json()) as any

  const songs: ParsedSong[] = []
  for (const item of extractItems(json)) {
    const song = toSong(item)
    if (song) songs.push(song)
  }
  if (songs.length === 0) {
    throw new Error(`音源「${label}」未返回任何歌曲`)
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
 * 传入的通常是用户在设置里配置的音源列表（具备歌单解析端点的才参与）。
 */
export async function parsePlaylistLink(
  sources: PlaylistCapableSource[],
  shareUrl: string
): Promise<PlaylistParseResult> {
  const enabled = (sources || []).filter((s) => s && s.enabled && playlistEndpointOf(s))
  if (enabled.length === 0) {
    throw new Error('尚未配置可解析歌单的音源，请在设置页添加音源（填一条音源地址即可），或改用纯文本粘贴导入')
  }
  let lastError: unknown = null
  for (const source of enabled) {
    try {
      return await resolvePlaylistUrl(source, shareUrl)
    } catch (err) {
      lastError = err
      console.warn(`[歌单解析] 「${source.name || '音源'}」解析失败:`, err)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('歌单解析失败')
}
