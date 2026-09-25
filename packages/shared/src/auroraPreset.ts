import { fetchWithTimeout } from './fetchWithTimeout'

/**
 * 标准音源（aurora 协议）端点约定与自动组装
 *
 * 目标：设置页不再要求用户填「完整接口地址 + 占位符」，只填**服务地址 + 密钥**两栏。
 * 端点地址由本模块生成——服务端在 GET / 与 GET /health 给出端点自描述（endpoints），
 * 客户端读到就按它组装（服务端改路径 / 换参数名，客户端无需改配置）；
 * 读不到（非本协议的服务、或旧版本服务端）则回落到下面的默认约定。
 *
 * 兼容旧配置：用户手里已有的完整地址（例如
 * https://music.lighthouses.top/aurora?query={query}&quality={quality}&key=xxx）
 * 粘进「服务地址」栏即可，detectAuroraSource 会拆出服务地址与密钥。
 */

/** 「服务地址 + 密钥」形态的音源标记，存在配置里用于设置页回显两栏表单 */
export const AURORA_PRESET = 'aurora'

export interface AuroraEndpoints {
  /** 搜索端点模板，含 {query} / {quality} / key */
  search: string
  /** 歌单解析端点模板，含 {url} / key */
  playlist: string
}

/** 服务端未给自描述时的兜底模板（与 QQ_Music 的 GET / 一致） */
export const AURORA_ENDPOINT_FALLBACK: AuroraEndpoints = {
  search: '/aurora?query={query}&quality={quality}&key=<API_KEY>',
  playlist: '/aurora/playlist?url={url}&key=<API_KEY>',
}

/** 「服务地址 + 密钥」：设置页两栏表单的值 */
export interface AuroraSourceForm {
  baseUrl: string
  apiKey: string
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

/**
 * 判断一段用户输入是不是「本协议的音源端点地址」，是则拆成服务地址 + 密钥。
 * 只认端点路径 /aurora 或 /aurora/playlist——带 {query} 之类的自定义接口一律不认，
 * 免得把用户自己的音源配置误改成服务地址。不认时返回 null（调用方按原值处理）。
 */
export function detectAuroraSource(raw: string): AuroraSourceForm | null {
  const text = String(raw || '').trim()
  const base = normalizeSourceBase(text)
  if (!base) return null
  let u: URL
  try {
    u = new URL(text.match(/^[a-z][a-z0-9+.-]*:\/\//i) ? text : `https://${text}`)
  } catch {
    return null
  }
  const path = u.pathname.replace(/\/+$/, '')
  if (!/(^|\/)aurora(\/playlist)?$/i.test(path)) return null
  return { baseUrl: base, apiKey: apiKeyFromUrl(text) }
}

/**
 * 解析用户填在「服务地址」栏里的内容：返回服务地址与其中的密钥。
 * 比 detectAuroraSource 宽容——那一栏本来就允许夹带端点路径与密钥，
 * 因此只要能解析出主机名就接受，能取到 key 参数就一并带出：
 *   https://music.lighthouses.top
 *   https://music.lighthouses.top?key=xxx
 *   https://music.lighthouses.top/aurora?query={query}&key=xxx
 * 服务地址非法时返回 null。
 */
export function parseSourceInput(raw: string): AuroraSourceForm | null {
  const baseUrl = normalizeSourceBase(raw)
  if (!baseUrl) return null
  return { baseUrl, apiKey: apiKeyFromUrl(raw) }
}

/** 输入是否像「粘贴进来的完整地址」——据此决定要不要就地拆解，避免逐字符打字时被打断 */
export function looksLikeEndpointInput(raw: string): boolean {
  const text = String(raw || '').trim()
  return text.includes('?') || /\/aurora(\/playlist)?$/i.test(text)
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
  return {
    search: resolveTemplate(base, templates?.search || AURORA_ENDPOINT_FALLBACK.search, apiKey),
    playlist: resolveTemplate(base, templates?.playlist || AURORA_ENDPOINT_FALLBACK.playlist, apiKey),
  }
}

/** 待写入存储的音源字段：apiUrl/playlistUrl 为派生结果，其余供设置页回显两栏表单 */
export interface ComposedAuroraSource {
  name: string
  apiUrl: string
  playlistUrl: string
  preset: typeof AURORA_PRESET
  baseUrl: string
  apiKey: string
}

/** 组装一条可写入存储的音源；服务地址非法时返回 null */
export function composeAuroraSource(opts: {
  name?: string
  baseUrl: string
  apiKey?: string
  endpoints?: Partial<AuroraEndpoints> | null
}): ComposedAuroraSource | null {
  const base = normalizeSourceBase(opts.baseUrl)
  if (!base) return null
  const apiKey = String(opts.apiKey || '').trim()
  const endpoints = buildAuroraEndpoints(base, apiKey, opts.endpoints)
  if (!endpoints) return null
  return {
    name: String(opts.name || '').trim() || '标准音源',
    apiUrl: endpoints.search,
    playlistUrl: endpoints.playlist,
    preset: AURORA_PRESET,
    baseUrl: base,
    apiKey,
  }
}

/**
 * 从根路径 / 或 /health 的响应里读端点自描述。
 * 只认相对路径或 http(s) 地址的字符串，读到一项即返回，都没有返回 null。
 */
export function parseAuroraEndpoints(json: unknown): Partial<AuroraEndpoints> | null {
  const endpoints = (json as { endpoints?: unknown } | null | undefined)?.endpoints
  if (!endpoints || typeof endpoints !== 'object') return null
  const out: Partial<AuroraEndpoints> = {}
  for (const key of ['search', 'playlist'] as const) {
    const value = (endpoints as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim()) out[key] = value.trim()
  }
  return out.search || out.playlist ? out : null
}

export interface AuroraProbeResult {
  ok: boolean
  /** 面向用户的结论文案（设置页「测试连接」直接展示） */
  message: string
  /** 服务端自描述的端点模板（读到才有） */
  endpoints?: Partial<AuroraEndpoints>
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
  if (!base) return { ok: false, message: '服务地址格式不正确', selfDescribed: false }

  const headers = { Accept: 'application/json' }
  let rootResp: Response
  try {
    rootResp = await fetchWithTimeout(`${base}/`, { headers }, timeoutMs)
  } catch {
    return { ok: false, message: '连接失败：地址不可达或端口不正确', selfDescribed: false }
  }
  if (!rootResp.ok) {
    return { ok: false, message: `服务返回 ${rootResp.status}，请确认服务地址`, selfDescribed: false }
  }

  let rootJson: unknown = null
  try {
    rootJson = await rootResp.json()
  } catch {
    rootJson = null
  }
  const endpoints = parseAuroraEndpoints(rootJson)

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
          if (!endpoints && fromHealth) {
            return { ok: true, message: '连接正常，密钥有效', endpoints: fromHealth, selfDescribed: true }
          }
        } catch {
          /* /health 响应不是 JSON 也不影响连通结论 */
        }
      } else if (health.status === 401 || health.status === 403) {
        return {
          ok: false,
          message: '密钥不正确（服务端拒绝了该密钥）',
          endpoints: endpoints || undefined,
          selfDescribed: Boolean(endpoints),
        }
      }
    } catch {
      /* /health 不可达但根路径可达：仍算服务在线，仅未校验密钥 */
      return {
        ok: true,
        message: '服务在线，但未能校验密钥（/health 不可达）',
        endpoints: endpoints || undefined,
        selfDescribed: Boolean(endpoints),
      }
    }
  }

  return {
    ok: true,
    message: endpoints
      ? key
        ? '连接正常，密钥有效'
        : '服务在线（未填密钥）'
      : '服务在线，但未读到端点自描述，将按默认 /aurora 路径组装',
    endpoints: endpoints || undefined,
    selfDescribed: Boolean(endpoints),
  }
}
