/**
 * 信任表管理的纯逻辑（可单测，不含 JSX）。
 *
 * 与 `pluginManage.ts` 同一分工：本文件负责"读 / 导入 / 删除 + 把失败原因翻成人话"，
 * `PluginTrustPanel.tsx` 只负责渲染。
 *
 * ## 为什么必须把失败原因说清
 *
 * 用户导入公钥时手上只有从他处抄来的一串字符。若是"导入失败"四个字，他唯一能做的
 * 就是反复试。所以每个失败码都必须指向**具体怎么改**：
 * 标识格式不对 / 公钥不是 64 hex / 备注太长 / 已存在同标识。
 */

import type { MessageKey, TrustedKey } from '@aurora/shared'
import { platform, type PluginTrustSnapshot, type TrustedKeyInfo } from '@/services/platform'
import { appTranslate } from '@/i18n'
import { renderErrorMessage } from '@/lib/utils'

/** 本端是否支持管理信任表（老 preload / 移动端 / Web 都没有） */
export function trustManagementAvailable(): boolean {
  const gateway = platform.plugins
  return typeof gateway?.trustList === 'function'
}

/** 空信任表（能力缺失时用，UI 据此显示"当前环境不支持"而不是"一条都没有"） */
const EMPTY_TRUST: PluginTrustSnapshot = { builtin: [], user: [], effective: 0 }

/**
 * 读信任表。
 *
 * 失败返回空表而不是抛错：插件页是设置里的一个分区，读失败不该让整页白屏。
 * `trustManagementAvailable()` 与这里的返回分开，UI 才能区分
 * "读失败/无能力" 与 "真的没导入过任何公钥"。
 */
export async function loadTrustTable(): Promise<PluginTrustSnapshot> {
  const gateway = platform.plugins
  if (typeof gateway?.trustList !== 'function') return EMPTY_TRUST
  try {
    return await gateway.trustList()
  } catch (err) {
    console.warn('[插件] 读取信任表失败:', err)
    return EMPTY_TRUST
  }
}

/** 导入结果（已渲染成可上屏的文案） */
export interface TrustAddOutcome {
  ok: boolean
  /** 成功时的 keyId */
  keyId?: string
  message?: string
}

/**
 * 失败码 → 文案键。
 *
 * 键与 shared 的 `TrustedKeyIssueCode` **一一对应**：那边加一个新的 code，
 * 这里必须同步加一条（`Record<TrustedKeyIssueCode, MessageKey>` 让漏加变成编译错误）。
 */
const TRUST_ERROR_KEYS: Record<string, MessageKey> = {
  'bad-key-id': 'sources.plugins.trust.error.badKeyId',
  'bad-public-key': 'sources.plugins.trust.error.badPublicKey',
  'note-too-long': 'sources.plugins.trust.error.noteTooLong',
  duplicate: 'sources.plugins.trust.error.duplicate',
  'not-found-or-builtin': 'sources.plugins.trust.error.notFoundOrBuiltin',
}

/** 把一个失败码翻成当前语言的一句话；未知码原样透出（不吞技术细节） */
export function describeTrustError(code: string | undefined): string {
  const t = appTranslate()
  if (!code) return t('sources.plugins.trust.error.unsupportedEnv')
  const key = TRUST_ERROR_KEYS[code]
  return key ? t(key) : code
}

/** 导入一条公钥 */
export async function addTrustedKey(input: {
  keyId: string
  publicKey: string
  note?: string
}): Promise<TrustAddOutcome> {
  const t = appTranslate()
  const gateway = platform.plugins
  if (typeof gateway?.trustAdd !== 'function') {
    return { ok: false, message: t('sources.plugins.trust.error.unsupportedEnv') }
  }
  const keyId = String(input.keyId || '').trim()
  const publicKey = String(input.publicKey || '').trim()
  if (!keyId || !publicKey) {
    // 空输入在本地就挡掉：不必往返主进程
    return {
      ok: false,
      message: describeTrustError(!keyId ? 'bad-key-id' : 'bad-public-key'),
    }
  }
  try {
    const result = await gateway.trustAdd({ keyId, publicKey, ...(input.note?.trim() ? { note: input.note.trim() } : {}) })
    if (!result?.ok) return { ok: false, message: describeTrustError(result?.code) }
    return { ok: true, keyId, message: t('sources.plugins.trust.added', { keyId }) }
  } catch (err) {
    return { ok: false, message: renderErrorMessage(err) }
  }
}

/** 删除一条用户导入的公钥 */
export async function removeTrustedKey(keyId: string): Promise<TrustAddOutcome> {
  const t = appTranslate()
  const gateway = platform.plugins
  if (typeof gateway?.trustRemove !== 'function') {
    return { ok: false, message: t('sources.plugins.trust.error.unsupportedEnv') }
  }
  try {
    const result = await gateway.trustRemove(keyId)
    if (!result?.ok) return { ok: false, message: describeTrustError(result?.code) }
    return { ok: true, keyId, message: t('sources.plugins.trust.removed', { keyId }) }
  } catch (err) {
    return { ok: false, message: renderErrorMessage(err) }
  }
}

/**
 * 公钥的展示形式：前 8 + 后 8，中间省略。
 *
 * 为什么截断：Ed25519 公钥是 64 个 hex 字符，整串铺在界面上既占地方又不像"一个名字"。
 * 前后各留 8 位足以让用户核对"这是我抄的那串"，同时保留复制完整值的入口。
 */
export function shortKeyOf(publicKey: string): string {
  const text = String(publicKey || '')
  if (text.length <= 20) return text
  return `${text.slice(0, 8)}…${text.slice(-8)}`
}

/** 条目分类：一条 key 是内置还是用户导入的（决定能否删除） */
export function keyCategoryOf(
  key: TrustedKeyInfo,
  snapshot: PluginTrustSnapshot
): 'builtin' | 'user' {
  return snapshot.user.some((item) => item.keyId === key.keyId) ? 'user' : 'builtin'
}

/** 供 UI 判断"能不能删"：内置的不可删（删了重启又会回来，那种体验更糟） */
export function canRemoveKey(key: TrustedKeyInfo, snapshot: PluginTrustSnapshot): boolean {
  return keyCategoryOf(key, snapshot) === 'user'
}

export type { TrustedKey }
