package com.aurora.music

import android.content.Context
import android.content.Intent
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Capacitor 插件：把 Android 原生 MediaSession + ForegroundService 暴露给 JS。
 *
 * JS 端通过 window.Capacitor.Plugins.MediaSession 调用：
 *   - start(): 启动 MediaPlaybackService（声明 foreground service + MediaSession）
 *   - stop(): 停止 service（用户退出 app 时）
 *   - updatePlayback(opts): 更新播放状态/元数据/通知栏
 *   - addListener("mediabuttonevent", cb): 监听通知栏/锁屏按钮事件
 *
 * 解决的问题：Honor/Huawei AudioHardening 会把未声明 foreground service 的 app
 * 的 STREAM_MUSIC 路由到 remote_submix（静音）。注册 MediaSession + fg service 后，
 * 系统识别为合法媒体 app，音频正常路由到扬声器。
 */
@CapacitorPlugin(name = "MediaSession")
class MediaSessionPlugin : Plugin() {

    private var serviceBound = false
    private var buttonCallback: ((String, Long) -> Unit)? = null

    override fun load() {
        super.load()
        // 注册一个回调，把通知栏按钮事件转发到 JS
        buttonCallback = { action, extra ->
            val payload = JSObject()
            payload.put("action", action)
            payload.put("position", extra)
            notifyListeners("mediabuttonevent", payload)
        }
        synchronized(MediaPlaybackService.jsCallbacks) {
            MediaPlaybackService.jsCallbacks.add(buttonCallback!!)
        }
    }

    /**
     * 启动 MediaPlaybackService。
     * 必须在用户实际触发播放后调用（Android 14+ 不允许无播放就启动 fg service）。
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

    /**
     * 更新播放状态和元数据
     * opts: { isPlaying, position (秒), duration (秒), title, artist, album, coverUrl }
     */
    @PluginMethod
    fun updatePlayback(call: PluginCall) {
        val svc = MediaPlaybackService.instance
        if (svc == null) {
            // service 尚未启动，忽略（首次 playTrack 时 JS 端会先 start）
            call.resolve()
            return
        }
        try {
            val isPlaying = call.getBoolean("isPlaying", false) ?: false
            val positionSec = call.getDouble("position", 0.0) ?: 0.0
            val durationSec = call.getDouble("duration", 0.0) ?: 0.0
            val title = call.getString("title")
            val artist = call.getString("artist")
            val album = call.getString("album")
            val coverUrl = call.getString("coverUrl")

            svc.updatePlayback(
                isPlaying = isPlaying,
                positionMs = (positionSec * 1000).toLong(),
                durationMs = (durationSec * 1000).toLong(),
                title = title,
                artist = artist,
                album = album,
                coverUrl = coverUrl
            )
            call.resolve()
        } catch (e: Exception) {
            call.reject("更新播放状态失败: ${e.message}")
        }
    }

    override fun handleOnDestroy() {
        // plugin 所在 WebView 销毁时移除回调
        if (buttonCallback != null) {
            synchronized(MediaPlaybackService.jsCallbacks) {
                MediaPlaybackService.jsCallbacks.remove(buttonCallback)
            }
        }
        super.handleOnDestroy()
    }
}
