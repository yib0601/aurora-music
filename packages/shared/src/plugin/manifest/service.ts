/**
 * 服务地址形态（service profile）的运行期派生。
 *
 * ## 解决什么
 *
 * 其它声明式端点要求**绝对 URL**，这对固定上游成立，对"用户填自己的服务地址"
 * 不成立：自建托管者填的是 `https://host?key=xxx`，全部端点都要从这条链接派生。
 *
 * 本模块只做一件事：**把"清单声明的派生规则 + 用户填的地址"算成具体端点模板**。
 * 它不执行请求、不解析响应 —— 那些仍归 `manifest/source.ts`，于是同一份清单在
 * 固定上游与自建托管两种形态下走**完全相同的执行代码**。
 *
 * ## 三条边界
 *
 * 1. **不引入模板求值**：只做占位符替换（复用 `fillEndpointTemplate`），
 *    与清单其它部分同一套语法。清单里出现表达式就等于 A 档退化成 B 档。
 * 2. **密钥只进 URL，不进日志/清单**：`{secret}` 的值来自用户配置，
 *    派生结果**不落盘**（每次调用现算），因此不会被写进插件目录。
 * 3. **自描述失败不算错误**：老服务端没有 `GET /` 的 `endpoints` 是常态，
 *    此时静默用静态模板 —— 这与内置 aurora 执行器的口径一致。
 */

import type { DeclarativeServiceSpec, PluginManifest } from './types'
import type { OnlineSourceConfig } from '../../types'
import { fillEndpointTemplate } from '../../auroraPreset'
import { valueAtPath } from './path'

/** 服务端可能给出的端点键（与 `DeclarativeServiceSpec.endpoints` 同名） */
export const SERVICE_ENDPOINT_KEYS = [
  'search',
  'track',
  'playlist',
  'lyric',
  'recommend',
  'toplists',
  'toplist',
] as const

export type ServiceEndpointKey = (typeof SERVICE_ENDPOINT_KEYS)[number]

/** 派生结果：端点模板（未填占位符）+ 用于请求自描述的地址 */
export interface DerivedService {
  /** 服务地址（`scheme://host[:port][/path]`，已去掉 query） */
  baseUrl: string
  /** 从用户链接里取出的密钥（可能为空串） */
  secret: string
  /** 已把 `{baseUrl}` / `{secret}` 填好的端点模板 */
  endpoints: Partial<Record<ServiceEndpointKey, string>>
  /** 自描述地址（清单没声明则为 null） */
  selfDescribeUrl: string | null
  /** 自描述响应里装端点的字段路径 */
  selfDescribePath: string | null
}

/**
 * 从用户填的地址里拆出「服务地址」与「密钥」。
 *
 * 为什么单独拆：`{baseUrl}` 必须是**去掉 query** 的地址（用户把 key 写在 query 里，
 * 若 baseUrl 保留 query，派生出的端点会变成 `https://h?key=x/aurora?...` 这种废地址）。
 *
 * 密钥位置由 `secretFrom` 决定，缺省 `query:key`。
 * 取不到时返回空串 —— 下游 `dropUnfilledParams` 会把相关参数整段剔除，
 * 于是"服务端不需要密钥"的情况天然成立。
 */
export function splitServiceUrl(
  rawUrl: string,
  secretFrom?: string
): { baseUrl: string; secret: string } {
  const text = String(rawUrl || '').trim()
  if (!text) return { baseUrl: '', secret: '' }
  try {
    const parsed = new URL(text)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { baseUrl: '', secret: '' }
    }
    // baseUrl 去 query 与 hash：它们属于「用户填的那条链接」，不属于服务基址
    const baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '')

    // `secretFrom` 形如 `query:key` / `query:api_key`；其它形态暂不支持（返回空密钥）
    const spec = String(secretFrom || 'query:key').trim()
    if (!spec.toLowerCase().startsWith('query:')) return { baseUrl, secret: '' }
    const paramName = spec.slice('query:'.length).trim()
    if (!paramName) return { baseUrl, secret: '' }
    return { baseUrl, secret: parsed.searchParams.get(paramName) ?? '' }
  } catch {
    return { baseUrl: '', secret: '' }
  }
}

/**
 * 把一份 service 声明 + 用户地址算成具体端点。
 *
 * 返回 `null` 表示派生不成立（用户没填地址 / 地址非法）——
 * 调用方据此让该源**不参与**，而不是发一个必然失败的请求。
 */
export function deriveService(
  spec: DeclarativeServiceSpec | null | undefined,
  config: Pick<OnlineSourceConfig, 'sourceUrl'> | null | undefined
): DerivedService | null {
  if (!spec) return null
  const { baseUrl, secret } = splitServiceUrl(config?.sourceUrl || '', spec.secretFrom)
  if (!baseUrl) return null

  const values: Record<string, string> = { baseUrl, secret }
  const endpoints: Partial<Record<ServiceEndpointKey, string>> = {}
  for (const key of SERVICE_ENDPOINT_KEYS) {
    const template = spec.endpoints?.[key]
    if (typeof template !== 'string' || !template.trim()) continue
    // 只替换 {baseUrl} / {secret}；其它占位符（{query} / {id} …）留给执行期，
    // 因为它们的值要等到具体请求才知道
    endpoints[key] = fillServicePlaceholders(template, values)
  }

  const selfDescribe = spec.selfDescribe
  return {
    baseUrl,
    secret,
    endpoints,
    selfDescribeUrl: selfDescribe?.url
      ? fillServicePlaceholders(selfDescribe.url, values)
      : null,
    selfDescribePath: selfDescribe?.endpoints || null,
  }
}

/**
 * 只替换服务级占位符，其余原样保留。
 *
 * 为什么不用 `fillEndpointTemplate` 一把梭：那个函数会把**所有** `{name}`
 * 当占位符处理，而 `{query}` / `{id}` 此刻还没有值 —— 用空串填进去会让
 * `dropUnfilledParams` 提前删掉它们，于是端点模板在执行期彻底错了。
 * 所以这里只动两个已知键，且**不动**其它花括号。
 */
export function fillServicePlaceholders(
  template: string,
  values: Record<string, string>
): string {
  return String(template || '').replace(/\{(baseUrl|secret)\}/g, (_match, name: string) => {
    return values[name] ?? ''
  })
}

/**
 * 把自描述响应里给出的端点覆盖到静态模板之上。
 *
 * 服务端自描述优先（它知道自己改了路径）；读不到就原样返回静态模板。
 * 自描述里的值同样是**模板**（可能含 `{query}` 等），所以只替换服务级占位符。
 */
export function mergeSelfDescribed(
  derived: DerivedService,
  rootJson: unknown
): DerivedService {
  if (!derived.selfDescribePath) return derived
  const raw = valueAtPath(rootJson, derived.selfDescribePath)
  if (!raw || typeof raw !== 'object') return derived

  const values: Record<string, string> = { baseUrl: derived.baseUrl, secret: derived.secret }
  const merged: Partial<Record<ServiceEndpointKey, string>> = { ...derived.endpoints }
  for (const key of SERVICE_ENDPOINT_KEYS) {
    const template = (raw as Record<string, unknown>)[key]
    if (typeof template !== 'string' || !template.trim()) continue
    merged[key] = fillServicePlaceholders(template, values)
  }
  return { ...derived, endpoints: merged }
}

/** 清单是否处于「服务地址形态」且白名单交由用户地址决定 */
export function isConfiguredOriginService(manifest: PluginManifest): boolean {
  return manifest.allowlist === 'configured-origin' && Boolean(manifest.service)
}
