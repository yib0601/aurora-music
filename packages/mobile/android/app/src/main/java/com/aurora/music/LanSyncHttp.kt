package com.aurora.music

import android.util.Log
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit

/**
 * 手写的最小 HTTP/1.1 服务端（`ServerSocket` + 固定线程池）。
 *
 * ## 为什么手写而不是用框架
 *
 * 本模块已有的原生侧 HTTP 依赖是 OkHttp（只做**客户端**）。服务端在 Android 上没有
 * `HttpServer`（`com.sun.net.httpserver` 不在 Android SDK 里），要引一个内嵌 HTTP
 * 服务器就是新增依赖——任务约束明确不加依赖。而这里需要的 HTTP 子集极小：
 * 一条请求、一个 JSON 响应、`Connection: close`，不需要 chunked、不需要 keep-alive、
 * 不需要 multipart。手写 200 行比引一个框架更可控，失败模式也全在自己手里。
 *
 * ## 刻意不支持的东西（以及为什么安全）
 *
 * - **不解析 chunked**：两端客户端（桌面 `fetch`、本机 OkHttp）都会先算好
 *   `Content-Length` 再发 JSON；没有长度就没有可读的体，按空体处理（签名会失败 → 401）。
 * - **不做 keep-alive**：每条响应都带 `Connection: close` 并关闭 socket。
 *   代价是每次同步多一轮 TCP 握手（局域网毫秒级），收益是「连接数、超时、半开连接」
 *   这些状态全都不存在——手机被 Doze 掐的时候少一类悬挂资源。
 * - **只解析 `Host` 之外的少量头**：路由与验签只用 `x-aurora-*` 与 `Content-Length`。
 *
 * ## 端口顺延
 *
 * 默认 45871；被占用时 +1 顺延最多 20 次（与桌面端一致，发现包里公布**真实**端口）。
 * 其它错误（地址不可用）直接失败——换端口也解决不了。
 *
 * ## 线程
 *
 * 一个 accept 线程 + `newFixedThreadPool(4)`。线程都是 daemon：本服务是被
 * 前台服务拉起的附属资源，不能单独把进程留住（进程该由 `LanSyncService` 负责）。
 * `stop()` 会先置 running=false、再关 serverSocket（accept 抛 SocketException 退出），
 * 最后 `shutdownNow()`；worker 里的 socket 有 15s 读超时，不会永久挂住。
 */
internal class LanSyncHttpServer(
    private val basePort: Int,
    private val maxAttempts: Int,
    private val dispatch: (LanHttpRequest) -> LanHttpResponse,
) {

    private companion object {
        const val TAG = "AuroraLanSync"

        /** 单次请求体上限：快照几十 KB，5MB 已经是「明显不是快照」的界限 */
        const val MAX_BODY_BYTES = 5 * 1024 * 1024

        /** 请求行 + 头的总字节上限：防止一条垃圾连接把我们读爆 */
        const val MAX_HEADER_BYTES = 16 * 1024

        /** 单条连接的读超时：对端卡住时 worker 线程不能被永久占用 */
        const val SOCKET_TIMEOUT_MS = 15_000

        /** worker 线程数：一次同步最多两端并发，4 个足够且不会把内存顶起来 */
        const val WORKER_THREADS = 4
    }

    @Volatile
    private var running = false

    @Volatile
    private var port: Int = -1

    private var serverSocket: ServerSocket? = null
    private var acceptThread: Thread? = null
    private var pool = Executors.newFixedThreadPool(WORKER_THREADS, daemonFactory("aurora-lansync-http"))

    /** 绑定端口并开始 accept；返回**真实**监听端口。失败抛 IOException（调用方回滚） */
    fun start(): Int {
        if (running) return port
        var bound: ServerSocket? = null
        var lastError: Exception? = null
        for (attempt in 0 until maxAttempts) {
            val candidate = basePort + attempt
            val socket = ServerSocket()
            try {
                socket.reuseAddress = false
                socket.bind(InetSocketAddress(candidate))
                bound = socket
                port = candidate
                break
            } catch (e: Exception) {
                // 端口被占用才顺延；其它错误（地址不可用）换端口也没用，直接抛出
                lastError = e
                try {
                    socket.close()
                } catch (_: Exception) {
                    // 未绑定成功的 socket close 也可能抛错，忽略
                }
                if (e !is java.net.BindException) break
            }
        }
        val socket = bound ?: throw (lastError ?: IllegalStateException("lan sync http bind failed"))
        serverSocket = socket
        running = true
        acceptThread = Thread({ acceptLoop(socket) }, "aurora-lansync-accept").apply {
            isDaemon = true
            start()
        }
        Log.i(TAG, "http listening on $port")
        return port
    }

    fun stop() {
        if (!running && serverSocket == null) return
        running = false
        val socket = serverSocket
        serverSocket = null
        try {
            socket?.close()
        } catch (_: Exception) {
            // 关掉监听口即可，accept 会自己抛异常退出
        }
        acceptThread?.interrupt()
        acceptThread = null
        pool.shutdownNow()
        // 重建线程池，允许 stop 后再次 start（setEnabled 反复开关）
        pool = Executors.newFixedThreadPool(WORKER_THREADS, daemonFactory("aurora-lansync-http"))
        Log.i(TAG, "http stopped")
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (running) {
            val client = try {
                socket.accept()
            } catch (e: SocketException) {
                // running=false 时 close() 会让 accept 走到这里，属于正常退出
                break
            } catch (e: Exception) {
                if (!running) break
                // 个别 accept 失败（对端刚连就断）不该terminate整个监听
                Log.w(TAG, "accept failed: ${e.javaClass.simpleName}")
                continue
            }
            val executor = pool
            try {
                executor.execute { handleClient(client) }
            } catch (e: Exception) {
                // 线程池已 shutdown（正在停服务）：关掉这条连接
                closeQuietly(client)
            }
        }
    }

    private fun handleClient(client: Socket) {
        try {
            client.soTimeout = SOCKET_TIMEOUT_MS
            client.tcpNoDelay = true
            val input = BufferedInputStream(client.getInputStream())
            val parsed = readRequest(client, input)
            val request = when (parsed) {
                is RequestParse.Ok -> parsed.request
                RequestParse.TooLarge -> {
                    // 先判声明长度、不把 5MB+ 真读进来，再回 413
                    writeResponse(client.getOutputStream(), LanHttpResponse.error(413, "tooLarge"))
                    return
                }
                RequestParse.Bad -> {
                    // 连请求行都读不全/超长：按协议错误回 400，然后关连接
                    writeResponse(client.getOutputStream(), LanHttpResponse.error(400, "protocol"))
                    return
                }
            }
            val response = try {
                dispatch(request)
            } catch (e: Exception) {
                Log.w(TAG, "request dispatch failed: ${e.javaClass.simpleName}")
                LanHttpResponse.error(500, "internal")
            }
            writeResponse(client.getOutputStream(), response)
        } catch (e: Exception) {
            // 连接层面的意外（对端断开/超时）：没有可回的通道，记一条即可
            Log.w(TAG, "connection failed: ${e.javaClass.simpleName}")
        } finally {
            closeQuietly(client)
        }
    }

    /** 请求解析结果：区分「协议错误」（400）与「体超限」（413），两者状态码不同 */
    private sealed class RequestParse {
        class Ok(val request: LanHttpRequest) : RequestParse()
        object TooLarge : RequestParse()
        object Bad : RequestParse()
    }

    /** 解析请求 */
    private fun readRequest(client: Socket, input: InputStream): RequestParse {
        var headerBytes = 0

        fun readLine(limit: Int): String? {
            val buffer = ByteArrayOutputStream()
            while (true) {
                val b = input.read()
                if (b < 0) return null
                headerBytes += 1
                if (headerBytes > MAX_HEADER_BYTES) return null
                if (b == '\n'.code) break
                if (b == '\r'.code) continue
                buffer.write(b)
                if (buffer.size() > limit) return null
            }
            return String(buffer.toByteArray(), Charsets.ISO_8859_1)
        }

        val requestLine = readLine(8 * 1024) ?: return RequestParse.Bad
        val parts = requestLine.split(' ')
        if (parts.size < 3) return RequestParse.Bad
        val method = parts[0].uppercase()
        if (method.length > 16 || !method.all { it in 'A'..'Z' || it == '-' }) return RequestParse.Bad
        val target = parts[1]
        val version = parts[2]
        if (!version.startsWith("HTTP/1.")) return RequestParse.Bad

        val headers = HashMap<String, String>()
        while (true) {
            val line = readLine(8 * 1024) ?: return RequestParse.Bad
            if (line.isEmpty()) break
            val colon = line.indexOf(':')
            if (colon <= 0) continue
            val name = line.substring(0, colon).trim().lowercase()
            val value = line.substring(colon + 1).trim()
            if (name.isEmpty()) continue
            // 同名头只留第一个：本项目自定义头都只发一次，重复多半是伪造/坏客户端
            if (!headers.containsKey(name)) headers[name] = value
        }

        val body = when (val read = readBody(input, headers)) {
            null -> return RequestParse.Bad
            is BodyRead.TooLarge -> return RequestParse.TooLarge
            is BodyRead.Ok -> read.bytes
        }

        // query 只在未签名路由里用（pairId 是 32 位 hex），parse 失败不影响签名路径
        val queryStart = target.indexOf('?')
        val path = if (queryStart >= 0) target.substring(0, queryStart) else target
        val query = if (queryStart >= 0) parseQuery(target.substring(queryStart + 1)) else emptyMap()

        return RequestParse.Ok(
            LanHttpRequest(
                method = method,
                path = path,
                query = query,
                headers = headers,
                body = body,
                remoteAddress = client.inetAddress?.hostAddress ?: "",
            ),
        )
    }

    private sealed class BodyRead {
        class Ok(val bytes: ByteArray) : BodyRead()
        object TooLarge : BodyRead()
    }

    /**
     * 按 `Content-Length` 读体。
     *
     * **先判上限再读**：声明 5GB 的请求不该被真读进来再拒绝。没有 `Content-Length`
     * 就是空体（本协议两端都先算好长度，chunked 刻意不支持，见类注释）。
     */
    private fun readBody(input: InputStream, headers: Map<String, String>): BodyRead? {
        val raw = headers["content-length"] ?: return BodyRead.Ok(ByteArray(0))
        val length = raw.toLongOrNull() ?: return null
        if (length < 0) return null
        if (length > MAX_BODY_BYTES) return BodyRead.TooLarge
        val body = ByteArray(length.toInt())
        var read = 0
        while (read < body.size) {
            val n = input.read(body, read, body.size - read)
            if (n < 0) break
            read += n
        }
        if (read < body.size) return null
        return BodyRead.Ok(body)
    }

    private fun writeResponse(output: OutputStream, response: LanHttpResponse) {
        val bodyBytes = response.body.toString().toByteArray(Charsets.UTF_8)
        val head = buildString {
            append("HTTP/1.1 ").append(response.status).append(' ').append(statusText(response.status)).append("\r\n")
            append("Content-Type: application/json; charset=utf-8\r\n")
            append("Content-Length: ").append(bodyBytes.size).append("\r\n")
            append("Cache-Control: no-store\r\n")
            append("Connection: close\r\n")
            append("\r\n")
        }
        output.write(head.toByteArray(Charsets.ISO_8859_1))
        output.write(bodyBytes)
        output.flush()
    }

    private fun statusText(status: Int): String = when (status) {
        200 -> "OK"
        202 -> "Accepted"
        400 -> "Bad Request"
        401 -> "Unauthorized"
        403 -> "Forbidden"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        413 -> "Payload Too Large"
        else -> "Internal Server Error"
    }

    private fun parseQuery(raw: String): Map<String, String> {
        if (raw.isEmpty()) return emptyMap()
        val out = HashMap<String, String>()
        for (pair in raw.split('&')) {
            if (pair.isEmpty()) continue
            val eq = pair.indexOf('=')
            if (eq < 0) {
                out[pair] = ""
            } else {
                out[pair.substring(0, eq)] = percentDecode(pair.substring(eq + 1))
            }
        }
        return out
    }

    private fun percentDecode(value: String): String {
        if (value.indexOf('%') < 0 && value.indexOf('+') < 0) return value
        val out = ByteArrayOutputStream()
        var i = 0
        while (i < value.length) {
            val c = value[i]
            when {
                c == '+' -> out.write(' '.code)
                c == '%' && i + 2 < value.length -> {
                    val hex = value.substring(i + 1, i + 3)
                    val parsed = hex.toIntOrNull(16)
                    if (parsed == null) out.write(c.code) else out.write(parsed)
                    i += 2
                }
                else -> out.write(c.code)
            }
            i += 1
        }
        return String(out.toByteArray(), Charsets.UTF_8)
    }

    private fun closeQuietly(socket: Socket) {
        try {
            socket.close()
        } catch (_: Exception) {
            // 已经关了就算了
        }
    }

    private fun daemonFactory(name: String): ThreadFactory {
        var counter = 0
        return ThreadFactory { runnable ->
            Thread(runnable, "$name-${counter++}").apply {
                isDaemon = true
                // 未捕获异常不能让整个进程的线程池卡死
                setUncaughtExceptionHandler { _, _ -> }
            }
        }
    }
}

/** 已解析的请求（头名统一小写，与桌面端 `req.headers` 的处理口径一致） */
internal data class LanHttpRequest(
    val method: String,
    val path: String,
    val query: Map<String, String>,
    val headers: Map<String, String>,
    val body: ByteArray,
    val remoteAddress: String,
)

/** 一个 JSON 响应；状态码与体一起返回，避免路由层直接摸 socket */
internal class LanHttpResponse private constructor(
    val status: Int,
    val body: JSONObject,
) {
    companion object {
        fun json(status: Int, body: JSONObject = JSONObject()): LanHttpResponse =
            LanHttpResponse(status, body)

        fun error(status: Int, code: String): LanHttpResponse =
            LanHttpResponse(status, JSONObject().put("code", code))
    }
}
