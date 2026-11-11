package com.aurora.music

import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * Capacitor 插件：把 Android 端的局域网同步服务暴露给 JS（`window.Capacitor.Plugins.LanSync`）。
 *
 * ## 与桌面端的能力对照（§17）
 *
 * | 能力 | 桌面 | 这里 |
 * |---|---|---|
 * | HTTP 服务 | `node:http`（主进程） | `LanSyncHttpServer` + 前台服务 |
 * | UDP 发现 | `node:dgram` | `LanSyncDiscovery`（MulticastLock + 广播地址按网卡算） |
 * | 配对码 / 凭证 | `safeStorage` | `LanSyncStore`（Keystore AES-GCM） |
 *
 * 协议（端口、路径、头字段、签名公式、配对封装）与桌面端逐字节一致，两端必须能互换角色。
 *
 * ## 线程模型
 *
 * Capacitor 的插件方法默认在主线程执行，而这里的每个操作都可能阻塞（读 Keystore、
 * 绑定端口、8s 对端请求、120s 配对轮询）。所以：
 * - 普通方法丢进 `work`（2 线程）：它们短，串行等着也不会把 UI 卡住；
 * - `pairStart` 单独丢进 `pairWork`（1 线程）：它会挂最多 120s，不能占住普通方法。
 *
 * 方法内部的网络/磁盘操作全部不在主线程，`call.resolve/reject` 从 worker 线程回是
 * Capacitor 允许的（官方 Filesystem 插件同款写法）。
 *
 * ## 返回值形状的两处刻意偏离
 *
 * Capacitor 的 `resolve()` **只接受 JSObject**（其父类 JSONObject），拿不到裸数组/布尔，
 * 所以：
 * - `takeInbox` / `pullPeer` / `discover` 返回 `{ snapshots: [...] }` / `{ peers: [...] }`；
 * - `adoptPairedCode` 返回 `{ adopted: boolean }`；
 * - `inbox` 事件负载是 `{ snapshots: [...] }`。
 * 其余方法严格按契约；`getCredential` 未保存时 resolve 空数据（JS 侧收到 undefined）。
 *
 * ## 错误约定
 *
 * reject 的 message 是**机器可读码**，不含给用户看的句子（文案由 JS 侧按当前语言渲染）：
 * `LAN_BAD_TARGET` / `LAN_UNREACHABLE` / `LAN_AUTH` / `LAN_DISABLED` / `LAN_PROTOCOL` /
 * `LAN_TOO_LARGE` / `LAN_SNAPSHOT` / `LAN_BAD_INPUT` / `LAN_INTERNAL`。
 * `pairStart` 的预期失败**不 reject**，只回 `{ ok:false, reason }`（reason 取值复用
 * shared 的 `LanPairFailureReason`）。
 */
@CapacitorPlugin(name = "LanSync")
class LanSyncPlugin : Plugin() {

    private companion object {
        const val TAG = "AuroraLanSync"

        const val ERR_BAD_TARGET = "LAN_BAD_TARGET"
        const val ERR_BAD_INPUT = "LAN_BAD_INPUT"
        const val ERR_UNREACHABLE = "LAN_UNREACHABLE"
        const val ERR_AUTH = "LAN_AUTH"
        const val ERR_DISABLED = "LAN_DISABLED"
        const val ERR_PROTOCOL = "LAN_PROTOCOL"
        const val ERR_TOO_LARGE = "LAN_TOO_LARGE"
        const val ERR_SNAPSHOT = "LAN_SNAPSHOT"
        const val ERR_INTERNAL = "LAN_INTERNAL"
    }

    /** 普通方法（短操作）。2 个线程足够：一次同步最多同时一个 pull 一个 push */
    private val work: ExecutorService = Executors.newFixedThreadPool(2) { runnable ->
        Thread(runnable, "aurora-lansync-plugin").apply { isDaemon = true }
    }

    /** 配对发起（可能挂 120s）：单独一个线程，不能占住普通方法 */
    private val pairWork: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "aurora-lansync-pair").apply { isDaemon = true }
    }

    override fun load() {
        super.load()
        // 事件出口：网络线程触发的事件一律回到主线程再 notifyListeners——
        // 监听器表是普通 Map，跨线程写读会踩并发问题，而事件本身频率极低
        LanSyncRuntime.attachEventSink { name, payload ->
            bridge?.executeOnMainThread { notifyListeners(name, payload) }
        }
    }

    override fun handleOnDestroy() {
        LanSyncRuntime.attachEventSink(null)
        work.shutdownNow()
        pairWork.shutdownNow()
        super.handleOnDestroy()
    }

    /* ------------------------------------------------------------------ *
     * 本机服务
     * ------------------------------------------------------------------ */

    @PluginMethod
    fun status(call: PluginCall) {
        runAsync(call) {
            call.resolve(LanSyncRuntime.status(context.applicationContext))
        }
    }

    /**
     * 开 / 关本机服务。
     *
     * 开 = HTTP 监听 + UDP 广播 + 前台服务；关 = 全停（含取消在途配对）。
     * 起不来时**回滚成关闭**并返回 `running:false`（不半开着跑）。
     */
    @PluginMethod
    fun setEnabled(call: PluginCall) {
        val enabled = call.getBoolean("enabled", false) ?: false
        runAsync(call) {
            val ctx = context.applicationContext
            if (enabled) {
                val started = LanSyncRuntime.ensureStarted(ctx)
                if (!started) {
                    Log.w(TAG, "setEnabled: runtime failed to start")
                } else {
                    try {
                        // 前台服务把进程钉住：没有它，息屏后对端就连不上了
                        LanSyncService.start(ctx)
                    } catch (e: Exception) {
                        Log.w(TAG, "foreground service start failed: ${e.javaClass.simpleName}")
                        LanSyncRuntime.stop()
                    }
                }
            } else {
                LanSyncRuntime.stop()
                try {
                    LanSyncService.stop(ctx)
                } catch (e: Exception) {
                    Log.w(TAG, "foreground service stop failed: ${e.javaClass.simpleName}")
                }
            }
            call.resolve(LanSyncRuntime.status(ctx))
        }
    }

    @PluginMethod
    fun rotateCode(call: PluginCall) {
        runAsync(call) {
            call.resolve(LanSyncRuntime.rotateCode(context.applicationContext))
        }
    }

    /** 发现对端：`timeoutMs` 默认 1200、上限 10000（与桌面端一致） */
    @PluginMethod
    fun discover(call: PluginCall) {
        val timeoutMs = call.getInt("timeoutMs")
        runAsync(call) {
            try {
                val peers = LanSyncRuntime.discover(timeoutMs)
                val array = JSArray()
                for (peer in peers) {
                    array.put(
                        JSObject()
                            .put("deviceId", peer.deviceId)
                            .put("deviceName", peer.deviceName)
                            .put("host", peer.host)
                            .put("port", peer.port)
                            .put("protocol", peer.protocol)
                            .put("lastSeenAt", peer.lastSeenAt),
                    )
                }
                call.resolve(JSObject().put("peers", array))
            } catch (e: Exception) {
                Log.w(TAG, "discover failed: ${e.javaClass.simpleName}")
                call.resolve(JSObject().put("peers", JSArray()))
            }
        }
    }

    /** 缓存本机快照供对端 `GET /v1/snapshot`（只缓存，不合并——合并是渲染层的职责） */
    @PluginMethod
    fun publish(call: PluginCall) {
        val snapshot = call.getObject("snapshot")
        if (snapshot == null) {
            call.reject(ERR_BAD_INPUT)
            return
        }
        runAsync(call) {
            val problem = LanSyncRuntime.publish(snapshot)
            if (problem == null) call.resolve() else call.reject(ERR_SNAPSHOT)
        }
    }

    /** 取走对端 PUT 进来的快照（取走即清空） */
    @PluginMethod
    fun takeInbox(call: PluginCall) {
        runAsync(call) {
            val snapshots = LanSyncRuntime.takeInbox()
            call.resolve(JSObject().put("snapshots", toJsonArray(snapshots)))
        }
    }

    /* ------------------------------------------------------------------ *
     * 对端收发
     * ------------------------------------------------------------------ */

    @PluginMethod
    fun pullPeer(call: PluginCall) {
        val target = parseTarget(call) ?: return
        runAsync(call) {
            try {
                val snapshots = LanSyncRuntime.pullPeer(context.applicationContext, target)
                call.resolve(JSObject().put("snapshots", toJsonArray(snapshots)))
            } catch (e: LanSyncPeerClient.PeerException) {
                call.reject(codeOf(e.kind))
            } catch (e: Exception) {
                Log.w(TAG, "pull failed: ${e.javaClass.simpleName}")
                call.reject(ERR_INTERNAL)
            }
        }
    }

    @PluginMethod
    fun pushPeer(call: PluginCall) {
        val target = parseTarget(call) ?: return
        val snapshot = call.getObject("snapshot")
        if (snapshot == null) {
            call.reject(ERR_BAD_INPUT)
            return
        }
        runAsync(call) {
            try {
                LanSyncRuntime.pushPeer(context.applicationContext, target, snapshot)
                call.resolve()
            } catch (e: LanSyncPeerClient.PeerException) {
                call.reject(codeOf(e.kind))
            } catch (e: Exception) {
                Log.w(TAG, "push failed: ${e.javaClass.simpleName}")
                call.reject(ERR_INTERNAL)
            }
        }
    }

    /* ------------------------------------------------------------------ *
     * 一键配对
     * ------------------------------------------------------------------ */

    /**
     * 发起配对：向对端请求 → 等对端用户点「允许」→ 换回对端配对码。
     *
     * 成功时对端码只在原生侧（`LanSyncStore` 暂存），渲染层随后用
     * `adoptPairedCode(configId, deviceId)` 把它落到配置名下——码不进渲染层。
     */
    @PluginMethod
    fun pairStart(call: PluginCall) {
        val peerObject = call.getObject("peer")
        if (peerObject == null) {
            call.reject(ERR_BAD_INPUT)
            return
        }
        val peer = LanSyncPairClient.PeerSpec(
            deviceId = peerObject.optString("deviceId", ""),
            deviceName = peerObject.optString("deviceName", ""),
            host = peerObject.optString("host", ""),
            port = peerObject.optInt("port", -1),
        )
        val pairId = LanSyncRuntime.newPairId()
        val token = LanSyncRuntime.registerOutgoing(pairId)
        if (token == null) {
            call.reject(ERR_INTERNAL)
            return
        }
        val ctx = context.applicationContext
        // 本机端口写进请求体供对端记录；服务没开时退默认端口（配对本身不依赖本机监听）
        val ownPort = LanSyncRuntime.currentPort() ?: LanSyncRuntime.DEFAULT_PORT
        try {
            pairWork.execute {
                val outcome = try {
                    LanSyncPairClient.start(ctx, peer, ownPort, token)
                } catch (e: Exception) {
                    Log.w(TAG, "pair start crashed: ${e.javaClass.simpleName}")
                    LanSyncPairClient.Outcome.Failure("invalid")
                }
                LanSyncRuntime.finishOutgoing(pairId, outcome)
                when (outcome) {
                    is LanSyncPairClient.Outcome.Success -> {
                        call.resolve(
                            JSObject()
                                .put("ok", true)
                                .put(
                                    "peer",
                                    JSObject()
                                        .put("deviceId", outcome.peer.deviceId)
                                        .put("deviceName", outcome.peer.deviceName)
                                        .put("host", outcome.peer.host)
                                        .put("port", outcome.peer.port),
                                ),
                        )
                    }
                    is LanSyncPairClient.Outcome.Failure -> {
                        call.resolve(JSObject().put("ok", false).put("reason", outcome.reason))
                    }
                }
            }
        } catch (e: RejectedExecutionException) {
            call.reject(ERR_INTERNAL)
        }
    }

    @PluginMethod
    fun pairRespond(call: PluginCall) {
        val pairId = call.getString("pairId")
        val accept = call.getBoolean("accept", false) ?: false
        if (pairId.isNullOrEmpty()) {
            call.reject(ERR_BAD_INPUT)
            return
        }
        runAsync(call) {
            val accepted = LanSyncRuntime.pairRespond(pairId, accept)
            call.resolve(JSObject().put("accepted", accepted))
        }
    }

    @PluginMethod
    fun pairCancel(call: PluginCall) {
        val pairId = call.getString("pairId")
        runAsync(call) {
            LanSyncRuntime.pairCancel(pairId)
            call.resolve()
        }
    }

    /**
     * 把配对换来的对端码写进按 `configId` 命名的凭证槽。
     *
     * 返回 `{ adopted: false }` = 没有可落的码（配对已过期/已被取走）或本机无法安全保存，
     * 调用方提示「请重新配对」。
     */
    @PluginMethod
    fun adoptPairedCode(call: PluginCall) {
        val configId = call.getString("configId", "") ?: ""
        val deviceId = call.getString("deviceId", "") ?: ""
        runAsync(call) {
            val adopted = try {
                LanSyncStore.adoptPairedCode(context.applicationContext, configId, deviceId)
            } catch (e: Exception) {
                Log.w(TAG, "adopt paired code failed: ${e.javaClass.simpleName}")
                false
            }
            call.resolve(JSObject().put("adopted", adopted))
        }
    }

    /* ------------------------------------------------------------------ *
     * 同步凭证（与 adoptPairedCode 同一套存储）
     * ------------------------------------------------------------------ */

    @PluginMethod
    fun saveCredential(call: PluginCall) {
        val configId = call.getString("configId", "") ?: ""
        val payloadObject = call.getObject("payload")
        val payload = LinkedHashMap<String, String>()
        val keys = payloadObject?.keys()
        if (keys != null) {
            while (keys.hasNext()) {
                val key = keys.next()
                val value = payloadObject.optString(key, "")
                if (value.isNotEmpty()) payload[key] = value
            }
        }
        runAsync(call) {
            val ctx = context.applicationContext
            try {
                val state = LanSyncStore.saveCredential(ctx, configId, payload)
                call.resolve(
                    JSObject()
                        .put("ok", true)
                        .put("saved", state.saved)
                        .put("encryptionAvailable", state.encryptionAvailable),
                )
            } catch (e: Exception) {
                Log.w(TAG, "save credential failed: ${e.javaClass.simpleName}")
                call.resolve(
                    JSObject()
                        .put("ok", false)
                        .put("saved", false)
                        .put("encryptionAvailable", LanSyncStore.isEncryptionAvailable()),
                )
            }
        }
    }

    @PluginMethod
    fun credentialState(call: PluginCall) {
        val configId = call.getString("configId", "") ?: ""
        runAsync(call) {
            val state = LanSyncStore.credentialState(context.applicationContext, configId)
            call.resolve(
                JSObject()
                    .put("saved", state.saved)
                    .put("encryptionAvailable", state.encryptionAvailable),
            )
        }
    }

    /** 未保存 / 解密失败时 resolve 空数据（JS 侧收到 undefined），不把空对象当「有凭证」 */
    @PluginMethod
    fun getCredential(call: PluginCall) {
        val configId = call.getString("configId", "") ?: ""
        runAsync(call) {
            val credential = LanSyncStore.readCredential(context.applicationContext, configId)
            if (credential == null) {
                call.resolve()
                return@runAsync
            }
            val out = JSObject()
            for ((key, value) in credential) out.put(key, value)
            call.resolve(out)
        }
    }

    @PluginMethod
    fun clearCredential(call: PluginCall) {
        val configId = call.getString("configId", "") ?: ""
        runAsync(call) {
            val state = try {
                LanSyncStore.clearCredential(context.applicationContext, configId)
            } catch (e: Exception) {
                LanSyncStore.CredentialState(false, LanSyncStore.isEncryptionAvailable())
            }
            call.resolve(
                JSObject()
                    .put("ok", true)
                    .put("saved", state.saved)
                    .put("encryptionAvailable", state.encryptionAvailable),
            )
        }
    }

    /* ------------------------------------------------------------------ *
     * 内部工具
     * ------------------------------------------------------------------ */

    /** 把短操作丢到 worker 线程；被拒（插件已销毁）时明确报错而不是静默吞掉 */
    private fun runAsync(call: PluginCall, block: () -> Unit) {
        try {
            work.execute {
                try {
                    block()
                } catch (e: Exception) {
                    Log.w(TAG, "plugin call failed: ${e.javaClass.simpleName}")
                    call.reject(ERR_INTERNAL)
                }
            }
        } catch (e: RejectedExecutionException) {
            call.reject(ERR_INTERNAL)
        }
    }

    /** 解析 `{ target: { host, port, code } }`；非法时直接 reject 并返回 null */
    private fun parseTarget(call: PluginCall): LanSyncPeerClient.Target? {
        val targetObject = call.getObject("target")
        if (targetObject == null) {
            call.reject(ERR_BAD_TARGET)
            return null
        }
        return try {
            LanSyncPeerClient.normalizeTarget(
                host = targetObject.optString("host", ""),
                port = targetObject.optInt("port", -1),
                code = targetObject.optString("code", ""),
            )
        } catch (e: LanSyncPeerClient.PeerException) {
            call.reject(if (e.kind == LanSyncPeerClient.ErrorKind.AUTH) ERR_AUTH else ERR_BAD_TARGET)
            null
        }
    }

    /** 对端错误分类 → JS 侧机器码 */
    private fun codeOf(kind: LanSyncPeerClient.ErrorKind): String = when (kind) {
        LanSyncPeerClient.ErrorKind.UNREACHABLE -> ERR_UNREACHABLE
        LanSyncPeerClient.ErrorKind.AUTH -> ERR_AUTH
        LanSyncPeerClient.ErrorKind.DISABLED -> ERR_DISABLED
        LanSyncPeerClient.ErrorKind.PROTOCOL -> ERR_PROTOCOL
        LanSyncPeerClient.ErrorKind.TOO_LARGE -> ERR_TOO_LARGE
        LanSyncPeerClient.ErrorKind.SNAPSHOT -> ERR_SNAPSHOT
        LanSyncPeerClient.ErrorKind.INVALID -> ERR_INTERNAL
    }

    private fun toJsonArray(items: List<JSONObject>): JSONArray {
        val array = JSONArray()
        for (item in items) array.put(item)
        return array
    }
}
