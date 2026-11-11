package com.aurora.music

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 一键配对的**发起方**流程（§16.4 的①②⑤⑥⑦）。
 *
 * ## 为什么整段跑在后台线程
 *
 * 轮询最长 120s（`LAN_PAIR_TTL_MS`）：放在主线程会直接 ANR，放在 Capacitor 的调用线程
 * 会挡住同一插件的其它调用。插件因此把它交给一个单独的 executor，`pairStart` 的
 * Promise 一直挂着，直到成功 / 拒绝 / 超时。
 *
 * ## 码的流向（这是整段流程唯一的目的）
 *
 * 双方的配对码都**只走密文**：本机码只出现在 `sealed` 密文里，对端码由本机用临时
 * ECDH 解出后立刻交给 `LanSyncStore.stagePairedCode`（内存），等渲染层建好配置再
 * `adoptPairedCode` 落进 Keystore 凭证槽。配对码与共享密钥都不进日志（只记 pairId /
 * deviceId 前 8 位）。
 *
 * ## 失败分类严格复用 shared 的 `LanPairFailureReason`
 *
 * `cancelled` / `denied` / `timeout` / `unreachable` / `unsupported` / `auth` / `self` / `busy` / `invalid`。
 * 原生侧不做字符串匹配、不拼句子——UI 按码查 `sync.pair.*` 文案。
 */
internal object LanSyncPairClient {

    private const val TAG = "AuroraLanSync"

    /** 配对请求有效期：发起方最多等这么久，应答方的 pending 也按它过期 */
    const val TTL_MS = 120_000L

    /** 轮询间隔：1s（§16.5） */
    private const val POLL_INTERVAL_MS = 1_000L

    /** `pair/reply` 失败重试次数：§16.4 允许对端在 A 在 ⑥ 失败后重试同一个 pairId */
    private const val REPLY_ATTEMPTS = 3

    /** 一台可配对的设备（发现结果去掉时间戳，与 shared `LanPairPeer` 同形） */
    data class PeerSpec(
        val deviceId: String,
        val deviceName: String,
        val host: String,
        val port: Int,
    )

    /** 本次配对的可取消句柄：runtime 按 pairId 存一份，`pairCancel` 置位后轮询尽快退出 */
    class CancelToken(val pairId: String) {
        private val cancelled = AtomicBoolean(false)

        fun cancel() {
            cancelled.set(true)
        }

        val isCancelled: Boolean get() = cancelled.get()
    }

    sealed class Outcome {
        class Success(val peer: PeerSpec, val peerCode: String) : Outcome()
        class Failure(val reason: String) : Outcome()
    }

    /**
     * 发起配对（阻塞直到出结果）。
     *
     * @param ownPort 本机 HTTP 端口（写进请求体的 `port`，应答方记录用；不等于它一定能连上）
     * @param token   取消句柄；用户在 UI 里关掉弹窗时 `pairCancel` 会置位
     */
    fun start(
        context: Context,
        peer: PeerSpec,
        ownPort: Int,
        token: CancelToken,
    ): Outcome {
        val myDeviceId = LanSyncStore.deviceId(context)
        // 先排除「自己」：发现包里出现自己的 deviceId 只可能是本机 socket 自收包
        if (peer.deviceId == myDeviceId) return Outcome.Failure("self")
        if (!isValidPeer(peer)) return Outcome.Failure("invalid")

        val pairId = token.pairId
        val keyPair = LanSyncCrypto.generateEcKeyPair()
        val publicPoint = LanSyncCrypto.encodePublicPoint(keyPair.public)
            ?: return Outcome.Failure("invalid")

        // ① 生成 pairId / ECDH 密钥对已在上面完成，这里发 ②
        val requestBody = JSONObject()
            .put("v", LanSyncCrypto.PROTOCOL_VERSION)
            .put("pairId", pairId)
            .put("deviceId", myDeviceId)
            .put("deviceName", LanSyncStore.deviceName())
            .put("port", ownPort)
            .put("pub", LanSyncCrypto.base64(publicPoint))

        val requestResult = try {
            LanSyncPeerClient.pairRequest(peer.host, peer.port, requestBody)
        } catch (_: Exception) {
            return Outcome.Failure("unreachable")
        }
        when (requestResult.status) {
            in 200..202 -> Unit
            409 -> return Outcome.Failure("busy")
            // 403 disabled = 对端服务没开，从发起方看就是「连不上可用服务」
            403 -> return Outcome.Failure("unreachable")
            404, 405 -> return Outcome.Failure("unsupported")
            else -> return Outcome.Failure("invalid")
        }
        Log.i(TAG, "pair request sent to ${prefix(peer.deviceId)} pairId=${prefix(pairId)}")

        // ③④ 每 1s 轮询一次，直到 accepted / denied / TTL
        val poll = pollUntilAccepted(peer, pairId, token)
        val accepted = when (poll) {
            is PollOutcome.Accepted -> poll.payload
            // 用户自己关掉弹窗 = cancelled，不能报成「对端拒绝」（责任错位，见 Lead 的约定）
            PollOutcome.Cancelled -> return Outcome.Failure("cancelled")
            PollOutcome.Denied -> return Outcome.Failure("denied")
            PollOutcome.Timeout -> return Outcome.Failure("timeout")
            PollOutcome.Invalid -> return Outcome.Failure("invalid")
        }
        if (accepted.optString("state", "") != "accepted") return Outcome.Failure("invalid")

        // ⑤ 解出对端配对码（只留在内存里，直到 adoptPairedCode）
        val peerPublicRaw = LanSyncCrypto.unbase64(accepted.optString("pub", ""))
            ?: return Outcome.Failure("invalid")
        val peerPublicKey = LanSyncCrypto.decodePublicPoint(peerPublicRaw)
            ?: return Outcome.Failure("invalid")
        val shared = LanSyncCrypto.sharedSecret(keyPair.private, peerPublicKey)
            ?: return Outcome.Failure("auth")
        val pairKey = LanSyncCrypto.pairKey(shared)
        val sealedForMe = accepted.optString("sealed", "")
        val peerCode = LanSyncCrypto.openSealedPairCode(pairKey, pairId, sealedForMe)
            ?.let { LanSyncCrypto.normalizePairCode(it) }
            ?: run {
                Log.w(TAG, "pair sealed payload rejected pairId=${prefix(pairId)}")
                return Outcome.Failure("auth")
            }

        // ⑥ 用对端的码签名，把本机码封好递过去
        val myCode = LanSyncStore.currentPairCode(context)
        val mySealed = LanSyncCrypto.sealPairCode(pairKey, pairId, myCode)
            ?: return Outcome.Failure("auth")
        val replyBody = JSONObject()
            .put("v", LanSyncCrypto.PROTOCOL_VERSION)
            .put("pairId", pairId)
            .put("sealed", mySealed)

        var lastFailure = "unreachable"
        for (attempt in 0 until REPLY_ATTEMPTS) {
            if (token.isCancelled) return Outcome.Failure("cancelled")
            try {
                val reply = LanSyncPeerClient.pairReply(
                    context = context,
                    peerHost = peer.host,
                    peerPort = peer.port,
                    pairId = pairId,
                    peerCode = peerCode,
                    body = replyBody,
                )
                when (reply.status) {
                    // ⑦ 对端已完成：幂等重试时对端也回 200 done
                    in 200..202 -> {
                        Log.i(TAG, "paired with ${prefix(peer.deviceId)} pairId=${prefix(pairId)}")
                        return Outcome.Success(peer, peerCode)
                    }
                    401 -> return Outcome.Failure("auth")
                    404 -> lastFailure = "timeout"
                    else -> lastFailure = "invalid"
                }
            } catch (_: Exception) {
                lastFailure = "unreachable"
            }
            if (attempt < REPLY_ATTEMPTS - 1 && !sleepInterruptibly(POLL_INTERVAL_MS)) {
                // 线程被中断（插件销毁 / 服务关闭）而没人再等结果：同样按取消收尾
                return Outcome.Failure("cancelled")
            }
        }
        return Outcome.Failure(lastFailure)
    }

    private sealed class PollOutcome {
        class Accepted(val payload: JSONObject) : PollOutcome()
        object Denied : PollOutcome()
        object Timeout : PollOutcome()
        object Cancelled : PollOutcome()
        object Invalid : PollOutcome()
    }

    /** 轮询 `/v1/pair/status`，返回本次配对的一个确定结局（不会「不确定」地返回） */
    private fun pollUntilAccepted(
        peer: PeerSpec,
        pairId: String,
        token: CancelToken,
    ): PollOutcome {
        val deadline = System.currentTimeMillis() + TTL_MS
        while (System.currentTimeMillis() < deadline) {
            if (token.isCancelled) return PollOutcome.Cancelled
            var payload: JSONObject? = null
            var statusCode = -1
            try {
                val result = LanSyncPeerClient.pairStatus(peer.host, peer.port, pairId)
                statusCode = result.status
                payload = result.json
            } catch (_: Exception) {
                // 单次轮询失败（对端短暂忙/丢包）不结束配对：下一轮接着问
            }
            if (statusCode in 200..299) {
                when (payload?.optString("state", "")) {
                    "accepted" -> return PollOutcome.Accepted(payload)
                    "denied" -> return PollOutcome.Denied
                    "pending" -> Unit
                    // 未知状态：结构不认识，别把用户卡满 120s
                    else -> if (payload != null) return PollOutcome.Invalid
                }
            } else if (statusCode == 404) {
                // 对端忘了这个 pairId（重启/过期）：等价于超时
                return PollOutcome.Timeout
            }
            // 线程被中断（插件销毁/服务关闭）等于这次配对已经没人等了：立刻退出，
            // 不能把中断标志留着——下一轮 sleep 会立即抛错，变成一个空转 120s 的忙等
            if (!sleepInterruptibly(POLL_INTERVAL_MS)) return PollOutcome.Cancelled
        }
        return PollOutcome.Timeout
    }

    private fun isValidPeer(peer: PeerSpec): Boolean =
        peer.deviceId.isNotEmpty() &&
            peer.host.isNotBlank() &&
            peer.host.none { it.isWhitespace() || it.isISOControl() } &&
            peer.port in 1..65535

    /** 睡 `ms`；被中断返回 false（调用方据此立刻放弃），不把中断标志留到下一轮 */
    private fun sleepInterruptibly(ms: Long): Boolean = try {
        Thread.sleep(ms)
        true
    } catch (_: InterruptedException) {
        false
    }

    private fun prefix(value: String): String = if (value.length > 8) value.substring(0, 8) else value
}
