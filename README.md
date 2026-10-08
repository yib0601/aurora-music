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
- **更新多源兜底** — 检查更新与安装包下载按「GitHub 官方 → 公共加速前缀」降级：检查更新并发竞速，下载跟随系统代理并在源明显过慢时自动换源

---

## 歌源协议

应用不内置任何音源：在线搜索、歌词匹配与歌单解析都依赖你自行配置的 HTTP 接口，或按洛雪格式自备的音源脚本（设置 → 在线源）。**一条音源同时提供这三种能力**。

### aurora 音源服务

填一条服务地址即可，端点优先读服务端的自描述（`GET {服务地址}/` 响应里的 `endpoints`），读不到按默认路径组装；密钥可直接写在链接里（`https://host?key=xxx`），「测试连接」会校验连通性与密钥。

| 能力 | 默认端点 |
|---|---|
| 搜索 | `/aurora?query={query}&quality={quality}&key=` |
| 歌词 | `/aurora/lyric?track={track}&artist={artist}&duration={duration}&key=` |
| 歌单解析 | `/aurora/playlist?url={url}&key=` |
| 推荐 / 榜单 | `/aurora/recommend`、`/aurora/toplists`、`/aurora/toplist` |

响应为 JSON 数组，或 `{results:[]}` / `{data:[]}` / `{songs:[]}` / `{list:[]}` 包裹。搜索每项 `audioUrl` 必填，另有 `title` / `artist` / `album` / `duration` / `coverUrl`，多音质用 `qualityUrls` 或 `url_128` / `url_320` / `url_flac`；歌词兼容 `syncedLyrics` / `lrc` / `lyric` / `plainLyrics`，全部音源未命中时回落内置 LRCLIB。链接含 `{query}` 时按「接口模板」原样使用（该形态没有歌词能力）。

### 洛雪音源脚本

可直接使用[洛雪音乐](https://github.com/lyswhut/lx-music-desktop)（桌面版 / 手机版）的用户自定义音源脚本：添加脚本链接（GitHub Raw、jsDelivr 或自建托管均可），源码不落库。脚本在客户端沙箱内执行：`document` / `navigator` / `location` / `localStorage` 与 Node 标识一律置为 `undefined`，网络请求只能经宿主的 `lx.request` 转发，拿不到宿主配置、数据库与文件系统接口。

绝大多数脚本只实现 `musicUrl`、没有公共搜索接口，因此搜索走你自己的搜索音源，取址再把曲目的平台标识交给脚本（酷我 `kw` / 酷狗 `kg` 用 `hash` | `songmid`；QQ `tx` / 网易 `wy` 用 `songmid`，网易另认 `id`；咪咕 `mg` 用歌名 + 歌手）。取址**按需**触发：搜到的条目只有元信息，播放或下载时才取直链回填队列，不写库也不落盘；脚本源没有歌词能力。

### WebDAV 媒体库（桌面端）

与在线音源不同，这是入库的持久曲库来源：配置服务器地址、账号与口令，测试连接后扫描入库。口令仅存本机；移除来源会连同其曲目一起从曲库删除（远端文件不受影响）。

> 应用不内置、也不推荐任何源站。

---

## 快速开始

```bash
git clone https://github.com/yib0601/aurora-music.git && cd aurora-music
pnpm install
pnpm rebuild          # 重建 better-sqlite3 原生模块（切换 Node / Electron 版本后需重跑）
pnpm dev              # 桌面端（Electron + Vite 热重载）
pnpm dev:app          # 仅 Web UI
```

pnpm monorepo：`packages/{app, desktop, mobile, shared}`；需 Node.js ≥ 20、pnpm ≥ 9.15，Android 构建另需 JDK 17+ 与 Android SDK。

测试：`pnpm --filter @aurora/shared test`（歌源协议与洛雪宿主的纯逻辑）、`pnpm --filter @aurora/app test`（渲染层与移动端缓存落盘）。前者有 4 条用例读第三方洛雪脚本素材（`pdone/lx-music-source`，不入库）：本地克隆优先，其次浅克隆，出网受限则显式 skip（`LX_SCRIPT_DIR` / `LX_SCRIPT_CACHE` 可指定位置）。

Android 构建（Web 层改动需先 `build:app` 再 `cap sync`，否则打包旧资源；原生代码改动只需重跑 gradlew）：

```bash
pnpm build:app
cd packages/mobile && npx cap sync android
cd android && ./gradlew assembleDebug   # 产物在 app/build/outputs/apk/
```

平台说明：

- **Linux** 走 X11 后端（Wayland 会话下由 Xwayland 承载）；无边框窗口的边缘缩放依赖客户端设置窗口位置，原生 Wayland 下会退化成「从底部 / 右侧缩放」，排障时可用 `--ozone-platform=wayland` 退回。
- **macOS** dmg 按芯片分 `-arm64` / `-x64`，ad-hoc 签名、未经公证；首启被 Gatekeeper 拦截时执行 `xattr -cr /Applications/Aurora-Music.app`。
- **移动端 UI 预览**：`pnpm dev:app` 后开 `http://localhost:5173/?ui=mobile`（`?ui=desktop` 反向，只影响排版分支），`/mobile-lab.html?ui=mobile&scene=np` 是播放界面验收台。预览需**同时覆盖手机与大屏视口**：宽 ≥1024 或宽高都 ≥520 CSS 像素即车机 / 平板形态（常驻侧栏），只测手机宽度会漏掉车机场景。

---

## 构建分发

- **桌面**：`pnpm build:desktop`，产物在 `packages/desktop/release/`（Linux AppImage / deb、Windows NSIS）；RPM 用自带的 `./build-rpm.sh`（绕开 electron-builder 内置 fpm 在 Ubuntu 上的 rpmdb 问题）。
- **发布**：推送 `v*` tag 触发 GitHub Actions 自动构建全平台产物（Windows / Linux / macOS 双架构 / Android）并发布 Release，发布前自动校验 APK 签名、macOS 产物与 Linux glibc 基线。
- **签名密钥**：APK 统一由仓库内固定的 `packages/mobile/android/app/aurora-music.keystore` 签名（SHA-256 `eb4e48a95587ed954789b81b20fc23689cc702e602ebac08050d308eabdb435b`），CI 每次校验指纹。该文件绝不可更换，否则存量用户无法覆盖升级；v0.1.4 及更早版本使用随机调试签名，升级到新版需卸载重装一次。

---

## 许可

[PolyForm Noncommercial License 1.0.0](./LICENSE)：禁止商业用途。个人使用、学习、二次修改与非商业分发不受限制，商业目的的使用需联系作者授权。v0.4.2 及更早的已发布版本仍按 MIT 授权。
