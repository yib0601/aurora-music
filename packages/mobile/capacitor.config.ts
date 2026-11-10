import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.aurora.music',
  appName: 'Aurora Music',
  webDir: '../app/dist',
  bundledWebRuntime: false,
  server: {
    androidScheme: 'https',
  },
  // WebView 画布底色（Capacitor 的 Bridge 会把它设成 webView.setBackgroundColor）。
  // 开屏现在只停「首帧」那么一下，撤场之后、React 首屏画出来之前会露出 WebView 的
  // 空白画布——不设就是系统默认的白色，冷启动会闪一帧白（实测 API 34 模拟器上约
  // 1 帧～1s，取决于设备速度）。与 <meta name="theme-color">、index.html 的静态
  // class="dark"、开屏底色同为 #0A0A0A，这一帧就看不出来。
  backgroundColor: '#0A0A0A',
  android: {
    // 歌源返回的封面/音频直链存在明文 http（实测 qpic.y.qq.com、aqqmusic.tc.qq.com），
    // 而 WebView 源是 https://localhost：默认混合内容策略下 <img>/<audio> 的 http
    // 资源全被拦掉，表现为推荐歌单封面整页空白。OS 层明文放行见
    // android/app/src/main/res/xml/network_security_config.xml 的域名白名单
    allowMixedContent: true,
  },
  plugins: {
    SplashScreen: {
      // 开屏只留「系统启动窗口」本身的时间，不额外占用：1ms 是让插件走 Android 12
      // 兼容路径的最小非零值（撑住启动窗口、并在首帧后立刻撤）。
      //   · 不能设 0：插件 showOnLaunch() 里 `if (getLaunchShowDuration() == 0) return;`，
      //     直接不装 androidx.core.splashscreen —— 于是 postSplashScreenTheme 没人应用，
      //     Activity 会一直停在启动主题上（主题错乱），不是「没开屏」而是「坏了」。
      //   · launchFadeOutDuration 设 0 关掉撤场动画：默认 200ms 的淡出期间插件还用
      //     isHiding 钉着启动窗口，等于白白多 200ms（底色和内容底色同为深色，淡出本来
      //     也看不见）。
      // 两者相加就是开屏的全部停留时间：大约「首帧 + 1 帧」。想再短只能不用这个插件，
      // 代价是启动主题要改成不依赖 installSplashScreen 的写法（见 values/styles.xml）。
      launchShowDuration: 1,
      launchFadeOutDuration: 0,
      // 与 android/app/src/main/res/values/colors.xml 的 aurora_window_bg 同值：
      // 启动图 → 窗口背景 → 主界面若不同色，冷启动会看到三层色块跳变
      backgroundColor: '#0A0A0A',
      showSpinner: false,
      // 启动画面是 res/drawable/splash.xml，插件按名字 splash（本项默认值）找它。
      // 那张资源**只有纯色底、没有图形**：开屏不画品牌图形是刻意的（Android 12+ 的
      // 系统启动画面会把图标按「画布 × 1.5」放大再套设备图标形状遮罩，尺寸形状都不由
      // 我们定；要在系统路径里放图形，就得长期维护一套 288dp 画布的派生资源）。
      // 详见该文件的注释。两点别动：
      //   · androidScaleType 保持默认 FIT_XY —— layer-list 需要铺满窗口，换成
      //     CENTER_INSIDE 之类会让纯色底一起缩掉，反而露出系统窗口底色；
      //   · 别把 splash 换回整屏位图 —— 位图宽高比固定、屏幕宽高比不固定，会被拉伸
      //     （车机竖屏上就是这么被拉宽 ~1.3 倍的）。
      // 「纯黑过渡」已经压到最短（见上面 launchShowDuration）；别把 0 当成更短，
      // 0 是「插件不接手」，不是「没有开屏」。
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
