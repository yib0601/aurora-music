package com.aurora.music

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.content.BroadcastReceiver
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.media.app.NotificationCompat.MediaStyle

/**
 * 后台媒体播放 ForegroundService
 *
 * 关键作用：
 * 1. 持有系统级 MediaSession，让 Honor/Huawei AudioHardening 识别为合法媒体 app
 *    （否则会把 STREAM_MUSIC 路由到 remote_submix 静音）
 * 2. foregroundServiceType=mediaPlayback 保持音频焦点在后台不丢失
 * 3. 通知栏提供播放/暂停/上一首/下一首控件
 *
 * 与 JS 端契约：JS 通过 MediaSessionPlugin 注册回调，本服务把通知栏/锁屏的
 * 用户操作转发给回调，由 JS 端的 Howler.js 执行实际播放控制。
 * 音频实际仍由 WebView 输出，本服务只负责"声明"和"通知栏"。
 */
class MediaPlaybackService : Service() {

    companion object {
        const val CHANNEL_ID = "aurora_music_playback"
        const val NOTIFICATION_ID = 1001
        const val ACTION_PLAY = "com.aurora.music.PLAY"
        const val ACTION_PAUSE = "com.aurora.music.PAUSE"
        const val ACTION_NEXT = "com.aurora.music.NEXT"
        const val ACTION_PREV = "com.aurora.music.PREV"
        const val ACTION_STOP = "com.aurora.music.STOP"

        // JS 桥接动作标识
        const val JS_PLAY = "play"
        const val JS_PAUSE = "pause"
        const val JS_NEXT = "next"
        const val JS_PREV = "prev"
        const val JS_STOP = "stop"
        const val JS_SEEK = "seek"

        @Volatile
        var instance: MediaPlaybackService? = null
            private set

        // JS 端注册的回调集合（MediaSessionPlugin 在 addListener 时加入）
        val jsCallbacks = mutableListOf<(String, Long) -> Unit>()
    }

    private var mediaSession: MediaSessionCompat? = null

    private val mediaButtonReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                ACTION_PLAY -> dispatchJs(JS_PLAY)
                ACTION_PAUSE -> dispatchJs(JS_PAUSE)
                ACTION_NEXT -> dispatchJs(JS_NEXT)
                ACTION_PREV -> dispatchJs(JS_PREV)
                ACTION_STOP -> { dispatchJs(JS_STOP); stopSelf() }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()

        val filter = IntentFilter().apply {
            addAction(ACTION_PLAY); addAction(ACTION_PAUSE)
            addAction(ACTION_NEXT); addAction(ACTION_PREV); addAction(ACTION_STOP)
        }
        ContextCompat.registerReceiver(this, mediaButtonReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)

        initMediaSession()
    }

    private fun initMediaSession() {
        mediaSession = MediaSessionCompat(this, "Aurora Music").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = dispatchJs(JS_PLAY)
                override fun onPause() = dispatchJs(JS_PAUSE)
                override fun onSkipToNext() = dispatchJs(JS_NEXT)
                override fun onSkipToPrevious() = dispatchJs(JS_PREV)
                override fun onStop() { dispatchJs(JS_STOP); stopSelf() }
                override fun onSeekTo(pos: Long) = dispatchJs(JS_SEEK, pos)
            })
            isActive = true
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, "音乐播放", NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Aurora Music 媒体播放控制"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        return START_STICKY
    }

    /**
     * 由 MediaSessionPlugin 调用，更新播放状态和元数据，并刷新通知栏
     */
    fun updatePlayback(
        isPlaying: Boolean,
        positionMs: Long,
        durationMs: Long,
        title: String?,
        artist: String?,
        album: String?,
        coverUrl: String?
    ) {
        val state = if (isPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        val stateBuilder = PlaybackStateCompat.Builder()
            .setActions(
                PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
                PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or PlaybackStateCompat.ACTION_STOP or
                PlaybackStateCompat.ACTION_SEEK_TO
            )
            .setState(state, positionMs, 1.0f)
        mediaSession?.setPlaybackState(stateBuilder.build())

        val metadata = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title ?: "Aurora Music")
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist ?: "")
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album ?: "")
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs)
            .build()
        mediaSession?.setMetadata(metadata)

        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(title, artist, isPlaying))
    }

    private fun buildNotification(title: String? = null, artist: String? = null, isPlaying: Boolean = false): Notification {
        val contentPI = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_SINGLE_TOP },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        fun actionPI(action: String, rc: Int) = PendingIntent.getBroadcast(
            this, rc, Intent(action).setPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val style = MediaStyle()
            .setShowActionsInCompactView(0, 1, 2)
            .setMediaSession(mediaSession?.sessionToken)

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title ?: "Aurora Music")
            .setContentText(artist ?: "")
            .setSmallIcon(R.drawable.ic_stat_play)
            .setContentIntent(contentPI)
            .addAction(R.drawable.ic_stat_prev, "上一首", actionPI(ACTION_PREV, 1))
            .addAction(
                if (isPlaying) R.drawable.ic_stat_pause else R.drawable.ic_stat_play,
                if (isPlaying) "暂停" else "播放",
                actionPI(if (isPlaying) ACTION_PAUSE else ACTION_PLAY, 2)
            )
            .addAction(R.drawable.ic_stat_next, "下一首", actionPI(ACTION_NEXT, 3))
            .setStyle(style)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .build()
    }

    private fun dispatchJs(action: String, extra: Long = 0L) {
        val snapshot = synchronized(jsCallbacks) { jsCallbacks.toList() }
        for (cb in snapshot) {
            try { cb(action, extra) } catch (_: Throwable) {}
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        try { unregisterReceiver(mediaButtonReceiver) } catch (_: Throwable) {}
        mediaSession?.isActive = false
        mediaSession?.release()
        instance = null
        super.onDestroy()
    }
}
