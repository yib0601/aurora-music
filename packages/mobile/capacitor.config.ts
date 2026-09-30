import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.aurora.music',
  appName: 'Aurora Music',
  webDir: '../app/dist',
  bundledWebRuntime: false,
  server: {
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      // 与 android/app/src/main/res/values/colors.xml 的 aurora_window_bg 同值：
      // 启动图 → 窗口背景 → 主界面若不同色，冷启动会看到三层色块跳变
      backgroundColor: '#0A0A0A',
      showSpinner: false,
    },
    StatusBar: {
      // Style 描述的是**图标颜色**，不是背景明暗：
      // LIGHT = 浅色图标（配深色背景）；DARK = 深色图标（配浅色背景）。
      // app 默认深色底，故取 LIGHT。主题切换后的动态同步见
      // packages/app/src/services/systemBars.ts
      style: 'LIGHT',
      backgroundColor: '#0A0A0A',
    },
    // SQLite 数据库插件：Android 默认存于 /data/data/com.aurora.music/databases/
    // 无需显式设置 iosDatabaseLocation / electronXxxLocation，使用各平台默认位置
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/CapacitorDatabase',
    },
  },
}

export default config
