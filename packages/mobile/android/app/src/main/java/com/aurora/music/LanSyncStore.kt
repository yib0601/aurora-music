package com.aurora.music

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 局域网同步的本地持久化：设备身份、配对码、（按配置 id 的）同步凭证、配对换来的对端码。
 *
 * ## 三样东西的密级不同，处理方式也不同
 *
 * | 数据 | 是否凭据 | 落盘方式 |
 * |---|---|---|
 * | `deviceId`（16 字节随机 hex） | **不是**凭据（只是设备标识，进了发现包与快照） | SharedPreferences 明文 |
 * | 配对码（10 位 Crockford base32） | **是**凭据，拿到就能写对端歌单 | Keystore AES-GCM 密文 |
 * | 同步凭证（`configId -> {code}`） | **是**凭据 | Keystore AES-GCM 密文 |
 *
 * 为什么 deviceId 可以明文：它出现在 UDP 广播包、`/v1/hello`、快照里，本来就对全网段可见；
 * 把它加密只会让人误以为它有安全语义。
 *
 * ## Keystore 不可用时为什么降级到内存而不是写明文
 *
 * 写明文等于把凭据摊在应用私有目录：能拿到文件的人（root、备份提取）就能推对端歌单。
 * 所以：
 * - **配对码**：只留内存，每次进程启动重新生成（与桌面端 `safeStorage` 不可用时的语义一致）。
 *   代价是重启后对端要重新抄码——这比「静默落一份明文凭据」便宜得多。
 * - **同步凭证**：拒绝保存，`saveCredential` 如实返回 `saved:false, encryptionAvailable:false`，
 *   由 UI 告诉用户「这台设备存不了配对码」。绝不假装保存成功。
 *
 * ## 密钥别名
 *
 * 固定 `aurora-music.lan-sync.v1`，与 `SecureStoragePlugin` 的 `aurora-music.storage-credentials.v1`
 * **刻意分开**：同名别名会把不同用途的密文混在一把 key 下，将来任何一方要轮换/清理都会
 * 波及另一方。改名等于换密钥，老密文全部作废。
 */
internal object LanSyncStore {

    private const val TAG = "AuroraLanSync"

    /** 设备身份：deviceId 明文落在 SharedPreferences（不是凭据，见类注释） */
    private const val PREFS_NAME = "aurora_lan_sync"
    private const val PREF_DEVICE_ID = "deviceId"

    /** 配对码密文文件（base64(iv12 || ciphertext+tag) 的文本） */
    private const val PAIR_CODE_FILE = "lan-sync-paircode.bin"

    /** 同步凭证密文文件（base64(iv12 || ciphertext+tag)，明文是 `configId -> {字段:值}` 的 JSON） */
    private const val CREDENTIALS_FILE = "lan-sync-credentials.bin"

    /** 与桌面端 `pluginCredentials` / `syncCredentials` 同源的文件名校验：configId 来自渲染层，按不可信处理 */
    private val CONFIG_ID_PATTERN = Regex("^[a-z0-9][a-z0-9._-]{0,63}$", RegexOption.IGNORE_CASE)

    private val lock = Any()

    /**
     * 配对换来的对端码：`deviceId -> code`，**只在内存**。
     *
     * 配对的目的就是把它交给 `adoptPairedCode(configId, deviceId)` 落进凭证存储；
     * 在那之前它只是一份「还没归属到某条配置」的临时材料，落盘只会多一处凭据副本。
     */
    private val stagedPairedCodes = HashMap<String, String>()

    /* ------------------------------------------------------------------ *
     * 设备身份
     * ------------------------------------------------------------------ */

    /** 读取或首次生成 deviceId（16 字节随机 hex，32 字符） */
    fun deviceId(context: Context): String = synchronized(lock) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val existing = prefs.getString(PREF_DEVICE_ID, null)
        if (!existing.isNullOrEmpty()) return existing
        val created = LanSyncCrypto.randomHex(16)
        prefs.edit().putString(PREF_DEVICE_ID, created).apply()
        Log.i(TAG, "device identity created: ${prefix(created)}")
        created
    }

    /**
     * 设备名（进广播包、配对确认框、快照）。
     *
     * 用 `Build.MODEL`：用户在两端确认框里看到的是自己能分辨的机型名。
     * 不拼接厂商与「的手机」之类后缀——广播包越小越好，且完整品牌串反而更难读。
     */
    fun deviceName(): String {
        val model = Build.MODEL?.trim().orEmpty()
        return model.ifEmpty { "Android" }
    }

    /* ------------------------------------------------------------------ *
     * 配对码
     * ------------------------------------------------------------------ */

    /**
     * 本次进程里的配对码。
     *
     * **必须缓存**：Keystore 不可用时（API 22）配对码根本不落盘，若每次调用都重新生成，
     * 「status 显示的码」与「服务端每请求派生的 key」会各用一份，签名永远对不上。
     * 缓存同时也省掉了每个请求一次 Keystore 解密（服务端每请求现取，见 §7）。
     */
    private var memoryPairCode: String? = null

    /** 当前配对码（惰性初始化：内存 → 密文 → 生成） */
    fun currentPairCode(context: Context): String = synchronized(lock) {
        memoryPairCode?.let { return it }
        val stored = readPairCodeFromDisk(context)
        if (stored != null) {
            memoryPairCode = stored
            return stored
        }
        val generated = LanSyncCrypto.generatePairCode()
        memoryPairCode = generated
        persistPairCode(context, generated)
        if (!keystoreAvailable()) {
            Log.i(TAG, "pair code kept in memory only (keystore unavailable)")
        }
        generated
    }

    /** 轮换配对码：新码立刻生效（服务端每个请求现取），旧码派生的 key 立即失效 */
    fun rotatePairCode(context: Context): String = synchronized(lock) {
        val next = LanSyncCrypto.generatePairCode()
        memoryPairCode = next
        persistPairCode(context, next)
        Log.i(TAG, "pair code rotated")
        next
    }

    private fun pairCodeFile(context: Context): File = File(context.filesDir, PAIR_CODE_FILE)

    private fun readPairCodeFromDisk(context: Context): String? {
        if (!keystoreAvailable()) return null
        val file = pairCodeFile(context)
        if (!file.isFile) return null
        val ciphertext = try {
            file.readText(Charsets.UTF_8)
        } catch (e: Exception) {
            Log.w(TAG, "pair code read failed: ${e.javaClass.simpleName}")
            return null
        }
        val plaintext = LanSyncKeystore.decrypt(ciphertext)
        if (plaintext == null) {
            // Keystore 密钥失效（恢复备份 / 换机 / 清数据）或文件损坏：删掉，重新生成。
            // 不删会让每次读都白跑一次解密，而且旧文件永远不会自愈。
            file.delete()
            return null
        }
        return try {
            LanSyncCrypto.normalizePairCode(JSONObject(plaintext).optString("code", ""))
        } catch (e: Exception) {
            file.delete()
            null
        }
    }

    private fun persistPairCode(context: Context, code: String) {
        if (!keystoreAvailable()) return
        val payload = JSONObject().put("code", code).toString()
        val ciphertext = LanSyncKeystore.encrypt(payload) ?: run {
            Log.w(TAG, "pair code persist skipped (encrypt failed)")
            return
        }
        writeAtomic(pairCodeFile(context), ciphertext)
    }

    /* ------------------------------------------------------------------ *
     * 同步凭证（按 configId）
     * ------------------------------------------------------------------ */

    /** 给渲染层的**不含内容**的状态 */
    data class CredentialState(val saved: Boolean, val encryptionAvailable: Boolean)

    fun isEncryptionAvailable(): Boolean = keystoreAvailable()

    /** 读取某条配置的凭证原文；未保存 / 解密失败 / 加密不可用一律 null（按「未保存」处理） */
    fun readCredential(context: Context, configId: String): Map<String, String>? = synchronized(lock) {
        val all = readAllCredentials(context) ?: return null
        val entry = all.optJSONObject(configId) ?: return null
        val out = LinkedHashMap<String, String>()
        val keys = entry.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = entry.optString(key, "")
            if (value.isNotEmpty()) out[key] = value
        }
        return out.ifEmpty { null }
    }

    /**
     * 保存某条配置的凭证。
     *
     * 空载荷 = 清除（用户在表单里把码清空，与桌面端 `saveSyncCredential` 同语义）。
     * 加密不可用时**不落盘**，返回 `saved:false` —— 宁可让用户知道「这台机器存不了」，
     * 也不能静默降级写明文。
     */
    fun saveCredential(context: Context, configId: String, payload: Map<String, String>): CredentialState =
        synchronized(lock) {
            val encryptionAvailable = keystoreAvailable()
            if (!isValidConfigId(configId)) return CredentialState(false, encryptionAvailable)
            val clean = sanitize(payload)
            if (clean.isEmpty()) {
                clearCredential(context, configId)
                return CredentialState(false, encryptionAvailable)
            }
            if (!encryptionAvailable) return CredentialState(false, false)

            val all = readAllCredentials(context) ?: JSONObject()
            all.put(configId, JSONObject(clean as Map<*, *>))
            if (!writeAllCredentials(context, all)) return CredentialState(false, true)
            CredentialState(true, true)
        }

    /** 清除某条配置的凭证（文件不存在视作成功） */
    fun clearCredential(context: Context, configId: String): CredentialState = synchronized(lock) {
        val encryptionAvailable = keystoreAvailable()
        if (!isValidConfigId(configId)) return CredentialState(false, encryptionAvailable)
        val all = readAllCredentials(context) ?: return CredentialState(false, encryptionAvailable)
        if (!all.has(configId)) return CredentialState(false, encryptionAvailable)
        all.remove(configId)
        if (all.length() == 0) {
            credentialsFile(context).delete()
            return CredentialState(false, encryptionAvailable)
        }
        writeAllCredentials(context, all)
        CredentialState(false, encryptionAvailable)
    }

    /**
     * 该配置是否已保存凭证。
     *
     * 判据是「解得出非空内容」而不是「文件在不在」：Keystore 密钥失效后文件还在，
     * 但内容已经等于不可用，报 `saved:true` 只会让 UI 显示一个假的「已保存」。
     */
    fun credentialState(context: Context, configId: String): CredentialState = synchronized(lock) {
        CredentialState(readCredential(context, configId) != null, keystoreAvailable())
    }

    /* ------------------------------------------------------------------ *
     * 一键配对换来的对端码
     * ------------------------------------------------------------------ */

    /** 暂存对端配对码（配对成功后由 `LanSyncRuntime` 调用；不进日志） */
    fun stagePairedCode(deviceId: String, code: String) {
        val normalized = LanSyncCrypto.normalizePairCode(code) ?: return
        synchronized(lock) { stagedPairedCodes[deviceId] = normalized }
    }

    /**
     * 把暂存的对端码写进这条配置的凭证槽（键名固定 `code`，与 `lan-sync` 插件的
     * `kind:'password'` 字段同名，见 §10）。
     *
     * 返回 false = 没有可落的码（配对已过期/已被取走）或本机无法安全保存。
     * 只有真正写成功才删暂存，失败时保留以便用户重试。
     */
    fun adoptPairedCode(context: Context, configId: String, deviceId: String): Boolean {
        val code = synchronized(lock) { stagedPairedCodes[deviceId] } ?: return false
        if (!isValidConfigId(configId) || !keystoreAvailable()) return false
        val existing = readCredential(context, configId).orEmpty()
        val merged = LinkedHashMap<String, String>(existing)
        merged["code"] = code
        val state = saveCredential(context, configId, merged)
        if (!state.saved) return false
        synchronized(lock) { stagedPairedCodes.remove(deviceId) }
        Log.i(TAG, "paired code adopted for ${prefix(deviceId)}")
        return true
    }

    /* ------------------------------------------------------------------ *
     * 内部：凭证文件读写
     * ------------------------------------------------------------------ */

    private fun credentialsFile(context: Context): File = File(context.filesDir, CREDENTIALS_FILE)

    private fun readAllCredentials(context: Context): JSONObject? {
        if (!keystoreAvailable()) return null
        val file = credentialsFile(context)
        if (!file.isFile) return null
        val ciphertext = try {
            file.readText(Charsets.UTF_8)
        } catch (e: Exception) {
            Log.w(TAG, "credentials read failed: ${e.javaClass.simpleName}")
            return null
        }
        val plaintext = LanSyncKeystore.decrypt(ciphertext) ?: return null
        return try {
            JSONObject(plaintext)
        } catch (e: Exception) {
            // 解不开就按「没有凭证」处理（上层会提示重新输入），但不删文件：
            // 下一次成功保存会覆盖它
            Log.w(TAG, "credentials decrypt payload invalid")
            null
        }
    }

    private fun writeAllCredentials(context: Context, all: JSONObject): Boolean {
        val ciphertext = LanSyncKeystore.encrypt(all.toString()) ?: return false
        return writeAtomic(credentialsFile(context), ciphertext)
    }

    /** 先写临时文件再 rename：进程被杀时不会留下半截密文 */
    private fun writeAtomic(target: File, content: String): Boolean = try {
        target.parentFile?.mkdirs()
        val tmp = File(target.parentFile, "${target.name}.tmp")
        tmp.writeText(content, Charsets.UTF_8)
        if (!tmp.renameTo(target)) {
            // rename 失败（极少数文件系统）时退化成覆盖写：内容仍是密文，不算降级
            target.writeText(content, Charsets.UTF_8)
            tmp.delete()
        }
        true
    } catch (e: Exception) {
        Log.w(TAG, "persist failed: ${e.javaClass.simpleName}")
        false
    }

    /** 只保留非空字符串值，避免把垃圾写进密文 */
    private fun sanitize(payload: Map<String, String>): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for ((key, value) in payload) {
            if (key.isNotEmpty() && value.isNotEmpty()) out[key] = value
        }
        return out
    }

    private fun isValidConfigId(configId: String): Boolean =
        configId.isNotEmpty() && CONFIG_ID_PATTERN.matches(configId)

    private fun keystoreAvailable(): Boolean = LanSyncKeystore.isAvailable()

    /** 日志里只出现前缀（与桌面端同一纪律） */
    private fun prefix(value: String): String = if (value.length > 8) value.substring(0, 8) else value
}

/**
 * Keystore AES-GCM 的薄封装（密钥不可导出，密文离了这台设备就是废字节）。
 *
 * 与 `SecureStoragePlugin` 里的实现同构，这里独立一份是因为用途与别名不同：
 * 插件那份是通用加解密通道，这份只服务局域网同步的落盘。
 * 参数选择理由见 `SecureStoragePlugin` 的类注释（随机 IV、128 位 tag、不要求用户认证）。
 */
internal object LanSyncKeystore {

    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "aurora-music.lan-sync.v1"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val KEY_BITS = 256
    private const val TAG_BITS = 128
    private const val IV_BYTES = 12

    /** minSdk 是 22，而 `KeyGenParameterSpec` 要 API 23 */
    fun isAvailable(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M

    /** 加密成 `base64(iv(12) || ciphertext+tag)`；任何失败返回 null（调用方按「不可用」处理） */
    fun encrypt(plaintext: String): String? {
        if (!isAvailable()) return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, secretKey())
            val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
            val payload = ByteArray(cipher.iv.size + ciphertext.size)
            System.arraycopy(cipher.iv, 0, payload, 0, cipher.iv.size)
            System.arraycopy(ciphertext, 0, payload, cipher.iv.size, ciphertext.size)
            LanSyncCrypto.base64(payload)
        } catch (_: Exception) {
            null
        }
    }

    fun decrypt(value: String): String? {
        if (!isAvailable()) return null
        val payload = LanSyncCrypto.unbase64(value) ?: return null
        if (payload.size <= IV_BYTES) return null
        return try {
            val iv = payload.copyOfRange(0, IV_BYTES)
            val ciphertext = payload.copyOfRange(IV_BYTES, payload.size)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_BITS, iv))
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    /** 取（必要时创建）本用途的加密密钥；别名固定，改名等于换密钥 */
    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(KEY_BITS)
            .setRandomizedEncryptionRequired(true)
            .build()
        generator.init(spec)
        return generator.generateKey()
    }
}
