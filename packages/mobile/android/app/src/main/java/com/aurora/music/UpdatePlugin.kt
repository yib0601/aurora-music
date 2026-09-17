package com.aurora.music

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Capacitor 插件：Android 应用内更新（下载 APK + 调起系统安装器）。
 *
 * 下载实现用原生 HttpURLConnection 流式写文件，而不是系统 DownloadManager：
 * DownloadManager 依赖 android.providers.downloads 服务，部分定制 ROM / 模拟器镜像
 * 上没有该服务，enqueue() 仍会返回 id 但任务永不执行（表现为「进度一直 0、文件不存在」），
 * 且这种失败没有任何异常可捕获。自带下载线程让进度、取消、失败原因完全可控，
 * 落地目录仍是应用外部私有 Downloads 目录，无需任何存储权限。
 *
 * 安装：Android 7.0+ 必须用 FileProvider 把 file:// 换成 content:// 才能跨应用共享，
 * 并需要 REQUEST_INSTALL_PACKAGES 权限 + 用户授予「安装未知应用」。
 * 本插件只负责下载与「调起安装器」，不做静默安装。
 *
 * JS 端通过 window.Capacitor.Plugins.Update 调用：
 *   - download({ url, altUrls, fileName }): 后台线程流式下载，返回 filePath
 *   - progress(): 查询当前任务进度 { phase, received, total, filePath }
 *   - install({ filePath }): 用 FileProvider 调起系统安装器
 *   - cancel(): 取消下载并删除残留文件
 *   - canInstall(): 是否已允许「安装未知应用」
 *   - openInstallPermissionSettings(): 跳到本应用的「安装未知应用」授权页
 */
@CapacitorPlugin(name = "Update")
class UpdatePlugin : Plugin() {

    companion object {
        private const val TAG = "UpdatePlugin"
        /** 连接/读取超时：更新包较大，超时给宽松些 */
        private const val CONNECT_TIMEOUT_MS = 15_000
        private const val READ_TIMEOUT_MS = 30_000
        /** 进度日志/推送的节流间隔，避免高频写状态 */
        private const val PROGRESS_THROTTLE_MS = 200L
    }

    /** 下载任务状态：由后台线程写、主线程读，用 volatile 保证可见性 */
    @Volatile private var phase: String = "idle"
    @Volatile private var received: Long = 0
    @Volatile private var total: Long = 0
    @Volatile private var filePath: String? = null
    @Volatile private var errorMessage: String? = null

    /** 取消标志：下载线程每轮循环检查 */
    private val cancelled = AtomicBoolean(false)
    private var worker: Thread? = null

    private val mainHandler = Handler(Looper.getMainLooper())

    /** APK 落地目录：应用外部私有 Downloads 目录，Android 10+ 免存储权限 */
    private fun downloadDir(): File {
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: File(context.filesDir, "downloads")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    /** 从 URL 推断文件名（兜底用传入的 fileName） */
    private fun fileNameOf(url: String, fallback: String): String {
        return try {
            val name = URL(url).path.substringAfterLast('/')
            if (name.endsWith(".apk", ignoreCase = true)) name else fallback
        } catch (e: Exception) {
            fallback
        }
    }

    /**
     * 启动下载。多源候选（GitHub 官方 + 加速前缀）在原生侧按序尝试：
     * 某个地址连接/响应失败就换下一个，全部失败才报错。
     */
    @PluginMethod
    fun download(call: PluginCall) {
        if (phase == "downloading") {
            call.reject("已有下载任务在进行中")
            return
        }
        val url = call.getString("url")
        if (url.isNullOrBlank() || !url.startsWith("https://", ignoreCase = true)) {
            call.reject("下载地址无效")
            return
        }
        // 候选列表：主地址 + altUrls（都是 https 白名单地址，由 JS 侧生成）
        val candidates = mutableListOf(url)
        call.getArray("altUrls")?.let { arr ->
            for (i in 0 until arr.length()) {
                val u = arr.optString(i, "")
                if (u.startsWith("https://", ignoreCase = true) && !candidates.contains(u)) {
                    candidates.add(u)
                }
            }
        }

        val fallbackName = call.getString("fileName")?.takeIf { it.isNotBlank() } ?: "aurora-update.apk"
        val safeName = fileNameOf(url, fallbackName).substringAfterLast('/').substringAfterLast('\\')

        // 重置状态
        cancelled.set(false)
        phase = "downloading"
        received = 0
        total = 0
        errorMessage = null
        filePath = null

        val target = File(downloadDir(), safeName)
        if (target.exists()) target.delete()

        worker = Thread {
            var lastError: String? = null
            for (candidate in candidates) {
                if (cancelled.get()) break
                try {
                    downloadOne(candidate, target)
                    lastError = null
                    break
                } catch (e: Exception) {
                    lastError = e.message ?: "下载失败"
                    android.util.Log.w(TAG, "候选地址失败: $candidate -> $lastError")
                }
            }

            if (cancelled.get()) {
                phase = "idle"
                target.delete()
                return@Thread
            }
            if (lastError != null) {
                phase = "error"
                errorMessage = lastError
            } else {
                phase = "done"
                filePath = target.absolutePath
            }
        }.also { it.start() }

        // 立即返回，进度由 JS 侧轮询 progress()
        val ret = JSObject()
        ret.put("filePath", target.absolutePath)
        call.resolve(ret)
    }

    /** 单个地址的流式下载；抛异常表示该地址不可用，由调用方换下一个 */
    private fun downloadOne(urlStr: String, target: File) {
        var conn: HttpURLConnection? = null
        try {
            var active: HttpURLConnection = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                instanceFollowRedirects = true
                requestMethod = "GET"
                // GitHub Release 会 302 到 objects.githubusercontent.com，需显式跟随
                setRequestProperty("User-Agent", "Aurora-Music-Android")
            }
            conn = active

            var code = active.responseCode
            // 部分 CDN 的重定向处理与 HttpURLConnection 默认行为不一致，手动跟随
            var redirects = 0
            var currentUrl = urlStr
            while (code in 300..399 && redirects < 5) {
                val location = active.getHeaderField("Location") ?: break
                active.disconnect()
                currentUrl = if (location.startsWith("http")) location else URL(URL(currentUrl), location).toString()
                active = (URL(currentUrl).openConnection() as HttpURLConnection).apply {
                    connectTimeout = CONNECT_TIMEOUT_MS
                    readTimeout = READ_TIMEOUT_MS
                    setRequestProperty("User-Agent", "Aurora-Music-Android")
                }
                conn = active
                code = active.responseCode
                redirects++
            }
            if (code !in 200..299) {
                throw IllegalStateException("服务器返回 HTTP $code")
            }

            total = active.contentLengthLong.takeIf { it > 0 } ?: 0
            received = 0

            FileOutputStream(target).use { out ->
                active.inputStream.use { input ->
                    val buf = ByteArray(64 * 1024)
                    var lastNotify = 0L
                    while (true) {
                        if (cancelled.get()) throw InterruptedException("已取消")
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        received += n
                        // 节流：进度不必每 64KB 都刷新
                        val now = System.currentTimeMillis()
                        if (now - lastNotify >= PROGRESS_THROTTLE_MS) {
                            lastNotify = now
                            notifyProgress()
                        }
                    }
                    out.flush()
                }
            }
            notifyProgress()
        } finally {
            try {
                conn?.disconnect()
            } catch (e: Exception) {
                // 忽略
            }
        }
    }

    /** 把进度事件推给 JS（同时保留轮询接口，前端只依赖其一即可） */
    private fun notifyProgress() {
        val data = JSObject().apply {
            put("phase", phase)
            put("received", received)
            put("total", total)
        }
        mainHandler.post {
            try {
                notifyListeners("progress", data)
            } catch (e: Exception) {
                // 前端未监听时忽略
            }
        }
    }

    /** 查询当前进度：pending | downloading | done | error | idle */
    @PluginMethod
    fun progress(call: PluginCall) {
        val ret = JSObject()
        ret.put("phase", phase)
        ret.put("received", received)
        ret.put("total", total)
        filePath?.let { ret.put("filePath", it) }
        errorMessage?.let { ret.put("error", it) }
        call.resolve(ret)
    }

    /**
     * 调起系统安装器安装已下载的 APK。
     * 未授予「安装未知应用」时返回 needPermission=true，由 JS 端引导用户去设置页。
     */
    @PluginMethod
    fun install(call: PluginCall) {
        val path = call.getString("filePath") ?: filePath
        if (path.isNullOrBlank()) {
            call.reject("安装包路径无效")
            return
        }
        val file = File(path)
        if (!file.exists()) {
            call.reject("安装包不存在，请重新下载")
            return
        }
        if (!canRequestPackageInstalls()) {
            val ret = JSObject()
            ret.put("launched", false)
            ret.put("needPermission", true)
            call.resolve(ret)
            return
        }

        try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                // 关键：给目标安装器授予这个 content:// 的读权限，否则会 SecurityException
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(intent)

            val ret = JSObject()
            ret.put("launched", true)
            ret.put("needPermission", false)
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("启动安装失败: ${e.message}")
        }
    }

    /** 取消进行中的下载并删除残留文件 */
    @PluginMethod
    fun cancel(call: PluginCall) {
        cancelled.set(true)
        worker?.interrupt()
        worker = null
        val leftover = filePath
        if (phase == "downloading") {
            phase = "idle"
            received = 0
            total = 0
        }
        // 清理半成品文件
        try {
            val dir = downloadDir()
            dir.listFiles()?.forEach { f ->
                if (f.name.endsWith(".apk", ignoreCase = true)) f.delete()
            }
            leftover?.let { File(it).takeIf { f -> f.exists() }?.delete() }
        } catch (e: Exception) {
            // 清理失败不影响用户感知
        }
        filePath = null
        val ret = JSObject()
        ret.put("cancelled", true)
        call.resolve(ret)
    }

    /** 是否已允许安装未知来源应用（Android 8.0+ 为 per-app 开关） */
    @PluginMethod
    fun canInstall(call: PluginCall) {
        val ret = JSObject()
        ret.put("granted", canRequestPackageInstalls())
        call.resolve(ret)
    }

    /**
     * 跳到本应用的「安装未知应用」授权页（带包名 deep link）。
     * Android 8.0 以下无此开关，直接返回 opened=false（旧系统默认允许）。
     */
    @PluginMethod
    fun openInstallPermissionSettings(call: PluginCall) {
        val ret = JSObject()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            ret.put("opened", false)
            call.resolve(ret)
            return
        }
        try {
            val intent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${context.packageName}")
            )
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            ret.put("opened", true)
            call.resolve(ret)
        } catch (e: Exception) {
            // 少数 ROM 不接受 deep link，降级到全局列表页
            try {
                val fallback = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(fallback)
                ret.put("opened", true)
                call.resolve(ret)
            } catch (e2: Exception) {
                call.reject("无法打开安装权限设置页: ${e2.message}")
            }
        }
    }

    /** 是否有权发起 APK 安装（Android 8.0+ 查询系统开关） */
    private fun canRequestPackageInstalls(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.packageManager.canRequestPackageInstalls()
        } else {
            true
        }
    }

    override fun handleOnDestroy() {
        cancelled.set(true)
        worker?.interrupt()
        worker = null
        super.handleOnDestroy()
    }
}
