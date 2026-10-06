import { platform } from '@/services/platform'
import { LX_PLATFORM_LABELS } from '@aurora/shared'
import type { LxSourceInspection } from '@aurora/shared'

/**
 * 洛雪音源脚本源的纯逻辑：链接校验、能力映射、探测调用。
 * 与渲染分离，便于单测；UI 侧见 components/common/LxSourceProbe.tsx。
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

/** 脚本声明的单个平台能力，转成界面直接可用的一行描述 */
export interface LxPlatformRow {
  key: string
  /** 中文展示名：优先用 shared 的平台映射，其次脚本自报名称，最后回落平台键 */
  label: string
  /** 有搜索接口才算「搜索+取址」，否则该平台只能按定位信息直接取址 */
  searchable: boolean
  qualityCount: number
}

/** 探测结果 → 平台能力行。无平台的脚本返回空数组，界面据此不渲染能力块 */
export function lxPlatformRows(inspection: LxSourceInspection | undefined): LxPlatformRow[] {
  const platforms = inspection?.platforms || {}
  return Object.entries(platforms).map(([key, cap]) => ({
    key,
    label: LX_PLATFORM_LABELS[key] || cap?.name || key,
    searchable: (cap?.actions || []).some((a) => a === 'search' || a === 'musicSearch'),
    qualityCount: (cap?.qualitys || []).length,
  }))
}

/** 探测失败时的可读文案：脚本自报的错误优先，其余按通用加载失败呈现 */
export function lxProbeErrorText(inspection: LxSourceInspection): string {
  return `脚本加载失败：${inspection.error || '脚本未声明任何可用平台'}`
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
  inspection?: LxSourceInspection
}

/**
 * 拉脚本 + 探测能力：拉脚本 → 探测 → 收敛成界面状态。
 * 平台未实现该方法时给出可读提示，而不是把异常抛到界面上。
 *
 * `opts.inspection` 用于「同一次探测的结论要在两处渲染」的场景（如弹窗与卡片同时展示）：
 * 传了就复用那份结论、只刷新文案，不再拉一次脚本。当前 UI 调用点（LxSourceProbe）不传，
 * 因为它的探测结果本来就存在同一个组件的 state 里，复用没有意义——保留该入参是为了
 * 调用方将来抽公共探测状态时不必改签名。
 */
export async function runLxProbe(
  id: string,
  sourceUrl: string,
  headers?: Record<string, string>,
  opts?: { inspection?: LxSourceInspection | null; message?: string }
): Promise<LxProbeState> {
  if (typeof platform.fetchLxScript !== 'function') {
    return { loading: false, ok: false, message: '当前平台尚未实现洛雪脚本能力' }
  }
  const url = sourceUrl.trim()
  const linkError = checkLxScriptLink(url)
  if (linkError) return { loading: false, ok: false, message: linkError }
  try {
    const script = await platform.fetchLxScript(url)
    const inspection =
      opts && opts.inspection
        ? opts.inspection
        : await platform.inspectLxSource({
            id,
            name: '',
            kind: 'lx',
            sourceUrl: url,
            headers,
            enabled: true,
            script,
          })
    if (!inspection.ok) {
      return { loading: false, ok: false, message: lxProbeErrorText(inspection), inspection }
    }
    return { loading: false, ok: true, message: opts?.message || '脚本可用', inspection }
  } catch (err) {
    return { loading: false, ok: false, message: `脚本加载失败：${(err as Error)?.message || String(err)}` }
  }
}