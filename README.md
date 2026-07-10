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
- 📜 **歌词滚动** — 同步显示歌词（LRC 格式支持）
- 📊 **音频可视化** — 内置频谱可视化器
- 🔀 **智能播放控制** — 顺序/随机/单曲循环，播放队列管理
- 🔍 **快速搜索** — 按标题、艺术家、专辑搜索
- ❤️ **收藏与最近播放** — 标记喜爱的歌曲，追踪播放历史
- 📦 **桌面应用** — 原生窗口体验（Electron）
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
│   │   │   ├── pages/        # 页面（Library, Playlist, Search...）
│   │   │   ├── stores/       # 状态管理（Zustand）
│   │   │   └── services/     # 音频服务（Howler.js）
│   │   └── dist/             # 构建输出
│   ├── desktop/          # Electron 桌面应用
│   │   ├── src/
│   │   │   ├── ipc/         # IPC 处理器（文件扫描、数据库）
│   │   │   └── main.ts      # Electron 主进程
│   │   └── dist-electron/   # 编译输出
│   └── mobile/           # Capacitor 移动端（WiP）
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
| 状态管理 | Zustand 5 |
| 音频引擎 | Howler.js |
| 桌面壳 | Electron 33 |
| 本地数据库 | better-sqlite3 + music-metadata |
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

---

## 构建分发

```bash
# 构建桌面安装包
pnpm build:desktop

# 产物位于 packages/desktop/release/
# 支持：AppImage / deb（Linux）、NSIS / portable（Windows）
```

---

## 许可

[MIT](./LICENSE) © 2026 yib0601
