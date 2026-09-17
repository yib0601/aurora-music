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
        super.onCreate(savedInstanceState);
    }
}
