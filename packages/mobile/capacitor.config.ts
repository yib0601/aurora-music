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
      backgroundColor: '#0f0f1a',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0f0f1a',
    },
    // SQLite 数据库插件：Android 默认存于 /data/data/com.aurora.music/databases/
    // 无需显式设置 iosDatabaseLocation / electronXxxLocation，使用各平台默认位置
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/CapacitorDatabase',
    },
  },
}

export default config
