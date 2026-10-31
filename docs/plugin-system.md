# 插件体系（v14）

> 本文定义**基础能力与插件的边界**、插件的两种来源、以及「添加第三方插件」的完整链路。
> 音源插件与存储插件的契约细节见 [plugins.md](./plugins.md)；本文是它之上的**分层与安装**部分。

## 1. 分层：什么是基础能力，什么是插件

一句话判据：**播不播得出来**。少了它播放器就不成立的是基础能力；少了它播放器仍然能听本地歌的是插件。

| 层 | 内容 | 位置 | 为什么在这一层 |
|---|---|---|---|
| **基础能力** | 音频解码与播放、播放队列、进度与音量、歌词渲染、曲库与本地扫描、播放条 / 全屏页 / 侧栏 | `packages/app`（`services/audio.*`、`stores/playerStore`、`components/player`、`components/lyrics`） | 它们是播放器本身。做成插件会让"能不能听歌"取决于装了哪些插件 |
| **插件：音源** | 搜索、取址、歌单曲目、登录 | `packages/shared/src/plugin`（`SourcePlugin`） | 应用**不内置任何音源**：在线能力的可用性取决于用户配置了哪个源 |
| **插件：歌词源** | 按曲目元信息取一份 LRC | `packages/shared/src/plugin/manifest`（`DeclarativeLyricsSpec`） | 歌词是"有更好、没有也能听"的增强。内置 LRCLIB 兜底 |
| **插件：存储** | 列举远端目录、读字节流、可用性探测 | `packages/shared/src/plugin/storage`（`StoragePlugin`） | 只有联网曲库需要它；本地目录不走插件（见下） |
| **插件：在线发现** | 推荐歌单、榜单 | `packages/shared/src/plugin/types.ts`（`SourcePlugin` 的 `recommendPlaylists` / `toplists` / `toplistDetail`） | 浏览型能力：没有它本地播放完全不受影响 |

### 三条边界纪律（改代码时要守的）

1. **基础能力不 import 插件实现，只 import 插件门面**。平台层（`app/src/services/platform`）
   与设置页只调 `searchViaPlugin` / `storagePluginOf` / `listPlugins` 这类门面，
   不出现 `kind === 'xxx'`。这条已经执行，`docs/plugins.md` 的自检清单继续有效。
2. **插件不碰播放器内部**。插件只产出「一份地址」或「一份歌词文本」；什么时候播、怎么降级、
   试听怎么提示，都由播放器决定。这条决定了插件可以完全不依赖 React。
3. **没有插件时播放器必须仍然可用**。本地曲库 + 本地歌词文件这条路径不经过任何插件。
   一个插件都没装 / 全部加载失败时，`我的音乐` 仍然能播。

## 2. 插件的两种来源

| 来源 | 形态 | 谁写 | 安装方式 | 能力上限 |
|---|---|---|---|---|
| **内置** | TypeScript 模块，编译进应用 | 仓库作者 | 随应用发布，不可卸载 | 任意（可调 Node API、可跑脚本沙箱） |
| **已安装** | 一份声明式 JSON 清单 | 用户 / 第三方 | 设置页填网址或选本地文件 | 只能发 HTTP + 读响应字段（**不执行代码**） |

两种来源**注册进同一个注册表**：执行路径完全一致，上层不区分。差别只在
「实现从哪来」与「能不能卸」。

内置插件清单：`aurora`（自有协议源）、`lx`（洛雪脚本）、`qishui`（汽水音乐）、`webdav`（存储）。
已安装插件清单：用户装的，落在磁盘上。

### 为什么第三方插件只支持「声明式清单」（A 档）

按风险分三档（这一判断沿用 `docs/plugins.md` 的结论）：

| 档 | 形态 | 风险 | 当前 |
|---|---|---|---|
| A | 声明式 HTTP（JSON 描述端点与字段映射） | 低：不执行任何代码 | **已实现** |
| B | 受限脚本（复用 `lxHost` 沙箱） | 中：执行第三方代码 | **已实现**（`script` 块） |
| C | 原生模块 | 高：等同运行任意程序 | **永不做** |

A 档与「用户填一个音源地址」是同一个信任量级：它只说"我请求这个地址、从这个字段取值"。
C 档一旦开放，应用就有了「下载并执行任意二进制」的能力，那是完全不同的信任模型。

### B 档的边界（都要守住）

B 档会**执行第三方代码**，所以它比 A 档多三道约束，缺一条都会让信任模型塌掉：

1. **单独的权限项 `script`**，且与清单里的 `script` 块**强制配平**（校验器会拒绝
   「有脚本块没权限」与「有权限没脚本块」）。安装确认框里这一条用的是完全不同的措辞：
   "在本机沙箱内运行插件作者提供的脚本代码"，而不是 A 档的"访问这些域名"。
2. **脚本正文安装时落盘，运行期绝不回源**。`script.url` 是地址不是身份（仓库可以
   force-push）；运行期回源等于让用户确认过的代码在下次播放时变成别的东西。
   安装时把脚本完整拉下来、算 sha256、与清单一起存进 `<pluginDir>/script.js`。
   清单里若预声明 `script.sha256`，安装时强制比对。
3. **沙箱沿用 `lxHost` 的既有实现，不新写一套**：伪全局遮蔽（`document` / `navigator` /
   `location` / `localStorage` 与 Node 标识一律 `undefined`）、网络只能经宿主 `lx.request`
   转发、桌面端用 `node:vm` 注入超时（同步死循环可被打断）。

A 与 B **不是二选一**：一份清单可以同时带声明式端点与脚本块，典型形态是
「声明式负责搜索、脚本负责取址」（洛雪脚本绝大多数只实现 `musicUrl`）。
合并规则是**声明式优先**（同名能力下声明式更可预测，不执行代码），脚本补空缺。

## 3. 清单格式

一份清单是一个 JSON 文件，`format` 字段固定为 `aurora-plugin/1`。完整字段表见
`packages/shared/src/plugin/manifest/types.ts`，这里给一份能跑的最小示例与逐段说明。

### 示例：一个音源插件

```json
{
  "format": "aurora-plugin/1",
  "id": "example-source",
  "name": { "zh-CN": "示例音源", "en": "Example Source" },
  "description": { "zh-CN": "演示用的音源插件", "en": "A demo source plugin" },
  "version": "1.0.0",
  "author": "someone",
  "permissions": ["network"],
  "hosts": ["api.example.com"],
  "source": {
    "search": {
      "url": "https://api.example.com/search?q={query}&quality={quality}",
      "headers": { "X-Token": "..." },
      "items": "data.songs",
      "map": {
        "id": "song.id",
        "title": "song.name",
        "artist": "song.artists[0].name",
        "album": "song.album.name",
        "durationMs": "song.duration",
        "coverUrl": "song.pic",
        "audioUrl": "song.playUrl"
      }
    },
    "resolveTrack": {
      "url": "https://api.example.com/track?id={id}&quality={quality}",
      "map": { "audioUrl": "data.playUrl", "expireAt": "data.expire_at", "isPreview": "data.is_trial" }
    },
    "playlistTracks": {
      "url": "https://api.example.com/playlist?id={playlistId}",
      "map": { "id": "songmid", "title": "title", "artist": "singer" }
    }
  },
  "lyrics": {
    "url": "https://api.example.com/lyric?t={track}&a={artist}&d={duration}",
    "format": "json"
  }
}
```

### 关键字段的语义

- **`id`**：小写字母开头，`[a-z0-9._-]`，最长 64。它同时是注册表键、目录名与凭证文件名。
  与内置插件**撞名会被拒绝安装**（否则会悄悄覆盖官方实现）。
- **`name` / `description`**：字符串，或按语言标记的字面量映射。
  **不能是字典键** —— 外部插件不在这份仓库的字典里（内置插件才用 `displayNameKey`）。
  解析顺序：精确语言 → 主语言 → `en` → 任意第一个非空值 → `id`（**永不为空**）。
- **`permissions`**：`network` / `credential`。`filesystem` 在 A 档**判为不支持**。
- **`hosts`**：具体域名列表，**禁止通配符**（`*` / `*.example.com` 直接判非法）。
  运行期强制：越界请求不会发出。白名单写 `api.example.com` 时该主机**任意端口**放行；
  写 `api.example.com:8443` 时只放行该端口。
- **`source.search.url`**：必须含 `{query}`。否则"搜什么都打同一个地址"——
  表面能跑、结果全错，所以是硬校验。
- **`source.resolveTrack.url`**：必须含 `{id}`（源内曲目 id，取址时原样交回）。
- **`source.playlistTracks.url`**：必须含 `{playlistId}`。
- **`lyrics.url`**：必须含 `{track}` 或 `{query}`（两者是同一个值的别名）。
  占位符值一律 `encodeURIComponent`；**取值为空的参数整段剔除**
  （留成 `artist_name=` 会被上游当成错误：LRCLIB 实���回 503）。

### 字段映射（`map`）的语法

只支持三种成分，**不是** JSONPath、不执行表达式：

```
a            → a
a.b.c        → a.b.c
a[0].b       → 数组下标 + 属性
a.b|a.c      → 多路径按顺序取第一个有值的（上游字段名不统一时用）
```

其余写法（`$.a`、`a?.b`、`a.b()`、`a['b']`）在**安装校验期**就报错 ——
它们装上去只会永远取不到值，而作者无从得知。

`duration` 与 `durationMs` 二选一（前者秒、后者毫秒），同时声明报错：
一个字段不可能既是秒又是毫秒。

### 各能力对 `audioUrl` 的要求不同（容易写错）

- `search.map.audioUrl`：**必填**。没有播放地址的搜索结果在界面上点不动。
- `playlistTracks.map.audioUrl`：**可选**。真实形态是"歌单只给元信息，
  地址在播放时按 id 现取"——此时应用自动带上 `trackRef`，播放前调 `resolveTrack`。

## 4. 安装链路

```
用户填网址 / 选文件
   ↓  主进程：下载或读字节（上限 1 MiB，超时 15s）
   ↓  按**文件字节**算 sha256
   ↓  UTF-8 解码 → JSON.parse → schema 校验（逐条给字段路径）
   ↓  与内置 / 已安装查冲突（撞名直接拒绝）
   ↓  写盘：<userData>/aurora-music/plugins/<id>/{manifest.json, install.json}
   ↓  注册进运行期（不重启即可用）
   ↓  渲染层刷新列表
```

### 为什么哈希按文件字节算，而不是规范化后的 JSON

「填一个地址」的天然问题是**同一个地址的内容会变**：仓库可以 force-push、
`main` 每天前进。所以安装记录里钉的是**内容指纹**（`sha256`）而不是「URL + 版本号」。

按解析后重新序列化的 JSON 算哈希会让"作者改一个缩进"也变哈希，而他其实没改语义；
更严重的是第三方工具无法复现我们的序列化格式。按原始字节算 + 校验时按同一份字节算，
是唯一可被任意工具复现的做法。

**每次启动都核对哈希**：不一致 → 拒绝加载并进"读不出来的插件"列表，让用户重新安装。
悄悄加载一份内容变了的第三方插件，正是这条约束要防的事。

### 目录布局：一个插件一个目录

```
<userData>/aurora-music/plugins/
  ├── example-source/
  │   ├── manifest.json     作者写的清单（逐字节保存）
  │   └── install.json      本机写的安装记录（sha256 / 时间 / 来源）
  └── another-plugin/
      └── ...
```

卸载 = 删一个目录。这避免"清单删了但安装记录还在"的孤儿文件 ——
孤儿记录会让插件在下次启动时"复活"，而用户明明已经点过卸载。

写盘先写 `<id>.tmp-<pid>-<ts>/` 再 `rename`：进程中途崩掉不会留下半截清单。
扫描时跳过带 `.tmp-` 的目录。

### 签名（Ed25519）：防的是链路，不是人

内容哈希与签名是**两层不同的保障**，都要：

- **哈希**（`install.json` 的 `sha256`）证明"装进来之后它没被改过"（本机一致性）
- **签名**（清单里的 `signature` 块）证明"下载到的东西确实是发布者签的那份"（传输链完整性）

签名的四档语义（`manifest/signature.ts`）：

| 清单里的签名 | 公钥在信任表里 | 结论 |
|---|---|---|
| 无 | — | `unsigned`：允许安装，列表标「未签名」 |
| 有，校验通过 | 是 | `verified`：允许安装，标「已验证」 |
| 有，校验失败 | 是 | **拒绝安装**（内容被改过） |
| 有，公钥不在表里 | 否 | `unknown-key`：允许安装，标「签名者未知」 |

为什么"公钥未知"不直接拒绝：那会让自建托管的人（没有内置公钥）完全装不了自签插件。
而"签名者未知"与"完全未签名"在用户看来是同一件事 —— 都不能证明来源可信。
真正危险的是"签名存在但校验失败"，那必须拒绝。

**签名覆盖的是「去掉 signature 字段后的规范化清单」**（键排序 + 紧凑序列化）。
为什么不是原始字节：签名块必须写在清单里，而它又要被签名覆盖，是经典的鸡生蛋问题。
规范化让签名对**语义**负责而不是对作者的缩进负责；代价是作者必须用
`canonicalizeManifest()` / `signableBytes()` 生成签名。

信任根是 `TRUSTED_PLUGIN_KEYS`（内置公钥表，**默认为空**）。
清单里附带的公钥**不被信任** —— 那等于让签名自己证明自己。

### 运行期边界的落点

`PluginContext.fetch` 对已安装插件被 `createGuardedFetch` 包过：
请求目标主机不在清单 `hosts` 里 → **抛错且不发出请求**。
插件契约本来就规定"插件只依赖注入的 fetch，不自带网络栈"，所以包在这一层等于覆盖了
它的全部出网路径。

**已知局限**（写在 `manifest/host.ts` 里）：只校验请求发起时的目标主机；
上游 302 到白名单外的主机由 fetch 自己跟随，这一层看不到中间跳转。

## 5. 代码地图

| 关注点 | 文件 |
|---|---|
| 清单契约与字段表 | `packages/shared/src/plugin/manifest/types.ts` |
| 校验器（安装期硬校验） | `packages/shared/src/plugin/manifest/validate.ts` |
| 路径解释器（`map` 的三成分语法） | `packages/shared/src/plugin/manifest/path.ts` |
| 主机白名单 fetch | `packages/shared/src/plugin/manifest/host.ts` |
| 清单 → 音源插件 | `packages/shared/src/plugin/manifest/source.ts` |
| 清单 → 歌词执行器 | `packages/shared/src/plugin/manifest/lyrics.ts` |
| 跨域统一目录（内置 + 已安装） | `packages/shared/src/plugin/manifest/catalog.ts` |
| 已安装插件的运行期登记 / 撤销 / 脚本正文 | `packages/shared/src/plugin/installed.ts` |
| 落盘（目录、哈希、原子写、扫描）· 桌面 | `packages/desktop/src/ipc/pluginStore.ts` |
| 安装 / 卸载 / 目录 IPC · 桌面 | `packages/desktop/src/ipc/pluginInstall.ts` |
| 落盘（Capacitor Filesystem）· 移动 | `packages/app/src/services/platform/mobile/pluginStore.ts` |
| 安装 / 卸载（原生 HTTP）· 移动 | `packages/app/src/services/platform/mobile/pluginInstall.ts` |
| 渲染层纯逻辑 | `packages/app/src/components/common/pluginManage.ts` |
| 渲染层 UI | `packages/app/src/components/common/PluginManagerPanel.tsx` |

启动顺序（`packages/desktop/src/main.ts`）：`registerIpcHandlers()` →
`mountInstalledPlugins()` → `createWindow()`。挂载必须早于建窗，
否则渲染层首帧问到的插件目录是空的，过一会儿才自己冒出来。
移动端没有独立主进程，挂载在 `packages/app/src/main.tsx` 里 **render 之前**发起
（`platform.platform === 'mobile'` 时），且刻意不 await —— 挂载是异步 I/O，
等它会拖慢首屏，而未挂载完的窗口里只是少几条已安装项，本地播放不受影响。

### 移动端与桌面端：共用纪律，不共用代码

桌面端用 `node:fs`（同步、任意路径），移动端是 Capacitor WebView，
只有 `@capacitor/filesystem`（异步、`Directory.Data` 这类抽象目录）。
两个环境没有共同的文件原语，硬抽象一个"两者都行"的接口只会让两边都变复杂。

**共用的是纪律**（都能被同一批类型与断言钉住）：

- 目录布局一致：`plugins/<id>/{manifest.json, install.json, script.js}`
- 哈希按**原始字节**算，每次启动核对，不符即拒绝加载
- 原子写：先写 staging 目录，全部成功后才挪到正式目录
- 一个坏插件不让其余插件消失（坏条目进 `broken` 列表）
- 安装前完成全部校验；B 档脚本安装时拉取并落盘，运行期不回源

移动端的两处差异（都是环境决定的，不是取舍）：

1. **没有"选本地文件"**：Capacitor 的文件选择需要额外的原生插件，而"填网址"已覆盖
   绝大多数场景。移动端的 `installFromFile` / `pickManifest` **不存在**，
   UI 据方法存在性隐藏对应按钮（与全仓「能力缺失用方法不存在表达」一致）。
2. **登录类能力不可用**：移动端没有 `safeStorage` 等价物，
   `authState` 恒返回 `{ loggedIn: false, encryptionAvailable: false }`，
   声明了 auth 能力的插件在手机端不会出现在登录面板里。

## 6. 还没做的部分（如实记录）

1. **SMB / SFTP 存储插件**：契约与声明式字段机制都已就绪（`StoragePlugin.fields`
   声明式渲染表单），但这两个协议无法用声明式 HTTP 表达。
   依赖（`ssh2` / `smb2`）**刻意不进应用本体**，理由与实现路线见
   [storage-protocols.md](./storage-protocols.md)。
2. **移动端没有脚本源的沙箱加固**：移动端 `Capacitor` 环境没有 `node:vm`，
   `lxHost` 回落成 `new Function`（同步死循环无法被打断）。这条限制在
   `lxHost.ts` 顶部已如实写明，装 B 档插件的移动端用户需要知道。
3. **信任表还没有 UI**：`TRUSTED_PLUGIN_KEYS` 当前是源码里的常量（默认为空）。
   自建托管的人要信任自己的签名，目前得改源码重新打包。
   加一个"导入公钥"的设置页入口是下一步（那时信任表要变成可持久化配置）。

## 7. 自检清单（改插件层时）

- 上层是否还在用 `kind === 'xxx'` 判断形态？应为零。
- 新增能力是「加一个可选方法」，还是又要改 N 个文件的分支？
- 清单校验失败的报错是否**指到了具体字段路径**？
- 装失败 / 卸载失败的原因是否**能归因**到具体动作（而不是统一一句"失败"）？
- 已安装插件的越界请求是否**没被发出去**（而不只是报了错）？
- 卸载是否同时摘掉了磁盘目录与运行期注册？（只做一半 = "已卸载但还在工作"）
- 第三方插件的展示名是否**不依赖本仓库字典**（用字面量）？
- 新增字典键是否 zh-CN 与 en **两边都加了**，且占位符集合一致？
