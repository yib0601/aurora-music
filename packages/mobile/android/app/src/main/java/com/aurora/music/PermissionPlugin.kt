package com.aurora.music

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Capacitor 插件：管理 Android 11+ 的 MANAGE_EXTERNAL_STORAGE 特殊权限。
 *
 * 背景：Android 11（API 30）起，普通存储权限不再允许访问 /storage/emulated/0 下的
 * 任意目录。扫描本地音乐需要 MANAGE_EXTERNAL_STORAGE，但这是特殊权限，必须由
 * 用户在系统设置中手动授予，不能通过弹窗自动获取。
 *
 * JS 端通过 window.Capacitor.Plugins.Permission 调用：
 *   - hasAllFilesAccess(): 返回 { granted: boolean }，判断当前是否已授权
 *   - requestAllFilesAccess(): 跳到系统「所有文件访问」设置页（带本应用 deep link）
 *
 * 配合 App.tsx：启动时调用 hasAllFilesAccess 检测，未授权则弹引导 Dialog，
 * 用户点「前往设置」后调用 requestAllFilesAccess 跳转；监听 app resume 后重新检测，
 * 已授权则触发扫描。
 *
 * 兼容性：API < 30（Android 10 及以下）走旧 READ_EXTERNAL_STORAGE 权限模型，
 * hasAllFilesAccess 直接返回 granted=true（旧系统不需要 AllFilesAccess）。
 */
@CapacitorPlugin(name = "Permission")
class PermissionPlugin : Plugin() {

    /**
     * 检测是否拥有「所有文件访问」权限。
     * Android 11+ 用 Environment.isExternalStorageManager()，
     * Android 10 及以下不需要此权限，直接返回 true（旧权限模型已通过 READ_EXTERNAL_STORAGE 处理）。
     */
    @PluginMethod
    fun hasAllFilesAccess(call: PluginCall) {
        val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            // Android 10 及以下不需要 AllFilesAccess，旧权限模型由 READ_EXTERNAL_STORAGE 覆盖
            true
        }
        val ret = JSObject()
        ret.put("granted", granted)
        call.resolve(ret)
    }

    /**
     * 跳到系统「所有文件访问」设置页（带本应用 deep link）。
     * 用户授权后按返回键回到 App，前端通过 @capacitor/app 的 appStateChange(resume) 重新检测。
     *
     * 注意：Android 11+ 才有此 intent；Android 10 及以下调用直接 resolve（无需授权）。
     */
    @PluginMethod
    fun requestAllFilesAccess(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            // Android 10 及以下不需要此权限，直接返回 success
            val ret = JSObject()
            ret.put("opened", false)
            call.resolve(ret)
            return
        }
        try {
            // 优先用包名 deep link，直接定位到本应用权限页
            val intent = Intent(
                Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                Uri.parse("package:${context.packageName}")
            )
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            val ret = JSObject()
            ret.put("opened", true)
            call.resolve(ret)
        } catch (e: Exception) {
            // 某些 OEM ROM 不接受 deep link，降级到全局「所有文件访问」列表页
            try {
                val fallback = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(fallback)
                val ret = JSObject()
                ret.put("opened", true)
                call.resolve(ret)
            } catch (e2: Exception) {
                call.reject("无法打开权限设置页: ${e2.message}")
            }
        }
    }
}
