# 桌面端打包约定

> 记录 electron-builder 的硬约束，改动 `packages/desktop/package.json` 的 `build.*` 前先读这份。
> Windows 见 §1-4，macOS 见 §5。

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

## 5. macOS：ad-hoc 签名 + 双架构分 runner

### 5.1 `mac.identity` 必须写 `"-"`，留空或 `null` 都会出不能运行的包

无 Apple 开发者证书时，三种取值的行为完全不同（electron-builder 26 的
`MacTargetHelper.findSigningIdentity`）：

| `mac.identity` | 行为 | 后果 |
| --- | --- | --- |
| 不设置（默认） | 查 keychain，找不到证书就跳过签名 | arm64 产物被内核拒绝执行（表现为「双击无反应」） |
| `null` | 显式跳过签名 | 同上 |
| `"-"` | ad-hoc 签名（`codesign --sign -`） | bundle 签名有效、能启动；Gatekeeper 提示「无法验证开发者」 |

Apple Silicon 要求所有可执行代码带有效签名，ad-hoc 也算。而 electron-builder 打包会
重写 app bundle、破坏 Electron 官方二进制的原有签名，因此**未签名的 arm64 产物在
M 系列机器上根本起不来**。`scripts/verify-macos-dmg.sh` 里的 `Signature=adhoc` 断言
就是防止这一点被改回去。

配套必须 `hardenedRuntime: false`：hardened runtime 的 library validation 会拒绝
Team ID 不同的 Electron 预签名框架，ad-hoc 签名下直接导致启动失败
（electron-builder 26 会就此打警告）。

将来买了开发者证书：`identity` 换成证书名、`hardenedRuntime` 改回 `true` 并接上
notarize，用户侧就不会再有 Gatekeeper 提示。

### 5.2 双架构各跑原生 runner，不交叉编译

`better-sqlite3` 是原生模块，`npmRebuild` 必须按目标架构重建。在 arm64 runner 上出
x64 包需要 node-gyp 拉异构 headers 并让 clang 交叉链接，失败面大于收益，所以拆两个 job：

| job | runner | 产物 |
| --- | --- | --- |
| `build-macos-arm64` | `macos-15`（arm64） | `Aurora-Music-<version>-arm64.dmg` |
| `build-macos-x64` | `macos-15-intel`（x64） | `Aurora-Music-<version>-x64.dmg` |

`macos-13` 已退役；Intel 的标准 runner 标签是 `macos-15-intel`（带 `-large` 的是付费
larger runner，不要混用）。

`artifactName` 必须带 `${arch}`：两个架构同名时后者会覆盖前者，release 里只剩一份且
用户拿到的是错架构的包。渲染层的更新逻辑（`packages/app/src/services/update-asset.ts`）
也依赖 `-arm64` / `-x64` 后缀挑本机那份。

### 5.3 图标用单独的 `icon-mac.png`（1024x1024、8-bit）

`icon.png` 是 512x512 的 **16-bit** PNG，转 icns 会被 electron-builder 的 icon-tool
拒绝，因此 macOS 侧单出一份 `resources/icon-mac.png`（由 `scripts/generate-icons.sh`
生成，1024x1024 且显式 `-depth 8`）。

### 5.4 发布前校验（仅在 macOS 上可跑）

```bash
EXPECTED_ARCH=arm64 bash scripts/verify-macos-dmg.sh packages/desktop/release/*.dmg
```

脚本挂载 dmg 后断言四件事：主程序架构、`better-sqlite3` 原生模块架构、
`Signature=adhoc`、dmg 内 `Info.plist` 版本号与根 `package.json` 一致。
依赖 hdiutil / lipo / codesign / PlistBuddy，Windows、Linux 上无法执行。

