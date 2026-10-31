/**
 * 清单签名（Ed25519）—— 防"下载链路被中间人替换"。
 *
 * ## 它防什么、不防什么（这条边界必须先说清）
 *
 * **防**：用户从 `https://example.com/plugin.json` 装插件时，若不是作者原始发布的那一份
 * （CDN 被投毒、托管被入侵、中间人替换），签名校验会失败并拒绝安装。
 *
 * **不防**：用户主动安装一个作者本身就写了恶意的插件。签名只证明"这份内容确实是
 * 某个持有私钥的人签的"，不证明"这个人值得信任"。
 *
 * 这与「内容哈希」是两层不同的保障：
 * - **哈希**证明"装进来之后它没被改过"（本机一致性）
 * - **签名**证明"下载到的东西确实是发布者签的那份"（传输链完整性）
 * 两者都要，缺一不可。
 *
 * ## 信任根（信任锚）怎么来
 *
 * 应用内置一份**可信公钥表**（`TRUSTED_PLUGIN_KEYS`）。当前为空数组：本应用没有
 * 官方插件仓库，也不打算扮演 CA。自建托管的人可以在这里加入自己的公钥
 * （改源码重新打包），或者在设置页导入公钥（后续能力，当前未做 UI）。
 *
 * 因此签名的语义是**分档**而不是一刀切：
 *
 * | 清单里的签名 | 公钥在信任表里 | 结论 |
 * |---|---|---|
 * | 无 | — | `unsigned`：允许安装，UI 标注「未签名」 |
 * | 有，校验通过 | 是 | `verified`：允许安装，标注「已签名（已验证）」 |
 * | 有，校验失败 | 是 | **拒绝安装**（内容被改过） |
 * | 有，公钥不在表里 | 否 | `unknown-key`：允许安装但标注「签名者未知」 |
 *
 * 为什么"公钥未知"不直接拒绝：那会让自建托管的人（没有内置公钥）完全无法安装
 * 自签插件。而"签名者未知"这个提示与"完全未签名"在用户看来是同一件事
 * —— 都不能证明来源可信。真正危险的是"签名存在但校验失败"，那必须拒绝。
 *
 * ## 算法与编码
 *
 * Ed25519，公钥与签名都是 32/64 字节的 **小写 hex**（不是 base64：hex 在 JSON 里
 * 更不容易因为转义或大小写规范化出问题，且长度固定易于校验）。
 */

import type { ManifestIssue } from './types'

/** 签名算法标识。将来换算法（如 Ed448 / ECDSA P-256）时用它区分 */
export const PLUGIN_SIGNATURE_ALGORITHM = 'ed25519' as const

/**
 * 应用内置的可信公钥表。
 *
 * **当前为空**：本应用没有官方插件仓库，也不打算扮演 CA。
 * 自建托管场景下把自己的公钥加进来（改源码重新打包），
 * 或在将来的设置页里动态导入（那种情况下这张表要变成可持久化的配置，
 * 并明确提示"你正在信任一个自己添加的签名者"）。
 */
export const TRUSTED_PLUGIN_KEYS: readonly { keyId: string; publicKey: string }[] = []

/** 清单里的签名块 */
export interface PluginSignature {
  /** 签名算法（当前只支持 ed25519） */
  algorithm: typeof PLUGIN_SIGNATURE_ALGORITHM
  /**
   * 公钥标识（作者自定的短名，如 `my-registry-2026`）。
   * 用途：让应用在**信任表**里查对应的公钥，而不是盲信清单里附带的公钥
   * —— 后者等于让签名自己证明自己（毫无意义）。
   */
  keyId: string
  /** Ed25519 签名的 hex（64 字节 = 128 个 hex 字符） */
  sig: string
}

/** 签名校验结论 */
export type SignatureVerdict =
  /** 清单没有签名块 */
  | { status: 'unsigned' }
  /** 签名有效且公钥在信任表里 */
  | { status: 'verified'; keyId: string }
  /** 有签名，但公钥不在信任表里（无法证明来源；允许安装但必须告知用户） */
  | { status: 'unknown-key'; keyId: string }
  /** 有签名但校验失败 —— **必须拒绝安装** */
  | { status: 'invalid'; keyId: string; reason: string }

/**
 * 待校验的字节：**清单原始字节去掉签名块之后**的规范化 JSON。
 *
 * ## 为什么不是"直接签原始文件字节"
 *
 * 签名块本身必须写在清单里（应用才能看到它），而它又要被签名覆盖 ——
 * 经典的鸡生蛋问题。三种解法里选了这个：
 *
 * 1. 签名单独一个文件（`plugin.json.sig`）—— 多一个文件，且"哪些文件算插件"变复杂
 * 2. 签名在清单里，签"除签名块外的规范化 JSON" —— **本方案**
 * 3. 签名在清单里，签"清单字节但把 sig 字段挖空" —— 与 2 等价，但字符串替换易错
 *
 * 规范化 = 深度排序键 + 紧凑序列化。为什么必须规范化：作者手写清单时空格/缩进/键序
 * 都可能变，而签名要对**语义**负责。代价是作者必须用我们的规范化规则生成签名 ——
 * 所以提供一个 `canonicalizeManifest()` 供签名工具使用（见下）。
 */
export function canonicalizeManifest(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

/** 递归按字典序排序对象的键；数组保序（顺序是语义的一部分） */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      out[key] = sortDeep(record[key])
    }
    return out
  }
  return value
}

/**
 * 取"用于签名的那份字节"：清单对象去掉 `signature` 字段后的规范化 JSON。
 *
 * 注意入参是**已解析的对象**而不是原始文本：签名的语义是"这份清单内容"，
 * 而不是"作者编辑器里保存的那些空格"。
 */
export function signableBytes(manifest: unknown): string {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return canonicalizeManifest(manifest)
  }
  const { signature: _omit, ...rest } = manifest as Record<string, unknown>
  return canonicalizeManifest(rest)
}

/** hex → 字节 */
export function hexToBytes(hex: string): Uint8Array | null {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** 字节 → 小写 hex */
export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * 校验一件签名。
 *
 * `verify` 由调用方注入（不在这里直接调 WebCrypto）：桌面端主进程用 `node:crypto`，
 * 渲染层用 `crypto.subtle`，而 Capacitor WebView 的 `crypto.subtle` 对 Ed25519 的
 * 支持随系统 WebView 版本变化 —— 注入让它"不支持"能被明确表达，而不是静默失败。
 */
export async function verifyManifestSignature(
  manifest: unknown,
  options: {
    trustedKeys?: readonly { keyId: string; publicKey: string }[]
    /** 注入的 Ed25519 验签实现：(签名, 公钥, 消息) → 是否有效 */
    verify: (sigHex: string, publicKeyHex: string, message: string) => Promise<boolean> | boolean
  }
): Promise<SignatureVerdict> {
  const signature = readSignature(manifest)
  if (!signature) return { status: 'unsigned' }

  const trusted = options.trustedKeys ?? TRUSTED_PLUGIN_KEYS
  const entry = trusted.find((item) => item.keyId === signature.keyId)
  if (!entry) {
    // 公钥不在信任表：不能证明来源。**不在这里拒绝** —— 拒绝会让自建托管（无内置公钥）
    // 完全装不了自签插件。UI 必须把这条标成"签名者未知"。
    return { status: 'unknown-key', keyId: signature.keyId }
  }

  let valid = false
  try {
    valid = await options.verify(signature.sig, entry.publicKey, signableBytes(manifest))
  } catch (err) {
    return {
      status: 'invalid',
      keyId: signature.keyId,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
  if (!valid) {
    // 签名存在、公钥可信、但校验不过 = 内容被动过。**必须拒绝**
    return { status: 'invalid', keyId: signature.keyId, reason: 'signature mismatch' }
  }
  return { status: 'verified', keyId: signature.keyId }
}

/** 从清单里读签名块；缺失或形状不对返回 null（形状问题由 validate 单独报） */
export function readSignature(manifest: unknown): PluginSignature | null {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null
  const raw = (manifest as Record<string, unknown>).signature
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const block = raw as Record<string, unknown>
  if (block.algorithm !== PLUGIN_SIGNATURE_ALGORITHM) return null
  if (typeof block.keyId !== 'string' || !block.keyId.trim()) return null
  if (typeof block.sig !== 'string') return null
  return { algorithm: PLUGIN_SIGNATURE_ALGORITHM, keyId: block.keyId.trim(), sig: block.sig }
}

/**
 * 校验签名块的**形状**（安装期 schema 校验的一部分）。
 *
 * 只查形状，不查有效性 —— 有效性需要公钥与异步验签，属于安装流程而不是 schema 校验。
 */
export function checkSignatureShape(log: { add: (path: string, code: ManifestIssue['code'], value?: unknown) => void }, path: string, value: unknown): void {
  if (value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    log.add(path, 'invalid-type', value)
    return
  }
  const block = value as Record<string, unknown>
  if (block.algorithm !== PLUGIN_SIGNATURE_ALGORITHM) {
    log.add(`${path}.algorithm`, 'invalid-type', block.algorithm)
  }
  if (typeof block.keyId !== 'string' || !block.keyId.trim()) {
    log.add(`${path}.keyId`, 'missing')
  }
  if (typeof block.sig !== 'string') {
    log.add(`${path}.sig`, 'invalid-type', block.sig)
  } else if (!/^[0-9a-f]{128}$/i.test(block.sig)) {
    // Ed25519 签名固定 64 字节 = 128 hex 字符。长度不对时明确报错，
    // 而不是等到验签失败才说"签名无效"（用户会以为是内容被动过）
    log.add(`${path}.sig`, 'invalid-type', block.sig)
  }
}

/**
 * 信任状态 → UI 用的徽章文案键（与 `sources.plugins.*` 字典对应）。
 *
 * 未签名 / 签名者未知 / 已验证 三档必须**都能被用户看到**：
 * 把"未签名"藏起来等于让用户以为所有插件都验过。
 */
export function signatureBadgeKey(verdict: SignatureVerdict): string {
  switch (verdict.status) {
    case 'verified':
      return 'sources.plugins.signature.verified'
    case 'invalid':
      return 'sources.plugins.signature.invalid'
    case 'unknown-key':
      return 'sources.plugins.signature.unknownKey'
    default:
      return 'sources.plugins.signature.unsigned'
  }
}
