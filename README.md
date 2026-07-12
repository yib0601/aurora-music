# Aurora Music ⛅

**Aurora Music** — 一款跨平台、优雅的本地音乐播放器，基于 Electron + React + Vite 构建。

> 🌟 极简美学·本地优先·全平台支持

---

## 截图

<!-- TODO: 添加截图 -->
<!-- ![Screenshot](./screenshots/player.png) -->

---

## 特性

- 🎵 **本地音乐播放** — 扫描本地文件夹，管理你的音乐收藏
- 🎨 **毛玻璃美学** — 沉浸式毛玻璃 UI，跟随系统深浅色模式
- 🪟 **无边框窗口** — 自定义标题栏与边缘缩放，原生级窗口体验
- 📜 **歌词滚动** — 同步显示歌词（LRC 格式支持）
- 📊 **音频可视化** — 内置频谱可视化器，动态主题色提取
- 🔀 **智能播放控制** — 顺序/随机/单曲循环，播放队列管理
- 🔍 **快速搜索** — 按标题、艺术家、专辑搜索
- ❤️ **收藏与最近播放** — 标记喜爱的歌曲，追踪播放历史
- 📦 **桌面应用** — 原生窗口体验（Electron 43）
- 📱 **移动端支持** — Capacitor 构建 Android/iOS（建设中）
- 🖥️ **跨平台** — Linux / Windows / macOS

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
│   │   │   │   └── ui/          # Radix UI 基础组件
│   │   │   ├── pages/        # 页面（Library, Playlist, Search...）
│   │   │   ├── stores/       # 状态管理（Zustand + useShallow）
│   │   │   ├── hooks/        # useAudioVisualizer / useThemeColor
│   │   │   ├── lib/          # colorExtractor / utils
│   │   │   └── services/     # audio.service / lyrics.service
│   │   └── dist/             # 构建输出
│   ├── desktop/          # Electron 桌面应用
│   │   ├── src/
│   │   │   ├── ipc/         # IPC 处理器（文件扫描、数据库、窗口控制）
│   │   │   ├── main.ts      # Electron 主进程（无边框窗口）
│   │   │   ├── preload.ts   # 上下文隔离 API 桥
│   │   │   └── types.ts
│   │   ├── resources/       # 图标 / .desktop 文件
│   │   └── dist-electron/   # 编译输出
│   └── mobile/           # Capacitor 移动端（WiP）
├── scripts/              # 打包辅助脚本（postinst / postremove / build）
├── build-rpm.sh          # RPM 打包脚本（基于 fpm）
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
| 音频引擎 | Howler.js |
| 桌面壳 | Electron 43（无边框 + 自定义缩放）|
| 本地数据库 | better-sqlite3 + music-metadata（`parseFile`）|
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

### 平台说明

- **Linux / Wayland**：Electron 43+ 默认启用 Wayland，已修复 frameless 窗口的渲染问题。如遇 AMD GPU 渲染异常，可通过 `--ozone-platform=x11` 回退到 X11 后端。
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

---

## 许可

[MIT](./LICENSE) © 2026 yib0601
