/**
 * 歌单同步配置的凭据（主进程）。
 *
 * ## 为什么复用 `pluginCredentials`
 *
 * 与 `storageCredentials.ts` 同一套理由：`safeStorage` 加密、0600 权限、临时文件 +
 * rename 的原子落盘、「加密不可用就拒绝写明文」都已经在 `pluginCredentials.ts` 里
 * 做对了，这里只换**键的语义**——按同步配置 id（`sync-1759...-ab12cd`）存，
 * 不按插件 id 存（一个 `webdav-sync` 插件可能有多条配置）。
 *
 * 落盘位置因此与存储来源共用 `<userData>/aurora-music/plugin-credentials/`，
 * 文件名校验正则也共用（同步配置 id 由 `packages/app` 用同一套规则生成）。
 *
 * ## 与存储来源的一处刻意差异：`get` 会把明文交回渲染层
 *
 * 存储来源的口令只在本机主进程用（`withStorageSecrets`），永远不出主进程。
 * 歌单同步的插件装配在渲染层（插件实例与配置都在那边），主进程只提供「安全存放 +
 * 局域网桥」，所以 `sync:credential:get` 必须把口令交回去——否则插件拿不到
 * WebDAV 密码。**这是契约 §15.3 明确要求的**，不是遗漏。
 *
 * ## 加密不可用时
 *
 * `save` 返回 `{ saved:false, encryptionAvailable:false }` 而不是抛错：
 * 同步配置的保存是「先存配置、再存凭据」的普通表单流程，UI 需要拿到一个可展示的
 * 状态（提示「本机无法安全保存口令」），而不是一个异常。
 */

import { auroraError } from '@aurora/shared'
import type { SyncSecrets } from '@aurora/shared'
import {
  savePluginCredential,
  readPluginCredential,
  hasPluginCredential,
  clearPluginCredential,
  isCredentialEncryptionAvailable,
} from './pluginCredentials'

/** 凭据载荷：键与 `SyncFieldDef.key`（`kind:'password'` 的那些）一一对应 */
export type SyncSecretPayload = Record<string, string>

/** 给渲染层的**不含内容**的状态 */
export interface SyncCredentialState {
  saved: boolean
  encryptionAvailable: boolean
}

/** 与 pluginCredentials 的文件名校验同源：id 来自渲染层，按不可信处理 */
const CONFIG_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i

function assertConfigId(configId: string): void {
  if (typeof configId !== 'string' || !CONFIG_ID_PATTERN.test(configId)) {
    throw auroraError('desktop.error.plugin.invalidId', { id: String(configId ?? '') })
  }
}

/** 只保留非空字符串值，避免把垃圾写进密文 */
function sanitize(payload: unknown): SyncSecretPayload {
  if (!payload || typeof payload !== 'object') return {}
  const out: SyncSecretPayload = {}
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value === 'string' && value) out[key] = value
  }
  return out
}

export function isSyncCredentialEncryptionAvailable(): boolean {
  return isCredentialEncryptionAvailable()
}

/**
 * 保存一条同步配置的口令。
 *
 * 空载荷 = 清除（用户在表单里把口令清空）。加密不可用时**不落盘**，
 * 返回 `saved:false`。
 */
export function saveSyncCredential(configId: string, payload: unknown): SyncCredentialState {
  assertConfigId(configId)
  const clean = sanitize(payload)
  const encryptionAvailable = isSyncCredentialEncryptionAvailable()

  if (Object.keys(clean).length === 0) {
    clearPluginCredential(configId)
    return { saved: false, encryptionAvailable }
  }

  if (!encryptionAvailable) {
    // 拒绝降级写明文：宁可让用户知道「这台机器存不了口令」
    return { saved: false, encryptionAvailable: false }
  }

  savePluginCredential(configId, clean)
  return { saved: true, encryptionAvailable: true }
}

/**
 * 读取口令原文（供 `sync:credential:get` 交给渲染层；**不要写进日志**）。
 * 未保存 / 解密失败返回 null。
 */
export function readSyncCredential(configId: string): SyncSecrets | null {
  if (typeof configId !== 'string' || !configId) return null
  const raw = readPluginCredential(configId)
  if (!raw) return null
  const clean = sanitize(raw)
  return Object.keys(clean).length > 0 ? clean : null
}

/** 该配置是否保存过口令（只看文件在不在，不解密） */
export function hasSyncCredential(configId: string): boolean {
  if (typeof configId !== 'string' || !configId) return false
  return hasPluginCredential(configId)
}

/** 清除口令（删除配置 / 用户清空口令）。文件不存在视作成功。 */
export function clearSyncCredential(configId: string): void {
  if (typeof configId !== 'string' || !configId) return
  clearPluginCredential(configId)
}

/** 状态查询：给 UI 的「已保存 / 本机能否安全保存」 */
export function syncCredentialState(configId: string): SyncCredentialState {
  return {
    saved: hasSyncCredential(configId),
    encryptionAvailable: isSyncCredentialEncryptionAvailable(),
  }
}
