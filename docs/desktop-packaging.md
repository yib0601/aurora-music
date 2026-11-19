# 桌面端打包约定

> 记录 electron-builder 的硬约束，改动 `packages/desktop/package.json` 的 `build.*` 前先读这份。
> Windows 见 §1-4，macOS 见 §5，多架构（arm64）见 §6。

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

### 5.2.1 必须排除 `cpu-features`（`ssh2` 的可选原生依赖）

`package.json` 的 `pnpm.ignoredOptionalDependencies` 里排除了 `cpu-features`。
这是**必需**配置，不是优化：

- 它是 `ssh2` 的 optional dependency，只为在 x86 上挑 AES 硬件加速路径。`ssh2`
  把 `require('cpu-features')` 包在 `try/catch` 里，装不上就回落到纯 JS/WASM
  实现（`bindingAvailable: false`），协议与算法集不受影响
- 但它给 `electron-builder` 的 `npmRebuild` 添了一个 node-gyp 目标：macOS runner 上
  报 `gyp: Call to 'node -e "require('nan')"' returned exit status 1`。pnpm 的符号
  链接布局下 gyp 从 `cpu-features/binding.gyp` 找不到 `nan`，于是**整个 macOS 打包
  失败，`create-release` 被 skip，整个 Release 不产出任何产物**

排除后必须同步 `pnpm-lock.yaml`：改这个字段会让 `--frozen-lockfile` 报
`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`，需用 `pnpm install --no-frozen-lockfile` 更新
一次（diff 只删掉 `cpu-features` 与它的 `buildcheck` 两条，依赖树其余部分不变）。

验证方式：`ssh2` 能 `new Client()` 并完成握手。实测连本机 sshd 会在
`client-authentication` 阶段失败（凭据是假的）——握手指的是协议协商与密钥交换
已经跑完，这正是本项要保证的。

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

macOS runner 用自带 bash 3.2（Linux 上是 bash 5），下面两个陷阱已真实踩过：

- **变量后紧跟中文标点必须写成 `${VAR}`**：bash 3.2 解析 `$VAR（` 时会把全角字符的字节
  并进变量名，报 `unbound variable` 并中止脚本；bash 5 不会。本地跑得好好的脚本到 mac
  runner 上会挂。
- **EXIT trap 必须显式 `exit "${code}"`**：bash 3.2 里 trap 内最后一条命令的退出码会覆盖
  脚本退出码（bash 4.4+ 才改成保留原码）。不显式 exit 时，校验失败会被 cleanup 的成功
  退出码洗成 0 —— 表现为「校验步骤全绿、包其实是坏的」。workflow 里断言输出含
  `✅ macOS 产物校验通过` 是第二道闸门。

## 6. 多架构：Linux / Windows 的 arm64 与 x64

macOS 从第一天就是双架构（§5.2），Linux 与 Windows 自 0.9.0 起也一样。三条硬约束都踩过坑：

### 6.1 配置里不要写 `target.arch` 数组，架构由 CI 命令行决定

`build.linux.target` / `build.win.target` 只写目标名（`"AppImage"`, `"deb"`, `"rpm"` / `"nsis"`），
**不要**写成 `{ "target": "deb", "arch": ["x64"] }`。

原因：`electron-builder --linux --arm64` 只是给 CLI 的 arch 留个位置，配置里带 `arch` 的 target
条目仍然按配置的架构生效。两者同时存在时的实测结果（`--linux --arm64` + 配置写死 x64）：

```
• building target=AppImage arch=x64 file=release/Aurora-Music-0.8.12-arm64.AppImage
```

也就是**文件名是 arm64、内容是 x86-64**，而且 arm64 那一轮因为 types 为空回落到默认
target 列表（含 snap），还会多打一个 `__snap-arm64` 并报 `snapcraft ENOENT`。
macOS 从来就是这么写的（`"mac": { "target": ["dmg"] }`），三条腿保持一致。

### 6.2 artifactName 必须用 `-c.artifactName` 从命令行覆盖成 `-x64` / `-arm64`

`${arch}` 宏在 electron-builder 里不是 electron 的架构名，而是各格式自己的架构名
（`builder-util/out/arch.js` 的 `getArtifactArchName`）：

| 目标 | x64 展开 | arm64 展开 |
| --- | --- | --- |
| AppImage | `x86_64` | `arm64` |
| deb | `amd64` | `arm64` |
| rpm | `x86_64` | `aarch64` |
| dmg | `x64` | `arm64` |

渲染层的更新逻辑（`packages/app/src/services/update-asset.ts`）按 `process.arch` 找
`-x64` / `-arm64` 后缀，所以 CI 里所有平台都传：

```bash
-c.artifactName='Aurora-Music-${version}-x64.${ext}'
-c.artifactName='Aurora-Music-${version}-arm64.${ext}'
```

（macOS 是唯一可以用配置文件里 `${arch}` 宏的地方，因为它展开就是 `x64`/`arm64`。）

改名会改变已发布资产的旧文件名，这一点是刻意的：x64 侧的新名字仍含 `-x64`，
所以**已经装在用户机器上的旧版本**（0.8.x 的 includes('-x64') 逻辑）照样能挑对包；
而如果给 x64 留无后缀名，旧客户端会 fallback 到「第一个匹配的 AppImage」，
可能下发 arm64 包。

### 6.3 Linux arm64 用原生 arm64 runner，Windows arm64 不进 `needs`

`better-sqlite3` 是原生模块（v12.11.1 没有 Electron 43 / ABI 148 的 prebuild），
必须在目标架构上编译，所以与 macOS 同一策略：每个架构跑自己的 runner。

| job | runner | 关键点 |
| --- | --- | --- |
| `build-linux-x64` | `ubuntu-latest` + `container: ubuntu:22.04` | 锁 glibc 2.35 基线（既有做法） |
| `build-linux-arm64` | `ubuntu-22.04-arm`（无 container） | runner 本身就是 Ubuntu 22.04 arm64，基线天然一致；job 级 container 在 arm64 上对 JS action 支持有限，不用 |
| `build-windows-x64` | `windows-latest` | 既有做法 |
| `build-windows-arm64` | `windows-11-arm` | `continue-on-error: true`，**不进** `create-release` 的 `needs` |

arm64 打包工具链逐项确认过（electron-builder 26.15.3，缺任何一项会在打包一开始就报
`AppImage tool ... not found` 之类）：

- `app-builder-bin` 自带 `linux/arm64/app-builder`
- `fpm` 有 `fpm-1.17.0-ruby-3.4.3-linux-arm64v8.7z`（`toolsets/linux.js` 按 `process.arch` 选）
- AppImage 走 legacy FUSE2 路径，`appimage-12.0.1.7z` 内含 `linux-arm64/mksquashfs`
  与 `runtime-arm64`（`7z l` 可验证）

标准 arm64 runner 的磁盘比 x64 小，job 第一步先清 `/usr/share/dotnet` 等目录再装依赖。

Windows arm64 单独说明：GitHub 的 arm64 Windows 标准 runner 镜像是否带 MSVC 的
ARM64 构建工具链不由本项目控制，失败时是「原生模块编不出来」而不是配置错。
所以它 `continue-on-error` 且不 gate 发布 —— 一个腿失败不该让整次 Release 没有产物
（同 §5.2.1 的教训）；产物存在就并入 Release。若该腿长期红，先查 runner 镜像的
VS 组件，再考虑改为在 x64 上交叉编译。

两个已知差异，改动时别当 bug：

- **arm64 AppImage 不内嵌 `lib/` 运行时库**：electron-builder 的 legacy FUSE2 路径只在
  `arch === x64 || ia32` 时把 `lib/x64` 打进包（`targets/appimage/appImageUtil.js`），
  arm64 目标是空的。也就是说 arm64 AppImage 依赖系统自带的 libXtst / libnss / libnotify，
  而 x64 那份自带。桌面发行版基本都有，服务器/极简系统上优先用 deb/rpm（依赖声明齐全）。
- **`ubuntu-22.04-arm` 是基线选择，不是随便挑的**：换到 `ubuntu-24.04-arm`（glibc 2.39）
  会立刻顶穿基线闸门。真要换只能上 container `ubuntu:22.04`（arm64 变体）——
  但 job 级 container 在 arm64 上对 JS action 支持有限，届时改法是把构建放进
  `docker run` 而不是 job-level `container:`。

### 6.4 校验：基线 + 架构一起卡

`scripts/check-linux-baseline.sh` 的 `EXPECTED_ARCH=x64|arm64` 会额外断言包内
`Aurora-Music` 与 `better_sqlite3.node` 的 ELF `e_machine`：

```bash
EXPECTED_ARCH=arm64 bash scripts/check-linux-baseline.sh packages/desktop/release/*-arm64.*
```

这是防「名字对、内容错」的最后一道闸门（§6.1 的情形如果不小心复发，这一步会红）。
注意 AppImage 的解包靠它自带的 runtime 执行 `--appimage-extract`，**跨架构解不了**
（x64 上检查 arm64 AppImage 会直接报「无法解包」），所以这一项必须在对应架构的 job 上跑。

Windows 侧同理，用 `scripts/verify-win-arch.cjs` 读 PE 头的 `Machine` 字段
（`0x8664` = x64、`0xAA64` = arm64），只读文件、不需要 wine：

```bash
node scripts/verify-win-arch.cjs packages/desktop/release/win-arm64-unpacked/Aurora-Music.exe arm64
```

两个 job 都跑它：文件名里的架构来自 `-c.artifactName`，而真实架构来自 Electron 包与
`better-sqlite3` 的 rebuild 目标，二者本就可以独立漂移。

### 6.5 本地重打 deb / rpm

`build-deb.sh` / `build-rpm.sh` 用 `ARCH` 选解包目录与包内架构字段：

```bash
ARCH=x64   bash build-deb.sh   # release/linux-unpacked        → aurora-music_<v>_amd64.deb
ARCH=arm64 bash build-deb.sh   # release/linux-arm64-unpacked  → aurora-music_<v>_arm64.deb
ARCH=arm64 bash build-rpm.sh   # → Aurora-Music-<v>-1.aarch64.rpm
```

`ARCH` 一个变量同时决定三件事（解包目录、fpm `--architecture`、输出文件名），
不要在命令行里只改其中一处 —— 三者错位就是「包名写 arm64、内容是 x64」的另一条路。

注意本地直接 `pnpm build:desktop` / `build:dir` 产出的文件名**不带** `-x64`
（全局 `artifactName` 仍是 `Aurora-Music-${version}.${ext}`），架构后缀只在 CI 里通过
`-c.artifactName` 加。本地包是自用产物，不必和 Release 命名对齐；要对齐就把 CI 那条
命令行原样贴进终端。
