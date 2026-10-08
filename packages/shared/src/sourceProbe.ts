/**
 * 源探测的原生门面（翻译层的一部分）
 *
 * 各形态源的探测过程差别很大：脚本源要拉脚本、在宿主里执行一遍才能问出能力；
 * 服务源只要打两个 HTTP 端点。这里把两者的探测结论统一翻译成 SourceProbeResult，
 * 于是 UI（设置页「测试」）只消费一份形态无关的结果 —— 新增源形态时界面不必改。
 *
 * 纯函数、不碰网络：真正发起探测（拉脚本 / 打 HTTP）由平台适配器负责。
 */

import { LX_PLATFORM_LABELS, type LxSourceInspection } from './lxHost'
import type { AuroraProbeResult } from './auroraPreset'
import type { SourceCapability, SourceProbeResult } from './types'

/** 服务源端点 → 能力行的展示名 */
const AURORA_ENDPOINT_LABELS: Record<string, string> = {
  search: '在线搜索',
  playlist: '歌单解析',
  recommend: '推荐歌单',
  toplists: '榜单列表',
  toplist: '榜单详情',
}

/** 端点出现顺序（固定顺序渲染，读起来稳定） */
const AURORA_ENDPOINT_ORDER = ['search', 'playlist', 'recommend', 'toplists', 'toplist'] as const

/**
 * 脚本源探测结论 → 原生探测结果。
 * 能力行取自脚本自报的 inited 数据（平台 / 动作 / 音质档位），平台展示名优先中文映射。
 */
export function lxInspectionToProbe(inspection: LxSourceInspection): SourceProbeResult {
  const platforms = inspection?.platforms || {}
  const capabilities: SourceCapability[] = Object.entries(platforms).map(([key, cap]) => ({
    key,
    label: LX_PLATFORM_LABELS[key] || cap?.name || key,
    searchable: (cap?.actions || []).some((a) => a === 'search' || a === 'musicSearch'),
    qualityCount: (cap?.qualitys || []).length,
  }))

  const out: SourceProbeResult = {
    ok: Boolean(inspection?.ok),
    kind: 'lx',
    capabilities,
  }
  if (!inspection?.ok) {
    out.error = inspection?.error || '脚本未声明任何可用平台'
    return out
  }
  if (inspection.name || inspection.version || inspection.author || inspection.description || inspection.homepage) {
    out.scriptInfo = {
      name: inspection.name,
      version: inspection.version,
      description: inspection.description,
      author: inspection.author,
      homepage: inspection.homepage,
      packed: inspection.packed,
    }
  }
  out.message = '脚本可用'
  return out
}

/**
 * 服务源探测结论 → 原生探测结果。
 * 能力行由服务端自描述的端点（或本机按默认约定组装的端点）生成。
 */
export function auroraProbeToResult(result: AuroraProbeResult): SourceProbeResult {
  const endpoints = result?.endpoints || {}
  const capabilities: SourceCapability[] = AURORA_ENDPOINT_ORDER.filter(
    (key) => typeof (endpoints as Record<string, unknown>)[key] === 'string' && !!(endpoints as Record<string, unknown>)[key]
  ).map((key) => ({
    key,
    label: AURORA_ENDPOINT_LABELS[key] || key,
    searchable: key === 'search',
  }))

  return {
    ok: Boolean(result?.ok),
    kind: 'aurora',
    capabilities,
    endpoints: result?.endpoints,
    message: result?.message,
    ...(result?.ok ? {} : { error: result?.message || '源不可用' }),
  }
}

/**
 * 探测得不到结论时的统一形态：环境不具备该能力（浏览器端没有脚本宿主），
 * 或探测过程本身失败（脚本拉不下来、宿主起不来）。
 * 两种都只是「这次探测没结论」，UI 一律按错误文案展示。
 */
export function unavailableProbe(
  kind: SourceProbeResult['kind'],
  error: string
): SourceProbeResult {
  return { ok: false, kind, capabilities: [], error }
}
