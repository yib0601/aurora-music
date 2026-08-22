package com.aurora.music

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.media.app.NotificationCompat.MediaStyle
import org.json.JSONArray

/**
 * 后台媒体播放 ForegroundService（原生播放引擎）
 *
 * 音频由本服务的 MediaPlayer 直接解码输出（不再经 WebView）。
 * 锁屏后系统会杀掉/冻结 WebView 渲染进程，若音频在 WebView 中播放，
 * 会出现"锁屏几秒后播放停止、锁屏控件点击无响应"的问题；
 * 改为原生 MediaPlayer 后，播放生命周期完全由本前台服务掌控。
 *
 * 职责：
 * 1. MediaPlayer 播放引擎（队列、上/下一首、单曲/列表循环、随机）
 * 2. 系统级 MediaSession + 通知栏控件（锁屏控件直接操作本引擎，无需 JS 参与）
 * 3. 播放状态变化通过 playbackEventCallback 回传 JS（同步 UI 状态）
 * 4. 播放期间持有 PARTIAL_WAKE_LOCK + 音频焦点（Honor/Huawei AudioHardening
 *    要求声明 foreground service 才把 STREAM_MUSIC 路由到扬声器）
 */
class MediaPlaybackService : Service() {

    data class QueueItem(
        val path: String,
        val title: String,
        val artist: String,
        val album: String,
    )

    companion object {
        private const val TAG = "AuroraPlayback"
        const val CHANNEL_ID = "aurora_music_playback"
        const val NOTIFICATION_ID = 1001
        const val ACTION_PLAY = "com.aurora.music.PLAY"
        const val ACTION_PAUSE = "com.aurora.music.PAUSE"
        const val ACTION_NEXT = "com.aurora.music.NEXT"
        const val ACTION_PREV = "com.aurora.music.PREV"
        const val ACTION_STOP = "com.aurora.music.STOP"

        @Volatile
        var instance: MediaPlaybackService? = null
            private set

        /** 播放状态事件回调（MediaSessionPlugin 在 load 时注册，转发给 JS） */
        @Volatile
        var playbackEventCallback: ((Map<String, Any>) -> Unit)? = null
    }

    private var mediaSession: MediaSessionCompat? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    // ─── 播放引擎 ───────────────────────────────────────────────
    private var player: MediaPlayer? = null
    private val queue = mutableListOf<QueueItem>()
    private var currentIndex = -1
    private var repeatMode = "off"   // off | all | one
    private var shuffleMode = "off"  // off | on
    private val shuffleHistory = mutableListOf<Int>()
    private var currentVolume = 0.7f
    private var pendingSeekMs = 0L

    // MediaPlayer -38（invalid state）错误重试计数：
    // 深度灭屏等场景下 MediaPlayer 偶发进入非法状态，直接报错会导致 JS 侧跳歌，
    // 改为重建播放器重试当前曲目（最多 2 次），用户无感知
    private var errorRetryCount = 0

    // 锁屏保活：播放期间持有 PARTIAL_WAKE_LOCK，防止 CPU 休眠
    private var wakeLock: PowerManager.WakeLock? = null
    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null
    private var hasAudioFocus = false

    // ─── 播放状态持久化 ─────────────────────────────────────────
    // Honor 等厂商深度灭屏时可能直接杀掉整个进程（前台服务一起死）。
    // 服务声明了 START_STICKY，进程重建后系统会重新拉起服务（onStartCommand
    // 收到 null intent），此时从 SharedPreferences 恢复队列与进度继续播放，
    // 避免"锁屏播一段时间就停、锁屏控件点不动"的现象。
    private val prefs: SharedPreferences by lazy {
        getSharedPreferences("aurora_playback_state", Context.MODE_PRIVATE)
    }

    /** 保存当前队列/索引/进度/模式快照（失败静默，不影响播放） */
    private fun saveState() {
        try {
            val arr = JSONArray()
            for (item in queue) {
                arr.put(
                    org.json.JSONObject()
                        .put("path", item.path)
                        .put("title", item.title)
                        .put("artist", item.artist)
                        .put("album", item.album)
                )
            }
            val posMs = try { player?.currentPosition?.toLong() ?: 0L } catch (_: Throwable) { 0L }
            val playing = try { player?.isPlaying ?: false } catch (_: Throwable) { false }
            prefs.edit()
                .putString("queue", arr.toString())
                .putInt("index", currentIndex)
                .putLong("position", posMs)
                .putBoolean("playing", playing)
                .putString("shuffle", shuffleMode)
                .putString("repeat", repeatMode)
                .putFloat("volume", currentVolume)
                .apply()
        } catch (_: Throwable) {}
    }

    private fun clearSavedState() {
        try { prefs.edit().clear().apply() } catch (_: Throwable) {}
    }

    /**
     * 进程被系统杀死后由 START_STICKY 重建服务时调用：
     * 从持久化快照恢复队列并从上次进度续播（之前处于播放状态则自动继续播放）。
     * @return 是否成功恢复
     */
    private fun restoreFromPrefs(): Boolean {
        if (queue.isNotEmpty()) return false
        try {
            val arr = JSONArray(prefs.getString("queue", "[]") ?: "[]")
            if (arr.length() == 0) return false
            val items = mutableListOf<QueueItem>()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                items.add(QueueItem(o.optString("path"), o.optString("title"), o.optString("artist"), o.optString("album")))
            }
            if (items.isEmpty()) return false
            queue.clear()
            queue.addAll(items)
            currentIndex = prefs.getInt("index", 0).coerceIn(0, items.size - 1)
            shuffleMode = prefs.getString("shuffle", "off") ?: "off"
            repeatMode = prefs.getString("repeat", "off") ?: "off"
            currentVolume = prefs.getFloat("volume", 0.7f)
            val posMs = prefs.getLong("position", 0L)
            val wasPlaying = prefs.getBoolean("playing", false)
            Log.i(TAG, "restoreFromPrefs: index=$currentIndex playing=$wasPlaying pos=${posMs}ms queue=${items.size}")
            startCurrent(wasPlaying, posMs)
            return true
        } catch (e: Throwable) {
            Log.e(TAG, "restoreFromPrefs 失败", e)
            return false
        }
    }

    /**
     * 播放看门狗：Honor 等厂商系统深度灭屏时可能不投递 MediaPlayer 回调
     * （典型现象：一首歌播完后 onCompletion 不触发、不自动切下一首）。
     * 放在独立 HandlerThread 上运行，避免主线程被系统干预时看门狗同时失效。
     * 每 10 秒检查一次：
     * 1. prepareAsync 超过 30 秒未回调 → 重建播放器重试
     * 2. 播放中进度连续停滞约 20 秒 → 强制走完成逻辑切下一首
     * 3. 已到结尾但 onCompletion 未触发 → 强制走完成逻辑切下一首
     */
    private val watchdogThread = HandlerThread("aurora-watchdog").apply { start() }
    private val watchdogHandler = Handler(watchdogThread.looper)
    private var lastWatchPositionMs = -1
    private var stallTicks = 0
    private var prepareStartedAt = 0L    // prepareAsync 发起时间（0 = 已 prepared 或无播放器）
    private var completionForced = false // 防止看门狗重复投递强制完成
    private val playbackWatchdog = object : Runnable {
        override fun run() {
            val p = player
            if (p != null && currentIndex >= 0) {
                val now = SystemClock.elapsedRealtime()
                if (prepareStartedAt > 0 && now - prepareStartedAt > 30_000) {
                    Log.w(TAG, "watchdog: prepare 超时，重建播放器重试")
                    prepareStartedAt = 0
                    mainHandler.post { if (prepareStartedAt == 0L && player != null) startCurrent(true, 0) }
                } else {
                    val playing = try { p.isPlaying } catch (_: Throwable) { false }
                    val pos = try { p.currentPosition } catch (_: Throwable) { -1 }
                    val dur = try { p.duration } catch (_: Throwable) { 0 }
                    if (pos >= 0) {
                        if (playing && pos == lastWatchPositionMs) {
                            // 连续 2 次（约 20s）停滞才判定卡死，避免缓冲场景误跳
                            stallTicks++
                            if (stallTicks >= 2 && !completionForced) {
                                Log.w(TAG, "watchdog: 进度停滞于 ${pos}ms，强制推进")
                                stallTicks = 0
                                lastWatchPositionMs = -2
                                completionForced = true
                                mainHandler.post { handleCompletion() }
                            }
                        } else if (!playing && dur > 0 && pos in (dur - 2000)..dur && !completionForced) {
                            Log.w(TAG, "watchdog: 已到结尾但 onCompletion 未触发，强制推进")
                            stallTicks = 0
                            lastWatchPositionMs = -2
                            completionForced = true
                            mainHandler.post { handleCompletion() }
                        } else {
                            stallTicks = 0
                            lastWatchPositionMs = pos
                            // 进度正常推进：每 10 秒顺带刷新持久化快照，
                            // 进程被系统杀掉时最多丢失 10 秒播放进度
                            if (playing) mainHandler.post { saveState() }
                        }
                    }
                }
            } else {
                stallTicks = 0
            }
            watchdogHandler.postDelayed(this, 10_000)
        }
    }

    /**
     * PlaybackState 周期刷新：锁屏后系统/锁屏控件展示的进度取自 MediaSession 的
     * PlaybackState.position，而该值只在 play/pause/seek 时更新一次，
     * 导致锁屏一段时间后控件上的进度条"冻结"。播放中每 5 秒刷新一次。
     */
    private var isSessionPlaying = false
    private val sessionStateRefresher = object : Runnable {
        override fun run() {
            if (!isSessionPlaying) return
            refreshSessionPosition()
            mainHandler.postDelayed(this, 5_000)
        }
    }

    private val playbackActions =
        PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
        PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
        PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or PlaybackStateCompat.ACTION_STOP or
        PlaybackStateCompat.ACTION_SEEK_TO

    private fun refreshSessionPosition() {
        val p = player ?: return
        val playing = try { p.isPlaying } catch (_: Throwable) { false }
        val positionMs = try { p.currentPosition.toLong() } catch (_: Throwable) { 0L }
        val state = if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        mediaSession?.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(playbackActions)
                .setState(state, positionMs, if (playing) 1.0f else 0.0f)
                .build()
        )
    }

    private val mediaButtonReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                ACTION_PLAY -> resume()
                ACTION_PAUSE -> pause()
                ACTION_NEXT -> next()
                ACTION_PREV -> previous()
                ACTION_STOP -> { stopEngine(); stopSelf() }
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
        mainHandler.postDelayed(playbackWatchdog, 10_000)
    }

    private fun initMediaSession() {
        mediaSession = MediaSessionCompat(this, "Aurora Music").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = resume()
                override fun onPause() = pause()
                override fun onSkipToNext() = next()
                override fun onSkipToPrevious() = previous()
                override fun onStop() { stopEngine(); stopSelf() }
                override fun onSeekTo(pos: Long) { seekTo(pos) }
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

    // ─── 播放引擎 API（由 MediaSessionPlugin 桥接调用）────────────

    /** 设置队列并开始播放指定曲目 */
    fun playQueue(
        items: List<QueueItem>,
        index: Int,
        autoplay: Boolean,
        positionMs: Long,
        volume: Double,
        shuffle: String,
        repeat: String,
    ) {
        queue.clear()
        queue.addAll(items)
        shuffleMode = shuffle
        repeatMode = repeat
        currentVolume = volume.toFloat().coerceIn(0f, 1f)
        shuffleHistory.clear()
        if (index in items.indices) {
            currentIndex = index
            if (shuffleMode == "on") shuffleHistory.add(index)
            startCurrent(autoplay, positionMs)
        }
        saveState()
    }

    /** 仅同步队列/模式镜像（增删队列、切换循环/随机时），不打断当前播放 */
    fun syncQueue(items: List<QueueItem>, index: Int, shuffle: String, repeat: String) {
        queue.clear()
        queue.addAll(items)
        shuffleMode = shuffle
        repeatMode = repeat
        currentIndex = index
        saveState()
    }

    fun resume() {
        val p = player ?: run {
            // 引擎未初始化（如服务被重建）：尝试从头播放当前曲目
            if (currentIndex >= 0) startCurrent(true, 0)
            return
        }
        if (!p.isPlaying) {
            try {
                p.start()
                acquirePlaybackResources()
                emitEvent("play", mapOf("position" to (p.currentPosition / 1000.0)))
                updateSessionState(true)
                saveState()
            } catch (_: Throwable) {}
        }
    }

    fun pause() {
        val p = player ?: return
        if (p.isPlaying) {
            try {
                p.pause()
                releasePlaybackResources()
                emitEvent("pause", mapOf("position" to (p.currentPosition / 1000.0)))
                updateSessionState(false)
                saveState()
            } catch (_: Throwable) {}
        }
    }

    fun seekTo(positionMs: Long) {
        val p = player ?: return
        try {
            p.seekTo(positionMs.toInt())
            emitEvent("seeked", mapOf("position" to (positionMs / 1000.0)))
            saveState()
        } catch (_: Throwable) {}
    }

    fun setVolume(volume: Double) {
        currentVolume = volume.toFloat().coerceIn(0f, 1f)
        try { player?.setVolume(currentVolume, currentVolume) } catch (_: Throwable) {}
    }

    fun next() {
        val nextIdx = computeNextIndex(fromCompletion = false)
        if (nextIdx < 0) return
        currentIndex = nextIdx
        if (shuffleMode == "on") { shuffleHistory.add(nextIdx); if (shuffleHistory.size > 100) shuffleHistory.removeAt(0) }
        startCurrent(true, 0)
        emitEvent("indexChanged", mapOf("index" to currentIndex))
    }

    fun previous() {
        val p = player
        // 播放超过 3 秒时"上一首"回到开头（与 JS 端行为一致）
        if (p != null && (try { p.currentPosition } catch (_: Throwable) { 0 }) > 3000) {
            seekTo(0)
            return
        }
        val prevIdx = computePrevIndex()
        if (prevIdx < 0) { seekTo(0); return }
        currentIndex = prevIdx
        if (shuffleMode == "on") { if (shuffleHistory.size > 1) shuffleHistory.removeAt(shuffleHistory.size - 1) }
        startCurrent(true, 0)
        emitEvent("indexChanged", mapOf("index" to currentIndex))
    }

    /** 直接播放队列中指定位置（JS 删除当前曲目后接续播放用） */
    fun playAt(index: Int) {
        if (index !in queue.indices) return
        currentIndex = index
        startCurrent(true, 0)
        emitEvent("indexChanged", mapOf("index" to currentIndex))
    }

    /** 停止播放并清理引擎（保留队列，用户可再点播放恢复） */
    fun stopEngine() {
        Log.i(TAG, "stopEngine")
        releasePlayer()
        releasePlaybackResources()
        updateSessionState(false)
        emitEvent("stopped", emptyMap())
        // 用户主动停止：清除持久化快照，避免进程被杀后被 START_STICKY 自动恢复播放
        clearSavedState()
    }

    fun getStateSnapshot(): Map<String, Any> {
        val p = player
        val playing = try { p != null && p.isPlaying } catch (_: Throwable) { false }
        val pos = try { p?.currentPosition?.div(1000.0) ?: 0.0 } catch (_: Throwable) { 0.0 }
        val dur = try { p?.duration?.div(1000.0) ?: 0.0 } catch (_: Throwable) { 0.0 }
        return mapOf(
            "index" to currentIndex,
            "isPlaying" to playing,
            "position" to pos,
            "duration" to dur,
        )
    }

    // ─── 引擎内部 ───────────────────────────────────────────────

    private fun startCurrent(autoplay: Boolean, positionMs: Long) {
        val item = queue.getOrNull(currentIndex) ?: run {
            Log.w(TAG, "startCurrent: 队列为空或索引越界 index=$currentIndex size=${queue.size}")
            return
        }
        Log.i(TAG, "startCurrent: index=$currentIndex title=${item.title} autoplay=$autoplay pos=$positionMs")
        releasePlayer()
        pendingSeekMs = positionMs
        lastWatchPositionMs = -1
        stallTicks = 0
        errorRetryCount = 0
        currentDurationMs = 0L

        val mp = MediaPlayer()
        player = mp
        try {
            mp.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
            )
            mp.setDataSource(resolvePath(item.path))
            mp.setVolume(currentVolume, currentVolume)
            mp.setOnPreparedListener { prepared ->
                Log.i(TAG, "onPrepared: index=$currentIndex duration=${prepared.duration}")
                if (prepared !== player) return@setOnPreparedListener
                // 记录时长并补刷元数据（锁屏控件展示进度总时长需要 METADATA_KEY_DURATION）
                currentDurationMs = try { prepared.duration.toLong() } catch (_: Throwable) { 0L }
                updateMetadata(item)
                if (pendingSeekMs > 0) {
                    try { prepared.seekTo(pendingSeekMs.toInt()) } catch (_: Throwable) {}
                    pendingSeekMs = 0
                }
                if (autoplay) {
                    try { prepared.start() } catch (e: Throwable) {
                        Log.e(TAG, "start() 失败", e)
                    }
                    acquirePlaybackResources()
                    emitEvent("play", mapOf("position" to (prepared.currentPosition / 1000.0)))
                    // 播放真正开始后刷新快照（startCurrent 时保存的是 preparing 状态）
                    saveState()
                }
                emitEvent("prepared", mapOf(
                    "index" to currentIndex,
                    "duration" to (prepared.duration / 1000.0),
                ))
                updateSessionState(autoplay)
            }
            mp.setOnCompletionListener { completed ->
                Log.i(TAG, "onCompletion fired: samePlayer=${completed === player}")
                if (completed !== player) return@setOnCompletionListener
                handleCompletion()
            }
            mp.setOnErrorListener { failed, what, extra ->
                Log.e(TAG, "onError: what=$what extra=$extra samePlayer=${failed === player}")
                if (failed === player) handleError(what, extra)
                true
            }
            mp.prepareAsync()
        } catch (e: Throwable) {
            handleError(-1, -1)
            return
        }

        // 立即更新元数据/通知栏（不等 prepared）
        updateMetadata(item)
        updateSessionState(false)
        // 曲目切换即持久化：进程随时可能被系统杀掉，快照越新恢复越准
        saveState()
    }

    private fun handleCompletion() {
        Log.i(TAG, "handleCompletion: index=$currentIndex repeat=$repeatMode shuffle=$shuffleMode queueSize=${queue.size}")
        when {
            repeatMode == "one" -> {
                val p = player ?: return
                try {
                    p.seekTo(0)
                    p.start()
                    acquirePlaybackResources()
                    emitEvent("play", mapOf("position" to 0.0))
                    updateSessionState(true)
                } catch (_: Throwable) {}
            }
            else -> {
                val nextIdx = computeNextIndex(fromCompletion = true)
                if (nextIdx < 0) {
                    // 队列播完（顺序 + 不循环）
                    releasePlaybackResources()
                    emitEvent("endedAll", emptyMap())
                    updateSessionState(false)
                } else {
                    currentIndex = nextIdx
                    if (shuffleMode == "on") { shuffleHistory.add(nextIdx); if (shuffleHistory.size > 100) shuffleHistory.removeAt(0) }
                    startCurrent(true, 0)
                    emitEvent("indexChanged", mapOf("index" to currentIndex))
                }
            }
        }
    }

    private fun handleError(what: Int, extra: Int) {
        Log.e(TAG, "handleError: what=$what extra=$extra index=$currentIndex retry=$errorRetryCount")
        // MediaPlayer ERROR_INVALID_STATE(-38) 等瞬时错误：重建播放器从当前位置重试，
        // 避免直接向 JS 抛 error 导致跳歌/播放中断（锁屏深度灭屏场景偶发）
        // what=1(MEDIA_ERROR_UNKNOWN) + extra=-38(invalid state) 是最常见的瞬时状态错误
        if ((what == MediaPlayer.MEDIA_ERROR_UNKNOWN && extra == -38) || what == -38) {
            if (errorRetryCount < 2 && queue.isNotEmpty() && currentIndex >= 0) {
                errorRetryCount++
                val pos = try { prefs.getLong("position", 0L) } catch (_: Throwable) { 0L }
                Log.w(TAG, "handleError: -38 瞬时错误，重建播放器重试 (pos=${pos}ms)")
                startCurrent(true, pos.coerceAtLeast(0L))
                return
            }
        }
        errorRetryCount = 0
        releasePlayer()
        releasePlaybackResources()
        emitEvent("error", mapOf(
            "index" to currentIndex,
            "what" to what,
            "extra" to extra,
        ))
        updateSessionState(false)
    }

    private fun computeNextIndex(fromCompletion: Boolean): Int {
        if (queue.isEmpty()) return -1
        if (queue.size == 1) {
            return if (fromCompletion && repeatMode == "off") -1 else 0
        }
        if (shuffleMode == "on") {
            val candidates = queue.indices.filter { it != currentIndex }
            return candidates.random()
        }
        val n = currentIndex + 1
        return if (n >= queue.size) {
            if (repeatMode == "all" || repeatMode == "one") 0 else -1
        } else n
    }

    private fun computePrevIndex(): Int {
        if (queue.isEmpty()) return -1
        if (shuffleMode == "on") {
            // 随机模式：回退到上一个随机曲目
            if (shuffleHistory.size >= 2) return shuffleHistory[shuffleHistory.size - 2]
            return currentIndex
        }
        val p = currentIndex - 1
        return if (p < 0) queue.size - 1 else p
    }

    /**
     * JS 侧曲目 path 为外部存储相对路径（如 "Music/xx.flac"）或在线 URL；
     * MediaPlayer 需要绝对路径或 http(s) URL。
     */
    private fun resolvePath(path: String): String {
        if (path.startsWith("http://") || path.startsWith("https://")) return path
        if (path.startsWith("/")) return path
        return "/storage/emulated/0/$path"
    }

    private fun releasePlayer() {
        try {
            player?.let {
                if (it.isPlaying) it.stop()
                it.reset()
                it.release()
            }
        } catch (_: Throwable) {}
        player = null
    }

    private fun emitEvent(type: String, extra: Map<String, Any>) {
        val payload = mutableMapOf<String, Any>("type" to type)
        payload.putAll(extra)
        mainHandler.post {
            try { playbackEventCallback?.invoke(payload) } catch (_: Throwable) {}
        }
    }

    // ─── 锁屏保活资源 ───────────────────────────────────────────

    /**
     * 播放中：持有 WakeLock + 申请音频焦点。
     * 锁屏后系统会让 CPU 休眠，PARTIAL_WAKE_LOCK 保持 CPU 运行，
     * 音频焦点让系统（尤其 Honor 电源管理）把本 app 识别为活跃媒体应用。
     */
    private fun acquirePlaybackResources() {
        val lock = wakeLock
        if (lock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "aurora-music:playback").apply {
                setReferenceCounted(false)
                acquire()
            }
        } else if (!lock.isHeld) {
            lock.acquire()
        }

        if (hasAudioFocus) return
        if (audioManager == null) {
            audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        }
        val am = audioManager ?: return
        try {
            val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val attrs = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
                val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attrs)
                    .setOnAudioFocusChangeListener { focusChange ->
                        Log.i(TAG, "音频焦点变化: $focusChange (isPlaying=${try { player?.isPlaying } catch (_: Throwable) { false }})")
                    }
                    .build()
                focusRequest = req
                am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
            } else {
                @Suppress("DEPRECATION")
                am.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
            }
            hasAudioFocus = granted
        } catch (_: Throwable) {}
    }

    /** 暂停/停止：释放 WakeLock 与音频焦点 */
    private fun releasePlaybackResources() {
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
        } catch (_: Throwable) {}
        if (hasAudioFocus) {
            try {
                val am = audioManager
                if (am != null) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        focusRequest?.let { am.abandonAudioFocusRequest(it) }
                    } else {
                        @Suppress("DEPRECATION")
                        am.abandonAudioFocus(null)
                    }
                }
            } catch (_: Throwable) {}
            hasAudioFocus = false
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        // START_STICKY 重建（进程被系统杀死后由系统重新拉起）时 intent 为 null：
        // 从持久化快照恢复队列并从上次进度续播，避免锁屏播放中断后控件失效
        if (intent == null && queue.isEmpty()) {
            Log.i(TAG, "onStartCommand: START_STICKY 重建，尝试从持久化状态恢复播放")
            restoreFromPrefs()
        }
        return START_STICKY
    }

    // ─── MediaSession / 通知栏 ──────────────────────────────────

    /** 当前曲目时长（毫秒）：prepared 后由引擎记录，元数据用于锁屏控件展示总时长 */
    private var currentDurationMs = 0L

    private fun updateMetadata(item: QueueItem) {
        val builder = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, item.title.ifEmpty { "Aurora Music" })
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, item.artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, item.album)
        if (currentDurationMs > 0) {
            builder.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, currentDurationMs)
        }
        mediaSession?.setMetadata(builder.build())
    }

    private fun updateSessionState(isPlaying: Boolean) {
        val positionMs = try { player?.currentPosition?.toLong() ?: 0L } catch (_: Throwable) { 0L }
        val state = if (isPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        val stateBuilder = PlaybackStateCompat.Builder()
            .setActions(playbackActions)
            .setState(state, positionMs, if (isPlaying) 1.0f else 0.0f)
        mediaSession?.setPlaybackState(stateBuilder.build())

        // 播放中启动周期刷新，保证锁屏/系统控件上的进度持续更新；暂停时停止
        isSessionPlaying = isPlaying
        mainHandler.removeCallbacks(sessionStateRefresher)
        if (isPlaying) mainHandler.postDelayed(sessionStateRefresher, 5_000)

        val item = queue.getOrNull(currentIndex)
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(item?.title, item?.artist, isPlaying))
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

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(playbackWatchdog)
        mainHandler.removeCallbacks(sessionStateRefresher)
        try { unregisterReceiver(mediaButtonReceiver) } catch (_: Throwable) {}
        releasePlayer()
        releasePlaybackResources()
        mediaSession?.isActive = false
        mediaSession?.release()
        instance = null
        super.onDestroy()
    }
}
