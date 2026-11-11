package com.aurora.music

import android.content.Context
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.concurrent.TimeUnit

/**
 * 快照形状校验（两端共用口径的客户端侧版本）。
 *
 * 桌面端用 shared 的 `parseSnapshot` 做逐条校验与归一化；Android 侧只有 `org.json`，
 * 所以这里只做**外壳**校验：格式版本、`playlists`/`likes` 的容器类型。
 * 逐条曲目字段的深校验留给渲染层（它在 JS 里本来就要过 `parseSnapshot`），
 * 原生侧拒绝「结构不明」的整份快照，就已经挡住了「一台上古对端把本机同步搞挂」。
 */
internal object LanSyncSnapshot {

    /** 快照格式标识；major 不同即拒绝（见 §5 与 shared `SYNC_SNAPSHOT_FORMAT`） */
    const val FORMAT = "aurora-playlist-sync/1"

    /** 校验失败原因，对应服务端 400 的两种 code */
    const val PROBLEM_INVALID = "snapshot"
    const val PROBLEM_VERSION = "snapshotVersion"

    /** 返回 null 表示外壳合法；否则返回对应 400 code */
    fun problemOf(snapshot: JSONObject?): String? {
        if (snapshot == null) return PROBLEM_INVALID
        val format = snapshot.optString("format", "")
        if (format.isEmpty()) return PROBLEM_INVALID
        if (format != FORMAT) return PROBLEM_VERSION
        if (snapshot.optString("deviceId", "").isEmpty()) return PROBLEM_INVALID
        if (!(snapshot.opt("playlists") is JSONArray)) return PROBLEM_INVALID
        // likes 可选，但给了就必须是数组（缺失与 [] 语义不同，见 shared `SyncSnapshot.likes`）
        val likes = snapshot.opt("likes")
        if (likes != null && likes !is JSONArray) return PROBLEM_INVALID
        return null
    }

    /** 从 PUT 的体里取快照：接受 `{ snapshot }` 包装或裸快照对象（与桌面端同口径） */
    fun unwrap(body: ByteArray): JSONObject? {
        val parsed = try {
            JSONObject(String(body, Charsets.UTF_8))
        } catch (_: Exception) {
            return null
        }
        // 包装形式：{"snapshot": {...}}；裸快照带着自己的 format 字段，不会被误判成包装
        val wrapped = parsed.optJSONObject("snapshot")
        return wrapped ?: parsed
    }
}

/**
 * 对端请求的客户端实现（OkHttp，签名 GET/PUT 与未签名的配对请求）。
 *
 * ## 为什么客户端用 OkHttp 而服务端手写
 *
 * 请求侧不需要「长期持有监听端口」，用现成客户端最省事；项目已依赖 OkHttp
 * （`NativeHttpPlugin`），不新增依赖。服务端没有可用库，只能手写（见 `LanSyncHttpServer`）。
 *
 * ## 签名头与桌面端逐个对齐
 *
 * `x-aurora-proto/ts/nonce/sig/device` 五个头，`path` 用 `/v1/snapshot`（不含 query）。
 * 每个请求现生成 nonce，`ts = System.currentTimeMillis()`：手机时钟可能偏，服务端给 ±300s。
 *
 * ## 错误分类
 *
 * 网络层失败一律 `unreachable`，其余按 HTTP 状态映射；上层把它们翻成机器码 reject，
 * 不在原生侧拼给人看的句子（文案在 i18n 字典里）。
 */
internal object LanSyncPeerClient {

    private const val TAG = "AuroraLanSync"

    /** 对端请求超时：局域网内 8s 足够；超时按「不可达」处理（与桌面端一致） */
    private const val TIMEOUT_MS = 8_000L

    /** 响应体上限：快照几十 KB，5MB 已经是「明显不是快照」的界限 */
    private const val MAX_BODY_BYTES = 5 * 1024 * 1024

    private const val PATH_SNAPSHOT = "/v1/snapshot"
    private const val PATH_PAIR_REQUEST = "/v1/pair/request"
    private const val PATH_PAIR_STATUS = "/v1/pair/status"
    private const val PATH_PAIR_REPLY = "/v1/pair/reply"

    /** 本模块的错误分类（上层翻成 `LAN_*` 机器码） */
    enum class ErrorKind { UNREACHABLE, AUTH, DISABLED, PROTOCOL, TOO_LARGE, SNAPSHOT, INVALID }

    class PeerException(val kind: ErrorKind) : Exception(kind.name)

    /** 归一化后的对端目标（host/port/code 全部来自渲染层，按不可信输入处理） */
    data class Target(val host: String, val port: Int, val code: String)

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .readTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .writeTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .build()
    }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    /**
     * 校验并归一化一条目标。
     *
     * host 只做「非空 + 无控制字符/空白」的粗校验：局域网里可能是 IPv4 字面量，
     * 也可能是 mDNS 名（`xxx.local`），还可能是用户手填的主机名。真正的可用性由连接决定。
     */
    fun normalizeTarget(host: String?, port: Int?, code: String?): Target {
        val cleanHost = host?.trim().orEmpty()
        val cleanPort = port ?: -1
        if (cleanHost.isEmpty() || cleanHost.any { it.isWhitespace() || it.isISOControl() }) {
            throw PeerException(ErrorKind.INVALID)
        }
        if (cleanPort < 1 || cleanPort > 65535) throw PeerException(ErrorKind.INVALID)
        val normalizedCode = LanSyncCrypto.normalizePairCode(code)
            ?: throw PeerException(ErrorKind.AUTH)
        return Target(cleanHost, cleanPort, normalizedCode)
    }

    /* ------------------------------------------------------------------ *
     * 签名 GET / PUT
     * ------------------------------------------------------------------ */

    /** 拉对端快照：404（对端还没发布）是正常空态，返回空列表 */
    fun pull(context: Context, target: Target): List<JSONObject> {
        val response = execute(
            signRequest(
                context = context,
                target = target,
                method = "GET",
                path = PATH_SNAPSHOT,
                body = ByteArray(0),
            ),
        )
        val status = response.code
        val text = readBody(response)
        when {
            status == 404 -> {
                Log.i(TAG, "pull empty ${target.host}:${target.port}")
                return emptyList()
            }
            status == 401 -> throw PeerException(ErrorKind.AUTH)
            status == 403 -> throw PeerException(ErrorKind.DISABLED)
            status == 400 -> throw PeerException(ErrorKind.PROTOCOL)
            status == 413 -> throw PeerException(ErrorKind.TOO_LARGE)
            status !in 200..299 -> throw PeerException(ErrorKind.INVALID)
        }
        val payload = try {
            JSONObject(text)
        } catch (_: Exception) {
            throw PeerException(ErrorKind.INVALID)
        }
        val snapshot = payload.optJSONObject("snapshot") ?: throw PeerException(ErrorKind.SNAPSHOT)
        if (LanSyncSnapshot.problemOf(snapshot) != null) throw PeerException(ErrorKind.SNAPSHOT)
        Log.i(TAG, "pull ok ${target.host}:${target.port} rev=${snapshot.optLong("revision", 0)}")
        return listOf(snapshot)
    }

    /**
     * 推本机快照到对端（签名 PUT）。
     *
     * 体用 `{ snapshot }` 包装：与桌面端 `pushToPeer` 逐字节一致，老对端也只认这种形状。
     */
    fun push(context: Context, target: Target, snapshot: JSONObject) {
        val problem = LanSyncSnapshot.problemOf(snapshot)
        if (problem != null) throw PeerException(ErrorKind.SNAPSHOT)
        val body = JSONObject().put("snapshot", snapshot).toString().toByteArray(Charsets.UTF_8)
        val response = execute(
            signRequest(
                context = context,
                target = target,
                method = "PUT",
                path = PATH_SNAPSHOT,
                body = body,
            ),
        )
        val status = response.code
        readBody(response)
        when {
            status in 200..299 -> {
                Log.i(TAG, "push ok ${target.host}:${target.port} rev=${snapshot.optLong("revision", 0)}")
                return
            }
            status == 401 -> throw PeerException(ErrorKind.AUTH)
            status == 403 -> throw PeerException(ErrorKind.DISABLED)
            status == 400 -> throw PeerException(ErrorKind.PROTOCOL)
            status == 413 -> throw PeerException(ErrorKind.TOO_LARGE)
            else -> throw PeerException(ErrorKind.INVALID)
        }
    }

    private fun signRequest(
        context: Context,
        target: Target,
        method: String,
        path: String,
        body: ByteArray,
    ): Request {
        val key = LanSyncCrypto.deriveKey(target.code)
        val headers = LanSyncCrypto.signHeaders(
            key = key,
            method = method,
            path = path,
            ts = System.currentTimeMillis(),
            nonce = LanSyncCrypto.randomHex(16),
            body = body,
            deviceId = LanSyncStore.deviceId(context),
        )
        val builder = Request.Builder().url(urlOf(target, path))
        for ((name, value) in headers) builder.header(name, value)
        val requestBody = if (method == "GET" || method == "HEAD") {
            null
        } else {
            body.toRequestBody(jsonMediaType)
        }
        return builder.method(method, requestBody).build()
    }

    /* ------------------------------------------------------------------ *
     * 一键配对（未签名路由 + 用对端码签名的 reply）
     * ------------------------------------------------------------------ */

    /** `POST /v1/pair/request`（无认证，见 §16.2）。返回 HTTP 状态码与响应体 */
    fun pairRequest(peerHost: String, peerPort: Int, body: JSONObject): PairHttpResult =
        executePlain(
            request = Request.Builder()
                .url(urlOf(peerHost, peerPort, PATH_PAIR_REQUEST))
                .post(body.toString().toByteArray(Charsets.UTF_8).toRequestBody(jsonMediaType))
                .build(),
        )

    /** `GET /v1/pair/status?pairId=...`（无认证）。pairId 是 32 位 hex，无需转义 */
    fun pairStatus(peerHost: String, peerPort: Int, pairId: String): PairHttpResult =
        executePlain(
            request = Request.Builder()
                .url(urlOf(peerHost, peerPort, "$PATH_PAIR_STATUS?pairId=$pairId"))
                .get()
                .build(),
        )

    /** `POST /v1/pair/reply?pairId=...`（**HMAC**，密钥 = 对端这次给出的配对码） */
    fun pairReply(
        context: Context,
        peerHost: String,
        peerPort: Int,
        pairId: String,
        peerCode: String,
        body: JSONObject,
    ): PairHttpResult {
        val path = PATH_PAIR_REPLY
        val url = urlOf(peerHost, peerPort, "$path?pairId=$pairId")
        val rawBody = body.toString().toByteArray(Charsets.UTF_8)
        val key = LanSyncCrypto.deriveKey(peerCode)
        val headers = LanSyncCrypto.signHeaders(
            key = key,
            method = "POST",
            path = path,
            ts = System.currentTimeMillis(),
            nonce = LanSyncCrypto.randomHex(16),
            body = rawBody,
            deviceId = LanSyncStore.deviceId(context),
        )
        val builder = Request.Builder().url(url).post(rawBody.toRequestBody(jsonMediaType))
        for ((name, value) in headers) builder.header(name, value)
        return executePlain(builder.build())
    }

    data class PairHttpResult(val status: Int, val json: JSONObject?)

    private fun executePlain(request: Request): PairHttpResult = try {
        client.newCall(request).execute().use { response ->
            PairHttpResult(response.code, parseJson(readBody(response)))
        }
    } catch (e: Exception) {
        throw PeerException(ErrorKind.UNREACHABLE)
    }

    private fun execute(request: Request): Response = try {
        client.newCall(request).execute()
    } catch (e: Exception) {
        // 局域网里连不上（对端没开服务 / 防火墙 / 换了网段）是最常见的失败
        Log.w(TAG, "peer request failed: ${e.javaClass.simpleName}")
        throw PeerException(ErrorKind.UNREACHABLE)
    }

    private fun readBody(response: Response): String {
        val body = response.body
        if (body == null) {
            response.close()
            return ""
        }
        return body.use {
            if (body.contentLength() > MAX_BODY_BYTES) throw PeerException(ErrorKind.TOO_LARGE)
            val stream: InputStream = body.byteStream()
            val out = ByteArrayOutputStream()
            val chunk = ByteArray(8 * 1024)
            var total = 0
            while (true) {
                val read = stream.read(chunk)
                if (read < 0) break
                total += read
                if (total > MAX_BODY_BYTES) throw PeerException(ErrorKind.TOO_LARGE)
                out.write(chunk, 0, read)
            }
            String(out.toByteArray(), Charsets.UTF_8)
        }
    }

    private fun parseJson(text: String): JSONObject? {
        if (text.isEmpty()) return null
        return try {
            JSONObject(text)
        } catch (_: Exception) {
            null
        }
    }

    /** URL 拼装：IPv6 字面量要加方括号，否则解析会把地址当主机名（与桌面端一致） */
    private fun urlOf(target: Target, path: String): String = urlOf(target.host, target.port, path)

    private fun urlOf(host: String, port: Int, path: String): String {
        val normalized = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
        return "http://$normalized:$port$path"
    }
}
