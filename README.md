# Aurora Music

<p align="center"><img src="./packages/desktop/resources/icon.svg" alt="Aurora Music 图标" width="128"></p>

<p align="center">
  <strong>Aurora Music</strong> — 跨平台音乐播放器，覆盖 <strong>桌面（Linux / Windows / macOS）与 Android</strong>。<br/>
  桌面端 Electron + React + Vite；移动端由 Capacitor 打包、原生播放引擎接管播放，一套 UI 多端一致。<br/>
  <img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue" alt="PolyForm Noncommercial License 1.0.0">
  &nbsp;·&nbsp; <a href="./README.en.md">English</a>
</p>

---

## 截图

**桌面端** — 音乐库 / 播放详情 / 设置（在线音源）

<p align="center"><img src="./screenshots/hall.jpg" width="760" alt="音乐库"></p>

<table align="center"><tr>
  <td><img src="./screenshots/detail.jpg" width="520" alt="播放详情"></td>
  <td><img src="./screenshots/settings.jpg" width="520" alt="设置"></td>
</tr></table>

**Android** — 原生播放引擎，锁屏与通知栏媒体控制

<p align="center"><img src="./screenshots/android-playing.jpg" width="280" alt="Android 播放界面"></p>

---

## 特性

| 能力 | 桌面（Linux / Windows / macOS） | Android |
|---|---|---|
| 本地播放 | 扫描文件夹、渐进式入库，支持 WebDAV 远端媒体库 | 系统文件夹导入、存储权限引导 |
| 后台播放 | 关闭窗口最小化到托盘继续播放 | MediaSession 前台服务，锁屏与深度灭屏下稳定续播 |
| 在线搜索 | 搜索 / 试听 / 下载 / 缓存（容量可调、一键清空） | 与桌面端同一份配额口径；下载目录可配置，原生后台线程下载 |
| 应用内更新 | 按平台推荐安装包（EXE / RPM / DEB / AppImage / DMG），一键安装 | 调起系统安装器 |

首屏**音乐库**的推荐歌单与排行榜由你配置的音源服务实时提供，点开即试听、不入库；**我的音乐**是你自己扫描入库的本地 / WebDAV 资产，长期有效、离线可播。未配音源时音乐库展示引导空态，本地曲库不受影响。

- **歌词** — LRC 同步歌词（含逐字时间戳），能力跟着音源走，无需另配歌词源
- **歌单导入** — 分享链接（经音源解析）或纯文本（本地处理、零网络请求），自动匹配本地曲库
- **外观** — Liquid Glass 毛玻璃美学、动态封面柔光背景、深色 / 浅色 / 跟随系统主题
- **多语言** — 简体中文 / English，默认跟随系统、可在设置中固定；界面、Android 通知与锁屏控件、桌面 .desktop 与 deb 元数据一并本地化
- **更新多源兜底** — 检查更新与安装包下载按「GitHub 官方 → 公共加速前缀」降级：检查更新并发竞速，下载跟随系统代理并在源明显过慢时自动换源

---

## 音源

应用不内置任何音源：在线搜索、歌词匹配与歌单解析都依赖你自行配置的 HTTP 接口，或按洛雪格式自备的音源脚本（设置 → 在线源）。**一条音源同时提供这三种能力**。

端点与响应字段、洛雪脚本的平台定位字段、WebDAV 媒体库用法见 [docs/music-sources.md](./docs/music-sources.md)。

---

## 快速开始

```bash
git clone https://github.com/yib0601/aurora-music.git && cd aurora-music
pnpm install
pnpm rebuild          # 重建 better-sqlite3 原生模块
pnpm dev              # 桌面端（Electron + Vite 热重载）
pnpm dev:app          # 仅 Web UI
```

pnpm monorepo：`packages/{app, desktop, mobile, shared}`；需 Node.js ≥ 20、pnpm ≥ 9.15，Android 构建另需 JDK 17+ 与 Android SDK。

测试、Android 构建、平台注意事项与打包发布见 [docs/development.md](./docs/development.md)。

---

## 许可

[PolyForm Noncommercial License 1.0.0](./LICENSE)：禁止商业用途。个人使用、学习、二次修改与非商业分发不受限制，商业目的的使用需联系作者授权。v0.4.2 及更早的已发布版本仍按 MIT 授权。
