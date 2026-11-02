package com.aurora.music;

import android.os.Bundle;

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
        super.onCreate(savedInstanceState);
    }
}
