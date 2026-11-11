package com.aurora.music

import android.content.Context
import android.util.Log
import com.getcapacitor.JSObject
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyPair
import java.security.PublicKey

/**
 * 局域网同步的进程级运行时：HTTP 服务 + UDP 发现 + 已发布快照 / 收件箱 + 配对状态。
 *
 * ## 为什么是单例 object 而不是插件实例的字段
 *
 * 服务（`LanSyncService`）与插件（`LanSyncPlugin`）是两套生命周期：Activity 重建时插件
 * 会被重新创建，而前台服务里的 HTTP 监听必须继续活着（WebView 被系统挂起时对端仍要能
 * 推快照）。所以状态放在进程级单例里，插件只是「调用方 + 事件出口」：
 * 插件 `load()` 时注入事件 sink，`handleOnDestroy()` 时摘掉。
 *
 * ## 收件箱语义
 *
 * `PUT /v1/snapshot` 进来的快照先进收件箱，由渲染层 `takeInbox()` 取走（**取走即清空**，
 * 避免同一份被重复应用）。按**来源设备**去重：每台设备只留 revision 最高的一份
 * （同 revision 重复 PUT 视为重试，不再触发事件），设备数上限 20，超出按 LRU 淘汰。
 * 理由与桌面端 `lanSyncServer.ts` 相同：对端在用户没打开面板时会重试推送，按条累积
 * 只会让同一台设备的旧快照把别台的挤掉。
 *
 * ## 配对状态都在内存
 *
 * pending 配对只在内存（TTL 120s）：它是一份「还没被任何人确认的临时协商」，
 * 落盘既没有恢复价值，还会多出一处凭据材料的副本。唯一需要跨调用保留的是
 * 换来的对端码，它由 `LanSyncStore.stagePairedCode` 暂存（同样只在内存）。
 */
internal object LanSyncRuntime {

    private const val TAG = "AuroraLanSync"

    /** 默认监听端口（文档 §7 固定值；对端「端口」字段默认也是它） */
    const val DEFAULT_PORT = 45871

    /** 端口顺延次数上限（含首个端口的尝试总数） */
    const val MAX_PORT_ATTEMPTS = 20

    /** 收件箱容量（按设备计：每台设备只留一份最新快照） */
    const val INBOX_LIMIT = 20

    /** 待处理配对上限（§16.5） */
    const val MAX_PENDING_PAIRS = 8

    private const val PATH_HELLO = "/v1/hello"
    private const val PATH_SNAPSHOT = "/v1/snapshot"
    private const val PATH_PAIR_REQUEST = "/v1/pair/request"
    private const val PATH_PAIR_STATUS = "/v1/pair/status"
    private const val PATH_PAIR_REPLY = "/v1/pair/reply"

    /** 事件名（与 shared 桥 / 桌面 IPC 的名字一一对应） */
    const val EVENT_INBOX = "inbox"
    const val EVENT_PAIR_REQUEST = "pairRequest"
    const val EVENT_PAIRED = "paired"

    /** 无 sink 时最多缓存多少条配对事件（正常只有个位数，上限只为防泄漏） */
    private const val MAX_QUEUED_EVENTS = 8

    private val lock = Any()
    private val nonceStore = LanNonceStore()

    @Volatile
    private var appContext: Context? = null

    @Volatile
    var enabled: Boolean = false
        private set

    @Volatile
    private var httpPort: Int? = null

    @Volatile
    private var httpServer: LanSyncHttpServer? = null

    @Volatile
    private var discovery: LanSyncDiscovery? = null

    /** 已发布快照（供对端 `GET /v1/snapshot`）；发布与读取都走 lock */
    private var published: JSONObject? = null

    /** 收件箱：来源 deviceId → 该设备 revision 最高的一份快照（插入顺序即 LRU 顺序） */
    private val inbox = LinkedHashMap<String, JSONObject>()

    /** 接收方待处理配对：pairId → 状态（含已 done 的短期条目，用于幂等重试） */
    private val incomingPairs = HashMap<String, IncomingPair>()

    /** 发起方未完成的配对：pairId → 取消句柄 */
    private val outgoingPairs = HashMap<String, LanSyncPairClient.CancelToken>()

    /** 事件出口（插件注入）；WebView 挂起/插件销毁时为空 */
    @Volatile
    private var eventSink: ((String, JSObject) -> Unit)? = null

    /** sink 为空期间攒下的配对事件（只缓存配对相关的小负载，快照不缓存——收件箱本身可再取） */
    private val queuedEvents = ArrayDeque<Pair<String, JSONObject>>()

    /* ------------------------------------------------------------------ *
     * 启动 / 停止
     * ------------------------------------------------------------------ */

    /**
     * 开启服务（幂等）：HTTP 监听 + UDP 广播。
     *
     * 失败时**不半开着跑**：任一环节起不来就回滚成关闭状态并返回 false
     * （与桌面端 `setEnabled` 的回滚语义一致）。端口被占满 / UDP 绑不上
     * 都是「这台设备当前不能用局域网同步」，而不是「部分可用」。
     */
    fun ensureStarted(context: Context): Boolean = synchronized(lock) {
        appContext = context.applicationContext
        if (enabled) return true
        val ctx = appContext ?: return false

        // 惰性初始化设备身份与配对码：pair code 读不出来时要生成本次会话用的那份
        val deviceId = LanSyncStore.deviceId(ctx)
        LanSyncStore.currentPairCode(ctx)

        val server = LanSyncHttpServer(DEFAULT_PORT, MAX_PORT_ATTEMPTS) { handle(it) }
        val port = try {
            server.start()
        } catch (e: Exception) {
            Log.w(TAG, "http server start failed: ${e.javaClass.simpleName}")
            return false
        }

        val lanDiscovery = LanSyncDiscovery(
            context = ctx,
            deviceId = deviceId,
            deviceName = LanSyncStore.deviceName(),
            getPort = { httpPort },
        )
        try {
            lanDiscovery.start()
        } catch (e: Exception) {
            Log.w(TAG, "discovery start failed: ${e.javaClass.simpleName}")
            server.stop()
            return false
        }

        httpServer = server
        discovery = lanDiscovery
        httpPort = port
        enabled = true
        Log.i(TAG, "service enabled on port $port (device ${prefix(deviceId)})")
        return true
    }

    /** 关闭服务（幂等）：关 HTTP、关 UDP、取消所有未完成配对。已发布快照与收件箱是内存态，保留 */
    fun stop() = synchronized(lock) {
        discovery?.stop()
        discovery = null
        httpServer?.stop()
        httpServer = null
        enabled = false
        httpPort = null
        for (token in outgoingPairs.values) token.cancel()
        outgoingPairs.clear()
        incomingPairs.clear()
        Log.i(TAG, "service disabled")
    }

    fun currentPort(): Int? = httpPort

    /** 本机服务状态（形状固定为 shared 的 `LanSyncStatus`） */
    fun status(context: Context): JSObject = synchronized(lock) {
        appContext = context.applicationContext
        val ctx = appContext ?: context.applicationContext
        JSObject()
            .put("running", enabled)
            .put("port", httpPort ?: JSONObject.NULL)
            .put("code", LanSyncStore.currentPairCode(ctx))
            .put("deviceId", LanSyncStore.deviceId(ctx))
            .put("deviceName", LanSyncStore.deviceName())
    }

    /** 轮换配对码：旧码派生的 key 立刻失效（服务端每请求现取），在途配对一并作废 */
    fun rotateCode(context: Context): JSObject = synchronized(lock) {
        LanSyncStore.rotatePairCode(context.applicationContext)
        // 已 accepted 但还没 reply 的配对是用旧码封的：留着会让对端拿到一个刚失效的码
        incomingPairs.clear()
        for (token in outgoingPairs.values) token.cancel()
        outgoingPairs.clear()
        Log.i(TAG, "pair code rotated")
        appContext = context.applicationContext
        JSObject()
            .put("running", enabled)
            .put("port", httpPort ?: JSONObject.NULL)
            .put("code", LanSyncStore.currentPairCode(context.applicationContext))
            .put("deviceId", LanSyncStore.deviceId(context.applicationContext))
            .put("deviceName", LanSyncStore.deviceName())
    }

    /* ------------------------------------------------------------------ *
     * 快照：发布 / 收件箱
     * ------------------------------------------------------------------ */

    /** 缓存本机快照供对端 GET；返回 null 表示成功，否则是对端可读的 400 code */
    fun publish(snapshot: JSONObject): String? {
        val problem = LanSyncSnapshot.problemOf(snapshot)
        if (problem != null) return problem
        // 深拷贝一份：缓存的对象要活着给后续 GET 用，不能是调用方那份可变引用
        val stored = try {
            JSONObject(snapshot.toString())
        } catch (_: Exception) {
            return LanSyncSnapshot.PROBLEM_INVALID
        }
        synchronized(lock) {
            // 只缓存，不合并：合并由渲染层引擎负责（两处各算一遍必然不一致）
            published = stored
        }
        Log.i(TAG, "snapshot published rev=${stored.optLong("revision", 0)}")
        return null
    }

    /** 取走收件箱（取走即清空） */
    fun takeInbox(): List<JSONObject> {
        synchronized(lock) {
            if (inbox.isEmpty()) return emptyList()
            val taken = inbox.values.toList()
            inbox.clear()
            return taken
        }
    }

    /** 收件箱快照（拷贝，**不清空**）——推 inbox 事件时用，让 takeInbox 仍是唯一消费者 */
    private fun inboxSnapshot(): List<JSONObject> = synchronized(lock) { inbox.values.toList() }

    /**
     * 把快照放进收件箱，返回它是否是该设备的**新**快照。
     *
     * - 同设备同/低 revision（重复 PUT、乱序重试）→ 不覆盖、不触发事件；
     * - 同设备更高 revision → 覆盖并把该设备挪到 LRU 队尾；
     * - 设备数超过 20 → 淘汰最久未更新的那台。
     */
    private fun pushInbox(snapshot: JSONObject): Boolean {
        val deviceId = snapshot.optString("deviceId", "")
        if (deviceId.isEmpty()) return false
        val revision = snapshot.optLong("revision", 0)
        synchronized(lock) {
            val existing = inbox[deviceId]
            if (existing != null && revision <= existing.optLong("revision", 0)) return false
            inbox.remove(deviceId)
            inbox[deviceId] = snapshot
            while (inbox.size > INBOX_LIMIT) {
                val oldest = inbox.keys.iterator()
                if (!oldest.hasNext()) break
                oldest.next()
                oldest.remove()
            }
            return true
        }
    }

    /* ------------------------------------------------------------------ *
     * 事件出口
     * ------------------------------------------------------------------ */

    /** 注入 / 摘除事件出口；注入时补发攒下的配对事件 */
    fun attachEventSink(sink: ((String, JSObject) -> Unit)?) {
        eventSink = sink
        if (sink == null) return
        val queued = synchronized(lock) {
            if (queuedEvents.isEmpty()) return
            val copy = queuedEvents.toList()
            queuedEvents.clear()
            copy
        }
        for ((name, payload) in queued) safeEmit(sink, name, payload)
    }

    private fun emit(name: String, payload: JSONObject) {
        val sink = eventSink
        if (sink != null) {
            safeEmit(sink, name, payload)
            return
        }
        // 没有 sink：只有配对相关的小负载值得攒——收件箱内容可以用 takeInbox() 再取一次
        if (name == EVENT_PAIR_REQUEST || name == EVENT_PAIRED) {
            synchronized(lock) {
                if (queuedEvents.size >= MAX_QUEUED_EVENTS) queuedEvents.removeFirst()
                queuedEvents.addLast(name to payload)
            }
        }
    }

    private fun safeEmit(sink: (String, JSObject) -> Unit, name: String, payload: JSONObject) {
        try {
            sink(name, JSObject.fromJSONObject(payload))
        } catch (e: Exception) {
            // 事件送达失败不该影响协议处理（收件箱还能靠 takeInbox 取）
            Log.w(TAG, "event deliver failed: ${e.javaClass.simpleName}")
        }
    }

    /* ------------------------------------------------------------------ *
     * HTTP 路由
     * ------------------------------------------------------------------ */

    /** 请求入口：由 `LanSyncHttpServer` 的 worker 线程调用（可能并发） */
    fun handle(request: LanHttpRequest): LanHttpResponse {
        if (!enabled) {
            // 关闭过程中仍有在途连接：一律 403，不暴露任何路由细节
            return LanHttpResponse.error(403, "disabled")
        }

        // 协议版本单独判：版本不符是 400（客户端结构没错，是版本不对）。
        // 缺 proto 头不算 400——它属于「没签名」，交给下面验签回 401 protocol。
        val protoHeader = request.headers[LanSyncCrypto.HEADER_PROTO]
        if (protoHeader != null && protoHeader != LanSyncCrypto.PROTOCOL_VERSION.toString()) {
            return LanHttpResponse.error(400, "protocol")
        }

        // §16.1：未认证路由只有 pair/request 与 pair/status
        if (request.path == PATH_PAIR_REQUEST && request.method == "POST") {
            return handlePairRequest(request)
        }
        if (request.path == PATH_PAIR_STATUS && request.method == "GET") {
            return handlePairStatus(request)
        }

        val context = appContext ?: return LanHttpResponse.error(500, "internal")
        val code = try {
            LanSyncStore.currentPairCode(context)
        } catch (e: Exception) {
            Log.w(TAG, "pair code unavailable: ${e.javaClass.simpleName}")
            return LanHttpResponse.error(500, "internal")
        }
        val failure = LanSyncCrypto.verifyRequest(
            key = LanSyncCrypto.deriveKey(code),
            method = request.method,
            path = request.path,
            headers = request.headers,
            body = request.body,
            now = System.currentTimeMillis(),
            nonceStore = nonceStore,
        )
        if (failure != null) {
            Log.w(
                TAG,
                "request rejected ${request.method} ${request.path} (${failure.wireCode}, " +
                    "from ${prefix(request.headers[LanSyncCrypto.HEADER_DEVICE].orEmpty())})",
            )
            return LanHttpResponse.error(401, failure.wireCode)
        }

        return when (request.path) {
            PATH_HELLO -> handleHello(request)
            PATH_SNAPSHOT -> handleSnapshot(request)
            PATH_PAIR_REPLY -> handlePairReply(request)
            else -> LanHttpResponse.error(404, "notFound")
        }
    }

    private fun handleHello(request: LanHttpRequest): LanHttpResponse {
        if (request.method != "GET") return LanHttpResponse.error(405, "method")
        val context = appContext ?: return LanHttpResponse.error(500, "internal")
        return LanHttpResponse.json(
            200,
            JSONObject()
                .put("proto", LanSyncCrypto.PROTOCOL_VERSION)
                .put("deviceId", LanSyncStore.deviceId(context))
                .put("deviceName", LanSyncStore.deviceName())
                .put("port", httpPort ?: 0),
        )
    }

    private fun handleSnapshot(request: LanHttpRequest): LanHttpResponse {
        if (request.method == "GET") {
            val snapshot = synchronized(lock) { published }
                ?: return LanHttpResponse.error(404, "empty")
            return LanHttpResponse.json(200, JSONObject().put("snapshot", snapshot))
        }
        if (request.method != "PUT") return LanHttpResponse.error(405, "method")

        val snapshot = LanSyncSnapshot.unwrap(request.body)
            ?: return LanHttpResponse.error(400, LanSyncSnapshot.PROBLEM_INVALID)
        val problem = LanSyncSnapshot.problemOf(snapshot)
        if (problem != null) return LanHttpResponse.error(400, problem)

        val accepted = pushInbox(snapshot)
        if (accepted) {
            Log.i(
                TAG,
                "snapshot accepted from ${prefix(snapshot.optString("deviceId"))} " +
                    "rev=${snapshot.optLong("revision", 0)}",
            )
            // 先落收件箱再通知：收件箱在事件回调里要能读到；重复 revision 不通知，
            // 否则对端的重试会把整份快照反复推给渲染层
            emit(EVENT_INBOX, JSONObject().put("snapshots", JSONArray(inboxSnapshot())))
        }
        return LanHttpResponse.json(
            202,
            JSONObject().put("accepted", true).put("revision", snapshot.optLong("revision", 0)),
        )
    }

    /* ------------------------------------------------------------------ *
     * 配对：应答方
     * ------------------------------------------------------------------ */

    /** 接收方的一条待处理配对（全在内存，TTL 到期即丢） */
    private class IncomingPair(
        val pairId: String,
        val peerDeviceId: String,
        val peerDeviceName: String,
        /** 对端地址一律取 TCP 源地址，不信 body 里自报的 host（§16.2） */
        val peerHost: String,
        /** 对端自报的 HTTP 端口（只在对话框/日志里有意义） */
        val peerPort: Int,
        val peerPublicKey: PublicKey,
        val keyPair: KeyPair,
        val createdAt: Long,
    ) {
        /** pending / accepted / denied / done */
        @Volatile
        var state: String = "pending"

        /** 本机码的密文（accept 时生成，供对端轮询取走） */
        @Volatile
        var sealed: String? = null
    }

    private fun handlePairRequest(request: LanHttpRequest): LanHttpResponse {
        val body = try {
            JSONObject(String(request.body, Charsets.UTF_8))
        } catch (_: Exception) {
            return LanHttpResponse.error(400, "protocol")
        }
        if (body.optInt("v", -1) != LanSyncCrypto.PROTOCOL_VERSION) {
            return LanHttpResponse.error(400, "protocol")
        }
        val pairId = body.optString("pairId", "")
        if (pairId.length != 32 || LanSyncCrypto.unhex(pairId) == null) {
            return LanHttpResponse.error(400, "protocol")
        }
        val peerDeviceId = body.optString("deviceId", "")
        if (peerDeviceId.isEmpty()) return LanHttpResponse.error(400, "protocol")
        val peerPort = body.optInt("port", -1)
        if (peerPort !in 1..65535) return LanHttpResponse.error(400, "protocol")
        val peerPublicRaw = LanSyncCrypto.unbase64(body.optString("pub", ""))
            ?: return LanHttpResponse.error(400, "protocol")
        val peerPublicKey = LanSyncCrypto.decodePublicPoint(peerPublicRaw)
            ?: return LanHttpResponse.error(400, "protocol")

        val context = appContext ?: return LanHttpResponse.error(500, "internal")
        val host = request.remoteAddress
        // 配对码也要从存储里现取一次：Keystore 惰性初始化必须发生在有人要用它之前
        LanSyncStore.currentPairCode(context)

        val pair = synchronized(lock) {
            prunePairs()
            if (incomingPairs.containsKey(pairId)) {
                // 同一 pairId 重复 request 视为重试（§16.5）：不再弹窗、不再入表
                return LanHttpResponse.json(202, JSONObject().put("state", "pending"))
            }
            // 同一 deviceId 只保留一个：新的顶掉旧的
            val stale = incomingPairs.values.filter { it.peerDeviceId == peerDeviceId && it.state == "pending" }
            for (entry in stale) incomingPairs.remove(entry.pairId)
            // 上限只算「还没走完」的条目：done 的条目还要留 TTL 做幂等重试，
            // 不能让它们占住名额把新设备挡在 409 外面
            val active = incomingPairs.values.count { it.state == "pending" || it.state == "accepted" }
            if (active >= MAX_PENDING_PAIRS) {
                return LanHttpResponse.error(409, "busy")
            }
            IncomingPair(
                pairId = pairId,
                peerDeviceId = peerDeviceId,
                peerDeviceName = body.optString("deviceName", ""),
                peerHost = host,
                peerPort = peerPort,
                peerPublicKey = peerPublicKey,
                keyPair = LanSyncCrypto.generateEcKeyPair(),
                createdAt = System.currentTimeMillis(),
            ).also { incomingPairs[pairId] = it }
        }

        Log.i(TAG, "pair request from ${prefix(peerDeviceId)} pairId=${prefix(pairId)}")
        // 弹窗要显示「谁在请求」，负载形状见 shared `LanPairRequest`
        emit(
            EVENT_PAIR_REQUEST,
            JSONObject()
                .put("pairId", pairId)
                .put("deviceId", peerDeviceId)
                .put("deviceName", pair.peerDeviceName)
                .put("host", host)
                .put("port", peerPort)
                .put("expiresAt", pair.createdAt + LanSyncPairClient.TTL_MS),
        )
        return LanHttpResponse.json(202, JSONObject().put("state", "pending"))
    }

    private fun handlePairStatus(request: LanHttpRequest): LanHttpResponse {
        val pair = lookupPair(request.query["pairId"])
            ?: return LanHttpResponse.error(404, "unknown")
        val context = appContext ?: return LanHttpResponse.error(500, "internal")

        return when (pair.state) {
            "pending" -> LanHttpResponse.json(200, JSONObject().put("state", "pending"))
            "denied" -> LanHttpResponse.json(200, JSONObject().put("state", "denied"))
            "accepted" -> {
                val myPublic = LanSyncCrypto.encodePublicPoint(pair.keyPair.public)
                val sealed = pair.sealed
                if (myPublic == null || sealed == null) {
                    LanHttpResponse.error(404, "unknown")
                } else {
                    LanHttpResponse.json(
                        200,
                        JSONObject()
                            .put("state", "accepted")
                            .put("deviceId", LanSyncStore.deviceId(context))
                            .put("deviceName", LanSyncStore.deviceName())
                            .put("port", httpPort ?: 0)
                            .put("pub", LanSyncCrypto.base64(myPublic))
                            .put("sealed", sealed),
                    )
                }
            }
            // done 的条目只剩「幂等重试 reply」这一个用途，status 一律当作不认识
            else -> LanHttpResponse.error(404, "unknown")
        }
    }

    private fun handlePairReply(request: LanHttpRequest): LanHttpResponse {
        val queryPairId = request.query["pairId"]
        val body = try {
            JSONObject(String(request.body, Charsets.UTF_8))
        } catch (_: Exception) {
            return LanHttpResponse.error(400, "protocol")
        }
        if (body.optInt("v", -1) != LanSyncCrypto.PROTOCOL_VERSION) {
            return LanHttpResponse.error(400, "protocol")
        }
        if (queryPairId != null && body.optString("pairId", queryPairId) != queryPairId) {
            return LanHttpResponse.error(400, "protocol")
        }
        val pair = lookupPair(queryPairId) ?: return LanHttpResponse.error(404, "unknown")

        // 幂等：对已 done 的 pairId 直接回 200（§16.4）
        if (pair.state == "done") return LanHttpResponse.json(200, JSONObject().put("state", "done"))
        if (pair.state != "accepted") return LanHttpResponse.error(404, "unknown")

        val shared = LanSyncCrypto.sharedSecret(pair.keyPair.private, pair.peerPublicKey)
            ?: return LanHttpResponse.error(401, "auth")
        val pairKey = LanSyncCrypto.pairKey(shared)
        val peerCode = LanSyncCrypto.openSealedPairCode(
            pairKey,
            pair.pairId,
            body.optString("sealed", ""),
        )?.let { LanSyncCrypto.normalizePairCode(it) }
            ?: run {
                Log.w(TAG, "pair reply sealed rejected pairId=${prefix(pair.pairId)}")
                return LanHttpResponse.error(401, "auth")
            }

        pair.state = "done"
        LanSyncStore.stagePairedCode(pair.peerDeviceId, peerCode)
        Log.i(TAG, "pair done with ${prefix(pair.peerDeviceId)} pairId=${prefix(pair.pairId)}")
        emit(
            EVENT_PAIRED,
            JSONObject()
                .put("deviceId", pair.peerDeviceId)
                .put("deviceName", pair.peerDeviceName)
                .put("host", pair.peerHost)
                .put("port", pair.peerPort),
        )
        return LanHttpResponse.json(200, JSONObject().put("state", "done"))
    }

    /** 按 pairId 取一条未过期的配对（过期项先清掉） */
    private fun lookupPair(pairId: String?): IncomingPair? {
        if (pairId.isNullOrEmpty()) return null
        synchronized(lock) {
            prunePairs()
            return incomingPairs[pairId]
        }
    }

    /** 清理过期条目：pending/accepted 到 TTL 就丢；done 只留 TTL 以便幂等重试 */
    private fun prunePairs() {
        val now = System.currentTimeMillis()
        val expired = incomingPairs.values.filter { now - it.createdAt > LanSyncPairClient.TTL_MS }
        for (entry in expired) incomingPairs.remove(entry.pairId)
    }

    /**
     * 应答配对请求（渲染层弹框的「允许 / 拒绝」）。
     *
     * 允许时立刻用临时 ECDH 派生 `K_pair` 并**封好本机配对码**留给对端轮询取走；
     * 码本身不进事件、不进日志，对端是唯一接收者。
     */
    fun pairRespond(pairId: String, accept: Boolean): Boolean {
        val pair = lookupPair(pairId) ?: return false
        if (pair.state != "pending") return accept && pair.state == "accepted"
        if (!accept) {
            pair.state = "denied"
            Log.i(TAG, "pair request denied pairId=${prefix(pairId)}")
            return true
        }
        val context = appContext ?: return false
        val shared = LanSyncCrypto.sharedSecret(pair.keyPair.private, pair.peerPublicKey)
            ?: return false
        val pairKey = LanSyncCrypto.pairKey(shared)
        val myCode = LanSyncStore.currentPairCode(context)
        val sealed = LanSyncCrypto.sealPairCode(pairKey, pair.pairId, myCode) ?: return false
        pair.sealed = sealed
        pair.state = "accepted"
        Log.i(TAG, "pair request accepted pairId=${prefix(pairId)}")
        return true
    }

    /** 撤销未完成的配对（幂等）：发起方的轮询句柄置位，未 reply 的接收方条目直接丢掉 */
    fun pairCancel(pairId: String?) {
        synchronized(lock) {
            if (pairId == null) {
                for (token in outgoingPairs.values) token.cancel()
                outgoingPairs.clear()
                return
            }
            outgoingPairs.remove(pairId)?.cancel()
            incomingPairs.remove(pairId)
        }
    }

    /* ------------------------------------------------------------------ *
     * 配对：发起方
     * ------------------------------------------------------------------ */

    /** 登记一次发起的配对（供 `pairCancel` 中断）；返回 null 表示同一 pairId 已在跑 */
    fun registerOutgoing(pairId: String): LanSyncPairClient.CancelToken? = synchronized(lock) {
        if (outgoingPairs.containsKey(pairId)) return null
        val token = LanSyncPairClient.CancelToken(pairId)
        outgoingPairs[pairId] = token
        token
    }

    /** 发起配对结束：注销句柄；成功时暂存对端码（等渲染层 `adoptPairedCode` 落盘） */
    fun finishOutgoing(pairId: String, outcome: LanSyncPairClient.Outcome) {
        synchronized(lock) { outgoingPairs.remove(pairId) }
        when (outcome) {
            is LanSyncPairClient.Outcome.Success -> {
                LanSyncStore.stagePairedCode(outcome.peer.deviceId, outcome.peerCode)
                Log.i(TAG, "pair start succeeded with ${prefix(outcome.peer.deviceId)}")
            }
            is LanSyncPairClient.Outcome.Failure -> {
                // 失败原因只记分类码，不记任何凭据材料
                Log.i(TAG, "pair start failed: ${outcome.reason}")
            }
        }
    }

    /** 生成本次配对的 pairId（16 字节随机 hex，既是幂等键也是 AEAD 的 AAD） */
    fun newPairId(): String = LanSyncCrypto.randomHex(16)

    /* ------------------------------------------------------------------ *
     * 对端收发（插件直接调）
     * ------------------------------------------------------------------ */

    fun pullPeer(context: Context, target: LanSyncPeerClient.Target): List<JSONObject> =
        LanSyncPeerClient.pull(context.applicationContext, target)

    fun pushPeer(context: Context, target: LanSyncPeerClient.Target, snapshot: JSONObject) =
        LanSyncPeerClient.push(context.applicationContext, target, snapshot)

    fun discover(timeoutMs: Int?): List<LanSyncDiscovery.Peer> = discovery?.discover(timeoutMs) ?: emptyList()

    /* ------------------------------------------------------------------ *
     * 工具
     * ------------------------------------------------------------------ */

    private fun prefix(value: String?): String {
        if (value.isNullOrEmpty()) return "unknown"
        return if (value.length > 8) value.substring(0, 8) else value
    }
}
