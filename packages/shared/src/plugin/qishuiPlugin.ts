/**
 * 汽水音乐（抖音音乐版）插件。
 *
 * ## 能力边界（2026-10-31 实测）
 *
 * | 能力 | 端点 | 需登录 | 需签名 |
 * |---|---|---|---|
 * | 取歌单内曲目 | `GET api.qishui.com/luna/pc/playlist/detail` | 否 | 否 |
 * | 取播放地址 | `GET beta-luna.douyin.com/luna/h5/seo_track` | 否 | 否 |
 * | 列「我的歌单」 | `GET api.qishui.com/luna/pc/me/playlist` | **是** | 否 |
 *
 * 所以本插件**不登录也能用**：给了歌单链接 / id 就能拉曲目、听歌。
 * 登录只解锁「列出我自己的歌单」。
 *
 * ## 三条必须守住的实测事实
 *
 * 1. **带 `Origin` 头请求 API 会 403**（实测：无 Origin → 200/8564B，带 Origin → 403/0B）。
 *    因此本插件只能在主进程执行（渲染进程的 fetch 必带 Origin）。
 * 2. **`video_model` 是 JSON 字符串**，必须二次 `JSON.parse`；`track_player.expire_at`
 *    给的是绝对过期时间。
 * 3. **VIP-only 曲目只返回 29–60 秒试听**（实测 22 首歌单中 13 首）。
 *    `video_model.video_duration` 与 `track.duration` 差 > 3 秒即为试听片段——
 *    必须标记 `isPreview`，否则用户听到一半断掉，观感是「播放失败」而不是「试听」。
 *
 * ## 登录为什么是「粘贴 cookie」而不是扫码
 *
 * 扫码流程（`get_qrcode` + `check_qrconnect`）纯 HTTP 能跑到 `status:"scanned"`，
 * 但确认一步必被 `error_code=1049`（「当前应用版本过低或经非官方渠道下载」）拦下。
 * 已实测五种请求头组合（无 Referer / 完整浏览器头 / +csrf / 站内 Referer+csrf /
 * 官方 LunaPC UA）**全部 1049**——它校验的是发起请求的客户端是否为官方签名应用，
 * 不在请求头层面。故收敛为粘贴 `sessionid`：纯 HTTP、无内置浏览器。
 */

import type {
  DownloadQuality,
  OnlineSourceConfig,
  OnlineTrackSearchResult,
  SourceProbeResult,
} from '../types'
import type {
  PluginAuthState,
  PluginCapability,
  PluginContext,
  PluginCredential,
  PluginPlaylist,
  ResolvedAudio,
  SourcePlugin,
} from './types'
import { auroraError } from '../i18n/errors'

/** 平台常量（汽水 PC 端自有参数，实测生效） */
const PC_API = 'https://api.qishui.com'
const LUNA_API = 'https://beta-luna.douyin.com'
const PC_UA = 'LunaPC/3.7.0(388267242)'
const AID = '386088'
/** 单次请求超时：歌单可能较大，给得比搜索宽 */
const TIMEOUT_MS = 15000
/**
 * 单页条数。
 * 注意上游 `count` 生效、`cnt` **不生效**（实测：传 cnt 会返回全量），别被第三方实现带偏。
 */
const PAGE_SIZE = 50
/** 试听判定容差：`video_duration` 与 `track.duration` 相差超过 3 秒即视为片段 */
const PREVIEW_TOLERANCE_MS = 3000

// ─── 上游响应形状（只声明用到的字段，其余忽略） ────────────────

interface QishuiCover {
  uri?: string
  urls?: string[]
  template_prefix?: string
}

interface QishuiTrack {
  id?: string | number
  name?: string
  duration?: number
  artists?: Array<{ name?: string }>
  album?: { name?: string; url_cover?: QishuiCover }
  label_info?: { only_vip_playable?: boolean }
  audition_info?: { duration_ms?: number }
}

interface QishuiMediaResource {
  id?: string | number
  type?: string
  entity?: { track_wrapper?: { track?: QishuiTrack }; track?: QishuiTrack }
}

interface QishuiPlaylistDetail {
  playlist?: { title?: string; count_tracks?: number; url_cover?: QishuiCover }
  media_resources?: QishuiMediaResource[]
  has_more?: boolean
  next_cursor?: string | number
}

interface QishuiPlaylistBrief {
  id?: string | number
  title?: string
  name?: string
  url_cover?: QishuiCover
  count_tracks?: number
  track_count?: number
  description?: string
}

// ─── 工具 ────────────────────────────────────────────────────

/**
 * 封面地址拼接。
 *
 * 上游给的是「基础域名数组 + 对象 uri + 模板前缀」三段，**裸 uri 会 400**（实测），
 * 必须拼成 `<urls[0]><uri>~<template_prefix>-15.webp` 才是可访问的图片。
 */
export function qishuiCoverUrl(cover: QishuiCover | undefined): string | undefined {
  if (!cover) return undefined
  const base = Array.isArray(cover.urls) && cover.urls[0] ? cover.urls[0] : ''
  const uri = typeof cover.uri === 'string' ? cover.uri : ''
  if (!base || !uri) return undefined
  const tpl = typeof cover.template_prefix === 'string' ? cover.template_prefix : ''
  return tpl ? `${base}${uri}~${tpl}-15.webp` : `${base}${uri}`
}

/** 从媒体资源里取曲目对象（App 端点在 track_wrapper 下，PC 端点在 entity.track） */
function trackOf(resource: QishuiMediaResource): QishuiTrack | undefined {
  return resource?.entity?.track_wrapper?.track || resource?.entity?.track
}

/**
 * 从用户粘贴的文本里提取 `sessionid`。
 *
 * 用户可能粘的是完整 Cookie 串、也可能只粘了值本身，两种都认。
 * 只取 `sessionid` 一个键：实测其余 cookie（`sessionid_ss` / `sid_guard` / `ttwid` 等）
 * 对拉歌单不是必需的，少存一个是一个。
 */
export function extractSessionId(input: string): string | null {
  const text = String(input || '').trim()
  if (!text) return null
  const m = text.match(/(?:^|[;\s])sessionid=([^;,\s]+)/i)
  if (m) return m[1]
  // 没有 `sessionid=` 前缀时，把整串当作裸值（用户只复制了值）
  if (/^[A-Za-z0-9_%-]{16,}$/.test(text)) return text
  return null
}

/** 带超时的 JSON 请求（插件只依赖注入的 fetch，不自带网络栈） */
async function getJson<T>(
  ctx: PluginContext,
  url: string,
  headers: Record<string, string>
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await ctx.fetch(url, {
      headers: { 'User-Agent': PC_UA, ...(ctx.headers || {}), ...headers },
      signal: controller.signal,
      // 关键：不要带 Referer / Origin。上游对第三方 Referer 返回 403，
      // 而带 Origin 会让 API 直接 403（实测）
    })
    if (!res.ok) {
      throw auroraError('core.error.sourceHttpStatus', { name: 'Qishui', status: res.status })
    }
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/** 从凭证里取 sessionid（未登录返回 null） */
function sessionIdOf(credential: PluginCredential | null | undefined): string | null {
  const v = credential?.payload?.sessionid
  return typeof v === 'string' && v ? v : null
}

// ─── 插件实现 ────────────────────────────────────────────────

export const qishuiPlugin: SourcePlugin = {
  id: 'qishui',
  displayNameKey: 'core.platform.qishui',
  descriptionKey: 'sources.form.kindQishuiHint',
  version: '1.0.0',
  capabilities: ['probe', 'userPlaylists', 'playlistTracks', 'auth'] as const,

  /**
   * 探测：不依赖登录，直接打一个公开歌单验证连通性。
   * 这里**不发 `me/playlist`**——未登录时它必失败，会被误判成「源不可用」。
   */
  async probe(config: OnlineSourceConfig, ctx: PluginContext): Promise<SourceProbeResult> {
    const capabilities: PluginCapability[] = ['playlistTracks']
    const credential = ctx.credential ?? null
    if (sessionIdOf(credential)) capabilities.push('userPlaylists', 'auth')

    try {
      // 连通性用一个必定存在的公开端点验证（不依赖任何用户歌单）。
      // 探测词取单字 `a`：这只是探活，不是界面文案，也不该随语言漂移
      await getJson<unknown>(
        ctx,
        `${PC_API}/luna/pc/search/playlist?aid=${AID}&q=a&cursor=0&count=1`,
        {}
      )
      return {
        ok: true,
        kind: 'aurora', // 探测结果的 kind 字段沿用既有枚举，插件能力另由 capabilities 表达
        capabilities: capabilities.map((key) => ({
          key,
          label: `core.plugin.capability.${key}`,
          searchable: false,
        })),
      }
    } catch (err) {
      return {
        ok: false,
        kind: 'aurora',
        capabilities: [],
        error: err instanceof Error ? err.message : String(err),
      }
    }
  },

  /**
   * 列「我的歌单」——**唯一需要登录的能力**。
   * 未登录时抛结构化错误（明确告诉用户需要登录），而不是返回空数组假装没有歌单。
   */
  async listUserPlaylists(
    _config: OnlineSourceConfig,
    ctx: PluginContext
  ): Promise<PluginPlaylist[]> {
    const sessionId = sessionIdOf(ctx.credential)
    if (!sessionId) throw auroraError('core.error.qishuiLoginRequired')

    const json = await getJson<{ playlists?: QishuiPlaylistBrief[] }>(
      ctx,
      `${PC_API}/luna/pc/me/playlist?aid=${AID}&version_code=30020100`,
      { Cookie: `sessionid=${sessionId}` }
    )

    return (json.playlists || [])
      .filter((p) => p && (p.id != null || p.title || p.name))
      .map((p) => ({
        id: String(p.id ?? ''),
        title: p.title || p.name || '',
        coverUrl: qishuiCoverUrl(p.url_cover),
        trackCount: Number(p.count_tracks ?? p.track_count ?? 0) || undefined,
        description: p.description,
      }))
      .filter((p) => p.id)
  },

  /**
   * 取歌单内曲目（**不需要登录**）。
   *
   * 分页边界：上游 `has_more` + `next_cursor`，按 `count` 逐页拉直到没有更多。
   * 防御：同一次调用里用 seen 集合去重，避免上游游标异常导致死循环。
   */
  async getPlaylistTracks(
    _config: OnlineSourceConfig,
    playlistId: string,
    ctx: PluginContext
  ): Promise<OnlineTrackSearchResult[]> {
    const id = String(playlistId || '').trim()
    if (!id) throw auroraError('core.error.playlistIdMissing')

    const out: OnlineTrackSearchResult[] = []
    const seen = new Set<string>()
    let cursor = '0'

    for (let page = 0; page < 200; page++) {
      const json = await getJson<QishuiPlaylistDetail>(
        ctx,
        `${PC_API}/luna/pc/playlist/detail?playlist_id=${encodeURIComponent(id)}&cursor=${encodeURIComponent(cursor)}&count=${PAGE_SIZE}`,
        { 'Content-Type': 'application/json; charset=utf-8' }
      )

      for (const resource of json.media_resources || []) {
        const track = trackOf(resource)
        if (!track || track.id == null) continue
        const trackId = String(track.id)
        if (seen.has(trackId)) continue
        seen.add(trackId)

        out.push({
          id: trackId,
          songmid: trackId,
          title: track.name || '',
          artist: (track.artists || [])
            .map((a) => a.name)
            .filter(Boolean)
            .join('/'),
          album: track.album?.name || '',
          // 上游 duration 单位是**毫秒**，本应用统一用秒
          duration: Math.round(Number(track.duration || 0) / 1000),
          coverUrl: qishuiCoverUrl(track.album?.url_cover),
          // 空串 = 由本插件惰性取址（见 SourcePlugin.resolveTrack 注释）
          audioUrl: '',
          source: 'qishui',
          sourceName: 'Qishui',
          trackRef: {
            sourceId: 'qishui',
            platform: 'qishui',
            meta: {
              trackId,
              // 带上是为让取址时能直接判断试听，不必再查一次歌单
              vipOnly: Boolean(track.label_info?.only_vip_playable),
              durationMs: Number(track.duration || 0),
            },
          },
        })
      }

      if (!json.has_more || json.next_cursor == null) break
      const next = String(json.next_cursor)
      if (!next || next === cursor) break // 游标不前进即停，防死循环
      cursor = next
    }

    return out
  },

  /**
   * 取播放地址（**不需要登录、不需要签名**）。
   *
   * `seo_track` 是官方分享页用的 H5 接口，返回完整播放信息：
   * - `track_player.video_model` 是 **JSON 字符串**，需二次解析
   * - `video_list[]` 每项有 `main_url`；选码率最高的一档
   * - 试听判定：`video_duration * 1000` 与 `track.duration` 差 > 3 秒即为片段
   */
  async resolveTrack(
    _config: OnlineSourceConfig,
    ref,
    _quality: DownloadQuality | undefined,
    ctx: PluginContext
  ): Promise<ResolvedAudio | null> {
    const trackId = String(ref?.meta?.trackId || '').trim()
    if (!trackId) return null

    let json: {
      seo_track?: { track?: { duration?: number; name?: string } }
      track_player?: { expire_at?: number; video_model?: string | Record<string, unknown> }
    }
    try {
      json = await getJson(
        ctx,
        `${LUNA_API}/luna/h5/seo_track?track_id=${encodeURIComponent(trackId)}&device_platform=web`,
        {}
      )
    } catch {
      // 取址失败一律返回 null，让上层回落按名搜索（既有编排约定：绝不抛错打断播放）
      return null
    }

    const player = json.track_player || {}
    let videoModel: Record<string, unknown> | null = null
    if (typeof player.video_model === 'string') {
      try {
        videoModel = JSON.parse(player.video_model) as Record<string, unknown>
      } catch {
        videoModel = null
      }
    } else if (player.video_model && typeof player.video_model === 'object') {
      videoModel = player.video_model as Record<string, unknown>
    }
    if (!videoModel) return null

    const list = Array.isArray(videoModel.video_list)
      ? (videoModel.video_list as Array<Record<string, unknown>>)
      : []
    // 选码率最高且有 main_url 的一档
    const best = list
      .filter((v) => typeof v.main_url === 'string' && v.main_url)
      .sort((a, b) => {
        const ba = Number((a.video_meta as Record<string, unknown>)?.bitrate || 0)
        const bb = Number((b.video_meta as Record<string, unknown>)?.bitrate || 0)
        return bb - ba
      })[0]
    if (!best) return null

    const meta = (best.video_meta || {}) as Record<string, unknown>
    const videoDurationMs = Math.round(Number(videoModel.video_duration || 0) * 1000)
    const fullDurationMs =
      Number(json.seo_track?.track?.duration || 0) || Number(ref?.meta?.durationMs || 0)
    const isPreview =
      fullDurationMs > 0 && Math.abs(videoDurationMs - fullDurationMs) > PREVIEW_TOLERANCE_MS

    const expireAt = Number(player.expire_at || 0)

    return {
      url: String(best.main_url),
      quality: typeof meta.quality === 'string' ? meta.quality : undefined,
      isPreview: isPreview || undefined,
      // 试听时明确给出片段时长，UI 可显示「试听 0:29 / 全长 3:38」
      previewDurationMs: isPreview ? videoDurationMs : undefined,
      fullDurationMs: fullDurationMs || undefined,
      expireAt: expireAt > 0 ? expireAt * 1000 : undefined,
    }
  },

  /**
   * 登录：只接受粘贴 `sessionid`。
   *
   * 扫码路径已实测被 `error_code=1049` 拦死（校验客户端签名，纯 HTTP 无法绕过），
   * 所以这里不做任何网络交互——用户的输入由 UI 收集后作为 `payload.input` 传入。
   */
  async login(ctx: PluginContext): Promise<PluginCredential> {
    const raw = typeof ctx.credential?.payload?.input === 'string' ? ctx.credential.payload.input : ''
    const sessionId = extractSessionId(raw)
    if (!sessionId) throw auroraError('core.error.qishuiSessionIdInvalid')
    return {
      pluginId: 'qishui',
      payload: { sessionid: sessionId },
      savedAt: Date.now(),
    }
  },

  /** 校验凭证：拉一次「我的歌单」，能拿到就说明 sessionid 有效 */
  async checkAuth(
    credential: PluginCredential | null,
    ctx: PluginContext
  ): Promise<PluginAuthState> {
    const sessionId = sessionIdOf(credential)
    if (!sessionId) return { loggedIn: false }
    try {
      await getJson(
        ctx,
        `${PC_API}/luna/pc/me/playlist?aid=${AID}&version_code=30020100`,
        { Cookie: `sessionid=${sessionId}` }
      )
      return { loggedIn: true, valid: true }
    } catch {
      // 网络故障与「凭证失效」在这里无法区分：返回 unknown，UI 不得据此显示「已失效」
      return { loggedIn: true, valid: undefined }
    }
  },

  /** 退出登录：本地凭证由平台层清除，这里没有远端会话需要登出 */
  async logout(): Promise<void> {
    /* 汽水没有可用的登出端点（扫码都过不去），只清本地凭证即可 */
  },
}
