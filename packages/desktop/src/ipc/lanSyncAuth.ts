/**
 * 局域网同步的鉴权原语（主进程，只用 `node:crypto`）。
 *
 * ## 为什么没有「长期配对密钥」
 *
 * 配对码本身就是唯一凭据（见 `docs/playlist-sync.md` §7）：每次请求按当前配对码
 * 现派生 HMAC key，轮换配对码 = 旧凭据立刻失效，不需要密钥协商、也不需要在磁盘上
 * 额外保存一份长期密钥。代价是每次同步都要把配对码从配置里读出来——它本来就在。
 *
 * ## 签名覆盖什么
 *
 * `HMAC-SHA256(key, `${method}\n${path}\n${ts}\n${nonce}\n${sha256hex(body)}`)`。
 * 五个头字段里**只有后四个参与签名**，`x-aurora-device` 仅用于对端日志/展示，
 * 不承担任何安全语义（改它不会让签名失效，但也换不来任何权限）。
 *
 * 请求头：
 * - `x-aurora-device` 发送方 deviceId（不参与签名）
 * - `x-aurora-proto`  协议版本，与快照格式版本分开演进
 * - `x-aurora-ts`     毫秒时间戳，|now - ts| <= 5 分钟
 * - `x-aurora-nonce`  一次性随机串（16 字节 hex），5 分钟内不得重复
 * - `x-aurora-sig`    上面那条 HMAC 的 hex
 *
 * ## 时钟与重放
 *
 * 局域网里的两台机器时间可能差几分钟，所以给 5 分钟窗口；窗口内的重放靠 nonce
 * 去重表挡住（进程级 Map，TTL 5 分钟、容量上限 4096，超出按插入顺序淘汰最旧的）。
 * 表只记录**签名验证通过**的 nonce——否则任何人都能拿随便构造的请求把表灌满，
 * 把合法请求挤成「重放」。
 */

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { SYNC_LAN_PROTOCOL_VERSION } from '@aurora/shared'

/** 配对码字母表：Crockford base32 去掉 0/1/I/O/U（抄写时不会看混） */
export const PAIR_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

/** 配对码长度：10 位 ≈ 49.5 bit，暴力猜的代价足够高，又短到能抄 */
export const PAIR_CODE_LENGTH = 10

/** 派生 key 的域分隔串：同一个配对码在别的用途上不会得到同一把 key */
export const LAN_KEY_CONTEXT = 'aurora-lan-sync/v1'

/** 允许的时钟偏差（毫秒） */
export const LAN_MAX_CLOCK_SKEW_MS = 300_000

/** nonce 保留时长（毫秒）：与时钟窗口同宽，窗口外的请求先被判 stale，不必再留 */
export const LAN_NONCE_TTL_MS = 300_000

/** nonce 去重表容量上限：超出按插入顺序淘汰最旧的，防止被灌爆内存 */
export const LAN_NONCE_MAX_ENTRIES = 4096

/** 协议头字段名。全小写——HTTP 头大小写不敏感，内部统一小写便于比较 */
export const LAN_HEADERS = {
  device: 'x-aurora-device',
  proto: 'x-aurora-proto',
  ts: 'x-aurora-ts',
  nonce: 'x-aurora-nonce',
  sig: 'x-aurora-sig',
} as const

/** 生成一个 10 位配对码（Crockford base32，`randomInt` 均匀取字符） */
export function generatePairCode(): string {
  let code = ''
  for (let i = 0; i < PAIR_CODE_LENGTH; i += 1) {
    code += PAIR_CODE_ALPHABET[randomInt(0, PAIR_CODE_ALPHABET.length)]
  }
  return code
}

/**
 * 归一化用户抄来的配对码：去掉空格与连字符、转大写，再校验字母表与长度。
 *
 * 非法输入返回 `null`（调用方据此报「配对码不对」，而不是拿一个坏 key 去发请求）。
 * 用户抄成 `2345 6789 ab` / `2345-6789-AB` 都要能认。
 */
export function normalizePairCode(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const compact = input.replace(/[\s-]+/g, '').toUpperCase()
  if (compact.length !== PAIR_CODE_LENGTH) return null
  for (const char of compact) {
    if (!PAIR_CODE_ALPHABET.includes(char)) return null
  }
  return compact
}

/**
 * 按配对码派生本次请求用的 HMAC key。
 *
 * 输入先归一化再派生：对端传 `2345-6789-AB` 还是 `23456789AB` 必须得到同一把 key。
 * 归一化失败时退回原始串（例如调用方直接拿任意口令当 code），此时两端只要写法
 * 完全一致仍能互通；安全边界由调用方校验码格式保证。
 */
export function deriveKey(code: string): Buffer {
  const normalized = normalizePairCode(code)
  return createHmac('sha256', normalized ?? code).update(LAN_KEY_CONTEXT).digest()
}

/** 生成请求 nonce（16 字节随机 hex，32 字符） */
export function createNonce(): string {
  return randomBytes(16).toString('hex')
}

function sha256Hex(body: string | Buffer | undefined): string {
  return createHash('sha256').update(body ?? '').digest('hex')
}

/** 签名需要的请求部件 */
export interface LanSignParts {
  readonly method: string
  /** 参与签名的路径：不含 query，两端都按 URL 的 pathname 取 */
  readonly path: string
  readonly ts: number
  readonly nonce: string
  /** 请求体原文（GET 无 body 传 undefined / 空串均可） */
  readonly body?: string | Buffer
  /** 发送方 deviceId，写进 `x-aurora-device`，不参与签名 */
  readonly deviceId?: string
  /** 协议版本，默认 `SYNC_LAN_PROTOCOL_VERSION` */
  readonly proto?: number
}

/**
 * 计算请求签名。
 *
 * 单独导出是为了让「公式本身」可被测试逐字核对；正常情况下用 `signRequest`。
 */
export function requestSignature(key: Buffer, parts: LanSignParts): string {
  const payload = [
    parts.method,
    parts.path,
    String(parts.ts),
    parts.nonce,
    sha256Hex(parts.body),
  ].join('\n')
  return createHmac('sha256', key).update(payload).digest('hex')
}

/** 生成一整套签名请求头（键名见 `LAN_HEADERS`） */
export function signRequest(key: Buffer, parts: LanSignParts): Record<string, string> {
  return {
    [LAN_HEADERS.device]: parts.deviceId ?? '',
    [LAN_HEADERS.proto]: String(parts.proto ?? SYNC_LAN_PROTOCOL_VERSION),
    [LAN_HEADERS.ts]: String(parts.ts),
    [LAN_HEADERS.nonce]: parts.nonce,
    [LAN_HEADERS.sig]: requestSignature(key, parts),
  }
}

/** 验签结果：失败时 `reason` 是机器可读分类，供上层映射 401/400 */
export type LanVerifyFailureReason = 'auth' | 'protocol' | 'stale' | 'replay'

export type LanVerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: LanVerifyFailureReason }

/** 收到的 HTTP 请求里验签需要的部分 */
export interface LanIncomingRequest {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string | string[] | undefined>
  readonly body?: string | Buffer
  /** 校验基准时间（默认 `Date.now()`；测试注入固定时钟） */
  readonly now?: number
}

/** nonce 去重表 */
export interface LanNonceStore {
  /** 该 nonce 是否已在 TTL 内出现过 */
  has(nonce: string, now: number): boolean
  /** 记住一个 nonce（调用方只在签名验证通过后调用） */
  remember(nonce: string, now: number): void
  /** 当前保留的 nonce 数（测试用） */
  readonly size: number
}

export interface LanNonceStoreOptions {
  ttlMs?: number
  maxEntries?: number
}

/**
 * 创建 nonce 去重表。
 *
 * 模块级默认表由 `verifyRequest` 使用；测试注入独立实例即可互不干扰。
 */
export function createNonceStore(options: LanNonceStoreOptions = {}): LanNonceStore {
  const ttlMs = options.ttlMs ?? LAN_NONCE_TTL_MS
  const maxEntries = options.maxEntries ?? LAN_NONCE_MAX_ENTRIES
  // 插入顺序即「大致」过期顺序；Map 不保证按值有序，所以清理时全量扫（上限 4096，很便宜）
  const seen = new Map<string, number>()

  const prune = (now: number): void => {
    for (const [nonce, expiresAt] of seen) {
      if (expiresAt <= now) seen.delete(nonce)
    }
  }

  return {
    get size() {
      return seen.size
    },
    has(nonce, now) {
      const expiresAt = seen.get(nonce)
      if (expiresAt === undefined) return false
      if (expiresAt <= now) {
        seen.delete(nonce)
        return false
      }
      return true
    },
    remember(nonce, now) {
      prune(now)
      if (seen.size >= maxEntries) {
        const oldest = seen.keys().next()
        if (!oldest.done) seen.delete(oldest.value)
      }
      seen.set(nonce, now + ttlMs)
    },
  }
}

/** 进程级默认 nonce 表（同进程的服务器与客户端共用一册没有意义，但验证只发生在服务器） */
const defaultNonceStore = createNonceStore()

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name]
  if (Array.isArray(raw)) return raw[0] ?? null
  return typeof raw === 'string' ? raw : null
}

/** 定长比较：长度不同直接失败，长度相同走 `timingSafeEqual` */
function signatureEquals(expectedHex: string, providedHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex')
  const provided = Buffer.from(providedHex.toLowerCase(), 'hex')
  if (expected.length !== provided.length) return false
  return timingSafeEqual(expected, provided)
}

/**
 * 校验一条请求。
 *
 * 判定顺序（对端只会看到第一个失败原因）：
 * 1. 协议头缺失 / 不是本版本 → `protocol`（结构化请求错误，服务器回 401 { code:'protocol' }）
 * 2. 时间戳缺失 / 非法 / 偏差超过 5 分钟 → `protocol` / `stale`
 * 3. 签名缺失 → `protocol`；签名不匹配 → `auth`
 * 4. nonce 在 TTL 内出现过 → `replay`（**只在签名通过后**才查/记，避免被伪造请求灌表）
 *
 * 注意：时间戳是**明文**的，攻击者可以随便改，所以 stale 的判定不构成信息泄露；
 * 但它同时意味着「伪造请求可以以 stale 收尾」，这对攻击者毫无价值。
 */
export function verifyRequest(
  key: Buffer,
  request: LanIncomingRequest,
  store: LanNonceStore = defaultNonceStore,
): LanVerifyResult {
  const now = request.now ?? Date.now()

  const proto = headerValue(request.headers, LAN_HEADERS.proto)
  if (proto === null || proto !== String(SYNC_LAN_PROTOCOL_VERSION)) {
    return { ok: false, reason: 'protocol' }
  }

  const tsRaw = headerValue(request.headers, LAN_HEADERS.ts)
  if (tsRaw === null || !/^\d{1,16}$/.test(tsRaw)) return { ok: false, reason: 'protocol' }
  const ts = Number(tsRaw)
  if (!Number.isFinite(ts)) return { ok: false, reason: 'protocol' }
  if (Math.abs(now - ts) > LAN_MAX_CLOCK_SKEW_MS) return { ok: false, reason: 'stale' }

  const nonce = headerValue(request.headers, LAN_HEADERS.nonce)
  if (nonce === null || nonce.length < 8 || nonce.length > 128) {
    return { ok: false, reason: 'protocol' }
  }

  const sig = headerValue(request.headers, LAN_HEADERS.sig)
  if (sig === null || sig.length === 0) return { ok: false, reason: 'protocol' }
  const expected = requestSignature(key, {
    method: request.method,
    path: request.path,
    ts,
    nonce,
    body: request.body,
  })
  if (!signatureEquals(expected, sig)) return { ok: false, reason: 'auth' }

  if (store.has(nonce, now)) return { ok: false, reason: 'replay' }
  store.remember(nonce, now)
  return { ok: true }
}
