# 本地开发与构建

> README 的「快速开始」只列最短路径，这里补全测试、Android 构建、平台注意事项与打包发布。

## 测试

```bash
pnpm --filter @aurora/shared test   # 音源协议与洛雪宿主的纯逻辑（含进程 / 超时对抗验证）
pnpm --filter @aurora/app test      # 渲染层与移动端缓存落盘
```

`@aurora/shared` 有 4 条用例读第三方洛雪脚本素材（`pdone/lx-music-source`，脚本不入库）：
本地克隆优先，其次浅克隆到临时目录，出网受限则显式 skip；`LX_SCRIPT_DIR` 指定本地克隆，
`LX_SCRIPT_CACHE` 指定缓存位置。

## Android 构建

```bash
pnpm build:app
cd packages/mobile && npx cap sync android
cd android && ./gradlew assembleDebug   # 产物在 app/build/outputs/apk/
```

Web 层改动需先 `build:app` 再 `cap sync`，否则打包旧资源；原生代码改动只需重跑 gradlew。

## 平台注意事项

- **Linux** 走 X11 后端（Wayland 会话下由 Xwayland 承载）；无边框窗口的边缘缩放依赖客户端设置
  窗口位置，原生 Wayland 下会退化成「从底部 / 右侧缩放」，排障时可用 `--ozone-platform=wayland` 退回。
- **macOS** dmg 按芯片分 `-arm64` / `-x64`，ad-hoc 签名、未经公证；首启被 Gatekeeper 拦截时执行
  `xattr -cr /Applications/Aurora-Music.app`。
- **移动端 UI 预览**：`pnpm dev:app` 后开 `http://localhost:5173/?ui=mobile`（`?ui=desktop` 反向，
  只影响排版分支），`/mobile-lab.html?ui=mobile&scene=np` 是播放界面验收台（`scene` 可切 `np` /
  `np-paused` / `np-empty` / `bar` / `bar-empty`，另支持 `theme=light`、`t=<秒>`）。预览需**同时覆盖
  手机与大屏视口**：宽 ≥1024 或宽高都 ≥520 CSS 像素即车机 / 平板形态（常驻侧栏），只测手机宽度
  会漏掉车机场景。
- 切换 Node / Electron 版本后需重新 `pnpm rebuild`。

## 打包与发布

- **桌面**：`pnpm build:desktop`，产物在 `packages/desktop/release/`（Linux AppImage / deb、
  Windows NSIS）；RPM 用自带的 `./build-rpm.sh`（绕开 electron-builder 内置 fpm 在 Ubuntu 上的 rpmdb 问题）。
- **发布**：推送 `v*` tag 触发 GitHub Actions 自动构建全平台产物（Windows / Linux / macOS 双架构 /
  Android）并发布 Release，发布前自动校验 APK 签名、macOS 产物与 Linux glibc 基线。
- **签名密钥**：APK 统一由仓库内固定的 `packages/mobile/android/app/aurora-music.keystore` 签名
  （SHA-256 `eb4e48a95587ed954789b81b20fc23689cc702e602ebac08050d308eabdb435b`），CI 每次校验指纹。
  该文件绝不可更换，否则存量用户无法覆盖升级；v0.1.4 及更早版本使用随机调试签名，升级到新版
  需卸载重装一次。
