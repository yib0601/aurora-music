# Aurora Music ⛅

**Aurora Music** — 一款跨平台的音乐播放器，基于 Electron + React + Vite 构建，移动端通过 Capacitor 打包为 Android 应用。

---

## 截图

<!-- TODO: 添加截图 -->
<!-- ![Screenshot](./screenshots/player.png) -->

---

## 特性

### 播放与音乐库

- 🎵 **本地音乐播放** — 扫描本地文件夹，渐进式入库（边扫描边显示，无需等待全部解析完成）
- 🔀 **智能播放控制** — 顺序/随机/单曲循环，播放队列管理
- 📜 **歌词滚动** — 同步显示歌词（LRC 格式支持），支持配置多个在线歌词源自动匹配
- 📊 **音频可视化** — 内置频谱可视化器，动态主题色提取
- 🔍 **快速搜索** — 按标题、艺术家、专辑搜索，附带历史搜索记录
- ❤️ **收藏与最近播放** — 标记喜爱的歌曲，追踪播放历史与播放次数
- 🌐 **在线搜索与下载** — 按歌源协议配置音源后，可在线搜索、试听并下载歌曲到本地音乐库

### 外观

- 🎨 **毛玻璃美学** — 沉浸式 Liquid Glass UI，动态封面柔光背景
- 🌗 **主题系统** — 深色 / 浅色 / 跟随系统三档切换，状态栏颜色自动同步

### 桌面端

- 🪟 **无边框窗口** — 自定义标题栏与边缘缩放，原生级窗口体验
- 📍 **系统托盘** — 关闭窗口最小化到托盘继续播放
- 🖥️ **跨平台** — Linux / Windows / macOS

### 移动端（Android）

- 📱 **原生播放引擎** — MediaSession 前台服务，锁屏/后台稳定播放不中断
- 🔒 **锁屏控件** — 系统锁屏界面与通知栏媒体控制，深度灭屏后自动恢复播放进度
- 📂 **文件夹导入** — 系统文件夹选择器导入音乐，未授权存储权限时自动引导
- 🎛️ **移动端适配 UI** — 汉堡导航、全屏 Now Playing 页面

### 其他

- ⬆️ **应用内更新提示** — 启动时检查新版本并展示更新横幅

---

## 快速开始

```bash
# 克隆
git clone https://github.com/yib0601/aurora-music.git
cd aurora-music

# 安装依赖（推荐 pnpm）
pnpm install

# 重建原生模块（better-sqlite3）
pnpm rebuild

# 运行桌面应用（开发模式）
pnpm dev

# 或仅运行 Web UI
pnpm dev:app
```

### 环境要求

- **Node.js** >= 20.0.0
- **pnpm** >= 9.15.0（npm 可用但不推荐）
- Android 构建额外需要：JDK 17+、Android SDK（AGP 9.x）

---

## 项目结构

```
aurora-music/
├── packages/
│   ├── app/              # React Web UI（Vite + TailwindCSS + Zustand）
│   │   ├── src/
│   │   │   ├── components/   # UI 组件
│   │   │   │   ├── layout/      # Sidebar / TitleBar / ResizeHandle
│   │   │   │   ├── player/      # PlayerBar / QueueView
│   │   │   │   ├── lyrics/      # 歌词滚动
│   │   │   │   ├── visualizer/  # 音频可视化
│   │   │   │   ├── mobile/      # 移动端组件（MobileFolderPicker 等）
│   │   │   │   └── ui/          # Radix UI 基础组件
│   │   │   ├── pages/        # 页面（Library, Search, Settings...）
│   │   │   ├── stores/       # 状态管理（Zustand + useShallow）
│   │   │   ├── hooks/        # useAudioVisualizer / useThemeColor
│   │   │   ├── lib/          # colorExtractor / utils
│   │   │   └── services/     # audio / lyrics / platform / update
│   │   └── dist/             # 构建输出
│   ├── desktop/          # Electron 桌面应用
│   │   ├── src/
│   │   │   ├── ipc/         # IPC 处理器（扫描、数据库、在线搜索、窗口控制）
│   │   │   ├── main.ts      # Electron 主进程（无边框窗口 + 托盘）
│   │   │   ├── preload.ts   # 上下文隔离 API 桥
│   │   │   └── types.ts
│   │   ├── resources/       # 图标 / .desktop 文件
│   │   └── dist-electron/   # 编译输出
│   ├── mobile/           # Capacitor 移动端（Android）
│   │   ├── android/         # Android 原生工程
│   │   │   └── app/src/main/java/com/aurora/music/
│   │   │       ├── MainActivity.java
│   │   │       ├── MediaPlaybackService.kt   # 前台服务 + 原生 MediaSession
│   │   │       ├── MediaSessionPlugin.kt     # WebView ↔ 原生播放桥
│   │   │       └── PermissionPlugin.kt       # 存储权限桥
│   │   └── capacitor.config.ts
│   └── shared/           # @aurora/shared：歌源协议规范与执行器（音源/歌词源）
├── scripts/              # 打包辅助脚本（postinst / postremove / build）
├── build-rpm.sh          # RPM 打包脚本（基于 fpm）
├── .github/workflows/    # CI：tag 触发 Release（Windows/Linux/Android）
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json
```

---

## 技术栈

| 层 | 技术 |
|------|--------|
| 前端框架 | React 18 + TypeScript |
| 构建工具 | Vite 5 |
| 样式 | TailwindCSS 3 + 毛玻璃效果 |
| 状态管理 | Zustand 5（`useShallow` 订阅优化）|
| 路由 | React Router 6（HashRouter 适配桌面端）|
| UI 基础组件 | Radix UI + CVA + tailwindcss-animate |
| 动画 | Framer Motion |
| 音频引擎 | Howler.js + Web Audio API |
| 桌面壳 | Electron 43（无边框 + 自定义缩放 + 托盘）|
| 移动端 | Capacitor 6（Android 原生播放引擎 + MediaSession）|
| 本地数据库 | better-sqlite3 / @capacitor-community/sqlite + music-metadata |
| 歌源协议 | @aurora/shared（音源/歌词源协议规范与执行器）|
| 包管理 | pnpm workspace monorepo |

---

## 开发

```bash
# Web UI 单独开发（浏览器）
pnpm dev:app

# Electron 桌面开发（热重载）
pnpm dev:desktop

# 构建
pnpm build

# 类型检查
pnpm --filter @aurora/desktop typecheck
```

### Android 开发

```bash
# 1. 构建 Web 资源
pnpm build:app

# 2. 同步到 Android 工程（在 packages/mobile 目录执行）
cd packages/mobile && npx cap sync android

# 3. 编译 APK（debug）
cd android && ./gradlew assembleDebug

# 产物位于 packages/mobile/android/app/build/outputs/apk/debug/
```

> 原生代码改动（MediaPlaybackService 等）只需重新执行 gradlew；Web 层改动需先 `build:app` 再 `cap sync`，否则会打包旧资源。

### 平台说明

- **Linux / Wayland**：仅支持 Wayland，请勿添加 `--ozone-platform=x11`（会导致崩溃）。AMD GPU 如遇渲染黑屏，应用已内置 `--disable-gpu` 启动参数解决。
- 原生模块（better-sqlite3）切换 Node/Electron 版本后需运行 `pnpm rebuild`。

---

## 构建分发

### Linux（RPM）

项目自带 `build-rpm.sh` 打包脚本（基于 [fpm](https://github.com/jordansissel/fpm)），绕开 electron-builder 内置 fpm 在 Ubuntu 上的 rpmdb 写入问题。

```bash
# 1. 构建桌面应用（解包目录）
pnpm --filter @aurora/desktop run build:dir

# 2. 打包 RPM
./build-rpm.sh

# 3. 安装
sudo rpm -Uvh --nodeps packages/desktop/release/Aurora-Music-<version>-1.x86_64.rpm

# 启动
Aurora-Music      # 终端
# 或在应用菜单中查找 "Aurora Music"
```

安装后入口：`/opt/Aurora-Music/`，桌面项：`/usr/share/applications/Aurora-Music.desktop`。

### Linux（其他格式）/ Windows

```bash
# electron-builder 默认产物
pnpm build:desktop

# 产物位于 packages/desktop/release/
# - Linux: AppImage / deb（electron-builder）
# - Windows: NSIS / portable
```

> ⚠️ Ubuntu 上 electron-builder 内置的 RPM 打包可能因 rpmdb.sqlite 写权限失败，建议使用上述 `build-rpm.sh` 脚本。

### Android（APK）

```bash
# 完整流程（也可参考上节「Android 开发」）
pnpm build:app
cd packages/mobile && npx cap sync android
cd android && ./gradlew assembleRelease   # 或 assembleDebug
```

> 推送 `v*` tag 会触发 GitHub Actions 自动构建全平台产物并发布 Release。

---

## 许可

[MIT](./LICENSE) © 2026 yib0601
