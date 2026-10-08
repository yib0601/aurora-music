import { platform } from '@/services/platform'
import type { SourceProbeResult } from '@aurora/shared'

/**
 * 洛雪音源脚本源的纯逻辑：链接校验、能力映射、探测调用。
 * 与渲染分离，便于单测；UI 侧见 components/common/LxSourceProbe.tsx。
 *
 * 探测本身走平台的通用入口 `platform.probeSource`：拉脚本、执行宿主、翻译能力
 * 这些形态差异都在平台适配器里完成，本模块只做链接校验与界面状态的收敛。
 */

/**
 * 脚本链接的宽校验：只要求 http(s)。
 * 脚本可托管在任意路径（GitHub Raw / jsDelivr 短链 / 私有服务），
 * 强行要求 .js 后缀会把合法源挡在门外；真实可用性由「测试」结果判定。
 */
export function checkLxScriptLink(url: string): string | null {
  const text = String(url || '').trim()
  if (!text) return '请填写脚本链接'
  if (!/^https?:\/\//i.test(text)) return '脚本链接需以 http:// 或 https:// 开头'
  return null
}

/** 源声明的单个能力，转成界面直接可用的一行描述 */
export interface LxPlatformRow {
  key: string
  /** 展示名（由探测层给好：中文平台映射优先，其次源自报名称） */
  label: string
  /** 有搜索接口才算「搜索+取址」，否则只能按定位令牌直接取址 */
  searchable: boolean
  qualityCount: number
}

/** 探测结果 → 能力行。没有能力的源返回空数组，界面据此不渲染能力块 */
export function lxPlatformRows(result: SourceProbeResult | undefined): LxPlatformRow[] {
  return (result?.capabilities || []).map((cap) => ({
    key: cap.key,
    label: cap.label,
    searchable: cap.searchable,
    qualityCount: cap.qualityCount || 0,
  }))
}

/** 探测失败时的可读文案：源自报的错误优先，其余按通用加载失败呈现 */
export function lxProbeErrorText(result: SourceProbeResult): string {
  return `脚本加载失败：${result.error || '脚本未声明任何可用平台'}`
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
 */
export async function runLxProbe(
  id: string,
  sourceUrl: string,
  headers?: Record<string, string>,
  opts?: { result?: SourceProbeResult | null; message?: string }
): Promise<LxProbeState> {
  const url = sourceUrl.trim()
  const linkError = checkLxScriptLink(url)
  if (linkError) return { loading: false, ok: false, message: linkError }
  try {
    const result =
      opts?.result ||
      (await platform.probeSource({ id, name: '', kind: 'lx', sourceUrl: url, headers }))
    if (!result.ok) {
      return { loading: false, ok: false, message: lxProbeErrorText(result), result }
    }
    return {
      loading: false,
      ok: true,
      message: opts?.message || result.message || '脚本可用',
      result,
    }
  } catch (err) {
    return { loading: false, ok: false, message: `脚本加载失败：${(err as Error)?.message || String(err)}` }
  }
}
