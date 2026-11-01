/**
 * 主机白名单 fetch（声明式插件的网络边界）。
 *
 * ## 为什么必须有这一层
 *
 * 内置插件是仓库里的代码，它请求哪里由**我们**审过。外部插件是第三方写的清单，
 * 它声明的 `hosts` 是"我打算访问这些主机"的**承诺**，而承诺靠自觉不算数 ——
 * 清单被改一行、或者作者本来就写了 `hosts: ["example.com"]` 却在跑的时候打别处，
 * 用户都看不出来。所以运行期必须**强制**：越界请求直接失败，不发出。
 *
 * ## 边界写在哪一层
 *
 * 包**注入给插件的 `fetch`**（`PluginContext.fetch`），而不是包某个调用点：
 * 契约里插件只能通过 `ctx.fetch` 发请求（"插件不自带网络栈"），包在这里等于覆盖了
 * 插件的全部出网路径。这也是为什么本函数不导出一个"原始 fetch"的旁路。
 *
 * ## 已知局限（必须如实写出来）
 *
 * - 只校验**请求发起时**的目标主机。上游返回 302 到白名单外的主机时，重定向由
 *   `fetch` 自己跟随（`follow` 默认 `follow`），本层看不到中间跳转。要堵住需要
 *   `redirect: 'manual'` 并自行逐跳校验 —— 代价是每个插件都得处理重定向语义，
 *   当前取"直连可信、跳转由上游自己负责"的折中。声明式插件**不**设置
 *   `redirect: 'manual'`，所以这条局限对声明式插件成立。
 * - 不做响应体大小限制（超时由调用方与 `fetchWithTimeout` 负责）。
 * - 不校验端口与协议之外的东西（`http:` 也放行：内网自建服务常是 http）。
 */

import type { PluginManifest } from './types'

/** 从 URL 里取主机（含端口，小写）。取不到返回空串 */
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return parsed.host.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 主机是否被白名单放行。
 *
 * 精确匹配 `host` 或 `hostname`（即在清单写了 `api.example.com` 时，
 * 请求 `api.example.com:8443` 也放行 —— 端口不应成为"同一个主机"的区分依据，
 * 否则作者必须在清单里穷举端口）。反过来，清单写了带端口的 `host:8443`
 * 时只放行该端口。
 */
export function hostAllowed(hosts: readonly string[], url: string): boolean {
  const target = hostOf(url)
  if (!target) return false
  const hostname = target.split(':')[0]
  for (const raw of hosts) {
    const allowed = String(raw || '').trim().toLowerCase()
    if (!allowed) continue
    if (allowed === target) return true
    // 白名单没写端口 = 该主机的任意端口都放行
    if (!allowed.includes(':') && allowed === hostname) return true
  }
  return false
}

/** 越界时的错误信息形状（结构化：显示端据此渲染本地化文案，不在本层烧中文） */
export const HOST_NOT_ALLOWED = 'AURORA_PLUGIN_HOST_NOT_ALLOWED'

/**
 * 出网白名单的两种模式。
 *
 * ## 为什么需要第二种
 *
 * 清单里写死 `hosts: ["api.example.com"]` 对**固定上游**的插件是对的。
 * 但有一种形态与之根本冲突：**「用户填自己的服务地址」** —— 自建托管者填
 * `https://music.myserver.com?key=…`，上游主机由用户决定，作者**不可能**
 * 在清单里穷举。若不支持它，这类插件只能放弃白名单强制（那等于把白名单变成
 * 装饰），或者要求用户改清单重新打包（那等于宣告"自建托管者用不了签名"）。
 *
 * ## `configured-origin` 不比 `declared-hosts` 松
 *
 * - **仍然禁止通配符**：放行的是**用户自己填的那一个 origin**，不是域后缀。
 * - **由用户输入产生，不由插件自述**：插件无法在黑盒里扩大范围，除非用户
 *   自己填了那个域 —— 那等于用户授权。
 * - 地址取自 `config.sourceUrl`（用户可见可改），不是插件能伪造的字段。
 */
export type AllowlistMode =
  /** 只在清单声明的 `hosts` 里放行（默认；固定上游的插件） */
  | 'declared-hosts'
  /** 只在**用户配置的服务地址**的 origin 里放行（自建托管型插件） */
  | 'configured-origin'

/** 白名单策略 */
export interface AllowlistPolicy {
  mode?: AllowlistMode
  /** `declared-hosts` 模式下的主机清单 */
  hosts?: readonly string[]
  /** `configured-origin` 模式下用户填的服务地址（运行期由调用方传入） */
  configuredUrl?: string
}

/**
 * 从一条用户填写的地址里取 origin（`scheme://host[:port]`，小写）。
 *
 * 只接受 http(s)：其它协议（`file:` / `ftp:`）不该出现在插件源配置里。
 * 取不到就返回空串 —— 调用方据此拒绝全部请求（fail-closed）。
 */
export function originOf(url: string | null | undefined): string {
  const text = String(url || '').trim()
  if (!text) return ''
  try {
    const parsed = new URL(text)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return `${parsed.protocol}//${parsed.host}`.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 按策略判定一条 URL 是否放行。
 *
 * `configured-origin` 要求**协议 + 主机 + 端口全一致**（标准 origin 语义）：
 * 比 `declared-hosts` 的"同主机任意端口"更严 —— 后者字段是作者声明，
 * 前者是用户地址；把端口差异一并放行会让"用户以为只授权了一个服务、
 * 实际授权了该主机上所有服务"。
 */
export function allowlistAllows(policy: AllowlistPolicy, url: string): boolean {
  const mode = policy.mode || 'declared-hosts'
  if (mode === 'configured-origin') {
    const targetOrigin = originOf(url)
    const allowedOrigin = originOf(policy.configuredUrl)
    // fail-closed：任一侧取不到 origin（用户没填、地址非法）就拒绝
    if (!targetOrigin || !allowedOrigin) return false
    return targetOrigin === allowedOrigin
  }
  return hostAllowed(policy.hosts || [], url)
}

/** 构造一条越界错误（带目标主机，便于诊断"是哪个域名没声明"） */
export function hostNotAllowedError(pluginId: string, url: string): Error {
  const host = hostOf(url) || '(invalid url)'
  const error = new Error(`${HOST_NOT_ALLOWED}:{plugin:${pluginId},host:${host}}`)
  ;(error as Error & { code?: string }).code = HOST_NOT_ALLOWED
  return error
}

/** 判断一个错误是否是本层抛出的越界错误 */
export function isHostNotAllowedError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === HOST_NOT_ALLOWED)
}

/**
 * 给插件包的 fetch：按策略放行。
 *
 * 返回的函数**签名与 `globalThis.fetch` 完全一致**，可以直接塞进
 * `PluginContext.fetch`，插件实现里不需要任何分支（"我是不是外部插件"这个判断
 * 在运行期不存在）。
 */
export function createGuardedFetch(
  manifest: Pick<PluginManifest, 'id' | 'hosts'>,
  base: typeof globalThis.fetch,
  /** `configured-origin` 模式下用户填的服务地址（调用方现传，因为配置会变） */
  options?: { mode?: AllowlistMode; configuredUrl?: string }
): typeof globalThis.fetch {
  const policy: AllowlistPolicy = {
    mode: options?.mode ?? 'declared-hosts',
    hosts: Array.isArray(manifest.hosts) ? manifest.hosts : [],
    configuredUrl: options?.configuredUrl,
  }
  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!allowlistAllows(policy, url)) throw hostNotAllowedError(manifest.id, url)
    return base(input, init)
  }
  // 只补 `preconnect`（fetch 的类型上它是可选的静态方法），其余静态成员不属于契约
  return guarded as typeof globalThis.fetch
}
