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
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadataRetriever
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
import android.util.LruCache
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.media.app.NotificationCompat.MediaStyle
import org.json.JSONArray
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

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
        /**
         * 封面来源，由 JS 下发。取值形态：
         * - Capacitor convertFileSrc 生成的 `https://localhost/_capacitor_file_/...`（本地封面缓存）
         * - 远端 `https://...` 封面直链（在线曲目）
         * - `file://` 或绝对路径
         * 为空时原生退化为从音频文件内嵌封面提取（MediaMetadataRetriever）。
         */
        val cover: String = "",
        /** 曲目时长（毫秒），JS 侧已知时下发；锁屏进度条需要它，0 = 未知 */
        val durationMs: Long = 0L,
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

        // ─── 「其他应用播放声音时」策略 ─────────────────────────────
        // 设置值：pause（默认，被抢焦点就暂停）/ continue（继续播，用户自担风险）。
        // 刻意用**独立**的 SharedPreferences 文件：播放快照那份额外会被
        // clearSavedState() 整份 clear()，设置写进去会被「停止播放」顺手抹掉。
        private const val SETTINGS_PREFS = "aurora_settings"
        private const val KEY_AUDIO_FOCUS_BEHAVIOR = "audio_focus_behavior"
        const val AUDIO_FOCUS_PAUSE = "pause"
        const val AUDIO_FOCUS_CONTINUE = "continue"

        /**
         * 归一化：契约只认 pause / continue，其余（null、空串、旧版本脏值、拼写错误）
         * 一律回落到 pause。默认侧必须是「被打断就暂停」——那才是不会让用户莫名其妙
         * 「歌还在走但没声音」的一边。
         */
        private fun normalizeAudioFocusBehavior(raw: String?): String =
            if (raw == AUDIO_FOCUS_CONTINUE) AUDIO_FOCUS_CONTINUE else AUDIO_FOCUS_PAUSE

        /**
         * 当前生效的焦点策略。
         * @Volatile 必要：写入来自 JS 线程/主线程，读取发生在 AudioManager 派发焦点事件的
         * 那个线程上（不是主线程），没有可见性保证的话可能一直读到旧值。
         */
        @Volatile
        private var audioFocusBehavior: String = AUDIO_FOCUS_PAUSE

        /**
         * 从独立设置文件读回策略（onCreate 调用）。
         * 读失败按默认 pause 处理：设置丢了只影响「被打断时是否暂停」，不能让播放本身出错。
         */
        fun loadAudioFocusBehavior(context: Context): String {
            val raw = try {
                context.getSharedPreferences(SETTINGS_PREFS, Context.MODE_PRIVATE)
                    .getString(KEY_AUDIO_FOCUS_BEHAVIOR, AUDIO_FOCUS_PAUSE)
            } catch (_: Throwable) {
                null
            }
            val behavior = normalizeAudioFocusBehavior(raw)
            audioFocusBehavior = behavior
            return behavior
        }

        /**
         * 写设置并立即更新内存值。服务未启动时也要落盘——否则用户在服务起来之前改的
         * 设置会在下次播放时静默回退成默认值。
         */
        fun applyAudioFocusBehavior(context: Context, behavior: String) {
            val normalized = normalizeAudioFocusBehavior(behavior)
            audioFocusBehavior = normalized
            try {
                context.getSharedPreferences(SETTINGS_PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putString(KEY_AUDIO_FOCUS_BEHAVIOR, normalized)
                    .apply()
            } catch (_: Throwable) {}
        }
    }

    private var mediaSession: MediaSessionCompat? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    // ─── 锁屏封面（artwork）──────────────────────────────────────
    // 锁屏/通知栏的封面与进度条完全由 MediaSession 的 Metadata + PlaybackState 驱动：
    // 没有 METADATA_KEY_ALBUM_ART 就没有封面（只剩默认音符图标），
    // 没有 METADATA_KEY_DURATION 则进度条整条不渲染（系统只画两端空槽）。
    // 封面解码/下载属 IO，放独立线程，避免卡主线程。
    private val artworkThread = HandlerThread("aurora-artwork").apply { start() }
    private val artworkHandler = Handler(artworkThread.looper)

    // ─── 播放快照落盘（异步）────────────────────────────────────
    // 整队列的 JSON 序列化不能压在主线程上：车机队列动辄几百上千首，而这个快照
    // 每 10 秒（看门狗）以及每次起播/暂停/seek/切歌都会刷新一次。
    private val stateThread = HandlerThread("aurora-state").apply { start() }
    private val stateHandler = Handler(stateThread.looper)
    /** 待落盘的最新快照（由 saveState 在调用线程抓取，见其注释） */
    @Volatile private var pendingSnapshot: PlaybackSnapshot? = null
    @Volatile private var saveScheduled = false
    private data class PlaybackSnapshot(
        val items: List<QueueItem>,
        val index: Int,
        val positionMs: Long,
        val playing: Boolean,
        val shuffle: String,
        val repeat: String,
        val volume: Float,
    )
    /** 已解码封面缓存（仅主线程访问），key 为封面来源或 `embedded:<音频路径>` */
    private val artworkCache = LruCache<String, Bitmap>(8)
    /** 当前曲目封面，随 metadata 一起下发给系统 */
    private var currentArtwork: Bitmap? = null
    /** 切歌令牌：异步解码回来时若已切歌则丢弃结果，防止封面串台 */
    private var artworkToken = 0

    // ─── 播放引擎 ───────────────────────────────────────────────
    private var player: MediaPlayer? = null
    /**
     * 播放器是否已完成 prepare。
     * ⚠️ MediaPlayer 在 PREPARING 状态下调用 getDuration() 会走 native 错误分支
     * （`Attempt to call getDuration in wrong state` + error(-38, 0)），
     * 该错误会经 onError 回调把整次播放打断；位置同理。
     * 因此时长/位置一律经下面的 helper 读取，prepare 前不向 MediaPlayer 询问。
     */
    private var playerPrepared = false
    /** 已 prepare 播放器的真实时长（毫秒），0 = 未知 */
    private var playerDurationMs = 0L
    private val queue = mutableListOf<QueueItem>()
    private var currentIndex = -1
    private var repeatMode = "off"   // off | all | one
    private var shuffleMode = "off"  // off | on
    private val shuffleHistory = mutableListOf<Int>()
    private var currentVolume = 0.7f
    private var pendingSeekMs = 0L

    // 锁屏保活：播放期间持有 PARTIAL_WAKE_LOCK，防止 CPU 休眠
    private var wakeLock: PowerManager.WakeLock? = null
    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null
    private var hasAudioFocus = false
    /** 是否因为被系统/其他应用抢走音频焦点而暂停（焦点回来后据此自动续播） */
    private var pausedByFocusLoss = false

    // ─── 网络流自愈 ─────────────────────────────────────────────
    /**
     * 在线直链是网络流，一次瞬时抖动（车机切网 / 省电 / 对端断流）不代表这首不能播。
     * 之前 onError 直接放弃，用户看到的就是「播到一半没声，按一下切歌才恢复」。
     */
    private val maxNetworkRetries = 2
    private val retryBaseDelayMs = 1_500L
    /** 当前曲目已重试过几次（换曲或成功播放后清零） */
    private var networkRetryCount = 0
    /** 网络流「缓冲停滞」自愈次数（成功推进后清零），避免死网络下无限重建播放器 */
    private val maxStallRecoveries = 2
    private var stallRecoveries = 0
    /** 待执行的延迟重试：换曲 / 暂停 / 停止时必须取消，否则会把已停掉的播放重新拉起来 */
    private var retryRunnable: Runnable? = null

    // ─── 播放状态持久化 ─────────────────────────────────────────
    // Honor 等厂商深度灭屏时可能直接杀掉整个进程（前台服务一起死）。
    // 服务声明了 START_STICKY，进程重建后系统会重新拉起服务（onStartCommand
    // 收到 null intent），此时从 SharedPreferences 恢复队列与进度继续播放，
    // 避免"锁屏播一段时间就停、锁屏控件点不动"的现象。
    private val prefs: SharedPreferences by lazy {
        getSharedPreferences("aurora_playback_state", Context.MODE_PRIVATE)
    }

    /**
     * 保存当前队列/索引/进度/模式快照（失败静默，不影响播放）。
     *
     * ⚠️ **不要在这里直接序列化整条队列**：这个函数被看门狗每 10 秒一次、外加每次
     * 起播/暂停/seek/切歌都会调用，而它原本在调用线程上把整个队列转 JSON 再写
     * SharedPreferences —— 车机队列大时这就是主线程上一份持续性的卡顿源（界面一顿一顿，
     * 严重时 ANR）。现在调用线程只抓一份轻量快照，序列化与写盘全部交给 aurora-state 线程。
     */
    private fun saveState() {
        val snapshot = try {
            PlaybackSnapshot(
                items = queue.toList(),
                index = currentIndex,
                positionMs = currentPositionMs(),
                playing = try { player?.isPlaying ?: false } catch (_: Throwable) { false },
                shuffle = shuffleMode,
                repeat = repeatMode,
                volume = currentVolume,
            )
        } catch (_: Throwable) {
            return
        }
        pendingSnapshot = snapshot
        // 已经排了一份就够了：它执行时会把最新的那份取走（见 drainStateWrites）
        if (saveScheduled) return
        saveScheduled = true
        stateHandler.post { drainStateWrites() }
    }

    /** 把排队中的快照逐个写掉；执行期间新来的快照会再被这个循环取走 */
    private fun drainStateWrites() {
        while (true) {
            try {
                while (true) {
                    val snapshot = pendingSnapshot ?: break
                    pendingSnapshot = null
                    writeState(snapshot)
                }
            } catch (_: Throwable) {
                // 写盘失败只丢这一份快照，不影响播放
            }
            saveScheduled = false
            // 竞态兜底：清标志那一瞬间刚好有新快照进来时，对方看到 saveScheduled=true
            // 不会再排队，这里必须自己再接一轮，否则最后一份快照会一直悬着
            if (pendingSnapshot == null) return
            saveScheduled = true
        }
    }

    private fun writeState(snapshot: PlaybackSnapshot) {
        try {
            val arr = JSONArray()
            for (item in snapshot.items) {
                arr.put(
                    org.json.JSONObject()
                        .put("path", item.path)
                        .put("title", item.title)
                        .put("artist", item.artist)
                        .put("album", item.album)
                        .put("cover", item.cover)
                        .put("durationMs", item.durationMs)
                )
            }
            prefs.edit()
                .putString("queue", arr.toString())
                .putInt("index", snapshot.index)
                .putLong("position", snapshot.positionMs)
                .putBoolean("playing", snapshot.playing)
                .putString("shuffle", snapshot.shuffle)
                .putString("repeat", snapshot.repeat)
                .putFloat("volume", snapshot.volume)
                .apply()
        } catch (_: Throwable) {}
    }

    private fun clearSavedState() {
        // 先掐掉排队中的快照，否则它会在这次 clear 之后把旧状态又写回去
        pendingSnapshot = null
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
                items.add(
                    QueueItem(
                        path = o.optString("path"),
                        title = o.optString("title"),
                        artist = o.optString("artist"),
                        album = o.optString("album"),
                        cover = o.optString("cover"),
                        durationMs = o.optLong("durationMs", 0L),
                    )
                )
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
                    // 只在 prepare 完成后才读位置/时长：PREPARING 状态下询问
                    // 会让 MediaPlayer 走 native 错误分支并回调 onError，打断正常播放
                    val playing = playerPrepared && (try { p.isPlaying } catch (_: Throwable) { false })
                    val pos = if (playerPrepared) (try { p.currentPosition } catch (_: Throwable) { -1 }) else -1
                    val dur = playerDurationMs.toInt()
                    if (pos >= 0) {
                        if (playing && pos == lastWatchPositionMs) {
                            // 连续 2 次（约 20s）停滞才判定"卡住"，避免正常缓冲被误判
                            stallTicks++
                            if (stallTicks >= 2) {
                                stallTicks = 0
                                lastWatchPositionMs = -2
                                val stalledItem = queue.getOrNull(currentIndex)
                                if (stalledItem != null && isRemote(stalledItem.path) &&
                                    stallRecoveries < maxStallRecoveries
                                ) {
                                    // 网络流停滞多半是缓冲断了：带原位置重试当前曲，
                                    // 而不是一律跳下一首（跳曲会丢歌，且弱网下会连续跳过整条队列）
                                    stallRecoveries++
                                    Log.w(TAG, "watchdog: 网络流停滞于 ${pos}ms，重试当前曲（第 ${stallRecoveries} 次）")
                                    val resumeAt = pos.toLong()
                                    mainHandler.post { startCurrent(true, resumeAt, isRetry = true) }
                                } else if (!completionForced) {
                                    Log.w(TAG, "watchdog: 进度停滞于 ${pos}ms，强制推进")
                                    completionForced = true
                                    mainHandler.post { handleCompletion() }
                                }
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
        // 先读回用户设置：进程被 START_STICKY 重建后内存值归零，不读回来会静默退回 pause
        loadAudioFocusBehavior(this)
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
        // 锁屏控件点击封面/标题回到应用：部分 ROM 缺少 sessionActivity 时不渲染锁屏媒体卡片
        val sessionActivity = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_SINGLE_TOP },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        mediaSession = MediaSessionCompat(this, "Aurora Music").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = resume()
                override fun onPause() = pause()
                override fun onSkipToNext() = next()
                override fun onSkipToPrevious() = previous()
                override fun onStop() { stopEngine(); stopSelf() }
                override fun onSeekTo(pos: Long) { seekTo(pos) }
            })
            setSessionActivity(sessionActivity)
            isActive = true
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // 频道名/描述取自资源（values/ 是英文默认，values-zh/ 是中文）：
            // 同一 id 重复创建会刷新这两项，故切换系统语言后冷启动即更新。
            val channel = NotificationChannel(
                CHANNEL_ID, getString(R.string.aurora_notification_channel_name), NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.aurora_notification_channel_description)
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
        cancelScheduledRetry()
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
        cancelScheduledRetry()
        // 播放已经恢复（用户点播放 / GAIN 后续播）：不再欠任何一次「焦点回来后续播」
        pausedByFocusLoss = false
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
        cancelScheduledRetry()
        // 用户主动暂停：焦点回来时不应该自动续播
        pausedByFocusLoss = false
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
            // 锁屏拖动进度条后必须回写 PlaybackState，否则系统仍按旧 position 渲染
            updateSessionState(try { p.isPlaying } catch (_: Throwable) { false })
            saveState()
        } catch (_: Throwable) {}
    }

    fun setVolume(volume: Double) {
        currentVolume = volume.toFloat().coerceIn(0f, 1f)
        try { player?.setVolume(currentVolume, currentVolume) } catch (_: Throwable) {}
    }

    /**
     * 切换「其他应用播放声音时」的策略（MediaSessionPlugin 桥接 JS 设置）。
     *
     * 从 pause 切到 continue 时顺手把被焦点中断的那次暂停补上：用户刚把策略改成
     * 「继续播」，不该还得再点一次播放键。
     *
     * 但**只补临时丢失那一次**（`hasAudioFocus` 仍为 true）：永久丢失时焦点已经被
     * 对方拿走、我们也在 LOSS 分支里放弃了焦点，这时起播会重新申请焦点、反向把对方
     * 按停 —— 与用户选「继续播放」的意图正好相反。
     */
    fun setAudioFocusBehavior(behavior: String) {
        val normalized = normalizeAudioFocusBehavior(behavior)
        applyAudioFocusBehavior(this, normalized)
        if (normalized == AUDIO_FOCUS_CONTINUE && pausedByFocusLoss && hasAudioFocus) {
            pausedByFocusLoss = false
            resume()
        }
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
        // 播放超过 3 秒时"上一首"回到开头（与 JS 端行为一致）
        if (currentPositionMs() > 3000) {
            seekTo(0)
            return
        }
        if (queue.isEmpty()) {
            seekTo(0)
            return
        }
        // 随机模式下「历史里确有一条更早的记录」才走随机回退，否则退回顺序上一首
        val fromHistory = shuffleMode == "on" && shuffleHistoryValid()
        val prevIdx = computePrevIndex()
        if (prevIdx < 0) { seekTo(0); return }
        currentIndex = prevIdx
        if (shuffleMode == "on") {
            if (fromHistory) {
                // 丢掉当前这一条，历史末项即回退目标
                shuffleHistory.removeAt(shuffleHistory.size - 1)
            } else {
                // 回退后把历史重开在回退位置上（连续按「上一首」继续往前走，而不是原地打转）
                shuffleHistory.clear()
                shuffleHistory.add(prevIdx)
            }
        }
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
        cancelScheduledRetry()
        pausedByFocusLoss = false
        releasePlayer()
        releasePlaybackResources()
        updateSessionState(false)
        emitEvent("stopped", emptyMap())
        // 用户主动停止：清除持久化快照，避免进程被杀后被 START_STICKY 自动恢复播放
        clearSavedState()
    }

    fun getStateSnapshot(): Map<String, Any> {
        val playing = try { player?.isPlaying ?: false } catch (_: Throwable) { false }
        return mapOf(
            "index" to currentIndex,
            "isPlaying" to playing,
            "position" to (currentPositionMs() / 1000.0),
            "duration" to (currentDurationMs() / 1000.0),
        )
    }

    // ─── 引擎内部 ───────────────────────────────────────────────

    /**
     * @param isRetry 由自愈路径（错误重试 / 停滞重试）发起的重启：
     *   不清零重试预算、也不取消自身，否则重试会无限循环。
     */
    private fun startCurrent(autoplay: Boolean, positionMs: Long, isRetry: Boolean = false) {
        val item = queue.getOrNull(currentIndex) ?: run {
            Log.w(TAG, "startCurrent: 队列为空或索引越界 index=$currentIndex size=${queue.size}") 
            return
        }
        Log.i(TAG, "startCurrent: index=$currentIndex title=${item.title} autoplay=$autoplay pos=$positionMs retry=$isRetry")
        if (!isRetry) {
            // 换了曲目（或用户显式起播）：上一曲的「焦点回来后自动续播」意图作废，
            // 否则迟到的 GAIN 会把一首已经自然放完（或已切走）的歌重新拉起来
            pausedByFocusLoss = false
            // 取消上一曲遗留的重试，并给满重试预算。
            // ⚠️ completionForced 也必须在这里复位——之前只在看门狗里置 true、从不置回，
            // 结果整个服务生命周期里只可能被强制推进一次，之后再卡就不会再自愈。
            cancelScheduledRetry()
            networkRetryCount = 0
            stallRecoveries = 0
            completionForced = false
        }
        // 未取址的在线曲目：JS 下发队列时 path 还是空的（移动端惰性取址，地址要在
        // 播到它时按 id 现取）。绝不能把空串当本地路径交给 MediaPlayer——
        // resolvePath("") 会拼出 /storage/emulated/0/（一个目录），setDataSource 必然
        // 抛错，进而走 handleError 被上报成「加载失败」。JS 侧把这类上报按「本地文件
        // 损坏」处理并移出队列，于是整条队列以肉眼可见的速度被逐首吃掉，直到撞上一首
        // 本地曲目——这正是「跳过第二首后疯狂切歌」的机制。
        // 正确做法是把「这条还没有地址」如实告诉 JS，由它取址后重新下发队列
        // （nativeBootstrapPlay）从这个位置继续播。
        if (item.path.isBlank()) {
            Log.i(TAG, "startCurrent: index=$currentIndex 无播放地址，交回 JS 取址")
            releasePlayer()
            releasePlaybackResources()
            updateMetadata(item)
            updateSessionState(false)
            emitEvent("unresolved", mapOf("index" to currentIndex))
            return
        }
        releasePlayer()
        pendingSeekMs = positionMs
        lastWatchPositionMs = -1
        stallTicks = 0

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
                // 时长只能在 prepared 之后取：提前问会触发 native error(-38) 中断播放
                playerPrepared = true
                prepareStartedAt = 0L
                playerDurationMs = prepared.duration.toLong().coerceAtLeast(0L)
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
                // 真实时长此时才可用（在线曲目 prepareAsync 可能较慢），
                // 必须在 updateSessionState 之前写入 metadata，否则锁屏进度条没有总长
                updateMetadata(queue.getOrNull(currentIndex))
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
            // 记录 prepare 起点：看门狗据此判定「prepareAsync 超过 30 秒未回调」
            // 并重建播放器重试。此前该变量只被读、从未被赋值，超时分支永远不成立，
            // 在线直链长时间不响应时引擎会一直空转不恢复。
            prepareStartedAt = SystemClock.elapsedRealtime()
            mp.prepareAsync()
        } catch (e: Throwable) {
            handleError(-1, -1)
            return
        }

        // 立即更新元数据/通知栏（不等 prepared）：时长先用 JS 下发的值，
        // prepared 后再用 MediaPlayer 的真实 duration 覆盖；封面异步加载后就绪即刷
        refreshArtwork(item)
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
        Log.e(TAG, "handleError: what=$what extra=$extra index=$currentIndex")
        val item = queue.getOrNull(currentIndex)
        // 网络流错误先原地重试：一次瞬时抖动不该把整首歌判死。
        // 只有重试预算用尽才上报 error —— JS 侧对在线曲目的处理是「停住 + 提示」，
        // 不会自动跳下一首，所以这里的自愈是唯一的恢复机会。
        if (item != null && isRemote(item.path) && networkRetryCount < maxNetworkRetries) {
            networkRetryCount++
            val attempt = networkRetryCount
            releasePlayer()
            updateSessionState(false)
            Log.w(TAG, "handleError: 网络流错误，${retryBaseDelayMs * attempt}ms 后重试（第 $attempt / $maxNetworkRetries 次）")
            scheduleRetry(retryBaseDelayMs * attempt) { startCurrent(true, 0, isRetry = true) }
            return
        }
        releasePlayer()
        releasePlaybackResources()
        emitEvent("error", mapOf(
            "index" to currentIndex,
            "what" to what,
            "extra" to extra,
        ))
        updateSessionState(false)
    }

    /** 延迟重试：同一时刻只保留一个（换曲/暂停/停止会取消），避免重试风暴把引擎打满 */
    private fun scheduleRetry(delayMs: Long, action: () -> Unit) {
        cancelScheduledRetry()
        val runnable = Runnable {
            retryRunnable = null
            try { action() } catch (_: Throwable) {}
        }
        retryRunnable = runnable
        mainHandler.postDelayed(runnable, delayMs)
    }

    private fun cancelScheduledRetry() {
        retryRunnable?.let { mainHandler.removeCallbacks(it) }
        retryRunnable = null
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

    /**
     * 随机历史是否可用于回退：需要**至少一条更早的记录**，且末项就是当前曲目。
     *
     * ⚠️ 两个条件都不可少：
     * - 只有一条记录（`shuffleHistory == [currentIndex]`）是**点某一首起播**的常态
     *   （playQueue 只把起播位置写进历史）。此时若还回退到「上一条随机记录」，就是当前曲
     *   自己 —— 表现为按「上一首」把当前曲从头重放，用户读作「上一曲无法播放」。
     *   正确行为是退回顺序上一首。
     * - 末项必须等于当前曲目：playAt / syncQueue 只改索引不动历史，历史陈旧时按它会
     *   随机跳到别的曲目上去。
     */
    private fun shuffleHistoryValid(): Boolean =
        shuffleHistory.size >= 2 && shuffleHistory[shuffleHistory.size - 1] == currentIndex

    private fun computePrevIndex(): Int {
        if (queue.isEmpty()) return -1
        if (shuffleMode == "on" && shuffleHistoryValid()) {
            // 随机模式：回退到上一条随机记录（末项是当前曲，故取 size-2）
            return shuffleHistory[shuffleHistory.size - 2]
        }
        val p = currentIndex - 1
        return if (p < 0) queue.size - 1 else p
    }

    /**
     * JS 侧曲目 path 为外部存储相对路径（如 "Music/xx.flac"）、在线 URL，
     * 或 Capacitor 的本地文件地址；MediaPlayer 需要绝对路径或**真实** http(s) URL。
     *
     * 关键一条：`https://localhost/_capacitor_file_...` 只是 WebView 内部拦截用的
     * 伪 URL，并**没有**对应的 HTTP 服务端（`WebViewLocalServer` 只处理来自 WebView
     * 的请求）。把它交给 MediaPlayer 必然失败 —— 媒体缓存命中后"点了没声音"就是这条。
     * 所以在判断 http(s) 之前先把它还原成本地路径。
     */
    private fun resolvePath(path: String): String {
        capacitorFilePath(path)?.let { return it }
        if (path.startsWith("http://") || path.startsWith("https://")) return path
        if (path.startsWith("/")) return path
        return "/storage/emulated/0/$path"
    }

    /**
     * 从 Capacitor 本地文件地址里取出真实路径；不是该形态返回 null。
     *
     * `Capacitor.convertFileSrc` 只是把入参字符串拼进 `.../_capacitor_file_<path>`，
     * 而入参是经 `encodeFilePathToUrl` 逐段编码过的 —— 播放中文/含空格路径必须先解码，
     * 否则 MediaPlayer 打不开文件（表现为"这首歌播不了"，日志里只有 IOException）。
     */
    private fun capacitorFilePath(path: String): String? {
        val marker = "/_capacitor_file_"
        if (!path.contains(marker)) return null
        val raw = path.substringAfter(marker)
        return try {
            java.net.URLDecoder.decode(raw, "UTF-8")
        } catch (_: Throwable) {
            raw
        }
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
        playerPrepared = false
        prepareStartedAt = 0L
        playerDurationMs = 0L
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
        acquireWakeLock()
        requestAudioFocusIfNeeded()
    }

    /** 只在播放期间持有：这是"CPU 别睡"的保证，与音频焦点是两件事 */
    private fun acquireWakeLock() {
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
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
        } catch (_: Throwable) {}
    }

    private fun requestAudioFocusIfNeeded() {
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
                    .setOnAudioFocusChangeListener { focusChange -> onAudioFocusChange(focusChange) }
                    .build()
                focusRequest = req
                am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
            } else {
                @Suppress("DEPRECATION")
                am.requestAudioFocus(
                    { focusChange -> onAudioFocusChange(focusChange) },
                    AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN
                ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
            }
            hasAudioFocus = granted
        } catch (_: Throwable) {}
    }

    /**
     * 音频焦点变化。
     *
     * 之前这里**只打日志**：别的应用或系统播报把焦点抢走后，我们仍继续"播放"
     * （进度在走、声音被系统静音 / 输出被切走），车机上看到的就是
     * 「歌播到一半突然没声、像卡死了」，按一下切歌重新申请焦点才恢复。
     * 正确语义：被打断就暂停；焦点回来、且不是用户自己按的暂停，才续播。
     *
     * 例外是用户把「其他应用播放声音时」设成了 continue：这时焦点丢失/临时丢失
     * 只记录不中断。代价是焦点已经不在我们手上，系统可能把我们静音或把输出路由
     * 到别处（车机上就是「进度还在走、但没声音」）——这是用户显式选择的产品决定，
     * 风险由用户自担，代码不再替他兜底。CAN_DUCK / GAIN 两种语义不受该设置影响。
     *
     * **永久丢失（LOSS）与临时丢失（LOSS_TRANSIENT）必须分开处理**：永久丢失时系统
     * 不会再派 GAIN，所以既不能指望自动续播，也不能留着 hasAudioFocus=true——
     * 那会让用户下次手动播放时 requestAudioFocusIfNeeded() 直接短路，整段播放都没有焦点。
     */
    private fun onAudioFocusChange(focusChange: Int) {
        Log.i(TAG, "音频焦点变化: $focusChange (isPlaying=${try { player?.isPlaying } catch (_: Throwable) { false }}, behavior=$audioFocusBehavior)")
        when (focusChange) {
            // 永久丢失：另一音乐 App 拿到 GAIN，焦点不会还回来
            AudioManager.AUDIOFOCUS_LOSS -> {
                // 先清掉可能残留的 duck（CAN_DUCK 之后紧跟永久丢失时没有 GAIN 来复原）
                applyDuck(false)
                // 焦点确实没了：放弃并清标记，否则 hasAudioFocus 卡在 true（见函数注释）
                abandonAudioFocus()
                if (audioFocusBehavior == AUDIO_FOCUS_CONTINUE) {
                    Log.i(TAG, "焦点被永久抢占但设置为 continue：不暂停")
                } else {
                    pauseForFocusLoss()
                }
            }
            // 临时丢失：不放弃焦点，系统随后会派 GAIN，据 pausedByFocusLoss 自动续播
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                applyDuck(false)
                if (audioFocusBehavior == AUDIO_FOCUS_CONTINUE) {
                    Log.i(TAG, "焦点临时丢失但设置为 continue：不暂停")
                } else {
                    pauseForFocusLoss()
                }
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> applyDuck(true)
            AudioManager.AUDIOFOCUS_GAIN -> {
                applyDuck(false)
                if (pausedByFocusLoss) {
                    pausedByFocusLoss = false
                    resume()
                }
            }
        }
    }

    /**
     * 被抢焦点（仅临时丢失路径会走到这里）：停播放器，但**不**放弃焦点
     * （放弃后系统不会再派 GAIN，自动续播就没了）。
     */
    private fun pauseForFocusLoss() {
        // 排队的网络重试必须掐掉：否则它到点会把刚因焦点暂停的歌重新拉起来
        // （与 pause() / stopEngine() 的同一约束）
        cancelScheduledRetry()
        val p = player ?: return
        if (!p.isPlaying) return
        pausedByFocusLoss = true
        try {
            p.pause()
            releaseWakeLock()
            emitEvent("pause", mapOf("position" to (p.currentPosition / 1000.0)))
            updateSessionState(false)
            saveState()
        } catch (_: Throwable) {}
    }

    /** 导航播报一类（CAN_DUCK）：压低音量继续播，而不是停掉 */
    private fun applyDuck(ducked: Boolean) {
        try {
            val v = if (ducked) currentVolume * 0.3f else currentVolume
            player?.setVolume(v, v)
        } catch (_: Throwable) {}
    }

    /** 暂停/停止：释放 WakeLock 与音频焦点 */
    private fun releasePlaybackResources() {
        releaseWakeLock()
        abandonAudioFocus()
    }

    private fun abandonAudioFocus() {
        if (!hasAudioFocus) return
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

    private fun isRemote(path: String): Boolean =
        path.startsWith("http://") || path.startsWith("https://")

    /** 当前播放位置（毫秒）：prepare 完成前返回 0，避免触碰 MediaPlayer 的非法状态 */
    private fun currentPositionMs(): Long {
        if (!playerPrepared) return 0L
        return try { player?.currentPosition?.toLong() ?: 0L } catch (_: Throwable) { 0L }
    }

    /**
     * 当前曲目时长（毫秒）：优先播放器 prepare 时缓存的真实值，其次 JS 下发的队列值。
     * 锁屏进度条 = position / duration，缺 duration 时系统整条不渲染（只画两端空槽）。
     */
    private fun currentDurationMs(): Long {
        if (playerDurationMs > 0) return playerDurationMs
        return queue.getOrNull(currentIndex)?.durationMs?.takeIf { it > 0 } ?: 0L
    }

    /**
     * 写入 MediaSession metadata。除标题/歌手/专辑外，锁屏卡片还必须拿到：
     * - METADATA_KEY_DURATION：缺了进度条不渲染
     * - METADATA_KEY_ALBUM_ART / METADATA_KEY_ART：缺了只显示默认音符占位图
     */
    private fun updateMetadata(item: QueueItem? = queue.getOrNull(currentIndex)) {
        if (item == null) return
        val builder = MediaMetadataCompat.Builder()
            // 标题缺失时兜底成品牌名（app_name 标了 translatable="false"，不翻译）
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, item.title.ifEmpty { getString(R.string.app_name) })
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, item.artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, item.album)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, currentDurationMs())
        currentArtwork?.let {
            builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it)
            builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, it)
        }
        mediaSession?.setMetadata(builder.build())
    }

    /** 封面缓存 key：JS 下发的来源优先，否则退化为音频文件内嵌封面 */
    private fun artworkKey(item: QueueItem): String =
        item.cover.ifEmpty { if (isRemote(item.path)) "" else "embedded:${resolvePath(item.path)}" }

    /**
     * 刷新当前曲目封面（主线程调用）。
     * 命中缓存则同步生效；未命中先清空旧封面（避免上一首封面残留），再异步加载回填。
     */
    private fun refreshArtwork(item: QueueItem) {
        val key = artworkKey(item)
        artworkToken++
        val token = artworkToken
        if (key.isEmpty()) {
            currentArtwork = null
            updateMetadata(item)
            return
        }
        val cached = artworkCache.get(key)
        if (cached != null) {
            currentArtwork = cached
            updateMetadata(item)
            return
        }
        currentArtwork = null
        updateMetadata(item)
        artworkHandler.post {
            val bitmap = loadArtwork(item)
            mainHandler.post {
                // 解码期间又切了歌：结果作废，防止封面串台
                if (token != artworkToken) return@post
                if (bitmap == null) {
                    Log.w(TAG, "封面加载失败: key=$key") 
                    return@post
                }
                artworkCache.put(key, bitmap)
                currentArtwork = bitmap
                updateMetadata(item)
                val playing = try { player?.isPlaying == true } catch (_: Throwable) { false }
                updateSessionState(playing)
            }
        }
    }

    /**
     * JS 侧封面异步就绪（CoverImage 提取/升级高清封面完成）后刷新锁屏封面。
     * 队列下发时封面可能尚未提取，这里做二次补写。
     */
    fun updateCurrentCover(cover: String) {
        mainHandler.post {
            val index = currentIndex
            val item = queue.getOrNull(index) ?: return@post
            if (item.cover == cover) return@post
            queue[index] = item.copy(cover = cover)
            refreshArtwork(queue[index])
        }
    }

    /** 解析封面来源（artwork 线程）：JS 下发来源优先，失败则退化为音频内嵌封面 */
    private fun loadArtwork(item: QueueItem): Bitmap? {
        if (item.cover.isNotEmpty()) {
            decodeArtworkSource(item.cover)?.let { return it }
        }
        val audio = resolvePath(item.path)
        if (isRemote(audio)) return null
        return embeddedArtwork(audio)
    }

    /** 支持 Capacitor 本地 URL / 远端直链 / file:// / 绝对路径四种形态 */
    private fun decodeArtworkSource(src: String): Bitmap? = try {
        when {
            // Capacitor convertFileSrc：https://localhost/_capacitor_file_/data/.../covers/x.jpg
            // 入参是逐段编码过的（`encodeFilePathToUrl`），必须解码后才能打开；
            // 与 resolvePath 共用同一个解码函数，免得两处口径分叉
            src.contains("/_capacitor_file_") -> capacitorFilePath(src)?.let { decodeArtworkFile(it) }
            src.startsWith("file://") -> decodeArtworkFile(src.removePrefix("file://"))
            src.startsWith("/") -> decodeArtworkFile(src)
            isRemote(src) -> downloadArtwork(src)
            else -> null
        }
    } catch (e: Throwable) {
        Log.w(TAG, "封面解析失败: $src", e) 
        null
    }

    private fun decodeArtworkFile(path: String): Bitmap? {
        val file = File(path)
        if (!file.exists() || !file.canRead()) return null
        return BitmapFactory.decodeFile(path)?.let { limitArtwork(it) }
    }

    private fun downloadArtwork(url: String): Bitmap? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000
                readTimeout = 8000
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", "AuroraMusic/1.0")
            }
            conn.inputStream.use { BitmapFactory.decodeStream(it) }?.let { limitArtwork(it) }
        } catch (e: Throwable) {
            Log.w(TAG, "封面下载失败: $url", e) 
            null
        } finally {
            try { conn?.disconnect() } catch (_: Throwable) {}
        }
    }

    /** 从音频文件内嵌标签提取封面（本地曲目兜底） */
    private fun embeddedArtwork(audioPath: String): Bitmap? {
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(audioPath)
            retriever.embeddedPicture?.let { bytes ->
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { limitArtwork(it) }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "内嵌封面提取失败: $audioPath", e) 
            null
        } finally {
            try { retriever.release() } catch (_: Throwable) {}
        }
    }

    /**
     * 限制封面尺寸：metadata 里的 Bitmap 经 Binder 传给系统 UI，
     * 原图（数 MB）会触发 TransactionTooLargeException，导致整份元数据下发失败
     * （表现就是锁屏封面和进度一起消失）。
     */
    private fun limitArtwork(src: Bitmap): Bitmap {
        val max = 512
        val longest = maxOf(src.width, src.height)
        if (longest <= max) return src
        val ratio = max.toFloat() / longest
        return Bitmap.createScaledBitmap(
            src,
            (src.width * ratio).toInt().coerceAtLeast(1),
            (src.height * ratio).toInt().coerceAtLeast(1),
            true
        )
    }

    private fun updateSessionState(isPlaying: Boolean) {
        val positionMs = currentPositionMs()
        val durationMs = currentDurationMs()
        val position = if (durationMs > 0) positionMs.coerceIn(0L, durationMs) else positionMs.coerceAtLeast(0L)
        val state = if (isPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        val stateBuilder = PlaybackStateCompat.Builder()
            .setActions(
                PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
                PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or PlaybackStateCompat.ACTION_STOP or
                PlaybackStateCompat.ACTION_SEEK_TO
            )
            // 显式给 updateTime：系统按 speed 自行推进进度，暂停时必须 speed=0
            .setState(state, position, if (isPlaying) 1.0f else 0.0f, SystemClock.elapsedRealtime())
        mediaSession?.setPlaybackState(stateBuilder.build())

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

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title ?: getString(R.string.app_name))
            .setContentText(artist ?: "")
            .setSmallIcon(R.drawable.ic_stat_play)
            .setContentIntent(contentPI)
            // 三个动作文案走资源：中文系统取 values-zh/，其余语言取默认（英文）
            .addAction(R.drawable.ic_stat_prev, getString(R.string.aurora_notification_action_previous), actionPI(ACTION_PREV, 1))
            .addAction(
                if (isPlaying) R.drawable.ic_stat_pause else R.drawable.ic_stat_play,
                getString(if (isPlaying) R.string.aurora_notification_action_pause else R.string.aurora_notification_action_play),
                actionPI(if (isPlaying) ACTION_PAUSE else ACTION_PLAY, 2)
            )
            .addAction(R.drawable.ic_stat_next, getString(R.string.aurora_notification_action_next), actionPI(ACTION_NEXT, 3))
            .setStyle(style)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)

        // 封面大图 + 进度：Android 13+ 由系统读 MediaSession 渲染，
        // 13 以下与部分国产 ROM 则依赖通知自身字段，两边都写才稳
        currentArtwork?.let { builder.setLargeIcon(it) }
        val durationMs = currentDurationMs()
        if (durationMs > 0) {
            val positionMs = currentPositionMs()
            builder.setProgress(
                durationMs.toInt(),
                positionMs.coerceIn(0L, durationMs).toInt(),
                false
            )
        }
        return builder.build()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(playbackWatchdog)
        cancelScheduledRetry()
        try { unregisterReceiver(mediaButtonReceiver) } catch (_: Throwable) {}
        artworkThread.quitSafely()
        stateThread.quitSafely()
        releasePlayer()
        releasePlaybackResources()
        mediaSession?.isActive = false
        mediaSession?.release()
        instance = null
        super.onDestroy()
    }
}
