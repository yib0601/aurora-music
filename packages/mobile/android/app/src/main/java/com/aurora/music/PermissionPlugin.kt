package com.aurora.music

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * Capacitor 插件：本地音乐扫描所需的存储权限管理。
 *
 * 权限模型分两层：
 * 1. 运行时媒体权限（READ_MEDIA_AUDIO，Android 13+ / READ_EXTERNAL_STORAGE，Android 12 及以下）
 *    —— 标准运行时权限，系统弹窗一键授予，足以通过 FUSE 直读公共目录中的音频文件。
 *    注意：@capacitor/filesystem 在 Android 11+ 上 isStoragePermissionGranted() 恒为 true，
 *    requestPermissions() 不会真正申请 READ_MEDIA_AUDIO，必须由本插件自行申请。
 * 2. 特殊权限 MANAGE_EXTERNAL_STORAGE（「所有文件访问」，Android 11+）
 *    —— 用于访问 FUSE 直读覆盖不到的任意目录；必须在系统设置中手动授予。
 *
 * JS 端通过 window.Capacitor.Plugins.Permission 调用：
 *   - hasMediaPermissions(): 是否已授予运行时媒体权限
 *   - requestMediaPermissions(): 弹系统对话框申请运行时媒体权限
 *   - hasAllFilesAccess(): 是否已授予「所有文件访问」
 *   - requestAllFilesAccess(): 跳到系统「所有文件访问」设置页
 */
@CapacitorPlugin(
    name = "Permission",
    permissions = [
        Permission(strings = [Manifest.permission.READ_MEDIA_AUDIO], alias = "mediaAudio"),
        Permission(strings = [Manifest.permission.READ_EXTERNAL_STORAGE], alias = "legacyStorage")
    ]
)
class PermissionPlugin : Plugin() {

    /** 运行时媒体权限是否已授予（Android 13+ 查 READ_MEDIA_AUDIO，旧系统查 READ_EXTERNAL_STORAGE） */
    private fun isMediaPermissionGranted(): Boolean {
        val permission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.READ_MEDIA_AUDIO
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }
        return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
    }

    /**
     * 检测运行时媒体权限（READ_MEDIA_AUDIO）是否已授予。
     * Android 11+ 且已授予「所有文件访问」时同样具备读取能力，直接返回 true。
     */
    @PluginMethod
    fun hasMediaPermissions(call: PluginCall) {
        val granted = isMediaPermissionGranted() ||
            (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager())
        val ret = JSObject()
        ret.put("granted", granted)
        call.resolve(ret)
    }

    /**
     * 弹系统对话框申请运行时媒体权限。
     * 已授予（或已拥有所有文件访问）时直接返回 granted=true，不弹窗。
     */
    @PluginMethod
    fun requestMediaPermissions(call: PluginCall) {
        if (isMediaPermissionGranted() ||
            (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager())
        ) {
            val ret = JSObject()
            ret.put("granted", true)
            call.resolve(ret)
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissionForAlias("mediaAudio", call, "mediaPermissionCallback")
        } else {
            requestPermissionForAlias("legacyStorage", call, "mediaPermissionCallback")
        }
    }

    /** 媒体权限申请结果回调：无论授予与否都 resolve，由 JS 端根据 granted 分支处理 */
    @PermissionCallback
    fun mediaPermissionCallback(call: PluginCall) {
        val ret = JSObject()
        ret.put("granted", isMediaPermissionGranted())
        call.resolve(ret)
    }

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
