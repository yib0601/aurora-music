/**
 * 可信公钥表（签名信任根）的**纯逻辑**。
 *
 * ## 为什么信任表必须可配置，而不是写死在源码里
 *
 * `signature.ts` 的 `TRUSTED_PLUGIN_KEYS` 是编译期常量（默认为空）。那意味着
 * **自建托管的人要信任自己的签名，必须改源码重新打包** —— 这等于宣告
 * 「签名功能只对能改代码的人可用」，而恰恰是自建托管者最需要它
 * （他们没有官方仓库，只有自己的公钥）。
 *
 * 所以信任表要做成**用户可管理**的持久化配置。本文件只放纯逻辑
 * （校验、归一、增删），落盘由两端的 I/O 层负责：
 * - 桌面：`packages/desktop/src/ipc/pluginTrust.ts`（`<userData>/aurora-music/plugin-trust.json`）
 * - 移动：`packages/app/src/services/platform/mobile/pluginTrust.ts`（`Directory.Data`）
 *
 * ## 一条必须守住的纪律：内置表与用户表**合并**，不是替换
 *
 * 内置表（`TRUSTED_PLUGIN_KEYS`）是"随应用发布的信任根"；用户表是"我自己加的"。
 * 若用用户表替换内置表，将来应用真的内置了官方公钥，用户加过一个自己的 key
 * 就会把官方的挤掉 —— 表现为"官方插件突然验不过"。所以两表**并集**，
 * 且用户表优先级更高（同 keyId 时以用户表为准：用户显式导入的意图更强）。
 */

import { TRUSTED_PLUGIN_KEYS } from './signature'

/** 一条可信公钥。`keyId` 是作者自定的短名，`publicKey` 是 32 字节 Ed25519 公钥的 hex */
export interface TrustedKey {
  keyId: string
  publicKey: string
  /** 用户给这条 key 写的备注（可空，用于"这是谁的公钥"） */
  note?: string
  /** 导入时间（毫秒时间戳）；内置 key 为 0 */
  addedAt?: number
}

/** 校验一条待导入的公钥 */
export type TrustedKeyValidation =
  | { ok: true; key: TrustedKey }
  | { ok: false; code: TrustedKeyIssueCode }

export type TrustedKeyIssueCode =
  /** keyId 为空或太长 */
  | 'bad-key-id'
  /** 公钥不是 64 位 hex（32 字节） */
  | 'bad-public-key'
  /** 备注太长 */
  | 'note-too-long'
  /** 已有同 keyId 的条目 */
  | 'duplicate'

/** keyId 允许的字符：与插件 id 同一套（小写字母开头，字母数字点下划线短横） */
const KEY_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** 备注长度上限：这是给人看的一行说明，不该被当成自由文本域 */
const MAX_NOTE_LENGTH = 120

/**
 * 校验并归一一条公钥。
 *
 * 公钥必须是 32 字节 hex（Ed25519 的 raw key）：长度不对时明确拒绝，
 * 而不是等到验签失败才说"签名无效" —— 那会让用户以为插件内容被动过。
 *
 * `existing` 用于查重：同 keyId 的条目已存在时返回 `duplicate`，
 * 由调用方决定是"拒绝导入"还是"覆盖"（UI 上应当是拒绝并要求先删除，
 * 因为静默覆盖意味着用户没意识到自己在替换信任根）。
 */
export function validateTrustedKey(
  input: { keyId?: unknown; publicKey?: unknown; note?: unknown },
  existing: readonly TrustedKey[] = []
): TrustedKeyValidation {
  const keyId = typeof input.keyId === 'string' ? input.keyId.trim() : ''
  if (!KEY_ID_RE.test(keyId)) return { ok: false, code: 'bad-key-id' }

  const publicKey = typeof input.publicKey === 'string' ? input.publicKey.trim().toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(publicKey)) return { ok: false, code: 'bad-public-key' }

  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (note.length > MAX_NOTE_LENGTH) return { ok: false, code: 'note-too-long' }

  if (existing.some((key) => key.keyId.toLowerCase() === keyId.toLowerCase())) {
    return { ok: false, code: 'duplicate' }
  }

  return {
    ok: true,
    key: {
      keyId,
      publicKey,
      ...(note ? { note } : {}),
      addedAt: Date.now(),
    },
  }
}

/**
 * 合并内置表与用户表。
 *
 * 顺序：**用户表在后**（同 keyId 时以用户表为准，见文件头注释）。
 * 返回的数组用于 `verifyManifestSignature` 的 `trustedKeys` 选项。
 */
export function mergeTrustedKeys(
  builtin: readonly TrustedKey[] = TRUSTED_PLUGIN_KEYS,
  user: readonly TrustedKey[] = []
): TrustedKey[] {
  const byId = new Map<string, TrustedKey>()
  // 内置先放（addedAt = 0 表示随应用发布）
  for (const key of builtin) {
    byId.set(key.keyId.toLowerCase(), { ...key, addedAt: key.addedAt ?? 0 })
  }
  // 用户表覆盖同 keyId 的条目
  for (const key of user) {
    byId.set(key.keyId.toLowerCase(), key)
  }
  return [...byId.values()]
}

/**
 * 从用户表里删一条。
 *
 * 内置 key **不可删**（它们随应用发布，删了只是让本次运行不信任它，
 * 重启后又会回来 —— 那种"删了又长回来"的体验比不给删更糟）。
 * 返回 `false` 表示没删成（不存在 / 是内置的）。
 */
export function removeTrustedKey(
  user: readonly TrustedKey[],
  keyId: string,
  builtin: readonly TrustedKey[] = TRUSTED_PLUGIN_KEYS
): { removed: boolean; keys: TrustedKey[] } {
  const id = String(keyId || '').toLowerCase()
  if (!id) return { removed: false, keys: [...user] }
  if (builtin.some((key) => key.keyId.toLowerCase() === id)) {
    // 内置 key 不在这里删
    return { removed: false, keys: [...user] }
  }
  const next = user.filter((key) => key.keyId.toLowerCase() !== id)
  return { removed: next.length !== user.length, keys: next }
}

/**
 * 解析落盘的用户表（容错：坏条目跳过，不让一个坏条目让整张表失效）。
 *
 * 为什么容错而不是整体拒绝：信任表是**安全关键**数据，但"一条坏了就全丢"
 * 会让用户的所有已验签插件突然变成"签名者未知"。逐条跳过更合理，
 * 且坏条目会被静默丢弃 —— 它们本来就无法参与验签。
 */
export function parseTrustedKeys(raw: unknown): TrustedKey[] {
  if (!Array.isArray(raw)) return []
  const out: TrustedKey[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const keyId = typeof record.keyId === 'string' ? record.keyId.trim() : ''
    const publicKey = typeof record.publicKey === 'string' ? record.publicKey.trim().toLowerCase() : ''
    if (!KEY_ID_RE.test(keyId) || !/^[0-9a-f]{64}$/.test(publicKey)) continue
    const id = keyId.toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      keyId,
      publicKey,
      ...(typeof record.note === 'string' && record.note.trim()
        ? { note: record.note.trim().slice(0, MAX_NOTE_LENGTH) }
        : {}),
      addedAt: typeof record.addedAt === 'number' ? record.addedAt : 0,
    })
  }
  return out
}

/** 序列化用户表（落盘形状稳定：只存契约字段，便于人工检查与备份） */
export function serializeTrustedKeys(keys: readonly TrustedKey[]): string {
  return JSON.stringify(
    keys.map((key) => ({
      keyId: key.keyId,
      publicKey: key.publicKey,
      ...(key.note ? { note: key.note } : {}),
      addedAt: key.addedAt ?? 0,
    })),
    null,
    2
  )
}
