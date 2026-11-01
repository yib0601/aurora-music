# 插件体系（v15）

> 本文定义**基础能力与插件的边界**、插件的两种来源、以及「添加第三方插件」的完整链路。
> 音源插件与存储插件的契约细节见 [plugins.md](./plugins.md)；本文是它之上的**分层与安装**部分。

## 1. 分层：什么是基础能力，什么是插件

一句话判据：**播不播得出来**。少了它播放器就不成立的是基础能力；少了它播放器仍然能听本地歌的是插件。

| 层 | 内容 | 位置 | 为什么在这一层 |
|---|---|---|---|
| **基础能力** | 音频解码与播放、播放队列、进度与音量、歌词渲染、曲库与本地扫描、播放条 / 全屏页 / 侧栏 | `packages/app`（`services/audio.*`、`stores/playerStore`、`components/player`、`components/lyrics`） | 它们是播放器本身。做成插件会让"能不能听歌"取决于装了哪些插件 |
| **插件：音源** | 搜索、取址、歌单曲目、登录 | `packages/shared/src/plugin`（`SourcePlugin`） | 应用**不内置任何音源**：在线能力的可用性取决于用户配置了哪个源 |
| **插件：歌词源** | 按曲目元信息取一份 LRC | `packages/shared/src/plugin/manifest`（`DeclarativeLyricsSpec`）+ 内置 `lrclibPlugin` | 歌词是"有更好、没有也能听"的增强。内置 LRCLIB 兜底，**自 v15 起它本身也是一条可停用的插件** |
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

### 判据：一条能力该做成插件还是基础能力

一句话：**凡是「从谁的服务器拿数据 / 换地址」的 → 插件；凡是不联网、只碰本地数据与播放器状态的 → 基础能力。**

| 域 | 归属 | 理由 |
|---|---|---|
| 播放内核（解码、队列、循环/随机、进度、音量、**变速**、**睡眠定时器**） | 基础能力 | 播放器本体。插件拿不到 `<audio>` 元素与音频图，做成插件等于让"能不能听歌"取决于装了哪些插件 |
| 本地曲库（扫描、元数据、内嵌封面、watcher、排序/视图/专辑聚合） | 基础能力 | 绑在 fs 上：`fs.watch`、GBK 兜底、掉盘不误删这些行为套不进插件契约（见 `mediaProvider.ts` 文件头） |
| 歌单（新建/改名/加移曲/排序/M3U/纯文本导入） | 基础能力 | 纯本地集合运算 |
| 歌单**分享链接解析**、歌单**远端曲目** | 插件 | 要访问第三方平台，且各平台差别极大（`parsePlaylist` / `getPlaylistTracks`） |
| 歌词渲染、LRC 解析、本地 `.lrc` 读写 | 基础能力 | 渲染与本地文件 |
| 在线**歌词源**（含内置 LRCLIB） | 插件 | 它是外部 HTTP 数据源。做成插件才能"看得见、关得掉" |
| 本地**搜索** + 搜索历史 | 基础能力 | 纯内存 filter |
| 在线**搜索**、按 id **取址**、**登录** | 插件 | 平台差异极大（签名/防盗链/VIP 试听），必须由插件表达 |
| 在线**发现**（推荐/榜单） | 插件 | 浏览型增强 |
| 网络**存储协议**（WebDAV/SMB/SFTP） | 插件 | 新协议只该加一个文件 + 声明字段 |
| 存储**协议代理**（`aurora-remote://`、凭证注入、Range 透传） | 基础能力 | 安全边界：口令只在主进程、越界必须拒。插件不能自己捏协议处理器 |
| 下载编排、缓存三池、标签/封面嵌入 | 基础能力 | 纯本地文件操作；只有"地址从哪来"依赖插件 |
| 应用更新（检查/下载/续传/校验/安装） | 基础能力，且**不开放插件化** | 更新链路可被第三方替换 = 任意代码执行入口，与"装个音源"不是同一信任量级 |
| 系统集成（托盘、媒体键、Android 前台服务/MediaSession） | 基础能力 | 宿主 OS 集成，插件层拿不到也不该拿到 |
| 外观、i18n、诊断日志、**插件基础设施本身** | 基础能力 | UI 一致性 / 一份词典 / 排障必须永远在；插件系统的地基不能被插件化 |


## 2. 插件的两种来源

| 来源 | 形态 | 谁写 | 安装方式 | 能力上限 |
|---|---|---|---|---|
| **内置** | TypeScript 模块，编译进应用 | 仓库作者 | 随应用发布，不可卸载 | 任意（可调 Node API、可跑脚本沙箱） |
| **已安装** | 一份声明式 JSON 清单 | 用户 / 第三方 | 设置页填网址或选本地文件 | 只能发 HTTP + 读响应字段（**不执行代码**） |

两种来源**注册进同一个注册表**：执行路径完全一致，上层不区分。差别只在
「实现从哪来」与「能不能卸」。

内置插件清单：`aurora`（自有协议源）、`lx`（洛雪脚本）、`qishui`（汽水音乐）、`builtin-lyrics-lrclib`（歌词兜底）、`webdav`/`sftp`/`smb`（存储）。
已安装插件清单：用户装的，落在磁盘上。

> **v15 变更**：内置 LRCLIB 以前是 `lyricsSource.ts` 里的模块级常量，由 `searchLyrics`
> **无条件**追加 —— 用户既看不到（插件列表里没有）、也关不掉（LRCLIB 实测会回 503，
> 那时每次取词都要在它身上白等一轮 8s 超时）。现在它是一条 `domain: 'lyrics'` 的内置插件：
> 进目录、可停用，停用后聚合器不再追加那两档。

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

### 关于清单签名：当前不提供

这套系统**没有**清单签名（Ed25519 / 公钥信任根都没有）。插件内容的完整性只靠上面
那层**内容哈希锁**：`install.json` 里的 `sha256` 在安装期钉住，之后每次启动按同一份
字节重新计算并比对。

为什么不做签名：签名要成立必须有一个**信任根的来源**（内置公钥表等于让本项目扮演 CA，
而本项目没有官方插件仓库；让用户自己导入公钥则要求用户先有一份可信的 keyId 与公钥），
在「填一个地址就能装」的定位下，这层成本与收益不成比例。取而代之的是把风险讲清楚：

- 安装确认框展示**清单里声明的主机白名单与权限**，让用户自己判断「这个源要去哪些主机、
  要什么权限」
- 装完之后靠哈希锁保证「本机上它没被改过」
- 运行期靠 `hosts` 白名单挡住越界出网

也就是说：**装的时候信任作者，装完之后不再信任任何后续变化**。

### 运行期边界的落点

`PluginContext.fetch` 对已安装插件被 `createGuardedFetch` 包过：
请求目标主机不在清单 `hosts` 里 → **抛错且不发出请求**。
插件契约本来就规定"插件只依赖注入的 fetch，不自带网络栈"，所以包在这一层等于覆盖了
它的全部出网路径。

**已知局限**（写在 `manifest/host.ts` 里）：只校验请求发起时的目标主机；
上游 302 到白名单外的主机由 fetch 自己跟随，这一层看不到中间跳转。

### 一条插件出错，不影响软件启动

插件是可失败的外部输入：清单来自磁盘、脚本来自网络、内置实现也可能在某一版里引入
求值期异常。所以**启动链路上每一处"一条插件"的粒度都必须被隔离** —— 任何一处抛出去
都会沿 `app.whenReady()` 的 promise 链冒出去，最坏情况是窗口根本没被创建。

三条纪律：

1. **只有一个隔离原语**：`plugin/health.ts` 的 `isolatePluginStep(stage, id, run)`。
   它跑一步插件逻辑，抛错时记一条失败记录并返回 `undefined`。不要在各调用点各写一遍
   try/catch：迟早漏一处，而漏掉的正好是启动路径。
2. **失败要能被用户看到**：记录进 `pluginFailures()`，启动后经 `plugin:startup` 通道
   （移动端是 `platform.plugins.startup()`）交给渲染层，汇总成一条 toast + 一个
   「查看」跳设置页；设置页里逐条列出插件 id 与技术原因。
3. **不拿别的插件顶上**：一条失败就是这一条失败。悄悄换另一个实现去执行，只会在
   另一处产生更难懂的现象。

隔离落点（都走 `isolatePluginStep`）：

| 阶段（`stage`） | 位置 | 为什么危险 |
|---|---|---|
| `storage` | `plugin/storage/index.ts` 顶层 | 模块求值期执行，抛错等于整个包 import 失败 |
| `builtin` | `plugin/builtins.ts` 的 `ensureBuiltinsRegistered` | 首次执行时才注册，抛错发生在业务调用里 |
| `installed` | `plugin/installed.ts` 的 `mountInstalled` | 启动路径上，在建窗之前 |

`mountInstalledPlugins()`（桌面 `ipc/pluginInstall.ts` / 移动 `mobile/pluginInstall.ts`）
本身**绝不抛错**，并返回 `PluginStartupReport { mounted, broken, failures }`：
`broken` 是"磁盘上的文件读不出来"，`failures` 是"加载时抛错"。两者对用户是同一件事
（这些插件用不了），所以提示里合并成一个数字。

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
| 加载隔离与失败登记 | `packages/shared/src/plugin/health.ts` |
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
- **插件异常不阻止启动**（`isolatePluginStep` + `PluginStartupReport`，见第 4 节）
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
3. **没有清单签名**：当前不提供清单签名，插件内容靠安装期哈希锁定（见上文
   「关于清单签名：当前不提供」）。要补这层得先有信任根的来源，而本项目
   不打算扮演 CA。

## 7. 自检清单（改插件层时）

- 上层是否还在用 `kind === 'xxx'` 判断形态？应为零。
- 新增能力是「加一个可选方法」，还是又要改 N 个文件的分支？
- 清单校验失败的报错是否**指到了具体字段路径**？
- 装失败 / 卸载失败的原因是否**能归因**到具体动作（而不是统一一句"失败"）？
- 已安装插件的越界请求是否**没被发出去**（而不只是报了错）？
- 卸载是否同时摘掉了磁盘目录与运行期注册？（只做一半 = "已卸载但还在工作"）
- 新代码里有没有一处"一条插件"的抛错会冒到启动链路上？
  该走 `isolatePluginStep` 而不是裸调用（判据：这段代码会在 `app.whenReady()` 里
  或模块求值期执行吗？）
- 新增的失败通道是否**接到了 UI**？（只记日志 = 用户永远不知道）
- 第三方插件的展示名是否**不依赖本仓库字典**（用字面量）？
- 新增字典键是否 zh-CN 与 en **两边都加了**，且占位符集合一致？
