/**
 * 存储来源的凭证（主进程）。
 *
 * ## 为什么复用 `pluginCredentials` 而不是另写一套
 *
 * `pluginCredentials.ts` 已经解决了三件难做对的事：`safeStorage` 加密、0600 权限、
 * 先写临时文件再 rename 的原子落盘，以及「加密不可用就拒绝写明文」。
 * 这里只是换一个**键的语义**，安全实现一律转调，不复制。
 *
 * ## 两个与音源插件不同的地方
 *
 * 1. **凭证按来源 id 存，不按插件 id 存。**
 *    用户可能添加三台 NAS，它们的 `pluginId` 都是 `'webdav'`——按插件 id 存会让
 *    后加的覆盖先加的，表现为「改了一台的密码，另一台也变了」。
 *    来源 id 形如 `lib-1759...-ab12cd`，恰好满足 `pluginCredentials` 的文件名校验
 *    （`^[a-z0-9][a-z0-9._-]{0,63}$`，大小写不敏感），因此可直接借用它的落盘布局。
 *
 * 2. **口令要在调用插件前「注入」回配置。**
 *    插件通过声明式字段 `password` 读口令（`storageFieldValue(cfg, 'password')`），
 *    但口令不在渲染层、也不在持久化里。所以每次调插件前用 `withStorageSecrets()`
 *    把解密后的口令并进 `cfg.settings`——**只在主进程内存里存在一瞬间**，
 *    既不回渲染层，也不进数据库。
 *
 * ## 边界（与 pluginCredentials 保持一致）
 *
 * - 渲染层只能问「有没有」「成没成」，**永远拿不到口令原文**；
 * - 加密不可用时 `save` 明确失败（不静默降级写明文），由 UI 提示用户。
 */

import { auroraError } from '@aurora/shared'
import type { LibrarySourceConfig } from '@aurora/shared'
import {
  savePluginCredential,
  readPluginCredential,
  hasPluginCredential,
  clearPluginCredential,
  isCredentialEncryptionAvailable,
} from './pluginCredentials'

/**
 * 凭证载荷：键与插件的 `fields` 里 `kind: 'password'` 的字段一一对应。
 *
 * 故意用 `Record<string, string>` 而不是 `{ password: string }`：
 * 将来某个协议要两个秘密（如 token + secret），这里不必再改签名。
 */
export type StorageSecretPayload = Record<string, string>

/** 只保留字符串值：非字符串（数字 / 对象 / undefined）一律丢弃，避免把垃圾写进密文 */
function sanitize(payload: unknown): StorageSecretPayload {
  if (!payload || typeof payload !== 'object') return {}
  const out: StorageSecretPayload = {}
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value === 'string' && value) out[key] = value
  }
  return out
}

/**
 * 保存某个来源的口令。
 *
 * 传空载荷等于「清掉口令」：用户在表单里把口令清空时走这条路，
 * 否则旧口令会一直留着，表现为「删了口令却还能连上」。
 */
export function saveStorageCredential(sourceId: string, payload: unknown): void {
  if (typeof sourceId !== 'string' || !sourceId) {
    throw auroraError('desktop.error.source.invalid')
  }
  const clean = sanitize(payload)
  // 空对象不能写：pluginCredentials 会拒绝非对象载荷，而「空对象」语义上应等于清除
  if (Object.keys(clean).length === 0) {
    clearPluginCredential(sourceId)
    return
  }
  savePluginCredential(sourceId, clean)
}

/** 该来源是否存了口令（只看文件在不在，不解密——UI 状态查询在高频路径上） */
export function hasStorageCredential(sourceId: string): boolean {
  if (typeof sourceId !== 'string' || !sourceId) return false
  return hasPluginCredential(sourceId)
}

/** 清除口令（删除来源 / 用户清空口令时调用）。文件不存在视作成功。 */
export function clearStorageCredential(sourceId: string): void {
  if (typeof sourceId !== 'string' || !sourceId) return
  clearPluginCredential(sourceId)
}

/** 读取口令原文（**仅供主进程内部**，绝不经 IPC 回渲染层） */
function readStorageCredential(sourceId: string): StorageSecretPayload {
  if (typeof sourceId !== 'string' || !sourceId) return {}
  const raw = readPluginCredential(sourceId)
  return raw ? sanitize(raw) : {}
}

/**
 * 把解密后的口令并进配置副本，供插件调用。
 *
 * 返回的是**浅拷贝**：`settings` 被替换成新对象，原 cfg（主进程 registry 里那份）
 * 不被污染——否则口令会随着 registry 里那份配置长期驻留内存，
 * 也容易在某次「顺手打印 cfg」时泄进日志。
 *
 * 口令缺失时原样返回 `settings`（不塞空串）：空串会让插件把「没配口令」
 * 与「配了空口令」混为一谈，前者应回落到匿名访问。
 */
export function withStorageSecrets(cfg: LibrarySourceConfig): LibrarySourceConfig {
  const secrets = readStorageCredential(cfg.id)
  if (Object.keys(secrets).length === 0) return cfg
  return { ...cfg, settings: { ...(cfg.settings || {}), ...secrets } }
}

/** 加密能力是否可用（UI 据此提示「本机无法安全保存口令」而不是反复失败） */
export function isStorageCredentialEncryptionAvailable(): boolean {
  return isCredentialEncryptionAvailable()
}

/** 凭证状态：给渲染层的**不含内容**的状态查询结果 */
export interface StorageCredentialState {
  /** 是否已保存口令 */
  saved: boolean
  /** 本机是否具备加密能力；为 false 时 UI 应提示无法保存（而不是让用户反复重试） */
  encryptionAvailable: boolean
}

export function storageCredentialState(sourceId: string): StorageCredentialState {
  return {
    saved: hasStorageCredential(sourceId),
    encryptionAvailable: isStorageCredentialEncryptionAvailable(),
  }
}
