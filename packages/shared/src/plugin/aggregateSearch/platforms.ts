/**
 * 五个平台的**搜索**适配器（只给元信息，不给播放地址）。
 *
 * ## 为什么只做搜索
 *
 * 「聚合搜索」是内置兜底：用户配置的音源（洛雪脚本）大多只实现 `musicUrl`、
 * 不实现 `search`，于是搜索永远没有结果。本插件补的正是这一段 ——
 * 用平台自己的公开搜索接口把曲目**元信息**搜出来，播放地址仍交给用户配的脚本
 * （按 `trackRef.meta.platform` 认领，见 `shared/src/plugin/trackAudio.ts`）。
 *
 * 内置取址（换平台直链）需要签名/加密与逐平台维护，本期不做：那会让这个插件从
 * 「补搜索」变成「重写洛雪」，维护成本与法律风险都不可控。
 *
 * ## 三条实测结论（2026-11-09，curl 直连验证）
 *
 * 1. 五个端点都**不需要登录态**，也不需要 eapi/weapi 那套加密签名；
 *    唯一要签名的是咪咕（固定盐 + 设备 id + 时间戳的 md5，与 LX 同源）。
 * 2. 请求必须在**主进程**发出：渲染进程的 fetch 会带 `Origin`，个别平台会 403。
 *    插件拿到的 `ctx.fetch` 就是宿主注入的主进程实现，本文件不需要关心这件事。
 * 3. 曲目 id 一律取**平台自己的曲目 id**（`songmid`），不放我们自造的令牌 ——
 *    洛雪脚本按该平台的字段名去取址，令牌换不成直链。
 *
 * ## 与 LX Music 的关系
 *
 * 字段映射按 LX `musicSdk/<platform>/musicSearch.js` 的 `filterData` 对齐（Apache-2.0，
 * 见仓库 NOTICE）；端点参数也照抄它验证过的形状。差异只有一处：LX 走 eapi 加密通道，
 * 这里走实测可用的明文接口，因此少一层依赖、也少一处随上游改版就失效的签名。
 */

import type { PluginContext } from '../types'
import { md5 } from './md5'

/** 洛雪/平台标识（与脚本宿主认的 `platform` 一致，不能改名） */
export type AggregatePlatform = 'kw' | 'kg' | 'tx' | 'wy' | 'mg'

/** 按 UI 习惯排序：用户最常用的两家在前 */
export const AGGREGATE_PLATFORMS: readonly AggregatePlatform[] = ['tx', 'kw', 'wy', 'kg', 'mg']

/** 平台展示名。品牌名不翻译（i18n-exempt） */
export const PLATFORM_LABELS: Record<AggregatePlatform, string> = {
  tx: 'QQ 音乐', // i18n-exempt: 品牌名
  kw: '酷我音乐', // i18n-exempt: 品牌名
  wy: '网易云音乐', // i18n-exempt: 品牌名
  kg: '酷狗音乐', // i18n-exempt: 品牌名
  mg: '咪咕音乐', // i18n-exempt: 品牌名
}

/**
 * 一条归一化后的平台命中。
 *
 * 只保留「界面上要显示的」+「脚本取址可能要用的」：后者进 `extra`，
 * 由调用方原样塞进 `trackRef.meta`（脚本按自己的字段名取，比如酷狗的 `hash`）。
 */
export interface AggregateHit {
  platform: AggregatePlatform
  /** 平台曲目 id（交给脚本取址的那个 id） */
  songmid: string
  title: string
  artist: string
  album: string
  /** 秒；平台没给就是 0 */
  duration: number
  coverUrl?: string
  /** 平台自报的可用档位（只用于展示，实际档位由来取址的脚本决定） */
  qualities?: string[]
  /** 平台原始字段里脚本可能用到的部分 */
  extra?: Record<string, unknown>
}

/** 单平台搜索函数签名 */
export type PlatformSearch = (
  ctx: PluginContext,
  query: string,
  limit: number
) => Promise<AggregateHit[]>

/** 单次请求超时：搜索要抢在用户失去耐心之前放弃 */
const TIMEOUT_MS = 8000

const PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const MOBILE_UA =
  'Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30'

// ─── 请求与取值的小工具 ────────────────────────────────────────

interface JsonInit {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
}

/**
 * 发一次请求并把响应读成 JSON。
 *
 * 头合并的顺序是「平台默认头 → 源配置的自定义头（只补缺）→ 请求头」：
 * 内置兜底源没有用户自定义头，但万一将来允许配置（例如走代理），
 * 缺省头不该被一个填错的 `User-Agent` 顶掉。
 */
async function getJson(ctx: PluginContext, url: string, init?: JsonInit): Promise<unknown> {
  const headers: Record<string, string> = {}
  if (ctx.headers) for (const [key, value] of Object.entries(ctx.headers)) headers[key] = value
  if (init?.headers) for (const [key, value] of Object.entries(init.headers)) headers[key] = value

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null
  try {
    const res = await ctx.fetch(url, {
      method: init?.method || 'GET',
      headers,
      ...(init?.body ? { body: init.body } : {}),
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function count(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 去掉上游塞在歌名里的富文本痕迹。
 *
 * 酷我的搜索结果带 `&nbsp;`（高亮时还会带 `<em>`），原样显示会把标签符号摆到界面上。
 */
function clean(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 歌手数组 → `A、B`（QQ/酷狗/咪咕形状一致，只差字段名） */
function joinNames(value: unknown, field: string): string {
  return list(value)
    .map((entry) => text(record(entry)[field]))
    .filter((name) => name)
    .join('、')
}

/** 酷我按 `&` 拼歌手，且歌手名可能带 `&nbsp;` */
function joinAmpersand(value: string): string {
  return clean(value)
    .split('&')
    .map((name) => name.trim())
    .filter((name) => name)
    .join('、')
}

// ─── 酷我 ──────────────────────────────────────────────────────

/** `N_MINFO` 里的一档：`level:flac,bitrate:2000,format:flac,size:30.5M` */
const KW_MINFO = /level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/g

const KW_BITRATE_QUALITY: Record<string, string> = {
  '4000': 'flac24bit',
  '2000': 'flac',
  '320': '320k',
  '128': '128k',
}

function kwQualities(raw: string): string[] {
  const found: string[] = []
  for (const match of raw.matchAll(KW_MINFO)) {
    const quality = KW_BITRATE_QUALITY[match[2]]
    if (quality && !found.includes(quality)) found.push(quality)
  }
  return found
}

export const searchKuwo: PlatformSearch = async (ctx, query, limit) => {
  const url =
    'http://search.kuwo.cn/r.s?client=kt' +
    `&all=${encodeURIComponent(query)}&pn=0&rn=${limit}` +
    '&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music' +
    '&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1'
  const json = record(await getJson(ctx, url, { headers: { 'User-Agent': PC_UA } }))
  const hits: AggregateHit[] = []
  const seen = new Set<string>()
  for (const raw of list(json.abslist)) {
    const item = record(raw)
    const songmid = text(item.MUSICRID).replace(/^MUSIC_/, '')
    if (!songmid || seen.has(songmid)) continue
    seen.add(songmid)
    hits.push({
      platform: 'kw',
      songmid,
      title: clean(text(item.SONGNAME)),
      artist: joinAmpersand(text(item.ARTIST)),
      album: clean(text(item.ALBUM)),
      duration: count(item.DURATION),
      qualities: kwQualities(text(item.N_MINFO)),
      extra: { albumId: text(item.ALBUMID) },
    })
  }
  return hits
}

// ─── 酷狗 ──────────────────────────────────────────────────────

function kgQualities(item: Record<string, unknown>): string[] {
  const qualities: string[] = []
  if (count(item.ResFileSize) > 0) qualities.push('flac24bit')
  if (count(item.SQFileSize) > 0) qualities.push('flac')
  if (count(item.HQFileSize) > 0) qualities.push('320k')
  if (count(item.FileSize) > 0) qualities.push('128k')
  return qualities
}

export const searchKugou: PlatformSearch = async (ctx, query, limit) => {
  const url =
    'http://songsearch.kugou.com/song_search_v2?platform=AndroidFilter&iscorrection=1' +
    `&keyword=${encodeURIComponent(query)}&hifiquality=0&pagesize=${limit}` +
    '&PrivilegeFilter=0&page=1'
  const json = record(await getJson(ctx, url, { headers: { 'User-Agent': PC_UA } }))
  const hits: AggregateHit[] = []
  const seen = new Set<string>()

  const push = (raw: unknown): void => {
    const item = record(raw)
    const songmid = text(item.Audioid)
    if (songmid && !seen.has(songmid)) {
      seen.add(songmid)
      const title = clean(text(item.SongName) || text(item.OriSongName))
      const suffix = text(item.Suffix)
      hits.push({
        platform: 'kg',
        songmid,
        title: suffix ? `${title} ${suffix}` : title,
        artist: joinNames(item.Singers, 'name') || joinAmpersand(text(item.SingerName)),
        album: clean(text(item.AlbumName)),
        duration: count(item.Duration),
        qualities: kgQualities(item),
        extra: {
          hash: text(item.FileHash),
          albumId: text(item.AlbumID),
          albumAudioId: text(item.MixSongID),
        },
      })
    }
    // 同一首歌的其它版本：平台把它们塞在 `Grp` 里，按 id 去重后一并给
    for (const child of list(item.Grp)) push(child)
  }

  for (const raw of list(record(json.data).lists)) push(raw)
  return hits
}

// ─── QQ 音乐 ───────────────────────────────────────────────────

/**
 * `musicu.fcg` 的 `comm` 是最容易踩的一处：**缺字段不会报错，只返回空列表**
 * （实测缺 `comm` → `code: 2001`）。这一组值取自 PC 客户端，逐字段都实测有效。
 */
const TX_COMM = {
  _channelid: '0',
  _os_version: '6.2.9200-2',
  ct: '19',
  cv: '2151',
  guid: '1F70E520B2EAA7D25E11760783C53CA9',
  patch: '118',
  psrf_access_token_expiresAt: 0,
  psrf_qqaccess_token: '',
  psrf_qqopenid: '',
  psrf_qqunionid: '',
  tmeAppID: 'qqmusic',
  tmeLoginType: 0,
  uin: '0',
  wid: '7223299733393904640',
} as const

/** PC 客户端的 searchid 形状：32 位大写 hex + 5 位补零随机数 */
function txSearchId(): string {
  let guid = ''
  for (let i = 0; i < 32; i++) guid += Math.floor(Math.random() * 16).toString(16)
  return `${guid.toUpperCase()}${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`
}

function txQualities(file: Record<string, unknown>): string[] {
  const qualities: string[] = []
  if (count(file.size_hires) > 0) qualities.push('flac24bit')
  if (count(file.size_flac) > 0) qualities.push('flac')
  if (count(file.size_320mp3) > 0) qualities.push('320k')
  if (count(file.size_128mp3) > 0) qualities.push('128k')
  return qualities
}

function txListOf(data: Record<string, unknown>): unknown[] {
  const fromBody = list(record(record(data.body).song).list)
  return fromBody.length > 0 ? fromBody : list(record(record(data.song).list))
}

export const searchTencent: PlatformSearch = async (ctx, query, limit) => {
  const body = JSON.stringify({
    comm: TX_COMM,
    'music.search.SearchCgiService': {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: {
        grp: 1,
        num_per_page: limit,
        page_num: 1,
        query,
        remoteplace: 'txt.newclient.top',
        search_type: 0,
        searchid: txSearchId(),
      },
    },
  })
  const json = record(
    await getJson(ctx, 'https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': PC_UA },
      body,
    })
  )
  const service = record(json['music.search.SearchCgiService'])
  if (count(service.code) !== 0) return []

  const hits: AggregateHit[] = []
  const seen = new Set<string>()
  for (const raw of txListOf(record(service.data))) {
    const item = record(raw)
    const file = record(item.file)
    // 没有 media_mid 的条目脚本取不了址（平台自己也不给播放地址），直接跳过
    const mediaMid = text(file.media_mid)
    const songmid = text(item.mid)
    if (!songmid || !mediaMid || seen.has(songmid)) continue
    seen.add(songmid)
    const album = record(item.album)
    const albumMid = text(album.mid)
    const singerMid = text(record(list(item.singer)[0]).mid)
    hits.push({
      platform: 'tx',
      songmid,
      title: clean(text(item.title) || text(item.name)),
      artist: joinNames(item.singer, 'name'),
      album: clean(text(album.name)),
      duration: count(item.interval),
      coverUrl: albumMid
        ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`
        : singerMid
          ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${singerMid}.jpg`
          : undefined,
      qualities: txQualities(file),
      extra: { songId: text(item.id), albumMid, mediaMid },
    })
  }
  return hits
}

// ─── 网易云 ────────────────────────────────────────────────────

function wyQualities(item: Record<string, unknown>): string[] {
  const qualities: string[] = []
  if (count(record(item.hr).size) > 0) qualities.push('flac24bit')
  if (count(record(item.sq).size) > 0) qualities.push('flac')
  if (count(record(item.h).size) > 0) qualities.push('320k')
  if (count(record(item.l).size) > 0) qualities.push('128k')
  return qualities
}

export const searchNetease: PlatformSearch = async (ctx, query, limit) => {
  // 明文表单接口即可（LX 走 eapi 是因为它的通道要求加密，不是接口要求）
  const body = new URLSearchParams({
    s: query,
    type: '1',
    limit: String(limit),
    offset: '0',
  }).toString()
  const json = record(
    await getJson(ctx, 'https://music.163.com/api/cloudsearch/pc', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': PC_UA,
        Referer: 'https://music.163.com/',
      },
      body,
    })
  )
  const hits: AggregateHit[] = []
  const seen = new Set<string>()
  for (const raw of list(record(json.result).songs)) {
    const item = record(raw)
    const songmid = text(item.id)
    if (!songmid || seen.has(songmid)) continue
    seen.add(songmid)
    const album = record(item.al)
    hits.push({
      platform: 'wy',
      songmid,
      title: clean(text(item.name)),
      artist: joinNames(item.ar, 'name'),
      album: clean(text(album.name)),
      duration: Math.round(count(item.dt) / 1000),
      coverUrl: text(album.picUrl) || undefined,
      qualities: wyQualities(item),
      extra: { albumId: text(album.id) },
    })
  }
  return hits
}

// ─── 咪咕 ──────────────────────────────────────────────────────

/**
 * 咪咕的签名：`md5(query + 固定盐 + 客户端盐 + 设备 id + 毫秒时间戳)`，纯 md5、无密钥交换。
 * 值与 LX 一致 —— 平台校验的是「客户端身份」，不校验请求来源。
 */
const MG_DEVICE_ID = '963B7AA0D21511ED807EE5846EC87D20'
const MG_SIGN_SALT = '6cdc72a439cef99a3418d2a78aa28c73'
const MG_CLIENT_SALT = 'yyapp2d16148780a1dcc7408e06336b98cfd50'
const MG_SEARCH_SWITCH = encodeURIComponent(
  JSON.stringify({
    song: 1,
    album: 0,
    singer: 0,
    tagSong: 1,
    mvSong: 0,
    bestShow: 1,
    songlist: 0,
    lyricSong: 0,
  })
)
/** 封面是相对路径，前缀固定 */
const MG_IMAGE_BASE = 'http://d.musicapp.migu.cn'

/** 咪咕的档位标识 → 我们的档位名（`ZQ24` 是 24bit 无损） */
const MG_FORMAT_QUALITY: Record<string, string> = {
  PQ: '128k',
  HQ: '320k',
  SQ: 'flac',
  ZQ24: 'flac24bit',
}

function mgCover(item: Record<string, unknown>): string | undefined {
  const raw = text(item.img3) || text(item.img2) || text(item.img1)
  if (!raw) return undefined
  return /^https?:/i.test(raw) ? raw : `${MG_IMAGE_BASE}${raw}`
}

function mgQualities(item: Record<string, unknown>): string[] {
  const qualities: string[] = []
  for (const entry of list(item.audioFormats)) {
    const quality = MG_FORMAT_QUALITY[text(record(entry).formatType)]
    if (quality && !qualities.includes(quality)) qualities.push(quality)
  }
  return qualities
}

export const searchMigu: PlatformSearch = async (ctx, query, limit) => {
  const timestamp = Date.now().toString()
  const sign = md5(`${query}${MG_SIGN_SALT}${MG_CLIENT_SALT}${MG_DEVICE_ID}${timestamp}`)
  const url =
    'https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1' +
    `&searchSwitch=${MG_SEARCH_SWITCH}&pageSize=${limit}` +
    `&text=${encodeURIComponent(query)}&pageNo=1&sort=0&sid=USS`
  const json = record(
    await getJson(ctx, url, {
      headers: {
        uiVersion: 'A_music_3.6.1',
        deviceId: MG_DEVICE_ID,
        timestamp,
        sign,
        channel: '0146921',
        'User-Agent': MOBILE_UA,
      },
    })
  )
  if (text(json.code) !== '000000') return []

  const hits: AggregateHit[] = []
  const seen = new Set<string>()
  // `resultList` 是**二维**数组：外层是「搜索结果分组」，内层才是曲目
  for (const group of list(record(json.songResultData).resultList)) {
    for (const raw of list(group)) {
      const item = record(raw)
      const songmid = text(item.songId)
      const copyrightId = text(item.copyrightId)
      // 两个 id 缺一不可：脚本取址要用 songId，版权校验缺 copyrightId 会被拒
      if (!songmid || !copyrightId || seen.has(songmid)) continue
      seen.add(songmid)
      hits.push({
        platform: 'mg',
        songmid,
        title: clean(text(item.name)),
        artist: joinNames(item.singerList, 'name'),
        album: clean(text(item.album)),
        duration: count(item.duration),
        coverUrl: mgCover(item),
        qualities: mgQualities(item),
        extra: { copyrightId, albumId: text(item.albumId), lrcUrl: text(item.lrcUrl) },
      })
    }
  }
  return hits
}

/** 平台 → 搜索实现 */
export const PLATFORM_SEARCHERS: Record<AggregatePlatform, PlatformSearch> = {
  tx: searchTencent,
  kw: searchKuwo,
  wy: searchNetease,
  kg: searchKugou,
  mg: searchMigu,
}
