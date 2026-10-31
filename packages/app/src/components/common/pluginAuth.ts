/**
 * 插件登录面板的纯逻辑（可单测）。
 *
 * 职责边界：
 * - 本文件：登录态查询、凭证提交、错误文案渲染——全部**不碰 JSX**；
 * - `PluginAuthPanel.tsx`：只负责渲染。
 *
 * 为什么单独拆：`SettingsPage.tsx` 已经 2500 行，而登录是「输入 → 校验 → 落盘 → 回显」
 * 的四步状态机，塞进页面组件就只能靠手点验证。拆出来才能被单测覆盖。
 *
 * ## 凭证纪律
 *
 * 渲染层**只提交用户输入的明文、只拿回状态**：`login()` 之后立刻丢弃输入框内容，
 * 不去读回任何凭证。跨进程接口本身就不回传凭证原文（见 desktop 的 pluginHost）。
 */

import type { AuroraError, PluginAuthState, SourceProbeResult } from '@aurora/shared'
import { translateError } from '@aurora/shared'
import { platform } from '@/services/platform'
import type { PluginMetaInfo } from '@/services/platform'
import { appTranslate } from '@/i18n'

/** 面板状态：与 UI 一一对应 */
export interface AuthPanelState {
  /** 是否正在查询登录态 */
  loading: boolean
  /** 是否正在提交凭证 */
  submitting: boolean
  /** 当前登录态（未查询为 null） */
  auth: PluginAuthState | null
  /** 提交结果的展示文案（成功 / 失败），已按当前语言渲染 */
  message?: string
  /** 提交是否成功（决定文案配色） */
  ok?: boolean
}

export const initialAuthPanelState: AuthPanelState = {
  loading: false,
  submitting: false,
  auth: null,
}

/** 当前端是否具备插件能力（浏览器端没有：需要主进程网络栈与凭证存储） */
export function pluginLayerAvailable(): boolean {
  return typeof platform.plugins?.list === 'function'
}

/** 列出插件元信息；能力缺失时返回空数组（UI 显示空态，不抛错） */
export async function loadPluginMeta(): Promise<PluginMetaInfo[]> {
  if (!pluginLayerAvailable()) return []
  try {
    return await platform.plugins!.list()
  } catch (err) {
    console.warn('[插件] 读取插件列表失败:', err)
    return []
  }
}

/**
 * 需要登录的插件（有 `auth` 能力）。
 *
 * 判定按能力而不是按 id：将来任何插件声明了 auth 都自动出现在登录区，
 * 无需改本文件。
 */
export function pluginsNeedingAuth(metas: readonly PluginMetaInfo[]): PluginMetaInfo[] {
  return metas.filter((m) => Array.isArray(m.capabilities) && m.capabilities.includes('auth'))
}

/** 查询登录态 */
export async function refreshAuthState(pluginId: string): Promise<PluginAuthState | null> {
  if (!pluginLayerAvailable()) return null
  try {
    return await platform.plugins!.authState(pluginId)
  } catch (err) {
    console.warn('[插件] 查询登录态失败:', pluginId, err)
    return null
  }
}

/**
 * 提交凭证。
 *
 * `raw` 是用户粘贴的原文（完整 Cookie 或裸 sessionid），解析在主进程完成——
 * 渲染层不参与解析，也就不需要知道任何平台私有字段格式。
 */
export async function submitCredential(
  pluginId: string,
  raw: string
): Promise<{ ok: boolean; message: string }> {
  if (!pluginLayerAvailable()) {
    return { ok: false, message: appTranslate()('sources.auth.unsupportedEnv') }
  }
  const text = String(raw || '').trim()
  if (!text) {
    return { ok: false, message: appTranslate()('sources.auth.emptyInput') }
  }
  try {
    await platform.plugins!.login(pluginId, text)
    return { ok: true, message: appTranslate()('sources.auth.saved') }
  } catch (err) {
    // 结构化错误按当前语言渲染；其余自由文本原样透出（不吞技术细节）
    return { ok: false, message: renderAuthError(err) }
  }
}

/** 退出登录 */
export async function logoutPlugin(pluginId: string): Promise<{ ok: boolean; message: string }> {
  if (!pluginLayerAvailable()) {
    return { ok: false, message: appTranslate()('sources.auth.unsupportedEnv') }
  }
  try {
    await platform.plugins!.logout(pluginId)
    return { ok: true, message: appTranslate()('sources.auth.loggedOut') }
  } catch (err) {
    return { ok: false, message: renderAuthError(err) }
  }
}

/**
 * 错误 → 可读文案。
 *
 * `translateError` 能识别结构化信封（`AURORA_ERR:{...}`）；自由文本原样返回。
 * 与 `lxSourceForm.renderError` 同一套口径。
 */
export function renderAuthError(err: unknown): string {
  const t = appTranslate()
  const e = err as AuroraError
  if (e && typeof e === 'object' && 'code' in e) return translateError(e, t)
  const text = err instanceof Error ? err.message : String(err ?? '')
  if (text.startsWith('AURORA_ERR:')) return translateError(text, t)
  return text || t('sources.auth.failed')
}

/**
 * 登录态的一句话描述（供 UI 直接渲染）。
 *
 * 注意 `valid === undefined` 表示**未校验**（离线 / 插件不做校验），
 * 这种情况必须显示「已保存」而不是「已失效」——把未校验当失效会误导用户重新登录。
 */
export function authStateText(auth: PluginAuthState | null): string {
  const t = appTranslate()
  if (!auth || !auth.loggedIn) return t('sources.auth.notLoggedIn')
  if (auth.valid === false) return t('sources.auth.expired')
  if (auth.accountName) return t('sources.auth.loggedInAs', { name: auth.accountName })
  return t('sources.auth.loggedIn')
}

/** 登录态徽章配色（已登录 / 失效 / 未登录） */
export function authStateTone(auth: PluginAuthState | null): 'ok' | 'warn' | 'idle' {
  if (!auth || !auth.loggedIn) return 'idle'
  return auth.valid === false ? 'warn' : 'ok'
}

/** 探测结果的诊断文案（插件「测试」按钮用） */
export function renderProbeResult(result: SourceProbeResult | null): string {
  if (!result) return ''
  const t = appTranslate()
  const raw = result.ok ? result.message : result.error || result.message
  if (!raw) return ''
  if (raw.startsWith('AURORA_ERR:')) return translateError(raw, t)
  return raw
}
