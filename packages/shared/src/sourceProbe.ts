/**
 * 源探测的原生门面（翻译层的一部分）
 *
 * 各形态源的探测过程差别很大：脚本源要拉脚本、在宿主里执行一遍才能问出能力；
 * 服务源只要打两个 HTTP 端点。这里把两者的探测结论统一翻译成 SourceProbeResult，
 * 于是 UI（设置页「测试」）只消费一份形态无关的结果 —— 新增源形态时界面不必改。
 *
 * 本模块产出的两类文本（这是「底层不烧文案」在本域的具体口径）：
 *   - **展示名**（能力行的 label）→ 给**文案键**，显示端在渲染期 `t(label)` 取值；
 *     脚本自报的平台名（第三方数据）原样透出，翻译器查不到键时返回原串，天然兜底。
 *   - **结论文案 / 失败原因**（message / error）→ 走 errors.ts 的结构化信封
 *     （`AURORA_ERR:{code,params,detail}`），显示端 `translateError(value, t)` 渲染；
 *     信封本就是中性的「码 + 参数」载体，成功结论与错误共用它，显示端只需一条规则。
 *
 * 纯函数、不碰网络：真正发起探测（拉脚本 / 打 HTTP）由平台适配器负责。
 */

import { LX_PLATFORM_LABEL_KEYS, type LxSourceInspection } from './lxHost'
import { auroraError, encodeErrorInfo } from './i18n/errors'
import type { MessageKey } from './i18n'
import type { TranslateParams } from './i18n/core'
import type { AuroraProbeResult } from './auroraPreset'
import type { SourceCapability, SourceProbeResult } from './types'

/** 服务源端点 → 能力行的**文案键**（展示名在渲染期按语言取值） */
const AURORA_ENDPOINT_LABEL_KEYS: Record<string, MessageKey> = {
  search: 'core.probe.endpoint.search',
  playlist: 'core.probe.endpoint.playlist',
  recommend: 'core.probe.endpoint.recommend',
  toplists: 'core.probe.endpoint.toplists',
  toplist: 'core.probe.endpoint.toplist',
}

/** 端点出现顺序（固定顺序渲染，读起来稳定） */
const AURORA_ENDPOINT_ORDER = ['search', 'playlist', 'recommend', 'toplists', 'toplist'] as const

/** 结论文案 → 结构化信封（成功结论与错误共用同一种载体，显示端只认信封） */
function messageOf(code: MessageKey, params?: TranslateParams): string {
  return encodeErrorInfo({ code, params })
}

/**
 * 脚本源探测结论 → 原生探测结果。
 * 能力行取自脚本自报的 inited 数据（平台 / 动作 / 音质档位），平台展示名给文案键。
 */
export function lxInspectionToProbe(inspection: LxSourceInspection): SourceProbeResult {
  const platforms = inspection?.platforms || {}
  const capabilities: SourceCapability[] = Object.entries(platforms).map(([key, cap]) => ({
    key,
    // 已知平台给文案键（渲染期 t() 取值）；脚本自报名与裸标识原样透出
    label: LX_PLATFORM_LABEL_KEYS[key] || cap?.name || key,
    searchable: (cap?.actions || []).some((a) => a === 'search' || a === 'musicSearch'),
    qualityCount: (cap?.qualitys || []).length,
  }))

  const out: SourceProbeResult = {
    ok: Boolean(inspection?.ok),
    kind: 'lx',
    capabilities,
  }
  if (!inspection?.ok) {
    out.error = inspection?.error || auroraError('core.error.lxNoPlatforms').message
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
  out.message = messageOf('core.probe.lxOk')
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
    label: AURORA_ENDPOINT_LABEL_KEYS[key] || key,
    searchable: key === 'search',
  }))

  return {
    ok: Boolean(result?.ok),
    kind: 'aurora',
    capabilities,
    endpoints: result?.endpoints,
    // message 由探测层给（已是信封或文案键），原样带出交给显示端渲染
    message: result?.message,
    ...(result?.ok ? {} : { error: result?.message || auroraError('core.error.sourceUnavailable').message }),
  }
}

/**
 * 探测得不到结论时的统一形态：环境不具备该能力（浏览器端没有脚本宿主），
 * 或探测过程本身失败（脚本拉不下来、宿主起不来）。
 * 两种都只是「这次探测没结论」，UI 一律按错误文案展示。
 *
 * `error` 由调用方给：既可以是结构化信封（共享层产出的结论），也可以是平台侧的自由文本
 * （显示端按原样透出，不吞信息）。
 */
export function unavailableProbe(
  kind: SourceProbeResult['kind'],
  error: string
): SourceProbeResult {
  return { ok: false, kind, capabilities: [], error }
}
