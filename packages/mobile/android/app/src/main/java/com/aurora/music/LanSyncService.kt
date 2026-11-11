package com.aurora.music

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import java.util.concurrent.Executors
import java.util.concurrent.ExecutorService

/**
 * 局域网同步的前台服务（`foregroundServiceType="dataSync"`）。
 *
 * ## 为什么必须是前台服务
 *
 * 监听端口 + UDP 广播是**长驻网络行为**：没有前台服务时，应用切到后台/锁屏后
 * Android 会做两件事——把进程冻结（Doze 的 App Standby），并在内存压力下直接杀掉。
 * 表现是「对端明明在同一网段却连不上」，而且没有任何错误能反馈给用户。
 * 前台服务把进程标记为「用户可见的正在进行的工作」，配合常驻通知，
 * 让对端在手机息屏时仍能推快照进来。
 *
 * 类型选 `dataSync` 而不是 `mediaPlayback`：本服务不碰音频，声明错类型会在
 * Android 14+ 的 FGS 校验里被拒（或让系统按错误策略调度）。
 *
 * ## 通知的角色
 *
 * 它**不是**装饰：前台服务必须有一条用户可见的通知，否则系统会直接判违规。
 * 渠道 `aurora_lan_sync` 用 IMPORTANCE_LOW + 静音 + 不显示角标：
 * 同步是后台辅助行为，不该响铃也不该在图标上堆红点。点通知回到 MainActivity。
 *
 * ## 服务与运行时单例的分工
 *
 * 真正的 socket / UDP / 定时器都在 `LanSyncRuntime` 里（进程级单例）。
 * 本服务只负责两件事：把进程「钉住」（前台服务），以及在自己被销毁时收尾
 * （关 socket），避免「通知没了但端口还开着」的幽灵状态。
 */
class LanSyncService : Service() {

    companion object {
        private const val TAG = "AuroraLanSync"
        private const val CHANNEL_ID = "aurora_lan_sync"

        /** 通知 id：与播放通知（MediaPlaybackService 用的那个）必须不同，否则会互相覆盖 */
        private const val NOTIFICATION_ID = 4210

        /**
         * 启动/停止服务。
         *
         * Android 8+ 从后台 `startService` 会抛 `IllegalStateException`，必须用
         * `startForegroundService` 并在 5s 内 `startForeground`（本服务在
         * `onStartCommand` 第一件事就是它）。
         */
        fun start(context: Context) {
            val intent = Intent(context, LanSyncService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, LanSyncService::class.java))
        }
    }

    /** socket 起在后台线程：`startForeground` 必须 5s 内完成，不能在它之前做网络绑定 */
    private val worker: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "aurora-lansync-service").apply { isDaemon = true }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 第一步永远是 startForeground：超时未调用会被系统直接杀进程并算一次 ANR 级违规
        startForegroundCompat(notification())
        worker.execute {
            val started = LanSyncRuntime.ensureStarted(applicationContext)
            if (!started) {
                Log.w(TAG, "runtime did not start; stopping foreground service")
            }
            // 起来（或失败）之后刷新一次通知：端口是 start 之后才知道的
            notifyForeground(notification())
        }
        // 不做 START_STICKY：进程被杀后由系统静默拉起一个「没人知道的同步服务」没有意义
        // （快照缓存与配对状态都在内存里，重启后服务是空的），下次打开应用时 JS 会按
        // 用户保存的开关重新 setEnabled(true)
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?): Unit {
        // 用户从最近任务划掉应用 = 明确要求停下（与 MediaPlaybackService 同口径）。
        // 只留 WebView 挂起这一种情况继续跑，那才是「服务该替渲染层活着」的场景。
        Log.i(TAG, "task removed; stopping lan sync service")
        stopSelf()
    }

    override fun onDestroy() {
        worker.shutdownNow()
        // 关 HTTP / UDP / 取消在途配对：不能留下「通知没了但端口还开着」的幽灵监听
        LanSyncRuntime.stop()
        super.onDestroy()
    }

    /* ------------------------------------------------------------------ *
     * 通知
     * ------------------------------------------------------------------ */

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.aurora_lan_sync_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.aurora_lan_sync_channel_description)
            // 静音 + 不出角标：同步是后台辅助行为，不该打扰用户
            setSound(null, null)
            enableVibration(false)
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    private fun notification(): Notification {
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_SINGLE_TOP },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val port = LanSyncRuntime.currentPort()
        val text = if (port != null) {
            getString(R.string.aurora_lan_sync_notification_text, port)
        } else {
            getString(R.string.aurora_lan_sync_notification_text_starting)
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.aurora_lan_sync_notification_title))
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_stat_lan_sync)
            .setContentIntent(contentIntent)
            // 常驻 + 不响：用户唯一能做的动作是关掉开关，不该能手动划掉它
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setSilent(true)
            .build()
    }

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            // API 29 才有带 type 的重载；低版本调三参版会 NoSuchMethodError
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun notifyForeground(notification: Notification) {
        try {
            getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, notification)
        } catch (e: Exception) {
            Log.w(TAG, "notification update failed: ${e.javaClass.simpleName}")
        }
    }
}
