# 桌面端打包约定（Windows）

> 记录 electron-builder 的两个硬约束，改动 `packages/desktop/package.json` 的 `build.win` / `build.nsis` 前先读这份。

## 1. exe 必须嵌入图标与版本信息 —— 用 `signExecutable: false`，不要用 `signAndEditExecutable: false`

`build.win.signAndEditExecutable: false` 会**整体跳过 exe 的资源编辑**（图标 + 版本信息）与签名，
打包日志会打印：

```
executable resource editing and code signing skipped — signAndEditExecutable is false.
To skip only code signing while keeping icon and metadata applied, use signExecutable: false instead.
```

后果：`Aurora-Music.exe` 保留 Electron 原始资源，桌面/开始菜单快捷方式
（NSIS 用 `CreateShortCut "$newDesktopLink" "$appExe" ... 0`，取 exe 第 0 号图标）会显示
**Electron 默认图标**，exe 属性里的产品名也是 `Electron`，与软件实际图标不一致。

正确写法：`build.win.signExecutable: false` —— 仍然执行资源编辑（resedit 纯 JS 写入，
不依赖 wine / winCodeSign），只跳过代码签名（本项目无证书）。

验证方式（可在 Linux 上直接跑，无需 wine）：

```bash
cd packages/desktop
pnpm --filter @aurora/shared build && pnpm --filter @aurora/app build
rm -rf app-dist && cp -r ../app/dist app-dist
pnpm exec tsc -p tsconfig.electron.json
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_CUSTOM_DIR="{{ version }}" \
  pnpm exec electron-builder --win --x64 --dir -c.npmRebuild=false -c.directories.output=/tmp/win-check
```

然后用 `scripts/verify-win-icon.cjs` 读回 `win-unpacked/Aurora-Music.exe`：

```bash
node scripts/verify-win-icon.cjs \
  /tmp/win-check/win-unpacked/Aurora-Music.exe \
  packages/desktop/resources/icon.ico
```

- 通过：图标组 7 个尺寸 `16/24/32/48/64/128/256`（与 `resources/icon.ico` 逐帧一致），
  版本信息 `ProductName: Aurora-Music`、`CompanyName: Aurora Music`；
- 失败：图标组只有 4 个尺寸（`16/32/48/256`）且 `ProductName: Electron` —— 配置被改坏了。

## 2. 不要设置 `allowToChangeInstallationDirectory` —— 它会让升级重建桌面快捷方式

electron-builder 的 `installUtil.nsh` 中 `setIsTryToKeepShortcuts` 宏带条件编译：

```nsis
StrCpy $isTryToKeepShortcuts "true"
!ifdef allowToChangeInstallationDirectory
  ${ifNot} ${isUpdated}      # 手动双击安装包升级时
    StrCpy $isTryToKeepShortcuts "false"
  ${endIf}
!endif
```

`$isTryToKeepShortcuts` 为 false 时，安装器**不向旧卸载器传 `--keep-shortcuts`**，
旧卸载器遂执行 `Delete "$oldDesktopLink"`，新安装器再 `CreateShortCut` 重建。

结果：每次升级桌面快捷方式都被删除重建，Windows 记录的桌面图标位置失效，
用户看到「更新后图标位置变了」。同时 `createDesktopShortcut: true`（映射为
`FRESH_INSTALL`）本身不重建快捷方式，问题只出在卸载侧。

保留机制生效的前提是旧版本安装时已在注册表写入 `KeepShortcuts=true`
（electron-builder 25 / 26 的 `registryAddInstallInfo` 都会写）。
本项目 Windows 安装包一直由 CI 用 electron-builder 25/26 构建，该值已存在，
因此去掉此选项后**下一次升级即保留快捷方式**；仅当从更早（electron-builder < 25）
的安装包升级时才可能再重建一次。

代价：安装向导不再提供自定义安装目录（已装用户仍在原注册的目录内升级，不受影响）。
这是保住桌面图标位置的必要代价 —— 两者在 electron-builder 中不可兼得。

## 3. 自定义 NSIS 脚本必须显式 include

`build.nsis.include: "installer.nsh"`（相对 `buildResources`，即 `packages/desktop/resources/`）。
漏掉这一行时 `resources/installer.nsh` 是死文件，其中的 `customCheckAppRunning`
不会被编译进安装器，升级时仍会弹出「应用正在运行，请先关闭」的确认框。

## 4. 升级后仍显示旧图标 → 清 Windows 图标缓存

exe 路径不变而图标资源变了时，资源管理器可能继续显示缓存图标：

```bat
ie4uinit.exe -show
```

仍不刷新则重建缓存（会短暂重启桌面）：

```bat
taskkill /f /im explorer.exe
del /a /q "%localappdata%\IconCache.db"
del /a /q "%localappdata%\Microsoft\Windows\Explorer\iconcache*"
start explorer.exe
```

