import {
  auroraError,
  translateError,
  type AppTranslator,
  type AuroraError,
  type MessageKey,
  type SourceProbeResult,
  type TFunction,
} from '@aurora/shared'
import { appTranslate } from '@/i18n'
import { platform } from '@/services/platform'

/**
 * 洛雪音源脚本源的纯逻辑：链接校验、能力映射、探测调用。
 * 与渲染分离，便于单测；UI 侧见 components/common/LxSourceProbe.tsx。
 *
 * 探测本身走平台的通用入口 `platform.probeSource`：拉脚本、执行宿主、翻译能力
 * 这些形态差异都在平台适配器里完成，本模块只做链接校验与界面状态的收敛。
 *
 * 文案纪律：本模块**不产出中文句子**。校验失败返回结构化错误（`AuroraError`，
 * code 是消息树里的完整键路径），渲染由 `translateError(err, t)` 按当前语言完成；
 * 探测结论里的平台名与脚本自报错误属于领域数据，作为 `{reason}` 参数透出。
 */

/** 本模块产出的错误码：类型标注成 MessageKey，键名写错在 tsc 阶段就炸 */
const ERROR_CODES = {
  scriptUrlRequired: 'sources.error.scriptUrlRequired',
  scriptUrlScheme: 'sources.error.scriptUrlScheme',
} as const satisfies Record<string, MessageKey>

/**
 * 把任意异常按当前语言渲染成人话（结构化错误取码，未知异常走归一兜底）。
 *
 * 为什么需要这一层：shared 的 `translateError` 第二参数声明为内核的 `TFunction`（键是通配
 * string），而渲染层拿到的是键集收窄的 `AppTranslator`；两者只差函数参数的逆变方向，
 * 运行期是同一件事（按键查表 + 缺键回退）。已实测 `translateError(err, t)` 直接传会报
 * TS2345，因此这里集中做一次收窄，调用点不再各写断言——项目里 UpdateDownloadDialog 的
 * 内核的 translateError 已收窄成只接受合法文案键的翻译函数（`ErrorTranslator`），
 * 所以这里不再需要类型断言。
 * **根治在 shared 侧**：把该参数放宽成 `AppTranslator`（或 `TFunction | AppTranslator`），
 * 那属于 i18n 内核对外的文件，不在本次改造的写作用域。
 */
export function renderError(error: unknown, t: AppTranslator): string {
  return translateError(error, t)
}

/**
 * 脚本链接的宽校验：只要求 http(s)。
 * 脚本可托管在任意路径（GitHub Raw / jsDelivr 短链 / 私有服务），
 * 强行要求 .js 后缀会把合法源挡在门外；真实可用性由「测试」结果判定。
 *
 * 返回 null 表示合法；否则返回结构化错误，由渲染端按当前语言取文案。
 */
export function checkLxScriptLink(url: string): AuroraError | null {
  const text = String(url || '').trim()
  if (!text) return auroraError(ERROR_CODES.scriptUrlRequired)
  if (!/^https?:\/\//i.test(text)) return auroraError(ERROR_CODES.scriptUrlScheme)
  return null
}

/** 源声明的单个能力，转成界面直接可用的一行描述 */
export interface LxPlatformRow {
  key: string
  /**
   * 平台展示名**文案键**（不是中文名）。
   * 探测层（shared 的 LX_PLATFORM_LABEL_KEYS）给的是 `core.platform.kw` 这类键，
   * 取值必须在渲染期 `t(labelKey)` —— 若在这里就 t() 成字符串，
   * 一来模块级求值会冻结语言，二来这张表会在语言切换后不刷新。
   */
  labelKey: MessageKey
  /** 有搜索接口才算「搜索+取址」，否则只能按定位令牌直接取址 */
  searchable: boolean
  qualityCount: number
}

/** 探测结果 → 能力行。没有能力的源返回空数组，界面据此不渲染能力块 */
export function lxPlatformRows(result: SourceProbeResult | undefined): LxPlatformRow[] {
  return (result?.capabilities || []).map((cap) => ({
    key: cap.key,
    // cap.label 是文案键（协议标识 → 键的映射在 shared 的 LX_PLATFORM_LABEL_KEYS）。
    // 源自报名称的兜底也是键（`core.platform.<自定义>`不存在时 t() 会退回键名，
    // 由调用方决定是否再兜一层，见 LxSourceProbe 的渲染处）。
    labelKey: cap.label as MessageKey,
    searchable: cap.searchable,
    qualityCount: cap.qualityCount || 0,
  }))
}

/** 探测失败时的可读文案：源自报的错误优先，其余按通用加载失败呈现（t 由调用方按语言注入） */
export function lxProbeErrorText(result: SourceProbeResult, t: AppTranslator): string {
  // reason 是参数位：底层给的是结构化信封，直接插进句子会把 AURORA_ERR:{…} 带上屏，
  // 所以先渲染成当前语言的整句，再作为参数嵌入外层句
  return t('sources.probe.scriptFailed', {
    reason: result.error ? renderError(result.error, t) : t('sources.probe.noPlatform'),
  })
}

/**
 * 洛雪音源脚本源在本平台是否可用。
 * 脚本要在平台侧拉取与执行：桌面端经主进程、移动端走原生 HTTP；纯浏览器（web）没有该能力，
 * 因此在设置页入口就禁用该形态，不让用户填完链接、点完测试才拿到「不支持」。
 * 判定输入由调用方注入（isDesktop() / isMobile()），便于单测覆盖三端组合。
 */
export function lxFormSupported(env: { desktop: boolean; mobile: boolean }): boolean {
  return env.desktop || env.mobile
}

/** 探测状态：结果不落库，只活在表单会话里 */
export interface LxProbeState {
  loading: boolean
  ok?: boolean
  message?: string
  /** 探测结论（形态无关的原生结构，界面只消费这一份） */
  result?: SourceProbeResult
}

/**
 * 探测一条脚本源：交给平台通用入口（拉脚本 → 执行宿主 → 翻译能力），再收敛成界面状态。
 * 平台不支持或脚本起不来时给可读提示，而不是把异常抛到界面上。
 *
 * `opts.result` 用于「同一次探测的结论要在两处渲染」的场景（如弹窗与卡片同时展示）：
 * 传了就复用那份结论、只刷新文案，不再探一次。
 * `opts.t` 供组件传入渲染期翻译函数（语言切换即时生效）；缺省走 appTranslate（事件回调场景）。
 */
export async function runLxProbe(
  id: string,
  sourceUrl: string,
  headers?: Record<string, string>,
  opts?: { result?: SourceProbeResult | null; message?: string; t?: AppTranslator }
): Promise<LxProbeState> {
  const t = opts?.t ?? appTranslate()
  const url = sourceUrl.trim()
  const linkError = checkLxScriptLink(url)
  if (linkError) return { loading: false, ok: false, message: renderError(linkError, t) }
  try {
    const result =
      opts?.result ||
      (await platform.probeSource({ id, name: '', kind: 'lx', sourceUrl: url, headers }))
    if (!result.ok) {
      return { loading: false, ok: false, message: lxProbeErrorText(result, t), result }
    }
    return {
      loading: false,
      ok: true,
      message: opts?.message || result.message || t('sources.probe.scriptOk'),
      result,
    }
  } catch (err) {
    // 平台抛出的异常可能是结构化错误（AuroraError）或底层网络异常：
    // 统一由 translateError 归一，绝不在此处拼中文句子
    return {
      loading: false,
      ok: false,
      message: t('sources.probe.scriptFailed', { reason: renderError(err, t) }),
    }
  }
}
