package com.aurora.music

import android.content.Context
import android.net.wifi.WifiManager
import android.util.Log
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.SocketException
import java.net.SocketTimeoutException
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * 局域网设备发现（UDP 广播，`DatagramSocket`）。
 *
 * ## 为什么是广播而不是 mDNS
 *
 * 与桌面端同一判据：mDNS 要走组播、依赖系统解析器，而这里只需要「同网段、毫秒级、
 * 抄一段 JSON」。广播足够，且零依赖。
 *
 * ## 广播包里**没有**配对码
 *
 * 包体只有 `{ kind, proto, deviceId, deviceName, port }`（§7）。配对码是抄写凭据，
 * 一旦进了广播包，同网段任何人都能拿到并推对端歌单，那它就等于没有。
 *
 * ## 为什么必须持 `MulticastLock`
 *
 * Wi-Fi 驱动默认会把「不是发给自己的」广播/组播帧在硬件层过滤掉以省电，
 * 不持锁时 `DatagramSocket` 收不到其它设备的 announce，表现为「另一台设备明明在广播，
 * 本机永远发现不到」。`WifiManager.MulticastLock` 就是关掉这个过滤的开关，
 * 因此 Manifest 需要 `ACCESS_WIFI_STATE` + `CHANGE_WIFI_MULTICAST_STATE`。
 * 拿不到 Wi-Fi 服务（纯以太网 / 飞行模式）时降级为不持锁，广播仍可能收到。
 *
 * ## 端口与自收包
 *
 * 绑定 45872 且 `reuseAddress`：同一台机器上桌面端与手机端（或开发时残留进程）
 * 可以各绑一份。代价是自己发的包自己也会收到——处理前先按 `deviceId` 排除自己。
 */
internal class LanSyncDiscovery(
    private val context: Context,
    private val deviceId: String,
    private val deviceName: String,
    /** 当前 HTTP 端口；null = 服务没开，此时不广播（对端也连不上） */
    private val getPort: () -> Int?,
) {

    private companion object {
        const val TAG = "AuroraLanSync"

        /** 发现用 UDP 端口（与 HTTP 服务端口分开：一个广播、一个单播） */
        const val DISCOVERY_PORT = 45872

        /** 周期性 announce 间隔；UDP 丢了也能在下一轮补上 */
        const val ANNOUNCE_INTERVAL_MS = 15_000L

        /** discover 默认/最长等待时间（与桌面端一致） */
        const val DEFAULT_TIMEOUT_MS = 1_200
        const val MAX_TIMEOUT_MS = 10_000

        /** 单包上限：协议包只有一百多字节，2KB 足够且不会被大包打爆内存 */
        const val MAX_PACKET_BYTES = 2048

        /** 周期性 announce 的线程名 */
        const val SCHEDULER_NAME = "aurora-lansync-announce"
    }

    /** 发现到的对端（`lastSeenAt` 是单调的本机时刻，用于 discover 的时间窗过滤） */
    data class Peer(
        val deviceId: String,
        val deviceName: String,
        val host: String,
        val port: Int,
        val protocol: Int,
        val lastSeenAt: Long,
    )

    @Volatile
    private var running = false

    private var socket: DatagramSocket? = null
    private var receiveThread: Thread? = null
    private var scheduler: ScheduledExecutorService? = null
    private var multicastLock: WifiManager.MulticastLock? = null

    /** deviceId → 最近一次看到的对端；访问都在 synchronized(peers) 下 */
    private val peers = LinkedHashMap<String, Peer>()

    fun start() {
        if (running) return
        val socket = DatagramSocket(null)
        try {
            // reuseAddress 必须在 bind 之前设置：允许同机多进程各绑一份（开发时常见）
            socket.reuseAddress = true
            socket.broadcast = true
            socket.bind(InetSocketAddress(DISCOVERY_PORT))
            socket.soTimeout = 1_000
        } catch (e: Exception) {
            try {
                socket.close()
            } catch (_: Exception) {
                // 未绑定成功的 close 也可能抛错，忽略
            }
            throw e
        }
        this.socket = socket
        running = true
        acquireMulticastLock()

        receiveThread = Thread({ receiveLoop(socket) }, "aurora-lansync-udp").apply {
            isDaemon = true
            start()
        }
        val scheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, SCHEDULER_NAME).apply { isDaemon = true }
        }
        this.scheduler = scheduler
        scheduler.scheduleWithFixedDelay(
            { safeAnnounce() },
            0L,
            ANNOUNCE_INTERVAL_MS,
            TimeUnit.MILLISECONDS,
        )
        Log.i(TAG, "discovery listening on $DISCOVERY_PORT")
    }

    fun stop() {
        if (!running && socket == null) return
        running = false
        scheduler?.shutdownNow()
        scheduler = null
        val socket = this.socket
        this.socket = null
        try {
            socket?.close()
        } catch (_: Exception) {
            // 关掉即可，receive 会抛 SocketException 退出
        }
        receiveThread?.interrupt()
        receiveThread = null
        releaseMulticastLock()
        synchronized(peers) { peers.clear() }
        Log.i(TAG, "discovery stopped")
    }

    /**
     * 发一次 probe，在 `timeoutMs` 内收集 announce，按 deviceId 去重后返回。
     *
     * 服务没开时直接返回空：此时本机没有可被连的端口，对端回了 announce 也用不上，
     * 反而会让 UI 显示「发现了设备却连不上」（与桌面端同一行为）。
     */
    fun discover(timeoutMs: Int?): List<Peer> {
        val socket = this.socket ?: return emptyList()
        if (!running) return emptyList()
        val port = getPort() ?: return emptyList()

        val requested = timeoutMs ?: DEFAULT_TIMEOUT_MS
        val waitMs = requested.coerceIn(100, MAX_TIMEOUT_MS)
        val startedAt = System.currentTimeMillis()

        val probe = packetOf("probe", port)
        for (target in broadcastTargets()) {
            send(socket, probe, target, DISCOVERY_PORT)
        }

        try {
            Thread.sleep(waitMs.toLong())
        } catch (_: InterruptedException) {
            // 被中断就当等够了，返回已收集到的
        }

        val collected = synchronized(peers) {
            peers.values.filter { it.lastSeenAt >= startedAt }
        }
        return collected.sortedWith(
            compareBy<Peer> { it.deviceName.lowercase(Locale.ROOT) }.thenBy { it.deviceId },
        )
    }

    /* ------------------------------------------------------------------ *
     * 收发
     * ------------------------------------------------------------------ */

    private fun packetOf(kind: String, port: Int): ByteArray =
        JSONObject()
            .put("kind", kind)
            .put("proto", LanSyncCrypto.PROTOCOL_VERSION)
            .put("deviceId", deviceId)
            .put("deviceName", deviceName)
            .put("port", port)
            .toString()
            .toByteArray(Charsets.UTF_8)

    private fun safeAnnounce() {
        try {
            val socket = this.socket ?: return
            if (!running) return
            val port = getPort() ?: return
            val announce = packetOf("announce", port)
            for (target in broadcastTargets()) {
                send(socket, announce, target, DISCOVERY_PORT)
            }
        } catch (e: Exception) {
            // 单轮广播失败（某块虚拟网卡不可达 / socket 正在关闭）不值得打日志到 warn
            Log.d(TAG, "announce skipped: ${e.javaClass.simpleName}")
        }
    }

    private fun receiveLoop(socket: DatagramSocket) {
        val buffer = ByteArray(MAX_PACKET_BYTES)
        while (running) {
            val packet = DatagramPacket(buffer, buffer.size)
            try {
                socket.receive(packet)
            } catch (e: SocketTimeoutException) {
                // soTimeout 只是用来定期检查 running，不是错误
                continue
            } catch (e: SocketException) {
                // stop() 关掉了 socket
                break
            } catch (e: Exception) {
                if (!running) break
                Log.w(TAG, "udp receive failed: ${e.javaClass.simpleName}")
                continue
            }
            try {
                handlePacket(socket, packet)
            } catch (e: Exception) {
                // 一个坏包不能让接收线程死掉
                Log.d(TAG, "udp packet ignored: ${e.javaClass.simpleName}")
            }
        }
    }

    private fun handlePacket(socket: DatagramSocket, packet: DatagramPacket) {
        val text = String(packet.data, 0, packet.length, Charsets.UTF_8)
        val json = try {
            JSONObject(text)
        } catch (_: Exception) {
            return
        }

        val kind = json.optString("kind", "")
        if (kind != "announce" && kind != "probe") return
        if (json.optInt("proto", -1) != LanSyncCrypto.PROTOCOL_VERSION) return
        val peerId = json.optString("deviceId", "")
        if (peerId.isEmpty()) return
        // reuseAddress 会把自己发的包也收回来（以及同机另一个进程的）：按 deviceId 排除自己
        if (peerId == deviceId) return
        val peerPort = json.optInt("port", 0)
        if (peerPort < 1 || peerPort > 65535) return
        val peerName = json.optString("deviceName", "")
        val host = packet.address?.hostAddress ?: return

        if (kind == "probe") {
            // 单播回去：用对端发包的源端口（它在 45872 上等），不广播，避免把整网段吵醒
            val port = getPort() ?: return
            send(socket, packetOf("announce", port), host, packet.port)
            return
        }

        // 地址一律取 UDP 源地址，不信包里自报的任何东西（包里本来也只有 port）
        val peer = Peer(
            deviceId = peerId,
            deviceName = peerName,
            host = host,
            port = peerPort,
            protocol = LanSyncCrypto.PROTOCOL_VERSION,
            lastSeenAt = System.currentTimeMillis(),
        )
        synchronized(peers) {
            // 设备数不设上限：一个网段里的设备量级远小于内存风险，且过期项由 stop 清空
            peers[peerId] = peer
        }
        Log.d(TAG, "peer announced: ${prefix(peerId)} @ $host:$peerPort")
    }

    private fun send(socket: DatagramSocket, payload: ByteArray, host: String, port: Int) {
        try {
            socket.send(DatagramPacket(payload, payload.size, InetAddress.getByName(host), port))
        } catch (e: Exception) {
            // 单条广播失败很常见（某块虚拟网卡不可达），静默即可
            Log.d(TAG, "udp send failed to $host: ${e.javaClass.simpleName}")
        }
    }

    private fun send(socket: DatagramSocket, payload: ByteArray, host: InetAddress, port: Int) {
        try {
            socket.send(DatagramPacket(payload, payload.size, host, port))
        } catch (e: Exception) {
            Log.d(TAG, "udp send failed: ${e.javaClass.simpleName}")
        }
    }

    /**
     * 广播目标：各网卡子网广播地址 + 恒定兜底 `255.255.255.255`。
     *
     * 子网广播能穿过部分交换机/VLAN 配置下的受限广播限制，比纯 255.255.255.255 更可靠；
     * 兜底地址保证多宿主 / 虚拟网卡算错时不至于完全发现不到。重复目标由 Set 去重。
     */
    private fun broadcastTargets(): List<InetAddress> {
        val targets = LinkedHashSet<InetAddress>()
        try {
            targets.add(InetAddress.getByName("255.255.255.255"))
        } catch (e: Exception) {
            Log.d(TAG, "broadcast fallback unavailable: ${e.javaClass.simpleName}")
        }
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces() ?: return targets.toList()
            for (networkInterface in interfaces) {
                try {
                    if (!networkInterface.isUp || networkInterface.isLoopback) continue
                    for (address in networkInterface.interfaceAddresses) {
                        val broadcast = address.broadcast ?: continue
                        if (address.address is Inet4Address && broadcast is Inet4Address) {
                            targets.add(broadcast)
                        }
                    }
                } catch (_: Exception) {
                    // 单块网卡枚举失败不影响其它网卡
                }
            }
        } catch (e: Exception) {
            // 取网卡失败时保留兜底地址即可
            Log.d(TAG, "network interfaces unavailable: ${e.javaClass.simpleName}")
        }
        return targets.toList()
    }

    /* ------------------------------------------------------------------ *
     * MulticastLock
     * ------------------------------------------------------------------ */

    private fun acquireMulticastLock() {
        try {
            val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                ?: return
            val lock = wifi.createMulticastLock("aurora-lan-sync")
            lock.setReferenceCounted(false)
            lock.acquire()
            multicastLock = lock
        } catch (e: Exception) {
            // 没有 Wi-Fi（纯以太网 / 飞行模式）时拿不到锁，广播仍可能收到，不该因此起不来
            Log.w(TAG, "multicast lock unavailable: ${e.javaClass.simpleName}")
        }
    }

    private fun releaseMulticastLock() {
        val lock = multicastLock ?: return
        multicastLock = null
        try {
            lock.release()
        } catch (_: Exception) {
            // 释放失败不影响功能（进程退出时系统会回收）
        }
    }

    private fun prefix(value: String): String = if (value.length > 8) value.substring(0, 8) else value
}
