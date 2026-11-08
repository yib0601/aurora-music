import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.aurora.music',
  appName: 'Aurora Music',
  webDir: '../app/dist',
  bundledWebRuntime: false,
  server: {
    androidScheme: 'https',
  },
  android: {
    // 歌源返回的封面/音频直链存在明文 http（实测 qpic.y.qq.com、aqqmusic.tc.qq.com），
    // 而 WebView 源是 https://localhost：默认混合内容策略下 <img>/<audio> 的 http
    // 资源全被拦掉，表现为推荐歌单封面整页空白。OS 层明文放行见
    // android/app/src/main/res/xml/network_security_config.xml 的域名白名单
    allowMixedContent: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      // 与 android/app/src/main/res/values/colors.xml 的 aurora_window_bg 同值：
      // 启动图 → 窗口背景 → 主界面若不同色，冷启动会看到三层色块跳变
      backgroundColor: '#0A0A0A',
      showSpinner: false,
      // 启动画面本身是 res/drawable/splash.xml（layer-list：纯色底 + 居中正方形
      // 图形），插件按名字 splash（本项默认值）找它。两件事别动：
      //   · androidScaleType 保持默认 FIT_XY —— layer-list 需要铺满窗口，换成
      //     CENTER_INSIDE 之类会让纯色底一起缩掉，反而露出系统窗口底色；
      //   · 别把 splash 换回整屏位图 —— 位图宽高比固定、屏幕宽高比不固定，
      //     图里的牌子会被拉伸（车机竖屏上就是这么被拉宽 ~1.3 倍的）。
      androidSplashResourceName: 'splash',
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
