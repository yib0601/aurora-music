import { fetchWithTimeout } from './fetchWithTimeout'
import { encodeErrorInfo } from './i18n/errors'

/**
 * 标准音源（aurora 协议）端点约定与运行时组装
 *
 * 设置页只要求用户填**一条链接**（落库为 OnlineSourceConfig.sourceUrl），解析与组装都收在本模块，
 * 且都发生在**执行时**——保存配置只存那条链接本身，不预先固化端点地址，两种形态因此不再分家。
 * 链接按 parseSourceInput 一次判定：
 *
 *   1. 服务地址（service）——https://music.lighthouses.top、带密钥的 https://host?key=xxx、
 *      以及本协议自己的完整端点地址（…/aurora?query={query}&key=xxx，迁移前的老配置正是这个样子）。
 *      一律剥成「服务地址 + 密钥」，两个端点由 buildAuroraEndpoints 组装：服务端在 GET / 与
 *      GET /health 给出端点自描述（endpoints）时按其组装（服务端改路径 / 换参数名，客户端无需
 *      改配置），读不到则回落到下面的默认约定。
 *   2. 接口模板（endpoint）——链接含 {query} / {url} 等占位符且不是本协议端点路径，
 *      即用户手写的第三方接口，原样当接口模板用。
 *
 * 执行层统一走 searchEndpointOf / playlistEndpointOf 取端点，不要自己读字段拼装。
 */

export interface AuroraEndpoints {
  /** 搜索端点模板，含 {query} / {quality} / key */
  search: string
  /** 歌单解析端点模板，含 {url} / key */
  playlist: string
  /**
   * 歌词端点模板，含 {track} / {artist} / {duration} / key。
   * 歌词由音源服务提供（而不是另配一条「歌词源」）：服务端自描述里有它就说明这条源会出词，
   * 详见 shared/src/lyricsSource.ts 的聚合执行与 app 的 lyrics.service.ts。
   */
  lyric: string
  /** 推荐歌单列表端点模板（在线音乐，只读浏览） */
  recommend: string
  /** 榜单列表端点模板（在线音乐，只读浏览） */
  toplists: string
  /** 单个榜单详情端点模板（在线音乐，含 {id} / {page} / {limit}） */
  toplist: string
}

/** 服务端未给自描述时的兜底模板（与 QQ_Music 的 GET / 一致） */
export const AURORA_ENDPOINT_FALLBACK: AuroraEndpoints = {
  search: '/aurora?query={query}&quality={quality}&key=<API_KEY>',
  playlist: '/aurora/playlist?url={url}&key=<API_KEY>',
  lyric: '/aurora/lyric?track={track}&artist={artist}&duration={duration}&key=<API_KEY>',
  recommend: '/aurora/recommend?categoryId={categoryId}&sortId={sortId}&page={page}&limit={limit}&key=<API_KEY>',
  toplists: '/aurora/toplists?preview={preview}&key=<API_KEY>',
  toplist: '/aurora/toplist?id={id}&page={page}&limit={limit}&key=<API_KEY>',
}

/**
 * 端点自描述的字段白名单（服务端 `GET /` 的 `endpoints` 里认哪些键）。
 * 新端点不加进来，服务端自描述就会被**静默丢弃** —— 不报错、页面永远空，最难查的一类问题。
 */
const ENDPOINT_KEYS = ['search', 'playlist', 'lyric', 'recommend', 'toplists', 'toplist'] as const

/** 链接形态：service = 服务地址（端点由本模块组装）；endpoint = 用户手写的接口模板 */
export type AuroraSourceKind = 'service' | 'endpoint'

/** 一条链接解析出的结构化结果：设置页据此派生端点预览、校验与保存字段 */
export interface ParsedSourceInput {
  kind: AuroraSourceKind
  /** kind='service'：服务地址（已剥掉端点路径与密钥参数） */
  baseUrl: string
  /** 从链接里解析出的密钥（无则空串） */
  apiKey: string
  /** kind='endpoint'：原样保留的接口模板（含占位符） */
  apiUrl?: string
}

/** 把服务地址规整成 https://host[:port][/path]（无尾斜杠、剥掉已知端点路径） */
export function normalizeSourceBase(raw: string): string {
  const text = String(raw || '').trim()
  if (!text) return ''
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return ''
  }
  if (!u.host) return ''
  const path = u.pathname.replace(/\/+$/, '')
  // 用户粘贴的是端点地址（…/aurora 或 …/aurora/playlist）时，服务地址应剥掉这一段
  const stripped = path.replace(/\/aurora(\/playlist)?$/i, '')
  return `${u.protocol}//${u.host}${stripped}`
}

/** 从端点地址里取密钥；模板占位（<API_KEY>、{key}）不算真实密钥 */
export function apiKeyFromUrl(raw: string): string {
  const text = String(raw || '').trim()
  if (!text) return ''
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return ''
  }
  const value = (u.searchParams.get('key') || '').trim()
  if (!value) return ''
  if (/^<.*>$/.test(value) || /^\{.*\}$/.test(value)) return ''
  return value
}

/** 模板占位符（{query} / {url} / {track}…）——出现即视为用户手写的接口模板 */
const PLACEHOLDER_RE = /\{[a-zA-Z_][\w-]*\}/

/**
 * 解析用户填的那条链接，一次判定形态。规则按顺序，先命中的赢：
 *   1. 路径是本协议端点（/aurora 或 /aurora/playlist）→ service，剥出服务地址与密钥；
 *      老配置里那条带 {query} 与 key 的完整链接走的正是这一条，粘进来即完成升级。
 *   2. 含占位符（{query} / {track}…），或带着除 key 以外的查询参数 → endpoint，原样当接口模板。
 *      服务地址除密钥外不该有别的参数，出现别的参数即说明用户粘的是接口地址。
 *   3. 其余（裸域名、子路径部署、仅带 ?key=）→ service。
 * 链接解析不出主机名时返回 null，设置页据此报格式错误。
 *
 * 判定只看输入本身，不关心调用方当前处于哪种形态——这就是设置页不再需要「填法切换」的原因。
 */
export function parseSourceInput(raw: string): ParsedSourceInput | null {
  const text = String(raw || '').trim()
  if (!text) return null
  const base = normalizeSourceBase(text)
  if (!base) return null

  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  const path = u.pathname.replace(/\/+$/, '')

  if (/(^|\/)aurora(\/playlist)?$/i.test(path)) {
    return { kind: 'service', baseUrl: base, apiKey: apiKeyFromUrl(text) }
  }
  // 除 key 之外还带了别的查询参数 → 说明粘进来的是接口地址，不是服务地址
  let extraParams = false
  u.searchParams.forEach((_value, name) => {
    if (name.toLowerCase() !== 'key') extraParams = true
  })
  if (PLACEHOLDER_RE.test(text) || extraParams) {
    return { kind: 'endpoint', baseUrl: '', apiKey: '', apiUrl: text }
  }
  return { kind: 'service', baseUrl: base, apiKey: apiKeyFromUrl(text) }
}

/** 表单校验结果：设置页只管渲染，判定全在这里 */
export interface AuroraFormCheck {
  /** 链接解析结果（非法时为 null） */
  parsed: ParsedSourceInput | null
  /** 链接被判为服务地址形态（仅音乐源有服务端组装约定） */
  isService: boolean
  /**
   * 链接本身的错误（格式错 / 缺占位符），无错为 null。
   * 形态：结构化信封（`AURORA_ERR:{code,params}`），显示端 `translateError(linkError, t)` 渲染。
   */
  linkError: string | null
  /** 是否需要手填歌单解析接口——服务地址形态的该端点由软件派生 */
  showPlaylist: boolean
  /** 歌单解析接口的错误（同 linkError 的形态），无错为 null */
  playlistError: string | null
  /** 能否保存 */
  canSave: boolean
}

/**
 * 校验设置页表单。音乐源与歌词源共用这一套判定：
 *   音乐源：链接是服务地址 → 只校验服务地址；是接口模板 → 需含 {query}（歌单接口含 {url}）
 *   歌词源：没有服务端组装约定，一律按接口模板校验，需含 {track} 与 {artist}
 * 「只做歌单解析」的音源允许留空主链接——此时没有可解析的链接，形态自然是接口模板。
 */
export function checkSourceForm(opts: {
  kind: 'music' | 'lyrics'
  link: string
  playlistUrl?: string
  headersInvalid?: boolean
}): AuroraFormCheck {
  const isMusic = opts.kind === 'music'
  const linkText = String(opts.link || '').trim()
  const playlistText = String(opts.playlistUrl || '').trim()
  const parsed = parseSourceInput(linkText)
  const isService = isMusic && parsed?.kind === 'service'

  const required = isMusic ? ['{query}'] : ['{track}', '{artist}']
  const example = isMusic
    ? 'https://music.lighthouses.top'
    : 'https://lrclib.net/api/search?track_name={track}'
  let linkError: string | null = null
  if (linkText && !parsed) {
    linkError = encodeErrorInfo({ code: 'core.error.formLinkInvalid', params: { example } })
  } else if (linkText && !isService) {
    const missing = required.filter((p) => !linkText.includes(p))
    if (missing.length) {
      // 列表用「, 」连接：占位符名是技术记号（{query}），语言无关，
      // 且在字典侧无法按语言选连接词（句子里只有一个 {placeholders} 占位符）
      linkError = encodeErrorInfo({
        code: 'core.error.formLinkPlaceholder',
        params: { placeholders: missing.join(', ') },
      })
    }
  }

  const showPlaylist = isMusic && !isService
  const playlistError =
    showPlaylist && playlistText && !playlistText.includes('{url}')
      ? encodeErrorInfo({ code: 'core.error.formLinkPlaceholder', params: { placeholders: '{url}' } })
      : null
  const playlistOnly = showPlaylist && !linkText && playlistText.length > 0

  return {
    parsed,
    isService,
    linkError,
    showPlaylist,
    playlistError,
    canSave: (parsed !== null || playlistOnly) && !linkError && !playlistError && !opts.headersInvalid,
  }
}

/** 清掉地址里的 key 参数（含占位形态），不留多余分隔符 */
function stripKey(url: string): string {
  return url
    .replace(/([?&])key=[^&]*/gi, '$1')
    .replace(/\?&/g, '?')
    .replace(/&&+/g, '&')
    .replace(/[?&]+$/, '')
}

/** 把密钥写进模板的 key 参数（模板没有则追加；密钥为空则清掉该参数） */
function applyKey(url: string, apiKey: string): string {
  const stripped = stripKey(url)
  const key = String(apiKey || '').trim()
  if (!key) return stripped
  const encoded = encodeURIComponent(key)
  if (/[?&]key=/i.test(url)) return url.replace(/([?&])key=[^&]*/i, `$1key=${encoded}`)
  return `${stripped}${stripped.includes('?') ? '&' : '?'}key=${encoded}`
}

/** 单个模板 → 完整地址：相对路径拼服务地址，保留 {query}/{url} 等占位符交给执行器替换 */
function resolveTemplate(base: string, template: string, apiKey: string): string {
  const raw = String(template || '').trim()
  const url = /^https?:\/\//i.test(raw)
    ? raw
    : `${base}${raw.startsWith('/') ? '' : '/'}${raw}`
  return applyKey(url, apiKey)
}

/**
 * 由服务地址 + 密钥组装两个端点地址。
 * templates 传服务端自描述（可选）；服务地址非法时返回 null。
 */
export function buildAuroraEndpoints(
  baseUrl: string,
  apiKey: string,
  templates?: Partial<AuroraEndpoints> | null
): AuroraEndpoints | null {
  const base = normalizeSourceBase(baseUrl)
  if (!base) return null
  const out = {} as AuroraEndpoints
  // 逐键回落默认约定：服务端只自描述了一部分时，其余仍按默认路径可用
  for (const key of ENDPOINT_KEYS) {
    out[key] = resolveTemplate(base, templates?.[key] || AURORA_ENDPOINT_FALLBACK[key], apiKey)
  }
  return out
}

/** 端点解析只关心这几个字段（OnlineSourceConfig 与之结构兼容） */
export interface SourceEndpointInput {
  /** 用户填的那条链接 */
  sourceUrl?: string
  /**
   * 源形态。脚本源（kind='lx'）的地址是脚本链接、没有 aurora 端点，
   * 派生函数一律返回空串 —— 否则会把脚本地址当成服务地址，拼出一个不存在的路径。
   */
  kind?: 'aurora' | 'lx'
  /** 接口模板形态下手填的歌单解析地址 */
  playlistUrl?: string
  /** 服务端自描述的端点模板缓存 */
  endpoints?: {
    search?: string
    playlist?: string
    lyric?: string
    recommend?: string
    toplists?: string
    toplist?: string
  } | null
}

/**
 * 取一条音源的**搜索端点模板**（执行时解析，不落盘）。无搜索能力返回空串。
 * 返回值一定含 {query}，由执行器替换占位符后得到最终地址。
 */
export function searchEndpointOf(source: SourceEndpointInput | null | undefined): string {
  const parsed = parseSourceInput(source?.sourceUrl || '')
  if (!parsed) return ''
  if (parsed.kind === 'endpoint') return parsed.apiUrl || ''
  return buildAuroraEndpoints(parsed.baseUrl, parsed.apiKey, source?.endpoints)?.search || ''
}

/**
 * 取一条音源的**歌单解析端点模板**（执行时解析，不落盘）。无该能力返回空串。
 * 服务地址形态的该端点由协议派生；接口模板形态取手填的 playlistUrl。
 */
export function playlistEndpointOf(source: SourceEndpointInput | null | undefined): string {
  const parsed = parseSourceInput(source?.sourceUrl || '')
  if (parsed?.kind === 'service') {
    return buildAuroraEndpoints(parsed.baseUrl, parsed.apiKey, source?.endpoints)?.playlist || ''
  }
  const own = String(source?.playlistUrl || '').trim()
  return own.includes('{url}') ? own : ''
}

/**
 * 取一条音源的**歌词端点模板**（执行时解析，不落盘）。无该能力返回空串。
 *
 * 歌词能力随音源走：服务端在自描述里给出 endpoints.lyric，客户端执行时把它拼成完整地址
 * （占位符 {track}/{artist}/{album}/{duration} 由歌词执行器替换）。
 * 服务端没自描述时逐键回落默认路径（见 AURORA_ENDPOINT_FALLBACK）——
 * 所以「服务端还没升级」与「已经升级」两种情况，老配置都能直接用，不需要用户重存音源。
 * 非服务地址形态（第三方接口模板、洛雪脚本源）没有歌词能力，返回空串。
 */
export function lyricEndpointOf(source: SourceEndpointInput | null | undefined): string {
  // 脚本源没有端点可派生（调用方通常已按 kind 分流，这里再兜一道）
  if (source?.kind === 'lx') return ''
  const parsed = parseSourceInput(source?.sourceUrl || '')
  if (parsed?.kind !== 'service') return ''
  return buildAuroraEndpoints(parsed.baseUrl, parsed.apiKey, source?.endpoints)?.lyric || ''
}

/**
 * 服务端能力清单（`GET /` 与 `/health` 的 capabilities）。
 *
 * 这是「这条源能做什么」的权威答案，客户端据此判断有没有歌词 / 歌单解析等能力，
 * 不必去试探端点是否存在。读不到（老服务端没这个字段）返回 null —— 调用方按
 * 「未知即回落到端点模板判断」处理，不要当成「没有能力」。
 */
export function parseAuroraCapabilities(json: unknown): string[] | null {
  const raw = (json as { capabilities?: unknown } | null | undefined)?.capabilities
  if (!Array.isArray(raw)) return null
  const out = raw.filter((v): v is string => typeof v === 'string' && Boolean(v.trim()))
  return out.length > 0 ? out : null
}

/**
 * 取一条音源的**在线音乐端点模板**（推荐歌单 / 榜单列表 / 榜单详情）。
 *
 * 只对**服务地址形态**的音源生效：这三个端点没有「接口模板」形态 ——
 * 在线音乐是浏览型界面，依赖响应里的固定字段（`list` / `groups` / `songs`），
 * 手写第三方接口模板不可能对齐，故一律由协议按服务地址派生。
 * 服务端没给自描述时回落默认路径（见 AURORA_ENDPOINT_FALLBACK）。
 */
export function hallEndpointOf(
  source: SourceEndpointInput | null | undefined,
  which: 'recommend' | 'toplists' | 'toplist'
): string {
  const parsed = parseSourceInput(source?.sourceUrl || '')
  if (parsed?.kind !== 'service') return ''
  return buildAuroraEndpoints(parsed.baseUrl, parsed.apiKey, source?.endpoints)?.[which] || ''
}

/**
 * 把端点模板里的占位符替换成实际值（只替换模板中**出现**的占位符，
 * 未出现的原样保留；模板里没有的键被忽略）。
 * 值统一走 encodeURIComponent，由调用方决定参数的具体取值。
 */
export function fillEndpointTemplate(template: string, values: Record<string, string | number>): string {
  let out = String(template || '')
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{${key}}`).join(encodeURIComponent(String(value)))
  }
  return out
}

/**
 * 从根路径 / 或 /health 的响应里读端点自描述。
 * 只认相对路径或 http(s) 地址的字符串，读到一项即返回，都没有返回 null。
 */
export function parseAuroraEndpoints(json: unknown): Partial<AuroraEndpoints> | null {
  const endpoints = (json as { endpoints?: unknown } | null | undefined)?.endpoints
  if (!endpoints || typeof endpoints !== 'object') return null
  const out: Partial<AuroraEndpoints> = {}
  for (const key of ENDPOINT_KEYS) {
    const value = (endpoints as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim()) out[key] = value.trim()
  }
  return Object.keys(out).length > 0 ? out : null
}

export interface AuroraProbeResult {
  ok: boolean
  /**
   * 面向用户的结论文案（设置页「测试连接」直接展示）。
   * 形态：结构化信封（`AURORA_ERR:{code,params}`），显示端 `translateError(message, t)` 渲染。
   */
  message: string
  /** 服务端自描述的端点模板（读到才有） */
  endpoints?: Partial<AuroraEndpoints>
  /** 服务端声明的能力清单（读到才有；老服务端没有这个字段） */
  capabilities?: string[]
  /** 服务地址是否给出了端点自描述 */
  selfDescribed: boolean
}

/**
 * 探测服务地址是否可用：
 *   1. GET {base}/ —— 不鉴权，拿到端点自描述并确认服务在线
 *   2. 填了密钥时再打 GET {base}/health?key=… 验证密钥（401/403 判为密钥错误）
 * 全程只读，不写任何配置。
 */
export async function probeAuroraService(
  baseUrl: string,
  apiKey?: string,
  timeoutMs = 8000
): Promise<AuroraProbeResult> {
  const base = normalizeSourceBase(baseUrl)
  if (!base) return { ok: false, message: encodeErrorInfo({ code: 'core.error.serviceUrlInvalid' }), selfDescribed: false }

  const headers = { Accept: 'application/json' }
  let rootResp: Response
  try {
    rootResp = await fetchWithTimeout(`${base}/`, { headers }, timeoutMs)
  } catch {
    return { ok: false, message: encodeErrorInfo({ code: 'core.error.serviceUnreachable' }), selfDescribed: false }
  }
  if (!rootResp.ok) {
    return {
      ok: false,
      message: encodeErrorInfo({ code: 'core.error.serviceStatus', params: { status: rootResp.status } }),
      selfDescribed: false,
    }
  }

  let rootJson: unknown = null
  try {
    rootJson = await rootResp.json()
  } catch {
    rootJson = null
  }
  const endpoints = parseAuroraEndpoints(rootJson)
  // 能力清单可能与自描述同处（服务端 GET / 就带），也可能只在 /health 里，两处都读
  let caps = parseAuroraCapabilities(rootJson)

  const key = String(apiKey || '').trim()
  if (key) {
    try {
      const health = await fetchWithTimeout(
        `${base}/health?key=${encodeURIComponent(key)}`,
        { headers },
        timeoutMs
      )
      if (health.ok) {
        try {
          const healthJson = await health.json()
          const fromHealth = parseAuroraEndpoints(healthJson)
          if (!caps) caps = parseAuroraCapabilities(healthJson)
          if (!endpoints && fromHealth) {
            return {
              ok: true,
              message: encodeErrorInfo({ code: 'core.probe.serviceKeyOk' }),
              endpoints: fromHealth,
              capabilities: caps || undefined,
              selfDescribed: true,
            }
          }
        } catch {
          /* /health 响应不是 JSON 也不影响连通结论 */
        }
      } else if (health.status === 401 || health.status === 403) {
        return {
          ok: false,
          message: encodeErrorInfo({ code: 'core.error.serviceKeyRejected' }),
          endpoints: endpoints || undefined,
          capabilities: caps || undefined,
          selfDescribed: Boolean(endpoints),
        }
      }
    } catch {
      /* /health 不可达但根路径可达：仍算服务在线，仅未校验密钥 */
      return {
        ok: true,
        message: encodeErrorInfo({ code: 'core.probe.serviceKeyUnverified' }),
        endpoints: endpoints || undefined,
        capabilities: caps || undefined,
        selfDescribed: Boolean(endpoints),
      }
    }
  }

  return {
    ok: true,
    // 三种形态各占一条整句（不拼「主句 + 补语」）
    message: encodeErrorInfo({
      code: endpoints
        ? key
          ? 'core.probe.serviceKeyOk'
          : 'core.probe.serviceOnline'
        : 'core.probe.serviceOnlineNoSelfDescription',
    }),
    endpoints: endpoints || undefined,
    capabilities: caps || undefined,
    selfDescribed: Boolean(endpoints),
  }
}
