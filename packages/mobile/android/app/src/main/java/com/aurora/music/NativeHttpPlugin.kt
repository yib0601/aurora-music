package com.aurora.music

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * Capacitor 插件：允许**任意 HTTP 动词**与**二进制读体**的原生 HTTP 桥。
 *
 * ## 为什么不能继续用 CapacitorHttp
 *
 * Capacitor 的 `CapacitorHttp` 在 Android 上最终调 `HttpURLConnection.setRequestMethod`，
 * 而它只放行 RFC 2616 的那几个动词（GET/HEAD/POST/PUT/DELETE/OPTIONS/TRACE），
 * `PROPFIND` 会直接抛 `ProtocolException`（JDK 自 1.6 起的既有行为，见 JDK-7017158）。
 * WebDAV 列目录只有 PROPFIND 一条路，所以网络存储必须走 OkHttp —— 它接受任意
 * method 字符串。
 *
 * 第二个理由是二进制：`CapacitorHttp` 的文本通道会把响应当字符串解码，
 * 音频字节（元数据头 / 封面）走那条路会损坏；这里用 base64 原样回传。
 *
 * ## 约定
 *
 * - 入参：`{ url, method, headers?, body? }`；`body` 只支持字符串（本项目唯一的
 *   自定义动词请求是 WebDAV 的 PROPFIND，体就是 XML 文本）
 * - 出参：`{ status, headers, data }`，`data` 为 **base64**（空体为空串）
 * - 失败：reject 的 message 是**机器可读的码**（`NETWORK_ERROR` / `READ_ERROR` /
 *   `BODY_TOO_LARGE`），由 JS 侧决定怎么呈现，这里不烧任何给用户看的句子
 *
 * 响应体上限 32 MiB：本插件的调用方只读"文件头"（≤1 MiB）与目录清单，
 * 真按整文件来就会把手机内存打爆 —— 宁可明确拒绝，也不要无声地 OOM。
 */
@CapacitorPlugin(name = "NativeHttp")
class NativeHttpPlugin : Plugin() {

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    @PluginMethod
    fun request(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) {
            call.reject("BAD_URL")
            return
        }
        val method = (call.getString("method") ?: "GET").uppercase()
        val methodIsSafe = method == "GET" || method == "HEAD"
        val headers = call.getObject("headers") ?: JSObject()
        val bodyText = call.getString("body")

        val builder = Request.Builder().url(url)
        var contentType: String? = null
        val names = headers.keys()
        while (names.hasNext()) {
            val name = names.next()
            val value = headers.getString(name) ?: continue
            if (name.equals("Content-Type", ignoreCase = true)) contentType = value
            try {
                builder.header(name, value)
            } catch (_: IllegalArgumentException) {
                // OkHttp 对非法头名会抛错：跳过这一条，别让一个坏头把整次请求打挂
            }
        }

        // GET/HEAD 必须无体，其余动词按需带体（PROPFIND 的 XML 就在体里）
        val requestBody = if (methodIsSafe) {
            null
        } else {
            (bodyText ?: "").toRequestBody((contentType ?: "application/xml; charset=utf-8").toMediaType())
        }
        try {
            builder.method(method, requestBody)
        } catch (e: IllegalArgumentException) {
            call.reject("BAD_METHOD", e)
            return
        }

        client.newCall(builder.build()).enqueue(object : Callback {
            // 形参不能叫 call：那会遮住外层的 PluginCall。Kotlin 对"重写改了形参名"发警告，
            // 这里显式抑制（改名的收益是保住外层那个必须用的 call）。
            @Suppress("PARAMETER_NAME_CHANGED_ON_OVERRIDE")
            override fun onFailure(httpCall: Call, e: IOException) {
                call.reject("NETWORK_ERROR", e)
            }

            @Suppress("PARAMETER_NAME_CHANGED_ON_OVERRIDE")
            override fun onResponse(httpCall: Call, response: Response) {
                response.use { resp ->
                    val payload: ByteArray
                    try {
                        payload = readBody(resp.body, MAX_BODY_BYTES)
                    } catch (e: IOException) {
                        call.reject("READ_ERROR", e)
                        return
                    } catch (e: IllegalStateException) {
                        // 超上限：明确拒绝，不静默截断（截断的 XML / 音频头更难排查）
                        call.reject("BODY_TOO_LARGE", e)
                        return
                    }
                    val out = JSObject()
                    out.put("status", resp.code)
                    val headersOut = JSObject()
                    for (name in resp.headers.names()) {
                        headersOut.put(name, resp.headers.values(name).joinToString(", "))
                    }
                    out.put("headers", headersOut)
                    out.put("data", Base64.encodeToString(payload, Base64.NO_WRAP))
                    call.resolve(out)
                }
            }
        })
    }

    /** 读完整个响应体，超过 `limit` 抛 IllegalStateException（由调用方转成 BODY_TOO_LARGE） */
    private fun readBody(body: okhttp3.ResponseBody?, limit: Long): ByteArray {
        if (body == null) return ByteArray(0)
        val declared = body.contentLength()
        if (declared > limit) throw IllegalStateException("body too large: $declared")
        val stream: InputStream = body.byteStream()
        val buffer = java.io.ByteArrayOutputStream()
        val chunk = ByteArray(8 * 1024)
        var total = 0L
        while (true) {
            val read = stream.read(chunk)
            if (read < 0) break
            total += read
            if (total > limit) throw IllegalStateException("body too large: $total")
            buffer.write(chunk, 0, read)
        }
        return buffer.toByteArray()
    }

    private companion object {
        /** 响应体上限：调用方只需要文件头与目录清单 */
        const val MAX_BODY_BYTES = 32L * 1024 * 1024
    }
}
