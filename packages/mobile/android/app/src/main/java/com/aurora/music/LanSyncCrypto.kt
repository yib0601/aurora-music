package com.aurora.music

import android.util.Base64
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 局域网同步的密码学原语（纯 JVM，无 Android 依赖，除了 base64 用 `android.util.Base64`）。
 *
 * ## 为什么这些值与桌面端逐字节对齐
 *
 * 两端必须能互换角色（手机连桌面、桌面连手机），所以下面每一条都是协议的一部分，
 * 不是「随便挑的参数」：
 * - 共享密钥 `K = HMAC-SHA256(key = 配对码, data = "aurora-lan-sync/v1")`；
 *   配对码先归一化（去空格/连字符、转大写）再当 key 用，用户抄成 `2345-6789-AB`
 *   与 `23456789AB` 必须得到同一把 K。
 * - 请求签名 `HMAC-SHA256(K, method\npath\nts\nnonce\nsha256hex(body))`，
 *   其中 `path` 不含 query、`sha256hex` 是**空 body** 的 sha256（GET 也参与签名）。
 * - 一键配对的 `K_pair = HMAC-SHA256(key = ECDH 共享 X 坐标, data = "aurora-lan-sync/pair/v1")`，
 *   `sealed = base64(nonce(12) || AES-256-GCM(K_pair, aad = pairId, plaintext = 配对码))`。
 *
 * 桌面端的对照实现是 `packages/desktop/src/ipc/lanSyncAuth.ts` 与 §16.3；改动这里
 * 必须先确认那边同样改，否则「手机配桌面」会静默变成 401。
 *
 * ## 配对码与密钥绝不出现在日志里
 *
 * 本文件不打印任何东西。上层日志只允许出现 deviceId / pairId 的前 8 个字符。
 */
internal object LanSyncCrypto {

    /** 局域网协议版本（发现包与 HTTP 头都带；与快照格式版本分开演进） */
    const val PROTOCOL_VERSION = 1

    /** 配对码字母表：Crockford base32 去掉 0/1/I/O/U（抄写时不会看混） */
    private const val PAIR_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

    /** 配对码长度：10 位 ≈ 49.5 bit，暴力猜的代价足够高，又短到能抄 */
    const val PAIR_CODE_LENGTH = 10

    /** 派生请求 key 的域分隔串 */
    private const val LAN_KEY_CONTEXT = "aurora-lan-sync/v1"

    /** 派生配对 key 的域分隔串 */
    private const val PAIR_KEY_CONTEXT = "aurora-lan-sync/pair/v1"

    /** 允许的时钟偏差（毫秒）：两台机器时间可能差几分钟 */
    const val MAX_CLOCK_SKEW_MS = 300_000L

    /** nonce 保留时长（毫秒）：与时钟窗口同宽 */
    const val NONCE_TTL_MS = 300_000L

    /** nonce 去重表容量上限：超出按插入顺序淘汰，防止被灌爆内存 */
    const val NONCE_MAX_ENTRIES = 4096

    /** P-256 曲线名（JCA/Conscrypt 用 secp256r1，等价 prime256v1） */
    private const val P256_CURVE = "secp256r1"

    /** 非压缩点长度：0x04 || X(32) || Y(32) */
    private const val EC_POINT_BYTES = 65

    /** GCM 标准 IV 长度 */
    private const val GCM_IV_BYTES = 12

    /** GCM 认证标签 128 位 */
    private const val GCM_TAG_BITS = 128

    private val random = SecureRandom()

    /* ------------------------------------------------------------------ *
     * 编码工具
     * ------------------------------------------------------------------ */

    fun base64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    fun unbase64(value: String): ByteArray? = try {
        Base64.decode(value, Base64.NO_WRAP)
    } catch (_: IllegalArgumentException) {
        null
    }

    fun hex(bytes: ByteArray): String {
        val out = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val value = b.toInt() and 0xff
            out.append(HEX_CHARS[value ushr 4]).append(HEX_CHARS[value and 0x0f])
        }
        return out.toString()
    }

    /** 严格 hex 解码（长度奇数或含非 hex 字符返回 null）；本方法用于 nonce / pairId 校验 */
    fun unhex(value: String): ByteArray? {
        if (value.length % 2 != 0) return null
        val out = ByteArray(value.length / 2)
        for (i in out.indices) {
            val high = hexDigit(value[i * 2])
            val low = hexDigit(value[i * 2 + 1])
            if (high < 0 || low < 0) return null
            out[i] = ((high shl 4) or low).toByte()
        }
        return out
    }

    private fun hexDigit(c: Char): Int = when (c) {
        in '0'..'9' -> c - '0'
        in 'a'..'f' -> c - 'a' + 10
        in 'A'..'F' -> c - 'A' + 10
        else -> -1
    }

    private val HEX_CHARS = "0123456789abcdef".toCharArray()

    /** 随机字节（SecureRandom；不用 Random：nonce / deviceId / pairId 都靠它） */
    fun randomBytes(size: Int): ByteArray = ByteArray(size).also { random.nextBytes(it) }

    fun randomHex(size: Int): String = hex(randomBytes(size))

    /* ------------------------------------------------------------------ *
     * 配对码
     * ------------------------------------------------------------------ */

    /** 生成一个 10 位配对码（字母表均匀取字符） */
    fun generatePairCode(): String {
        val out = StringBuilder(PAIR_CODE_LENGTH)
        for (i in 0 until PAIR_CODE_LENGTH) {
            out.append(PAIR_CODE_ALPHABET[random.nextInt(PAIR_CODE_ALPHABET.length)])
        }
        return out.toString()
    }

    /**
     * 归一化用户抄来的配对码：去掉空格与连字符、转大写，再校验字母表与长度。
     *
     * 非法输入返回 null（调用方据此报「配对码不对」，而不是拿一个坏 key 去发请求）。
     * 归一化口径必须与桌面端 `normalizePairCode` 完全一致，否则同一把码两边算出两把 key。
     */
    fun normalizePairCode(input: String?): String? {
        if (input == null) return null
        val compact = input.replace(Regex("[\\s\\-]+"), "").uppercase()
        if (compact.length != PAIR_CODE_LENGTH) return null
        for (c in compact) {
            if (!PAIR_CODE_ALPHABET.contains(c)) return null
        }
        return compact
    }

    /* ------------------------------------------------------------------ *
     * HMAC / 摘要
     * ------------------------------------------------------------------ */

    fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    fun sha256(body: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(body)

    fun sha256Hex(body: ByteArray): String = hex(sha256(body))

    /**
     * 按配对码派生本次请求用的 HMAC key。
     *
     * 输入先归一化再派生：对端传 `2345-6789-AB` 还是 `23456789AB` 必须得到同一把 key。
     * 归一化失败时退回原始串（与桌面端一致：调用方直接拿任意口令当 code 时两边仍能互通），
     * 安全边界由调用方校验码格式保证。
     */
    fun deriveKey(code: String): ByteArray {
        val normalized = normalizePairCode(code) ?: code
        return hmacSha256(normalized.toByteArray(Charsets.UTF_8), LAN_KEY_CONTEXT.toByteArray(Charsets.UTF_8))
    }

    /* ------------------------------------------------------------------ *
     * 请求签名 / 验签
     * ------------------------------------------------------------------ */

    /**
     * 请求签名。
     *
     * `path` 不含 query；`body` 为原始字节（GET 传空数组），空体也要参与签名——
     * 桌面端同样对空串取 sha256，两边必须一致。
     */
    fun requestSignature(
        key: ByteArray,
        method: String,
        path: String,
        ts: Long,
        nonce: String,
        body: ByteArray,
    ): String {
        val payload = buildString {
            append(method).append('\n')
            append(path).append('\n')
            append(ts).append('\n')
            append(nonce).append('\n')
            append(sha256Hex(body))
        }
        return hex(hmacSha256(key, payload.toByteArray(Charsets.UTF_8)))
    }

    /** 一整套签名请求头（键名与桌面端 `LAN_HEADERS` 一致） */
    fun signHeaders(
        key: ByteArray,
        method: String,
        path: String,
        ts: Long,
        nonce: String,
        body: ByteArray,
        deviceId: String,
    ): Map<String, String> = mapOf(
        HEADER_DEVICE to deviceId,
        HEADER_PROTO to PROTOCOL_VERSION.toString(),
        HEADER_TS to ts.toString(),
        HEADER_NONCE to nonce,
        HEADER_SIG to requestSignature(key, method, path, ts, nonce, body),
    )

    const val HEADER_DEVICE = "x-aurora-device"
    const val HEADER_PROTO = "x-aurora-proto"
    const val HEADER_TS = "x-aurora-ts"
    const val HEADER_NONCE = "x-aurora-nonce"
    const val HEADER_SIG = "x-aurora-sig"

    /** 验签失败分类（对端只会看到第一个失败原因） */
    enum class VerifyFailure(val wireCode: String) {
        /** 缺头 / 版本不符 / 时间戳或 nonce 结构非法 → 401 `protocol` */
        PROTOCOL("protocol"),

        /** 签名不匹配 → 401 `auth` */
        AUTH("auth"),

        /** 时钟偏差超窗 → 401 `auth`（桌面端把它归为 auth，这里保持一致） */
        STALE("auth"),

        /** nonce 在 TTL 内出现过 → 401 `auth` */
        REPLAY("auth"),
    }

    /**
     * 校验一条请求；返回 null 表示通过。
     *
     * 判定顺序与桌面端 `verifyRequest` 一致：
     * 1. 协议头缺失 / 不是本版本 → PROTOCOL
     * 2. 时间戳缺失、非法、偏差超过 5 分钟 → PROTOCOL / STALE
     * 3. 签名缺失 → PROTOCOL；签名不匹配 → AUTH
     * 4. nonce 复用 → REPLAY（**只在签名通过后**才查/记，否则伪造请求就能把表灌满）
     *
     * 刻意先比签名再查 nonce：让攻击者无法用伪造请求占位、把合法请求挤成「重放」。
     */
    fun verifyRequest(
        key: ByteArray,
        method: String,
        path: String,
        headers: Map<String, String>,
        body: ByteArray,
        now: Long,
        nonceStore: LanNonceStore,
    ): VerifyFailure? {
        val proto = headers[HEADER_PROTO]
        if (proto == null || proto != PROTOCOL_VERSION.toString()) return VerifyFailure.PROTOCOL

        val tsRaw = headers[HEADER_TS]
            ?: return VerifyFailure.PROTOCOL
        if (!TS_PATTERN.matches(tsRaw)) return VerifyFailure.PROTOCOL
        val ts = tsRaw.toLongOrNull() ?: return VerifyFailure.PROTOCOL
        if (kotlin.math.abs(now - ts) > MAX_CLOCK_SKEW_MS) return VerifyFailure.STALE

        val nonce = headers[HEADER_NONCE]
        if (nonce == null || nonce.length < 8 || nonce.length > 128) return VerifyFailure.PROTOCOL

        val sig = headers[HEADER_SIG]
        if (sig.isNullOrEmpty()) return VerifyFailure.PROTOCOL
        val expected = requestSignature(key, method, path, ts, nonce, body)
        if (!constantTimeEquals(expected, sig)) return VerifyFailure.AUTH

        if (!nonceStore.rememberIfFresh(nonce, now)) return VerifyFailure.REPLAY
        return null
    }

    private val TS_PATTERN = Regex("\\d{1,16}")

    /**
     * 定长比较。
     *
     * `MessageDigest.isEqual` 在等长输入上是时间恒定的（这是它被 JDK 明确改造过的语义），
     * 比 `==` 少一个「按字节提前返回」的侧信道。长度不同直接失败，避免把长度信息带出去。
     */
    private fun constantTimeEquals(expectedHex: String, providedHex: String): Boolean {
        val expected = unhex(expectedHex) ?: return false
        val provided = unhex(providedHex.lowercase()) ?: return false
        if (expected.size != provided.size) return false
        return MessageDigest.isEqual(expected, provided)
    }

    /* ------------------------------------------------------------------ *
     * 一键配对：ECDH P-256 + AES-256-GCM
     * ------------------------------------------------------------------ */

    fun generateEcKeyPair(): KeyPair {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec(P256_CURVE))
        return generator.generateKeyPair()
    }

    /** 导出非压缩 P-256 点：0x04 || X(32) || Y(32)（与桌面端 `pub` 同形） */
    fun encodePublicPoint(publicKey: PublicKey): ByteArray? {
        val ec = publicKey as? ECPublicKey ?: return null
        val x = fixedLength(ec.w.affineX, 32)
        val y = fixedLength(ec.w.affineY, 32)
        val out = ByteArray(EC_POINT_BYTES)
        out[0] = 0x04
        System.arraycopy(x, 0, out, 1, 32)
        System.arraycopy(y, 0, out, 33, 32)
        return out
    }

    fun decodePublicPoint(raw: ByteArray): PublicKey? {
        if (raw.size != EC_POINT_BYTES || raw[0] != 0x04.toByte()) return null
        return try {
            val params = AlgorithmParameters.getInstance("EC")
            params.init(ECGenParameterSpec(P256_CURVE))
            val spec = params.getParameterSpec(ECParameterSpec::class.java)
            val x = BigInteger(1, raw.copyOfRange(1, 33))
            val y = BigInteger(1, raw.copyOfRange(33, 65))
            KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), spec))
        } catch (_: Exception) {
            // 点不在曲线上 / 参数不合法：对端给什么都不能信，一律当解不开
            null
        }
    }

    /** ECDH 共享密钥（32 字节 X 坐标） */
    fun sharedSecret(privateKey: PrivateKey, peerPublicKey: PublicKey): ByteArray? = try {
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(privateKey)
        agreement.doPhase(peerPublicKey, true)
        agreement.generateSecret()
    } catch (_: Exception) {
        null
    }

    /** 一次性配对 key：只用于这一次配对，与请求签名用的 K 无关 */
    fun pairKey(shared: ByteArray): ByteArray =
        hmacSha256(shared, PAIR_KEY_CONTEXT.toByteArray(Charsets.UTF_8))

    /** `sealed = base64(nonce(12) || AES-256-GCM(K_pair, iv=nonce, aad=pairId, plaintext=code))` */
    fun sealPairCode(key: ByteArray, pairId: String, code: String): String? = try {
        val iv = randomBytes(GCM_IV_BYTES)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(GCM_TAG_BITS, iv),
        )
        // AAD 绑定 pairId：同一对密钥的密文不能挪到另一次配对里重放
        cipher.updateAAD(pairId.toByteArray(Charsets.UTF_8))
        val ciphertext = cipher.doFinal(code.toByteArray(Charsets.UTF_8))
        val payload = ByteArray(iv.size + ciphertext.size)
        System.arraycopy(iv, 0, payload, 0, iv.size)
        System.arraycopy(ciphertext, 0, payload, iv.size, ciphertext.size)
        base64(payload)
    } catch (_: Exception) {
        null
    }

    fun openSealedPairCode(key: ByteArray, pairId: String, sealedBase64: String): String? {
        val payload = unbase64(sealedBase64) ?: return null
        if (payload.size <= GCM_IV_BYTES) return null
        return try {
            val iv = payload.copyOfRange(0, GCM_IV_BYTES)
            val ciphertext = payload.copyOfRange(GCM_IV_BYTES, payload.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(key, "AES"),
                GCMParameterSpec(GCM_TAG_BITS, iv),
            )
            cipher.updateAAD(pairId.toByteArray(Charsets.UTF_8))
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (_: Exception) {
            // 认证失败（错 key / 改过 AAD / 密文损坏）一律当「解不开」
            null
        }
    }

    /** BigInteger → 定长大端字节（曲线坐标必须是 32 字节，前导零不能省） */
    private fun fixedLength(value: BigInteger, size: Int): ByteArray {
        val raw = value.toByteArray()
        return when {
            raw.size == size -> raw
            raw.size == size + 1 && raw[0].toInt() == 0 -> raw.copyOfRange(1, raw.size)
            raw.size < size -> ByteArray(size).also { System.arraycopy(raw, 0, it, size - raw.size, raw.size) }
            else -> raw.copyOfRange(raw.size - size, raw.size)
        }
    }
}

/**
 * 进程级 nonce 去重表：TTL 5 分钟、容量上限 4096，超出按插入顺序淘汰最旧的。
 *
 * 只在**验签通过之后**记录（见 `LanSyncCrypto.verifyRequest`）：否则任何人都能用
 * 伪造请求把表灌满，把合法请求挤成「重放」。
 */
internal class LanNonceStore(
    private val ttlMs: Long = LanSyncCrypto.NONCE_TTL_MS,
    private val maxEntries: Int = LanSyncCrypto.NONCE_MAX_ENTRIES,
) {
    private val seen = LinkedHashMap<String, Long>()

    /** 记下一个 nonce；已存在且未过期时返回 false（= 重放） */
    @Synchronized
    fun rememberIfFresh(nonce: String, now: Long): Boolean {
        prune(now)
        val expiresAt = seen[nonce]
        if (expiresAt != null && expiresAt > now) return false
        if (seen.size >= maxEntries) {
            val oldest = seen.keys.iterator()
            if (oldest.hasNext()) {
                oldest.next()
                oldest.remove()
            }
        }
        seen[nonce] = now + ttlMs
        return true
    }

    @Synchronized
    fun size(): Int = seen.size

    private fun prune(now: Long) {
        val iterator = seen.entries.iterator()
        while (iterator.hasNext()) {
            if (iterator.next().value <= now) iterator.remove()
        }
    }
}
