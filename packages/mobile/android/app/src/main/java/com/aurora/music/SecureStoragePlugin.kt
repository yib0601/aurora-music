package com.aurora.music

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Capacitor 插件：Android Keystore 的对称加解密通道。
 *
 * ## 解决什么
 *
 * 网络存储（WebDAV）的口令必须落盘，而手机上没有桌面端 `safeStorage` 的等价物。
 * 明文写在应用私有目录只是"别的应用读不到"，拿得到文件的人（root / 备份提取）
 * 仍能直接读出口令。要真正加密，唯一不引入第三方库的做法就是 Keystore：
 * AES-256-GCM 密钥由系统生成并**不可导出**，密文离了这台设备就是废字节。
 *
 * ## 参数选择（都不是默认值，都是有理由的）
 *
 * - **AES/GCM/NoPadding**：带认证的加密，密文被篡改时解密直接抛异常，
 *   不会悄悄返回一段乱码当口令用；CBC 没有这个性质。
 * - **随机 IV**：`setRandomizedEncryptionRequired(true)` 由系统保证每次加密的 IV
 *   不重复（GCM 复用 IV 会直接毁掉保密性与完整性）。IV 随密文一起存（前 12 字节）。
 * - **不要求用户认证**（`setUserAuthenticationRequired` 保持默认 false）：
 *   曲库扫描在后台进行，要求解锁会让"息屏时的扫描/播放取址"失败。
 *   代价是密钥在设备解锁状态下对本应用全程可用 —— 这正是我们要的威胁模型边界。
 *
 * ## 约定
 *
 * - 入参出参全是**字符串**，密文形态为 `base64(iv(12) + ciphertext+tag)`；
 * - 失败 reject 的 message 是机器可读码（`UNSUPPORTED` / `BAD_INPUT` / `CRYPTO_ERROR`），
 *   给人看的文案由 JS 侧决定，这里不烧任何句子；
 * - `isAvailable` 只回答"这台设备能不能用"，不生成密钥（生成推迟到第一次 encrypt）。
 *
 * minSdk 是 22，而 `KeyGenParameterSpec` 要 API 23，所以低版本必须明确拒绝，
 * 不能让它抛 NoClassDefFoundError。
 */
@CapacitorPlugin(name = "SecureStorage")
class SecureStoragePlugin : Plugin() {

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val out = JSObject()
        out.put("available", isSupported())
        call.resolve(out)
    }

    @PluginMethod
    fun encrypt(call: PluginCall) {
        if (!isSupported()) {
            call.reject("UNSUPPORTED")
            return
        }
        val plaintext = call.getString("plaintext")
        if (plaintext == null) {
            call.reject("BAD_INPUT")
            return
        }
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, secretKey())
            val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
            val payload = ByteArray(cipher.iv.size + ciphertext.size)
            System.arraycopy(cipher.iv, 0, payload, 0, cipher.iv.size)
            System.arraycopy(ciphertext, 0, payload, cipher.iv.size, ciphertext.size)
            val out = JSObject()
            out.put("value", Base64.encodeToString(payload, Base64.NO_WRAP))
            call.resolve(out)
        } catch (e: Exception) {
            call.reject("CRYPTO_ERROR", e)
        }
    }

    @PluginMethod
    fun decrypt(call: PluginCall) {
        if (!isSupported()) {
            call.reject("UNSUPPORTED")
            return
        }
        val value = call.getString("value")
        if (value.isNullOrEmpty()) {
            call.reject("BAD_INPUT")
            return
        }
        try {
            val payload = Base64.decode(value, Base64.NO_WRAP)
            if (payload.size <= IV_BYTES) {
                call.reject("BAD_INPUT")
                return
            }
            val iv = payload.copyOfRange(0, IV_BYTES)
            val ciphertext = payload.copyOfRange(IV_BYTES, payload.size)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_BITS, iv))
            val plaintext = cipher.doFinal(ciphertext)
            val out = JSObject()
            out.put("plaintext", String(plaintext, Charsets.UTF_8))
            call.resolve(out)
        } catch (e: Exception) {
            // 密钥失效（恢复备份 / 换机重装 / 用户清数据）也走这里：
            // 密文还在、密钥没了，只能让用户重填口令
            call.reject("CRYPTO_ERROR", e)
        }
    }

    private fun isSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M

    /**
     * 取（必要时创建）本应用的加密密钥。
     *
     * 密钥别名固定且不随版本变化：改名等于换密钥，老密文全部作废。
     */
    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(KEY_BITS)
            .setRandomizedEncryptionRequired(true)
            .build()
        generator.init(spec)
        return generator.generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "aurora-music.storage-credentials.v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val KEY_BITS = 256
        /** GCM 认证标签 128 位（系统默认值，显式写出来免得被人当成可调参数） */
        const val TAG_BITS = 128
        /** GCM 标准 IV 长度 */
        const val IV_BYTES = 12
    }
}
