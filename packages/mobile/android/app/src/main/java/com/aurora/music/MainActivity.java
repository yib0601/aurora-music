package com.aurora.music;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注册原生插件（Kotlin 实现）
        // MediaSession：ForegroundService + MediaSessionCompat，解决 Honor/Huawei 后台静音
        // Permission：MANAGE_EXTERNAL_STORAGE 特殊权限引导，扫描本地音乐前必须授权
        // Update：Android 应用内更新（DownloadManager 下载 APK + FileProvider 调起系统安装器）
        registerPlugin(MediaSessionPlugin.class);
        registerPlugin(PermissionPlugin.class);
        registerPlugin(UpdatePlugin.class);
        // NativeHttp：任意 HTTP 动词（WebDAV 的 PROPFIND）+ base64 二进制读体。
        // CapacitorHttp 底层是 HttpURLConnection，它拒绝非标准动词（ProtocolException），
        // 网络存储的列目录因此只能走 OkHttp。
        registerPlugin(NativeHttpPlugin.class);
        // SecureStorage：Android Keystore 的 AES-GCM 加解密。网络存储口令用它加密后再落盘
        // （没有 keyring 等价物时，这是唯一不引第三方库的加密手段）。
        registerPlugin(SecureStoragePlugin.class);
        // LanSync：局域网同步服务端（HTTP 监听 + UDP 广播 + 一键配对）。
        // socket/UDP 的生命周期挂在 LanSyncService 前台服务上，WebView 被挂起时仍能接请求。
        registerPlugin(LanSyncPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /**
     * 回到前台时补一次重绘。
     *
     * 车机上的 WebView 在后台被系统停摆后，回来常表现为「声音恢复了、界面停在旧帧」：
     * 音频走的是 MediaPlaybackService 里的原生 MediaPlayer（不依赖 WebView，
     * 所以媒体键还能切歌），挂掉的只有界面这一侧。Capacitor 的 onResume 只恢复
     * 定时器，不保证合成器重新出帧，这里显式 resumeTimers + 连续两次 invalidate
     * （当帧一次、下一帧再一次）把合成器推起来。失败不影响音频。
     */
    @Override
    public void onResume() {
        super.onResume();
        Bridge bridge = getBridge();
        if (bridge == null) {
            return;
        }
        WebView webView = bridge.getWebView();
        if (webView == null) {
            return;
        }
        try {
            webView.resumeTimers();
            webView.invalidate();
            webView.post(() -> webView.invalidate());
        } catch (Throwable ignored) {
            // 重绘兜底失败不影响播放（音频在原生服务里）
        }
    }
}
