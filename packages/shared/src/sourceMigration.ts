import { buildAuroraEndpoints, parseSourceInput } from './auroraPreset'
import type { LyricsSourceConfig, OnlineSourceConfig, PlaylistResolverConfig } from './types'

/** 迁移中间形态：老字段与目标字段并存，只在 persist migrate 里出现 */
type RawSource = Record<string, any>

/** 老配置里「服务地址 + 密钥」形态的标记（该字段已从 OnlineSourceConfig 移除） */
const LEGACY_AURORA_PRESET = 'aurora'

/**
 * 音源合并迁移（持久化数据 v9）：
 * v0.4.x 的「歌单解析源」是独立列表（PlaylistResolverConfig），音源与它分别配置；
 * 现两者合并为一条音源（OnlineSourceConfig.playlistUrl）。
 *
 * 迁移规则：
 * 1. 解析地址与某条音源的搜索地址同主机 → 挂到那条音源上（一条音源两种能力）；
 * 2. 找不到同主机音源 → 转为「只做歌单解析」的音源（搜索地址留空，不参与在线搜索）；
 * 3. 地址不含 {url} 的旧条目丢弃（本就不是歌单解析接口）。
 * 输出仍是「待规整」的对象（可能带老字段），随后由 migrateOnlineSources 统一收口。
 * 纯函数：不修改入参数组，便于单测。
 */
export function mergeLegacyPlaylistSources(
  onlineSources: unknown,
  legacySources: PlaylistResolverConfig[] | null | undefined,
  makeId: () => string = defaultId
): RawSource[] {
  const merged: RawSource[] = (Array.isArray(onlineSources) ? onlineSources : [])
    .filter((s) => Boolean(s))
    .map((s) => ({ ...(s as RawSource) }))
  const legacy = Array.isArray(legacySources) ? legacySources : []

  for (const p of legacy) {
    if (!p) continue
    const apiUrl = typeof p.apiUrl === 'string' ? p.apiUrl : ''
    if (!apiUrl.includes('{url}')) continue

    const host = hostOf(apiUrl)
    const target = host
      ? merged.find((s) => {
          const own = sourceUrlOf(s)
          return Boolean(own) && !s.playlistUrl && hostOf(own) === host
        })
      : undefined

    if (target) {
      target.playlistUrl = apiUrl
      if (!target.name && p.name) target.name = p.name
      if (!target.headers && p.headers) target.headers = p.headers
      continue
    }

    merged.push({
      id: p.id || makeId(),
      name: p.name || '歌单解析源',
      apiUrl: '',
      playlistUrl: apiUrl,
      ...(p.headers ? { headers: p.headers } : {}),
      enabled: p.enabled !== false,
    })
  }

  return merged
}

/**
 * 音源地址迁移（持久化数据 v10）：把「保存时拼好的端点地址」收敛回**一条音源地址**。
 *
 * 端点改为执行时解析（见 auroraPreset 的 searchEndpointOf / playlistEndpointOf），
 * 于是 apiUrl 不再是事实源，preset / baseUrl / apiKey 三个回显字段一并消失。
 *
 * 规则：
 * 1. sourceUrl 取老配置里那条链接——preset='aurora' 时由 baseUrl + apiKey 重建，否则取 apiUrl；
 * 2. 老端点地址若与默认约定**不同**（服务端自描述过非默认路径），转入 endpoints 缓存，
 *    否则丢弃：它与默认约定一致，执行时能重新推出来；
 * 3. 「只做歌单解析」的音源保留 playlistUrl；服务地址形态的歌单端点由协议派生，不落库。
 * 纯函数：不修改入参，便于单测。
 */
export function migrateOnlineSources(sources: unknown): OnlineSourceConfig[] {
  const list = Array.isArray(sources) ? sources : []
  const out: OnlineSourceConfig[] = []

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const s = raw as RawSource
    const sourceUrl = sourceUrlOf(s)
    const parsed = parseSourceInput(sourceUrl)

    const migrated: OnlineSourceConfig = {
      id: typeof s.id === 'string' && s.id ? s.id : defaultId(),
      name: typeof s.name === 'string' && s.name ? s.name : '音源',
      sourceUrl,
      enabled: s.enabled !== false,
    }
    if (s.headers && typeof s.headers === 'object') migrated.headers = s.headers

    if (parsed && parsed.kind === 'service') {
      // 服务地址形态：老配置里那份歌单端点由协议派生，不再落库；
      // 两个端点若与默认约定不同（服务端自描述过）则转存缓存，已经是新形态时沿用既有缓存
      const existing =
        s.endpoints && typeof s.endpoints === 'object'
          ? (s.endpoints as { search?: string; playlist?: string })
          : undefined
      const endpoints = divergedEndpoints(s, parsed) || existing
      if (endpoints) migrated.endpoints = endpoints
    } else {
      // 接口模板形态（含历史「只做歌单解析」的音源）：歌单地址单独留着
      const own = typeof s.playlistUrl === 'string' ? s.playlistUrl.trim() : ''
      if (own.includes('{url}')) migrated.playlistUrl = own
    }

    out.push(migrated)
  }

  return out
}

/**
 * 歌词源地址迁移（持久化数据 v10）：字段随音源一起统一为 sourceUrl。
 * 歌词源没有「服务地址组装」一说，地址本身原样保留。纯函数。
 */
export function migrateLyricsSources(sources: unknown): LyricsSourceConfig[] {
  const list = Array.isArray(sources) ? sources : []
  const out: LyricsSourceConfig[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const s = raw as RawSource
    const sourceUrl =
      typeof s.sourceUrl === 'string' && s.sourceUrl
        ? s.sourceUrl
        : typeof s.apiUrl === 'string'
          ? s.apiUrl
          : ''
    const migrated: LyricsSourceConfig = {
      id: typeof s.id === 'string' && s.id ? s.id : defaultId(),
      name: typeof s.name === 'string' && s.name ? s.name : '歌词源',
      sourceUrl,
      enabled: s.enabled !== false,
    }
    if (s.headers && typeof s.headers === 'object') migrated.headers = s.headers
    out.push(migrated)
  }
  return out
}

/** 把老配置里那条链接还原出来（老形态里它等价于「服务地址 + 密钥」两栏） */
function sourceUrlOf(s: RawSource): string {
  const explicit = typeof s.sourceUrl === 'string' ? s.sourceUrl.trim() : ''
  if (explicit) return explicit
  const base = typeof s.baseUrl === 'string' ? s.baseUrl.trim() : ''
  if (s.preset === LEGACY_AURORA_PRESET && base) {
    const key = typeof s.apiKey === 'string' ? s.apiKey.trim() : ''
    return key ? `${base}?key=${encodeURIComponent(key)}` : base
  }
  // 其余形态（接口模板 / 历史歌单解析源）地址本来就在 apiUrl
  return typeof s.apiUrl === 'string' ? s.apiUrl.trim() : ''
}

/** 老端点地址里与默认约定不同的部分（服务端自描述的痕迹）；都与默认一致时返回 undefined */
function divergedEndpoints(
  s: RawSource,
  parsed: { baseUrl: string; apiKey: string }
): { search?: string; playlist?: string } | undefined {
  const fallback = buildAuroraEndpoints(parsed.baseUrl, parsed.apiKey, null)
  if (!fallback) return undefined
  const oldSearch = typeof s.apiUrl === 'string' ? s.apiUrl.trim() : ''
  const oldPlaylist = typeof s.playlistUrl === 'string' ? s.playlistUrl.trim() : ''
  const endpoints: { search?: string; playlist?: string } = {}
  if (oldSearch && oldSearch !== fallback.search) endpoints.search = oldSearch
  if (oldPlaylist && oldPlaylist !== fallback.playlist) endpoints.playlist = oldPlaylist
  return endpoints.search || endpoints.playlist ? endpoints : undefined
}

/** 取 URL 主机名（判断「同一音源服务的两个端点」）；解析失败返回空串 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function defaultId(): string {
  return `src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
