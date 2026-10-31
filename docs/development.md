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

## 测试与 fixture 的隐私约束

本仓库**公开**。冒烟脚本 `packages/desktop/scripts/smoke-*.js` 不入库（`.gitignore` 已排除）——
它们天然要读本机曲库、本机音源服务与真实 Electron 运行时，对别人没有意义，留在本地工作区即可。

入库的 `__tests__/` 参与 CI，但同样不许写死机器私有信息：

- 真实凭据（API_KEY / Cookie / token / 口令）一律不入库；需要时从环境变量读，默认值只能是
  明显的假值或本地开发值
- 不写死绝对路径（`/home/<user>/...` 用 `os.homedir()` / `process.env` 推导）
- 不写死本机端口与私有服务地址（如 `127.0.0.1:<port>`）——那不是项目契约，走可覆盖的环境变量
- 不原地读改真实用户数据：确需真实库/缓存时，先复制到临时沙箱再操作

测试 fixture 里的 URL、密钥、路径只用于**字符串比对与解析断言**，用真值不会让断言更严格，只会
把生产信息写进公开仓库。统一用 `00000000-0000-0000-0000-000000000000` 这类一眼可辨的假值，或
`local-dev-key` 这类明显非生产的本地值。判断标准只有一句：**这条信息在别人的机器上成立吗？**

### 提交前自检

```bash
# 扫描入库内容里的硬编码（凭据 / 绝对路径 / 本机端口）
git grep -nE "(/home/[a-z]+|127\.0\.0\.1:[0-9]{4}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})" \
  -- 'packages/*/src/**/__tests__/*'
```

`packages/desktop/scripts/` 已整体忽略，不在扫描范围。命中不等于一定有问题（假值、`os.homedir()`
推导是允许的），但每一条都要能回答「别人机器上成立吗」。

已知待清理（非阻塞）：`onlineDownload.service.test.ts`（6 处）、`fileUrl.test.ts`（4 处）、
`coverMatch.test.ts`（2 处）、`onlineTrack.test.ts`（1 处）——都是 `/home/yibin/Music` 与本机端口，
不是凭据；同文件内已有 `/home/Music`、`/home/李四` 这类中性写法，清理时对齐即可。**新增代码不要
再引入**。

含具体域名、真实凭据、内部部署细节的排查记录属于本地知识，绝不入库（推上去就收不回了，改文件
只能止损）——这类记录只留本机，不作为仓库内容的一部分。

## Android 构建

```bash
pnpm build:android   # 前端产物 → cap sync → release APK，一条命令
# 只改原生代码（Web 层没动）时可以省掉同步，直接重跑 gradle：
cd packages/mobile/android && ./gradlew assembleRelease
```

产物在 `packages/mobile/android/app/build/outputs/apk/`。

Web 层改动必须先 `build:app` 再 `cap sync`，否则打进 APK 的是上一次的前端产物 ——
`pnpm build:android` 就是把这两步串在一起，让这条依赖没机会被跳过。

应用图标、启动图与 web favicon 都由 `packages/desktop/resources/icon*.svg` 派生，统一交给
`scripts/generate-icons.sh` 生成（`pnpm verify:brand` 校验一致性，CI 的 android job 已接入）。
换品牌图形时改 SVG 后重跑一次即可，不要单独去改 `res/drawable*/splash.png` 或 mipmap：
启动图曾长期停留在 Capacitor 模板的白底占位图上，根因就是那次「替换全平台图标」漏掉了
这一组派生资源，而当时没有任何东西会提示漏了。

## 多语言开发

界面文案的权威规范（分层、写界面的三条路径、硬规则）见 [docs/i18n.md](./i18n.md)。
本节只覆盖**不在 React 字典里、但同样不能把中文烧死在代码里**的两段：原生层与打包元数据。

### Android 资源组织

- `packages/mobile/android/app/src/main/res/values/strings.xml` 是**英文默认**资源，
  `values-zh/strings.xml` 是中文。默认资源放英文是 Android 的兜底语义：系统语言匹配不到
  任何语言限定符目录（values-ja / values-de …）时回落到默认资源，若默认放中文，
  非中文系统一律看到中文。
- 品牌名与包标识（`app_name` / `title_activity_main` / `package_name` / `custom_url_scheme`）
  标 `translatable="false"`，只在默认资源里出现一份，两种语言同值。
- 应用自有文案统一 `aurora_` 前缀（与 Capacitor 模板字符串隔离）：通知频道名与描述、
  通知栏动作按钮（上一首 / 播放 / 暂停 / 下一首）都在这里。
  `npx cap sync` 对 strings.xml 只做 `My App` / `com.getcapacitor.myapp` 的字面替换，
  不会重写文件，新增条目安全。
- Kotlin 侧一律 `getString(R.string.aurora_xxx)`，不做字符串拼接；开发者日志与注释继续用
  中文，含中文字面量的日志行在该行尾加 `// i18n-exempt: 开发者日志`
  （`scripts/check-i18n.mjs` 的行级豁免；日志面向开发者，不进界面）。

### 原生错误码 → 字典键

原生插件（`UpdatePlugin` / `MediaSessionPlugin` / `PermissionPlugin`）**不回传中文句子**，
只回传机器码：`<域>_error_<小驼峰名>`，需要参数时以查询串追加（值做 URL 编码）。

映射是**可逆的单行规则**：键路径 = `mobile.` + 码把 `_` 换成 `.`（段内小驼峰原样保留）。

```ts
// JS 侧解析示例：拿到原生回传的字符串 → 可直接喂给 translateError 的键与参数
function parseNativeError(raw: string): { code: string; params?: Record<string, string> } {
  const [code, query] = raw.trim().split('?')
  const key = `mobile.${code.split('_').join('.')}`
  if (!query) return { code: key }
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(query)) params[k] = v
  return { code: key, params }
}
```

码与 `packages/shared/src/i18n/messages/{zh-CN,en}/mobile.ts` 一一对应（`?x=` 表示该码会带该参数）：

| 原生码 | 字典键 |
| --- | --- |
| `update_error_busy` | `mobile.update.error.busy` |
| `update_error_urlInvalid` | `mobile.update.error.urlInvalid` |
| `update_error_httpStatus?status=` | `mobile.update.error.httpStatus` |
| `update_error_canceled` | `mobile.update.error.canceled` |
| `update_error_incomplete?received=&expected=` | `mobile.update.error.incomplete` |
| `update_error_pathInvalid` | `mobile.update.error.pathInvalid` |
| `update_error_apkMissing` | `mobile.update.error.apkMissing` |
| `update_error_launchFailed?detail=` | `mobile.update.error.launchFailed` |
| `update_error_permissionSettings?detail=` | `mobile.update.error.permissionSettings` |
| `update_error_downloadFailed` | `mobile.update.error.downloadFailed` |
| `media_error_serviceStartFailed?detail=` | `mobile.media.error.serviceStartFailed` |
| `media_error_serviceStopFailed?detail=` | `mobile.media.error.serviceStopFailed` |
| `media_error_serviceNotRunning` | `mobile.media.error.serviceNotRunning` |
| `media_error_playQueueFailed?detail=` | `mobile.media.error.playQueueFailed` |
| `media_error_syncQueueFailed?detail=` | `mobile.media.error.syncQueueFailed` |
| `permission_error_settingsUnavailable?detail=` | `mobile.permission.error.settingsUnavailable` |

### 打包元数据

- **桌面 .desktop**（`packages/desktop/package.json` 的 `build.linux.desktop.entry`）：
  英文默认 `Name` / `Comment`，另给 freedesktop 规范的本地化键 `Name[zh_CN]` /
  `Comment[zh_CN]`（语言标签用 `_`，不是 `-`）。品牌名不翻译，两种语言同值。
- **deb**（`build-deb.sh`）：`--description` 给英文默认，中文走
  `--deb-field "Description-zh_CN: …"`。dpkg 接受并保留该字段（可用
  `dpkg-deb -f <pkg>.deb Description-zh_CN` 读回），但 apt / 软件中心不显示包描述的
  语言变体——那由仓库的 DDTP 翻译索引或 AppStream metainfo 提供，中文只是包内自描述。
- **rpm**（`build-rpm.sh`）：只给英文。fpm 的 rpm 输出没有 i18n 描述字段
  （`--rpm-summary` / `--description` 都是单值），软件中心的本地化描述同样走 AppStream。

### 语言作用域的字体

`packages/app/index.html` 一次加载 Inter / Noto Sans SC / JetBrains Mono，
切换语言不重新请求字体；`packages/app/src/styles/globals.css` 用
`html[data-locale="en"]` 把 Inter 提到 `--font-sans` 最前（中文界面沿用中文优先栈）。
`data-locale` 的真值只有一处来源：`index.html` 首屏脚本与 `I18nProvider`，不要再写第三份。

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

## 诊断日志

用户报问题时的第一动作是让他导出日志，而不是凭描述猜。日志系统分两层：
`packages/shared/src/logging/` 是**内核**（级别、脱敏、排版、导出包拼装，无平台 API），
各端只负责「往哪写、怎么导出」。

- **内核**：`initLogging({ sinks, level, origin })` + `captureConsole()` + `installErrorCapture()`。
  三个端（Electron 主进程 / 渲染进程 / Android WebView）共用同一份实现。
- **脱敏在记录创建时完成**，不是导出时：命中 `api_key` / `token` / `secret` / `password` /
  `cookie` / `authorization` 等键名的值、URL query、URL userinfo、`Bearer xxx` 一律打码成 `***`。
  落盘的那份已经是安全的 —— 用户发出去的文件不会带凭据。
- **console 被接管**：既有 150+ 处 `console.warn` / `console.error` 无需改动即进入日志包；
  接管的层默认仍向原始 console 输出（开发期行为不变），且内核自身绝不走 console（避免递归）。
- **滚动**：桌面端单文件 2 MB、最多 5 个（约 10 MB 上限），同步追加保证崩溃前最后一条不丢。
- **导出**：设置页「关于」下的诊断日志分区 →「导出日志」把全部日志拼成**一个 .txt**
  （环境头 + 各分段），落到系统「下载」目录并定位；移动端写到用户可访问目录后展示路径。
- **入口**：桌面端设置页诊断分区；移动端同页。

排障顺序建议：先看导出包的环境头（版本 / 平台 / 安装形态 / 发行版），再看 `[origin]` 与
scope 定位是哪条链路，最后看 `crash` scope 有无 `uncaughtException` / `unhandledrejection`。

## 打包与发布

- **桌面**：`pnpm build:desktop`，产物在 `packages/desktop/release/`（Linux AppImage / deb、
  Windows NSIS）；RPM 用自带的 `./build-rpm.sh`（绕开 electron-builder 内置 fpm 在 Ubuntu 上的 rpmdb 问题）。
- **发布**：推送 `v*` tag 触发 GitHub Actions 自动构建全平台产物（Windows / Linux / macOS 双架构 /
  Android）并发布 Release，发布前自动校验 APK 签名、macOS 产物与 Linux glibc 基线。
- **签名密钥**：APK 统一由仓库内固定的 `packages/mobile/android/app/aurora-music.keystore` 签名
  （SHA-256 `eb4e48a95587ed954789b81b20fc23689cc702e602ebac08050d308eabdb435b`），CI 每次校验指纹。
  该文件绝不可更换，否则存量用户无法覆盖升级；v0.1.4 及更早版本使用随机调试签名，升级到新版
  需卸载重装一次。
