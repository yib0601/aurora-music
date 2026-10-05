import type {
  MusicHallOptions,
  MusicHallSource,
  RecommendPlaylist,
  ToplistGroup,
} from './types'
import { fillEndpointTemplate, hallEndpointOf } from './auroraPreset'
import { fetchWithTimeout } from './fetchWithTimeout'

/**
 * 音乐馆读取执行器（协议执行器，与 musicSource 同构）
 *
 * 只做**只读浏览**：推荐歌单列表、榜单列表、榜单详情。
 * 响应解析一律容错——字段名宽松兼容、结构缺失降级为空数组而不是抛错，
 * 因为服务端可能来自第三方实现（协议只约定语义，不强制字段大小写）。
 * 只有「网络失败 / HTTP 非 2xx / 端点未配置」才抛错，由 UI 展示直白中文提示。
 */

// 统一默认请求头（部分上游对 UA 敏感），可被源配置的 headers 覆盖
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
}

/** 单条请求超时：与在线搜索一致 */
const HALL_TIMEOUT_MS = 10000

/** 数值容错：字符串数字、空值、非数字统一归零 */
function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 字符串容错：仅接受非空字符串 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 从响应 JSON 里取数组：数组本身 / {list} / {data} / {groups} / {songs} 包裹 */
function pickArray(json: any, keys: string[]): any[] {
  if (Array.isArray(json)) return json
  if (!json || typeof json !== 'object') return []
  for (const key of keys) {
    if (Array.isArray(json[key])) return json[key]
    const nested = json[key]
    if (nested && typeof nested === 'object') {
      for (const inner of keys) {
        if (Array.isArray(nested[inner])) return nested[inner]
      }
    }
  }
  return []
}

/** 取某个启用音源的音乐馆端点模板；无能力返回空串 */
function endpointFor(source: MusicHallSource, which: 'recommend' | 'toplists' | 'toplist'): string {
  return hallEndpointOf(source, which)
}

/** 执行一次 GET 并解析 JSON；失败抛带源名的中文错误 */
async function requestJson(source: MusicHallSource, url: string): Promise<any> {
  let resp: Response
  try {
    resp = await fetchWithTimeout(
      url,
      { headers: { ...DEFAULT_HEADERS, ...(source.headers || {}) } },
      HALL_TIMEOUT_MS
    )
  } catch (err) {
    throw new Error(`音源「${source.name}」请求失败：${(err as Error).message}`)
  }
  if (!resp.ok) throw new Error(`音源「${source.name}」返回 HTTP ${resp.status}`)
  try {
    return await resp.json()
  } catch {
    throw new Error(`音源「${source.name}」返回的不是 JSON`)
  }
}

/**
 * 推荐歌单列表。
 * 服务端响应：`{ list:[{id,name,coverUrl,listenNum,creatorName,createTime}], total }`
 * 兼容：`data.list` / `playlists` / 裸数组；条目字段名宽松（id/dissid、name/dissname/title…）
 */
export async function fetchRecommendPlaylists(
  source: MusicHallSource,
  options?: MusicHallOptions
): Promise<RecommendPlaylist[]> {
  const template = endpointFor(source, 'recommend')
  if (!template) return []
  const url = fillEndpointTemplate(template, {
    categoryId: options?.categoryId || '10000000',
    sortId: options?.sortId || '5',
    page: options?.page || 1,
    limit: options?.limit || 30,
  })
  const json = await requestJson(source, url)
  const items = pickArray(json, ['list', 'playlists', 'results', 'data'])

  const out: RecommendPlaylist[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const rawId = item.id ?? item.dissid ?? item.dissId
    const name = str(item.name) || str(item.dissname) || str(item.title)
    // 无 id 或无名条目直接丢弃：没有 id 就无法点开取曲目，没有名字的卡片是空白
    if (rawId == null || !name) continue
    out.push({
      id: String(rawId),
      name,
      coverUrl: str(item.coverUrl) || str(item.imgurl) || str(item.cover) || str(item.pic),
      listenNum: num(item.listenNum ?? item.listennum ?? item.listen_count) || undefined,
      creatorName: str(item.creatorName) || str(item.creator?.name) || str(item.creator),
      createTime: str(item.createTime) || str(item.createtime),
      source: source.id,
      sourceName: source.name,
    })
  }
  return out
}

/**
 * 榜单列表（按分组）。
 * 服务端响应：`{ groups:[{groupId,groupName,toplists:[{id,name,...,songs:[…]}]}] }`
 * 兼容：`data.group`（QQ 上游原始形状）/ `toplists` / 裸数组（视为单组）。
 */
export async function fetchToplistGroups(
  source: MusicHallSource,
  options?: MusicHallOptions
): Promise<ToplistGroup[]> {
  const template = endpointFor(source, 'toplists')
  if (!template) return []
  const url = fillEndpointTemplate(template, { preview: options?.preview ?? 5 })
  const json = await requestJson(source, url)

  const groups = pickArray(json, ['groups', 'group', 'data'])
  const out: ToplistGroup[] = []

  for (const group of groups) {
    if (!group || typeof group !== 'object') continue
    // 榜单数组的字段名收敛：协议形状 toplists、QQ 原始形状 toplist、泛用 list；裸数组视为本层即榜单
    const lists = Array.isArray(group.toplists)
      ? group.toplists
      : Array.isArray(group.toplist)
        ? group.toplist
        : Array.isArray(group.list)
          ? group.list
          : Array.isArray(group)
            ? group
            : []
    const briefs = []
    for (const raw of lists) {
      if (!raw || typeof raw !== 'object') continue
      const rawId = raw.id ?? raw.topId ?? raw.topid
      const name = str(raw.name) || str(raw.title)
      if (rawId == null || !name) continue
      const previewSongs = Array.isArray(raw.songs) ? raw.songs : Array.isArray(raw.song) ? raw.song : []
      briefs.push({
        id: num(rawId),
        name,
        updateTime: str(raw.updateTime) || str(raw.update_time),
        period: str(raw.period),
        listenNum: num(raw.listenNum ?? raw.listenNum) || undefined,
        coverUrl:
          str(raw.coverUrl) || str(raw.frontPicUrl) || str(raw.picUrl) || str(raw.cover) || undefined,
        songs: previewSongs
          .map((s: any) => ({
            rank: num(s?.rank),
            title: str(s?.title) || str(s?.name) || '',
            artist: str(s?.artist) || str(s?.singerName) || '',
            coverUrl: str(s?.coverUrl) || str(s?.cover) || undefined,
          }))
          .filter((s: any) => s.title),
      })
    }
    if (briefs.length === 0) continue
    out.push({
      groupId: group.groupId == null ? undefined : num(group.groupId),
      groupName: str(group.groupName) || str(group.name) || '榜单',
      toplists: briefs,
    })
  }
  return out
}

/** 榜单详情曲目（服务端 `songs[]`） */
export interface ToplistDetail {
  id: number | string
  name: string
  updateTime?: string
  total: number
  songs: Array<{
    rank: number
    title: string
    artist: string
    album: string
    duration: number
    coverUrl?: string
    songmid?: string
  }>
}

/**
 * 榜单详情（含曲目与排名序号）。
 * 服务端响应：`{ id,name,updateTime,total,songs:[{rank,title,artist,album,duration,coverUrl,songmid}] }`
 * 兼容：`data.songs` / `songlist`（QQ 原始形状：`songlist[].data`）。
 * `id` 缺失时返回空曲目列表而不是抛错——调用方应把「id 缺失」当调用错误提前拦下。
 */
export async function fetchToplistSongs(
  source: MusicHallSource,
  options?: MusicHallOptions
): Promise<ToplistDetail> {
  const empty: ToplistDetail = { id: options?.id ?? '', name: '', total: 0, songs: [] }
  const template = endpointFor(source, 'toplist')
  if (!template || options?.id == null) return empty

  const limit = options?.limit || 100
  const page = options?.page || 1
  const url = fillEndpointTemplate(template, { id: options.id, page, limit })
  const json = await requestJson(source, url)

  const raw = pickArray(json, ['songs', 'songlist', 'list', 'data'])
  const songs: ToplistDetail['songs'] = []

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (!item || typeof item !== 'object') continue
    // QQ 原始形状把曲目字段放在 data 里，协议形状平铺在条目上，两者都兼容
    const core = item.data && typeof item.data === 'object' ? item.data : item
    const title = str(core.songname) || str(core.title) || str(core.name)
    if (!title) continue
    const singer = core.singer
    const artist =
      str(core.artist) ||
      str(core.singerName) ||
      (Array.isArray(singer)
        ? singer.map((s: any) => str(s?.name) || '').filter(Boolean).join(' / ')
        : '') ||
      '未知艺术家'
    const albummid = str(core.albummid)
    const album = str(core.album) || str(core.albumname) || str(core.albumName) || ''
    songs.push({
      rank: num(item.rank ?? core.rank) || (page - 1) * limit + i + 1,
      title,
      artist,
      album,
      duration: num(core.interval ?? core.duration),
      coverUrl:
        str(core.coverUrl) ||
        str(core.cover) ||
        (albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albummid}_3.jpg` : undefined),
      songmid: str(core.songmid) || str(core.mid),
    })
  }

  const info = json?.topinfo && typeof json.topinfo === 'object' ? json.topinfo : {}
  return {
    id: json?.id ?? options.id,
    name: str(json?.name) || str(info.ListName) || str(info.listName) || '',
    updateTime: str(json?.updateTime) || str(info.update_time) || str(info.updateTime),
    total: num(json?.total ?? json?.total_song_num ?? info.total) || songs.length,
    songs,
  }
}

/**
 * 选出一个提供音乐馆能力的音源（按配置顺序取第一个）。
 * 返回 null 表示没有任何音源提供该能力（UI 据此展示空态引导）。
 */
export function musicHallSourceOf(sources: MusicHallSource[]): MusicHallSource | null {
  for (const s of sources || []) {
    if (!s || s.enabled === false) continue
    if (endpointFor(s, 'recommend') || endpointFor(s, 'toplists')) return s
  }
  return null
}

export { endpointFor as musicHallEndpointOf }