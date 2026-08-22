package com.aurora.music

import android.content.Intent
import android.os.Build
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

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
 *   - getState(): 查询播放快照
 *   - addListener("playbackevent", cb): 监听播放状态事件（同步 UI）
 */
@CapacitorPlugin(name = "MediaSession")
class MediaSessionPlugin : Plugin() {

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
            call.reject("启动媒体服务失败: ${e.message}")
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        try {
            context.stopService(Intent(context, MediaPlaybackService::class.java))
            call.resolve()
        } catch (e: Exception) {
            call.reject("停止媒体服务失败: ${e.message}")
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
                )
            )
        }
        return items
    }

    /**
     * 设置队列并开始播放
     * opts: { items: [{path,title,artist,album}], index, autoplay, position (秒), volume, shuffle, repeat }
     */
    @PluginMethod
    fun playQueue(call: PluginCall) {
        val svc = MediaPlaybackService.instance
        if (svc == null) {
            call.reject("媒体服务未启动")
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
            call.reject("设置播放队列失败: ${e.message}")
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
            call.reject("同步队列失败: ${e.message}")
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
