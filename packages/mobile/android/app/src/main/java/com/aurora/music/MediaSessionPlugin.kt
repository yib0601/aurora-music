package com.aurora.music

import android.content.Intent
import android.os.Build
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.net.URLEncoder

/**
 * Capacitor 插件：把 Android 原生播放引擎（MediaPlaybackService）暴露给 JS。
 *
 * 架构说明：
 * 音频由原生 MediaPlayer 播放（非 WebView），因为锁屏后系统会杀掉
 * WebView 渲染进程，导致 WebView 内的 HTML5 Audio 播放中断、锁屏控件失效。
 * 原生引擎 + foreground service 保证锁屏/后台播放不中断。
 *
 * JS 端通过 window.Capacitor.Plugins.MediaSession 调用：
 *   - start(): 启动 MediaPlaybackService（必须在播放后调用，Android 14+ 限制）
 *   - stop(): 停止 service
 *   - playQueue(opts): 设置队列并从指定位置播放
 *   - syncQueue(opts): 仅同步队列/循环/随机镜像（不打断播放）
 *   - pause()/resume()/seekTo()/setVolume()/next()/previous()/playAt()/stopEngine()
 *   - updateArtwork(opts): 补写当前曲目锁屏封面（封面异步就绪后调用）
 *   - getState(): 查询播放快照
 *   - addListener("playbackevent", cb): 监听播放状态事件（同步 UI）
 *
 * 错误约定：reject 回传的**永远是错误码**（`media_error_xxx`），不含给用户看的句子——
 * 文案由 JS 侧按当前语言渲染，见 packages/shared/src/i18n/messages/{zh-CN,en}/mobile.ts
 * 的 `media.error.*` 与 docs/development.md「多语言开发」的码→键映射说明。
 */
@CapacitorPlugin(name = "MediaSession")
class MediaSessionPlugin : Plugin() {

    /**
     * 拼装原生错误码（与 UpdatePlugin.err 同一协议）。码是**机器可读**的：
     * 不含任何给用户看的文案，文案由 JS 侧按当前语言渲染（字典 `media.error.*`）。
     * 形式 `<域>_error_<小驼峰名>`，参数以查询串追加（值做 URL 编码）；
     * JS 侧键路径 = `mobile.` + 码把 `_` 换成 `.`。
     */
    private fun err(code: String, vararg params: Pair<String, String?>): String {
        if (params.isEmpty()) return code
        val query = params.joinToString("&") { (key, value) ->
            "$key=" + URLEncoder.encode(value.orEmpty(), "UTF-8")
        }
        return "$code?$query"
    }

    override fun load() {
        super.load()
        // 把原生引擎的播放状态事件转发到 JS（"playbackevent"）
        MediaPlaybackService.playbackEventCallback = { event ->
            val payload = JSObject()
            for ((key, value) in event) {
                when (value) {
                    is Boolean -> payload.put(key, value)
                    is Int -> payload.put(key, value)
                    is Long -> payload.put(key, value)
                    is Double -> payload.put(key, value)
                    is String -> payload.put(key, value)
                    else -> payload.put(key, value.toString())
                }
            }
            notifyListeners("playbackevent", payload)
        }
    }

    /**
     * 启动 MediaPlaybackService。
     * 必须在用户实际触发播放后调用（Android 14+ 不允许无播放就启动 mediaPlayback fg service）。
     */
    @PluginMethod
    fun start(call: PluginCall) {
        try {
            val intent = Intent(context, MediaPlaybackService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
            call.resolve()
        } catch (e: Exception) {
            call.reject(err("media_error_serviceStartFailed", "detail" to e.message))
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        try {
            context.stopService(Intent(context, MediaPlaybackService::class.java))
            call.resolve()
        } catch (e: Exception) {
            call.reject(err("media_error_serviceStopFailed", "detail" to e.message))
        }
    }

    private fun parseQueue(arr: JSArray?): List<MediaPlaybackService.QueueItem> {
        val items = mutableListOf<MediaPlaybackService.QueueItem>()
        if (arr == null) return items
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            items.add(
                MediaPlaybackService.QueueItem(
                    path = o.optString("path"),
                    title = o.optString("title"),
                    artist = o.optString("artist"),
                    album = o.optString("album"),
                    // 封面来源：convertFileSrc URL / 远端直链 / 本地路径，空则由原生提取内嵌封面
                    cover = o.optString("cover"),
                    // JS 传秒，原生用毫秒（锁屏进度条需要总时长）
                    durationMs = (o.optDouble("duration", 0.0) * 1000).toLong().coerceAtLeast(0L),
                )
            )
        }
        return items
    }

    /**
     * 更新当前曲目的锁屏封面。
     * JS 侧封面可能是异步提取/升级的（CoverImage 渲染时才落盘），
     * 队列下发时封面为空，此时用本方法补写，避免锁屏长期停在默认占位图。
     * opts: { cover: string }
     */
    @PluginMethod
    fun updateArtwork(call: PluginCall) {
        val cover = call.getString("cover", "") ?: ""
        MediaPlaybackService.instance?.updateCurrentCover(cover)
        call.resolve()
    }

    /**
     * 设置队列并开始播放
     * opts: { items: [{path,title,artist,album}], index, autoplay, position (秒), volume, shuffle, repeat }
     */
    @PluginMethod
    fun playQueue(call: PluginCall) {
        val svc = MediaPlaybackService.instance
        if (svc == null) {
            call.reject(err("media_error_serviceNotRunning"))
            return
        }
        try {
            val items = parseQueue(call.getArray("items"))
            svc.playQueue(
                items = items,
                index = call.getInt("index", 0) ?: 0,
                autoplay = call.getBoolean("autoplay", true) ?: true,
                positionMs = ((call.getDouble("position", 0.0) ?: 0.0) * 1000).toLong(),
                volume = call.getDouble("volume", 0.7) ?: 0.7,
                shuffle = call.getString("shuffle", "off") ?: "off",
                repeat = call.getString("repeat", "off") ?: "off",
            )
            call.resolve()
        } catch (e: Exception) {
            call.reject(err("media_error_playQueueFailed", "detail" to e.message))
        }
    }

    /**
     * 仅同步队列镜像（增删队列、切换循环/随机模式时），不打断当前播放
     * opts: { items, index, shuffle, repeat }
     */
    @PluginMethod
    fun syncQueue(call: PluginCall) {
        val svc = MediaPlaybackService.instance
        if (svc == null) {
            call.resolve()
            return
        }
        try {
            svc.syncQueue(
                items = parseQueue(call.getArray("items")),
                index = call.getInt("index", -1) ?: -1,
                shuffle = call.getString("shuffle", "off") ?: "off",
                repeat = call.getString("repeat", "off") ?: "off",
            )
            call.resolve()
        } catch (e: Exception) {
            call.reject(err("media_error_syncQueueFailed", "detail" to e.message))
        }
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        MediaPlaybackService.instance?.pause()
        call.resolve()
    }

    @PluginMethod
    fun resume(call: PluginCall) {
        MediaPlaybackService.instance?.resume()
        call.resolve()
    }

    @PluginMethod
    fun seekTo(call: PluginCall) {
        val positionSec = call.getDouble("position", 0.0) ?: 0.0
        MediaPlaybackService.instance?.seekTo((positionSec * 1000).toLong())
        call.resolve()
    }

    @PluginMethod
    fun setVolume(call: PluginCall) {
        val volume = call.getDouble("volume", 0.7) ?: 0.7
        MediaPlaybackService.instance?.setVolume(volume)
        call.resolve()
    }

    @PluginMethod
    fun next(call: PluginCall) {
        MediaPlaybackService.instance?.next()
        call.resolve()
    }

    @PluginMethod
    fun previous(call: PluginCall) {
        MediaPlaybackService.instance?.previous()
        call.resolve()
    }

    @PluginMethod
    fun playAt(call: PluginCall) {
        val index = call.getInt("index", -1) ?: -1
        MediaPlaybackService.instance?.playAt(index)
        call.resolve()
    }

    @PluginMethod
    fun stopEngine(call: PluginCall) {
        MediaPlaybackService.instance?.stopEngine()
        call.resolve()
    }

    /** 查询播放快照：{ index, isPlaying, position, duration } */
    @PluginMethod
    fun getState(call: PluginCall) {
        val svc = MediaPlaybackService.instance
        val obj = JSObject()
        if (svc == null) {
            obj.put("index", -1)
            obj.put("isPlaying", false)
            obj.put("position", 0.0)
            obj.put("duration", 0.0)
        } else {
            val snap = svc.getStateSnapshot()
            obj.put("index", snap["index"] as Int)
            obj.put("isPlaying", snap["isPlaying"] as Boolean)
            obj.put("position", snap["position"] as Double)
            obj.put("duration", snap["duration"] as Double)
        }
        call.resolve(obj)
    }

    override fun handleOnDestroy() {
        MediaPlaybackService.playbackEventCallback = null
        super.handleOnDestroy()
    }
}
