# 歌单同步（插件域 `sync`）

> 目标：在**多台桌面设备**之间同步歌单（名称、顺序、成员），支持两条链路——
> 用户自己的 Web 网络存储（任意 WebDAV），以及局域网内直连自动同步。
>
> 本文只写**当前实现**的事实与理由。做完的、没做的、为什么这么做，都在这里。

---

## 1. 范围

同步的内容：

- **歌单**：`name`、创建/更新时间、曲目顺序（`trackIds` 的**顺序是有意义的**）
- **曲目元数据**：曲名 / 歌手 / 专辑 / 时长，以及「本机文件在哪」或「在线曲目是谁」

不同步的内容：喜欢列表、播放次数、最近播放、播放队列、当前选中歌单、音源凭证。

平台：**桌面端**。移动端与 Web 端不出现入口——理由见 §8。

---

## 2. 为什么是「插件域」，而不是一个功能页

仓库的插件体系有一条判据（`docs/plugin-system.md`）：**凡「从谁的服务器拿数据 / 换地址」→ 插件；
不联网只碰本地数据与播放器状态 → 基础能力。**

歌单同步落在这条线的两侧，所以按职责切开：

| 层 | 归谁 | 负责什么 |
|---|---|---|
| 数据模型、合并算法、曲目身份再匹配、调度、冲突提示、UI | **基础能力**（`packages/app`） | 与「用哪条链路」无关的语义 |
| 把快照字节搬进搬出（`probe` / `pull` / `push`） | **插件**（`packages/shared/src/plugin/sync/`） | 协议、鉴权、错误映射 |

因此「换成 S3 / 换成 FTP / 换成自建服务」只需新增一个插件文件，引擎与 UI 不动。
这与存储插件（`docs/plugins.md`）是同一套设计语言：**声明式字段 + `available()` +
能力按方法存在性派生 + 单一入口**。

与存储插件的一处刻意差异：**没有 `capabilities` 自报字段**，能力一律由
`syncCapabilitiesOf()` 按 `probe/pull/push` 是否存在派生。一份实现只允许有一种说法。

### 为什么不是「已安装的 A 档声明式插件」

A 档只能发 HTTP 并读响应字段（`docs/plugin-system.md` §A）。WebDAV 同步需要
PROPFIND/MKCOL/PUT 与非标准动词、需要读目录枚举结果；局域网同步需要监听端口。
硬套只会做出一个只能连 demo 服务器的玩具——与 `PluginDomain` 里 `storage` **不支持声明式**
的理由完全一致。所以两个同步插件都是**内置插件**（编译进应用，能力不限）。

---

## 3. 快照格式

全量快照，不增量。

```jsonc
{
  "format": "aurora-playlist-sync/1",
  "deviceId": "6f1a…",          // 设备身份，不是账号
  "deviceName": "书房台式机",     // 仅用于 UI 展示「来自哪台设备」
  "revision": 42,                // 本机单调计数，用于日志与诊断
  "updatedAt": 1762400000000,
  "playlists": [
    {
      "id": "p-…",
      "name": "通勤",
      "createdAt": 1760000000000,
      "updatedAt": 1762400000000,
      "deletedAt": null,         // 墓碑：有值表示这份歌单在 updatedAt 被删除
      "tracks": [ /* SyncTrackRef[]，顺序即歌单顺序 */ ]
    }
  ]
}
```

**为什么全量**：几十个歌单、几千条曲目引用，序列化后几十 KB 量级；增量同步要为
「顺位 / 补偿 / 乱序到达」再写一套状态机，收益为零而失败模式多一倍。

**为什么 `updatedAt` 而不是逻辑时钟**：跨设备没有共享的因果链，HLC/向量时钟的额外
收益（精确的并发判定）在本场景换不来复杂度——见 §5 的冲突提示。

**为什么快照里不放 `sourceId`**：它是**设备本地**的音源配置 id，换台机器就是另一个值。
存储类曲目用 `pluginId` + 相对路径表达（见 §4）。

---

## 4. 曲目引用：`SyncTrackRef`

跨设备唯一可比较的身份不是 `trackId`（`packages/desktop/src/ipc/scanner.ts` 里由
`uuidv4()` 生成，**设备相关**），也不是文件绝对路径（另一台机器上可能是别的盘符、
别的用户名）。所以快照里存的是「怎么把这首歌在本机再找回来」：

```ts
type SyncTrackRef =
  | { kind: 'local';   path: string }                       // 本机绝对路径（本机自用）
  | { kind: 'storage'; pluginId: string; relPath: string }  // 存储库相对路径
  | { kind: 'meta' }                                        // 只有元数据
```

三者都带同一份元数据：`title` / `artist` / `album` / `duration`，可选
`onlineId` / `platform` / `coverUrl`（来自歌单导入登记的在线曲目）。

**到达对端后的解析顺序**（`resolveSyncTrackRef`，实现在 `trackRef.ts`）：

1. `kind:'local'` → 本机路径**精确**命中（先按原样，再按归一化：反斜杠转斜杠 + 小写）
2. 同名 + 时长在容差内（复用 `trackIdentity.ts` 的口径，`DURATION_MATCH_TOLERANCE = 1s`）
3. `kind:'storage'` → 同 `pluginId` 的相对路径精确，再退到**后缀互含 / basename 相同**
   （复用 `importMatch.ts` 的 `matchTracksByPaths` 语义，**不新写一份**）
4. 在线身份：本机有同 `platform` 的已启用音源时按 `onlineId` 认领，否则按元数据在线搜索
5. 全部落空 → **占位曲目**（登记进 `importedTracks`，`path: ''`）：歌单里照样能看见、
   能显示歌词与封面，播放时由 `ensurePlayableTrack` 按需取址

> 第 5 条是这次设计里最重要的取舍：**宁可显示一首「暂时放不了」的歌，也不要静默丢条目**。
> 静默丢弃会让用户以为同步坏了，而且下轮同步还会把丢掉的条目当成「对端新增」再加回来。

**明确不做**：不自动下载音频文件，不修改本地曲库，不动文件系统。

---

## 5. 合并规则

**以歌单为最小冲突单元，LWW（last-write-wins）**：

- 每个 `playlistId` 在「本机 + 本次拉到的所有远端快照」里取 `updatedAt` 最大者
- `updatedAt` 相同（同毫秒）时按 `deviceId` 字典序取大者——只看「确定性」，不看语义
- `deletedAt` 参与同一套比较：墓碑更晚就是删除，否则就是对方还在旧版本上编辑
- 墓碑保留 **90 天**后清理（`TOMBSTONE_TTL_MS`），避免快照无限增长

**为什么不做「曲目并集」**：顺序是这个数据模型的一部分（`trackIds` 有序，且用户会手动排序）。
并集合并无法回答「两边的顺序都变了，听谁的」，也无法回答「A 删了、B 又加回来」。
LWW 的代价是明确的：**两端同时改同一个歌单会丢一侧的改动**。这个代价用 UI 明说
（`sync.conflict.note`：同一歌单在两端都被修改时，以较新的改动为准），而不是靠算法偷偷选一个。

**幂等与收敛**（`__tests__/merge.test.ts` 覆盖）：

- `merge(merge(a, b), b) = merge(a, b)` — 重复拉取同一条快照不产生新变化
- `merge(a, b) = merge(b, a)` — 交换律（在 `updatedAt` 不同或 `deviceId` 可比较时成立）
- 三台设备两两同步两次后状态一致

**写入策略**：只有「合并结果与本机当前状态不同」才改写 store（`changed` 标志），
避免同步把 zustand 的 `updatedAt` 抬高、进而触发下一轮虚假变更。

---

## 6. WebDAV 链路（`webdav-sync`）

### 布局

```
<用户填的目录>/aurora-sync/<deviceId>.json
```

**每设备一个文件**，读时枚举目录取全部 `*.json` 合并。

为什么不是「所有设备写同一个文件」：WebDAV 没有条件写（If-Match 支持参差不齐），
两台设备同时 PUT 就是互相覆盖，而且**覆盖了还不知道**。各写各的文件，
读取侧合并，从根上消灭丢更新。

为什么不在同一个文件里做「多设备段落」：那等于把合并逻辑塞进文件格式，
并把并发写变成必然冲突。

### 新增的三处原语

`packages/shared/src/webdav.ts` 现有出口只覆盖「列目录 / 读区间 / 读流」，
同步插件需要补三个小函数（同一文件、同一套错误映射，不另起一套）：

- `readWebdavText(cfg, relPath)` — GET，2xx 返回文本；404 返回 `null`（**不是错误**，
  首次同步时快照文件本来就不存在）
- `writeWebdavText(cfg, relPath, body)` — PUT，201/204/200 视为成功
- `ensureWebdavDir(cfg, relPath)` — MKCOL，405（已存在）视为成功

错误映射沿用 `WebdavError` + `core.error.webdav*` 文案键，不新增一套错误词汇。

### 字段

| key | kind | 说明 |
|---|---|---|
| `url` | url | 服务地址，如 `https://dav.jianguoyun.com/dav` |
| `username` | text | 账号（必填；Basic 认证） |
| `password` | password | 应用密码 —— **不进 settings**，走主进程 safeStorage，按 configId 存 |
| `dir` | path | 目录（相对根，如 `/aurora-music`）；留空为根目录 |

> 口令明文进 localStorage 是 `webdav.ts`（存储插件）当年的缺陷，同步这边不复制。

### 传输为什么必须过主进程

打包后的桌面端是 `webSecurity: true` + `loadFile`，渲染层 origin 是 `file://`。PROPFIND /
PUT / MKCOL 都是非简单方法，必定触发 CORS 预检，而绝大多数 WebDAV 服务端不返回
`Access-Control-Allow-Origin`——**渲染层直连第三方 WebDAV 在发布形态下不可用**。
存储侧当年就是因为同一原因把扫描搬进了主进程（`packages/desktop/src/ipc/librarySource.ts`）。

所以传输路径是：

```
shared webdav.ts  ──(setWebdavFetch 注入)──▶  app platform.syncFetch
                                                   │
                                    preload `sync.fetch`
                                                   │
                                    IPC `sync:fetch`（主进程）
                                                   │
                                      net.fetch / http(s) 直连
```

- `packages/shared/src/webdav.ts` 加 `setWebdavFetch(fetcher | null)`，内部所有请求走注入，
  默认回落全局 `fetch`——**不改任何导出函数签名**（照 `setSsh2Module` / `setSmb2Module` 的范式）。
  这样同一份插件代码在移动端/测试里仍可直接用全局 fetch。
- 渲染层在 `initPlaylistSync()` 时注入 `platform.syncFetch`，`disposePlaylistSync()` 时还原 `null`。
- 主进程侧 `sync:fetch` 只放行 `http:` / `https:`，不跟随重定向（3xx 原样返回），默认 15 s、
  上限 60 s，响应体上限 8 MB；日志只记 method + host + status + 耗时，**绝不记
  Authorization / Cookie / body / path**。

---

## 7. 局域网链路（`lan-sync`）

### 组件

```
桌面主进程                     渲染层
┌──────────────────────┐   ┌───────────────────────────┐
│ HTTP 服务（本机快照） │←→│ 同步引擎（合并 / 应用 / UI）│
│ UDP 发现（广播）      │   │                           │
│ 配对码 + HMAC 校验    │   └───────────────────────────┘
└──────────────────────┘
```

插件 `lan-sync` 只有三个方法，全部委托给主进程桥（`ctx.lan`）：
`probe`（拿本机服务状态 + 探测对端 `/v1/hello`）、`pull`（签名 GET 对端快照）、
`push`（签名 PUT 本机快照）。**渲染层不持有长期凭证，也不做密码学**——
HMAC 用 `node:crypto`，留在主进程。

### 端点（协议版本 1）

| 方法与路径 | 作用 |
|---|---|
| `GET /v1/hello` | `{ proto, deviceId, deviceName, port }`；**没有匿名放行**——端口对全网点开放，所有路由（含这条）一律先验签 |
| `GET /v1/snapshot` | `{ snapshot }`：本机已发布的那份快照（渲染层 `lan:publish` 推给主进程的缓存）；还没发布过 → 404 `empty` |
| `PUT /v1/snapshot` | 请求体就是快照本体 → 202 `{ accepted, revision }`；进收件箱，渲染层应用后重新 `publish` |

监听 `0.0.0.0:45871`，被占用时顺延（发现包里公布真实端口）。仅 IPv4。

### 鉴权：配对码 + HMAC-SHA256

- 配对码：本机生成 **10 位 Crockford base32**，用 safeStorage 加密落在 `userData`；
  **safeStorage 不可用时只留内存**（每次启动重新生成，不写明文）。
  UI 可复制、可轮换。**不广播、不落日志**。
- 共享密钥 `K = HMAC-SHA256(key = code, data = "aurora-lan-sync/v1")` —— 只取决于配对码，
  与设备、方向、时间无关；**没有长期配对密钥、没有密钥协商状态**，换码即旧 `K` 立即失效。
- 请求签名：`HMAC-SHA256(K, method + "\n" + path + "\n" + ts + "\n" + nonce + "\n" + sha256hex(body))`，
  头：`x-aurora-proto` / `x-aurora-ts` / `x-aurora-nonce` / `x-aurora-sig` / `x-aurora-device`。
  `x-aurora-device` 只用于对端日志，**不参与签名**（它可以被伪造，但不影响鉴权）。
- 校验顺序：协议版本（不符 400 `protocol`）→ 时间窗（±300s）→ 签名（`timingSafeEqual`）→
  nonce 复用。nonce 表 5 分钟 TTL、4096 条上限，**只在验签通过之后才入表**——否则任何人都能
  用伪造请求把表灌满。失败一律 401 + 机器可读 `code`。

**为什么不是 TLS**：局域网自签证书要用户装 CA 或点过浏览器警告，体验与信任模型都更差。
配对码 + HMAC 防的是「同网段的其它设备乱写你的歌单」，**不防**流量分析（快照内容明文可见）。
这个边界写在 UI 的说明里，不假装它是加密信道。

**为什么只配一侧也能用**：`K` 只取决于「对端的配对码 + 双方 deviceId」。
A 填了 B 的地址与配对码就能读写 B；B 端用自己的码校验，通过即接受。

### 发现

UDP 广播 `45872`（`reuseAddr`），每 15s 一次 announce；主动扫描时改发 probe，对端收到 probe
回一份 announce。广播目标 = 各网卡子网广播地址（按 `address | ~netmask` 自算，
Node 的 `os.networkInterfaces()` 不提供 broadcast 字段）+ 恒定兜底 `255.255.255.255`：

```
{"kind":"announce","proto":1,"deviceId":"…","deviceName":"书房台式机","port":45871}
{"kind":"probe","proto":1,"deviceId":"…","deviceName":"…","port":45871}
```

**配对码不进发现包**（否则同网段任何人都能算 `K`）。收到广播 → 60s 内视为在线，
UI 列成「可添加的设备」，点一下就把 `host/port` 预填进配置表单，配对码仍需手输或抄对端屏幕。

### 方向

一次同步 = `GET 对端 → 本地合并应用 → PUT 合并结果给对方`。
对端收到 PUT 后在渲染层异步合并应用，于是**一轮双向收敛**（两端都拿到合并结果）。

配置项 `direction`：`bidirectional` / `pullOnly` / `pushOnly`。
`pullOnly` 适合「只读分享机」，`pushOnly` 适合「备份机」。

---

## 8. 为什么只做桌面端

| 需要的能力 | 桌面 | 移动 | Web |
|---|---|---|---|
| 监听局域网端口 + UDP 广播 | ✅ | ❌ 后台接听不可靠、Doze 会掐 | ❌ |
| safeStorage 存口令/配对码 | ✅ | ⚠️ 有 Keystore 但无 safeStorage 封装 | ❌ |
| 长驻调度（5 分钟定时） | ✅ | ⚠️ 受限 | ❌ |

WebDAV 链路本身在移动端是可行的（`CapacitorHttp` + Basic 认证），但它需要同样的
safeStorage 与调度支撑才能安全落地；移动端当前连「选本地文件」都没有，歌单数据面也不完整。
**所以 v1 的入口判定统一用 `platform.supportsPlaylistSync === true`（仅桌面端），
不按插件 `available()` 分散判断**——一处判定，两端一致，避免出现「插件显示可用但点了没反应」。

---

## 9. 触发与调度

| 时机 | 说明 |
|---|---|
| 启动后 10s | 避开启动高峰（与曲库扫描抢 IO 会拖慢首屏） |
| 本地歌单变更后 20s | 防抖；只对 `autoSync` 打开的配置生效 |
| 每 5 分钟 | 定时；`visibilitychange` 隐藏时跳过桌面端不需要的轮询 |
| 手动「立即同步」 | 不受 `autoSync` 限制 |

**串行**：同一配置的运行带互斥锁（`running: Set<configId>`），手动与定时撞车时后者直接跳过
（不排队——排队会让「卡住的同步」变成雪崩）。
**退避**：失败后 1 / 2 / 5 分钟（上限 5 分钟），直到成功或用户手动重试。

`lastSyncAt` / `lastError` 写进配置，重启后 UI 仍能显示上次结果。

---

## 10. 凭证

- `kind: 'password'` 的字段值**不进** `syncStore` 持久化；提交时由渲染层剥出，
  经 IPC 交主进程 `safeStorage`，按 **`configId`** 存（不是 `pluginId`：
  同一个插件可以配多个目标，每个目标不同口令）。
- 运行时由引擎通过 `platform.syncGetSecrets(configId)` 取回明文，塞进
  `ctx.secrets`（只在内存里活一次调用）。主进程不可用时（移动端/Web）返回空，
  插件因缺口令而报认证错误——错误信息指向「这台设备不支持保存密码」，不是静默失败。

---

## 11. 目录与出口

```
packages/shared/src/plugin/sync/
  types.ts              契约（SyncPlugin / SyncFieldDef / SyncSnapshot / SyncTrackRef / SyncConfig）
  registry.ts           注册表 + 能力派生 + 纯数据投影
  snapshot.ts           本机状态 → 快照；快照解析与版本校验
  trackRef.ts           曲目引用 ↔ 本机曲目（解析优先级见 §4）
  merge.ts              合并（§5）
  webdavSyncPlugin.ts   WebDAV 链路
  lanSyncPlugin.ts      局域网链路（委托 ctx.lan）
  index.ts              出口：注册两个内置同步插件（模块求值时，包在 isolatePluginStep 里）
  __tests__/*.test.ts
```

出口只在 `packages/shared/src/index.ts` 里加一行再导出（`export * from './plugin/sync'`），
其余层一律从 `@aurora/shared` 取，不从深路径取。

---

## 12. 测试与门禁

| 层 | 覆盖 |
|---|---|
| `merge.test.ts` | 幂等、交换律、墓碑、时间并列、三方收敛、`changed` 标志 |
| `trackRef.test.ts` | 五种解析路径、路径归一化（Windows 反斜杠）、占位回落 |
| `snapshot.test.ts` | 版本/格式校验拒绝、坏 JSON 不抛到调用点 |
| `webdavSyncPlugin.test.ts` | 列举→合并、404 视为空、401 映射、PUT 失败映射（用 stub fetch） |
| desktop `lanAuth.test.ts` | 签名正确/篡改/过期/重放、密钥派生对称性、发现包解析 |
| app `playlistSync.service.test.ts` | 引擎应用快照：本地匹配、占位登记、删除、`changed=false` 不写 store |

门禁：

```bash
pnpm --filter @aurora/shared test && pnpm --filter @aurora/shared typecheck
pnpm --filter @aurora/desktop test && pnpm --filter @aurora/desktop typecheck
pnpm --filter @aurora/app test && pnpm --filter @aurora/app typecheck
pnpm verify:i18n
```

打包验证走 `pnpm --filter @aurora/desktop build:dir`（直接 `electron-builder` 会跳过 `app-dist` 复制）。

---

## 13. 隐私

快照里含：歌单名、曲名/歌手/专辑/时长、**本机绝对路径**（可能含用户名）。

- 文件只写进**用户自己的** WebDAV 目录，或只在**配对过**的设备间传输；
- 不传播放统计、喜欢、音源凭证、任何音频内容；
- UI 的同步面板明示这一点（`sync.panel.privacyNote`）；
- 局域网快照是**明文**（见 §7 的信任边界），不宣称加密。

---

## 14. 未做（明确的下一步）

- 喜欢列表 / 播放统计 / 最近播放的同步（数据模型不同，需要单独定冲突语义）
- 移动端（需要 safeStorage 封装与后台调度，先做 WebDAV 单向拉取更现实）
- A 档声明式同步插件（JSON 描述「GET/PUT 一个端点」的极简场景，如自建 HTTP 服务）
- 实时推送（SSE / WebSocket）：当前靠定时 + 变更防抖，延迟上限 5 分钟
- 歌单封面同步（当前歌单没有封面字段）

---

## 15. 实现契约（模块、导出与通道）

本节是给实现者的**唯一接口定义**：谁写哪个文件、导出什么签名、走哪些 IPC 通道。
改动接口先改这里，再看代码。

### 15.1 目录与归属

```
packages/shared/src/plugin/sync/           # T1
  types.ts           契约（已完成，勿改语义）
  registry.ts        插件注册表 + 局域网桥注入
  snapshot.ts        快照构造 / 解析 / 校验 / 墓碑清理
  trackRef.ts        曲目引用 ↔ 本机曲目
  merge.ts           合并（LWW + 墓碑）
  canonical.ts       歌单/曲目引用的规范化内容串（合并并列裁决与内容哈希共用）
  webdavSyncPlugin.ts
  lanSyncPlugin.ts
  index.ts           模块求值期注册（isolatePluginStep）
  __tests__/{merge,trackRef,snapshot,webdavSyncPlugin}.test.ts
packages/shared/src/webdav.ts              # T1 追加：ensureWebdavDir / readWebdavText / writeWebdavText

packages/desktop/src/ipc/                  # T2
  lanSyncAuth.ts     配对码 → 密钥派生、HMAC 签名/校验、nonce 去重
  lanSyncServer.ts   http server：/v1/hello、/v1/snapshot（GET/PUT）
  lanSyncDiscovery.ts UDP 45872 广播与收包
  lanSync.ts         IPC 注册 + deviceId 持久化 + 快照缓存 + 收件箱
  syncCredentials.ts sync 配置口令（照 storageCredentials.ts）
  __tests__/lanAuth.test.ts
packages/desktop/{preload.ts,ipc/handlers.ts,src/main.ts}

packages/app/src/                          # T3
  services/playlistSync.service.ts   引擎（快照构造、编排、锁、调度、状态写回）
  stores/syncStore.ts                配置 + 运行态（zustand persist）
  components/plugin/syncConfigCards.tsx
  components/plugin/PlaylistSyncPanel.tsx
  components/plugin/PluginSettingsDialog.tsx   （加 'sync' 分区）
  components/common/{pluginConfig.ts,pluginManage.ts}
  services/platform/{index.ts,web.ts,mobile/index.ts}
  stores/playlistStore.ts            （墓碑字段 + applySyncedPlaylists）
  App.tsx                            （initPlaylistSync 一次）
```

### 15.2 shared 导出（`@aurora/shared` 根出口已再导出）

```ts
// registry.ts
export function registerSyncPlugin(plugin: SyncPlugin): void        // 非法 id / fields 非数组 → throw
export function unregisterSyncPlugin(id: string): void
export function getSyncPlugin(id: string): SyncPlugin | undefined
export function listSyncPlugins(): SyncPlugin[]
export interface SyncPluginMeta {           // 纯数据，可过 IPC
  id: string; displayNameKey: MessageKey; descriptionKey?: MessageKey; version: string
  fields: readonly SyncFieldDef[]; capabilities: readonly SyncCapability[]
  available: boolean; enabled: boolean
}
export function listSyncPluginMeta(): SyncPluginMeta[]
export function setLanSyncBridge(bridge: LanSyncBridge | null): void
export function getLanSyncBridge(): LanSyncBridge | null   // 仅 available() 判定用
export const SYNC_PLUGIN_ID_RE: RegExp

// snapshot.ts
export const SYNC_TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000
export function serializeSnapshot(snapshot: SyncSnapshot): string
export function parseSnapshot(text: string, file?: string): SyncSnapshot   // 失败 throw auroraError('sync.error.snapshotInvalid' / 'snapshotVersion')
export function isSnapshotOfDevice(snapshot: SyncSnapshot, deviceId: string): boolean
export function pruneSnapshot(snapshot: SyncSnapshot, now?: number): SyncSnapshot
export function snapshotContentHash(snapshot: SyncSnapshot): string   // 跨设备可比的「歌单内容」哈希

// trackRef.ts
export interface SyncMatchTrack { id: string; title: string; artist: string; duration: number; path: string; sourceId?: string }
export interface SyncMatchIndex { /* 由 buildMatchIndex 产出，结构自定 */ }
export function buildMatchIndex(tracks: readonly SyncMatchTrack[], opts?: { online?: ReadonlyMap<string, string> }): SyncMatchIndex
export function toSyncTrackRef(track: SyncMatchTrack, storagePluginIdOf?: (sourceId: string) => string | undefined): SyncTrackRef
export function resolveSyncTrackRef(ref: SyncTrackRef, index: SyncMatchIndex): string | null

// merge.ts
export interface MergeOutcome { snapshot: SyncSnapshot; changed: boolean; added: number; updated: number; removed: number }
export function mergeSnapshots(local: SyncSnapshot, remotes: readonly SyncSnapshot[], now?: number): MergeOutcome
```

`mergeSnapshots` 的硬要求（测试会逐条验）：幂等（`merge(merge(a,b),b) === merge(a,b)`）、
交换律（歌单集合与各歌单成败一致）、结合律、并列时按**歌单内容的规范化串**字典序裁决
（不含 `deviceId`，故结合律成立；见 `packages/shared/src/plugin/sync/merge.ts`）、
墓碑在 TTL 内保留并参与合并、超 TTL 丢弃、`changed` 只反映「相对 `local` 是否真有变化」。
`snapshotContentHash` 是给引擎判「这份内容上次是不是已经推过」用的：排除 `deviceId`/
`revision`/快照级 `updatedAt`，歌单按 `id` 排序后取内容串哈希，用于打断局域网互推环。
仍是「硬要求」的代数性质里，`mergeSnapshots` 的并列裁决**只取决于歌单内容**——即
`(a∘b)∘c ≡ a∘(b∘c)`，与合并顺序、与记录来自哪台设备都无关。

**入参前提**：`mergeSnapshots` 假定两份快照**都已经过 `parseSnapshot` 归一化**，自身不做二次结构校验（否则每轮合并都要重跑一遍校验，代价与收益倒挂）。边界就是 `parseSnapshot`：WebDAV 侧 `pull` 解析文件、局域网侧 PUT/`lan:pull`/`lan:publish` 全部先过它，坏结构在那一步就被拦成 `sync.error.snapshotInvalid`。

`toSyncTrackRef` 的判据：`path` 为空 → `meta`；`path` 命中 `webdav:|web:` 前缀且能解析出
`sourceId` 与相对路径 → `storage`；其余非空路径 → `local`。`onlineId`/`platform` 三态都可带。

### 15.3 主进程 IPC 通道（T2 实现，T3 消费）

| 通道 | 入参 | 返回 |
|---|---|---|
| `sync:device` | — | `{ deviceId: string; deviceName: string }` |
| `sync:credential:save` | `configId, payload: Record<string,string>` | `{ saved: boolean; encryptionAvailable: boolean }` |
| `sync:credential:state` | `configId` | 同 `storageCredentialState` 的形状 |
| `sync:credential:clear` | `configId` | `void` |
| `sync:credential:get` | `configId` | `SyncSecrets \| null` |
| `lan:status` | — | `LanSyncStatus` |
| `lan:setEnabled` | `enabled` | `LanSyncStatus` |
| `lan:rotateCode` | — | `LanSyncStatus` |
| `lan:discover` | `timeoutMs?` | `LanPeerInfo[]` |
| `lan:publish` | `snapshot` | `void`（主进程缓存，供 `GET /v1/snapshot`） |
| `lan:pull` | `LanSyncTarget` | `SyncSnapshot[]` |
| `lan:push` | `LanSyncTarget, snapshot` | `void` |
| `lan:takeInbox` | — | `SyncSnapshot[]`（取走即清空） |
| `lan:inbox`（下行事件） | — | `SyncSnapshot[]` |
| `sync:fetch` | `{ url, method?, headers?, body?, timeoutMs? }` | `{ status, statusText, headers, bodyText }` |

preload 暴露为两个**顶层**对象（`preloadApi.test.ts` 只认两空格缩进的顶层键）：

```ts
sync:    { device, saveCredential, credentialState, clearCredential, getCredential, fetch }
lanSync: { status, setEnabled, rotateCode, discover, publish, pull, push, takeInbox, onInbox }
```

`onInbox(cb)` 返回退订函数（与既有事件订阅同形）。

**`sync:fetch` 为什么要存在**：打包后的渲染层 origin 是 `file://`，直连第三方 WebDAV 会被 CORS 预检拦死（§6「传输为什么必须过主进程」）。所以 WebDAV 的全部请求都由主进程代发：只放行 `http:`/`https:`，拒绝 URL 内嵌凭据与 CRLF 头注入，`redirect: 'manual'`（3xx 原样返回、不跟随），默认 15 s、上限 60 s，响应体上限 8 MB；日志只记 method + host + status + 耗时，绝不记 `Authorization`/`Cookie`/body/path。失败沿用项目既有信封 `auroraError`（`message = 'AURORA_ERR:{code,params,detail}'`），渲染层用 `parseErrorInfo(stripIpcPrefix(err.message))` 还原 `code`。

**口令为什么要过一遍 IPC 到渲染层**：同步插件跑在渲染层（合并与歌单数据都在那边），
`ctx.secrets` 只能由引擎放进内存。约束：只在一次 `pull/push` 期间持有、不进 zustand persist、
不进日志、不打进 `lastError`。这比 storage 的 `withStorageSecrets`（主进程内注入）弱一档，
但比 `webdav.ts` 把口令存 localStorage 强一档；要再收紧得把 WebDAV 同步整体搬进主进程，
那是下一轮的事（记在 §14）。

**局域网鉴权**（`lanSyncAuth.ts`）：

- 配对码 = 10 位 Crockford base32（`23456789ABCDEFGHJKLMNPQRSTUVWXYZ`），排除易混字符；
- 派生：`key = HMAC-SHA256(code, 'aurora-lan-sync/v1')`。**没有**长期配对密钥：
  配对码就是唯一凭据，每次请求现派生；换码即旧凭据立即失效，不必维护密钥协商状态；
- 每个请求头：`x-aurora-device`、`x-aurora-proto`、`x-aurora-ts`、`x-aurora-nonce`、
  `x-aurora-sig = HMAC-SHA256(key, `${method}\n${path}\n${ts}\n${nonce}\n${sha256(body)}`)`；
- 校验：`|now - ts| <= 300_000`、nonce 在 5 分钟内未见过、常量时间比较；
- 失败一律 **401 + 机器可读的 `code` 字段**（`auth` / `protocol`），渲染层映射成 `sync.error.lanAuth`
  / `sync.error.lanProtocol`；路由层的其余状态码：`400 protocol`（版本头不符/请求体读不出）、
  `400 snapshot`（PUT 的快照结构非法）、`403 disabled`、`404 empty` / `notFound`、`405 method`、
  `413 tooLarge`（>5MB）、`500 internal`；
- 配对码与 key **绝不进**日志、广播包、`lastError`；`LanSyncStatus.code` 只给 UI。

端口：HTTP `45871`（占用则 +1 顺延，最多 20 次），UDP 发现固定 `45872`。
发现包是明文 JSON（`{ kind, proto, deviceId, deviceName, port }`），**只广播存在性，不带 key**。

### 15.4 引擎（T3）的编排

```
syncOnce(config) →
  secrets = platform.sync.getCredential(config.id)
  ctx = { fetch, secrets, device, log, lan: getLanSyncBridge() ?? undefined }
  remote = config.direction === 'pushOnly' ? [] : await plugin.pull?.(config, ctx)
  local  = snapshotFromStores(device)                 // 由 playlistStore + importedTracks 构造
  outcome = mergeSnapshots(local, remote.filter(r => !isSnapshotOfDevice(r, device.deviceId)))
  if (outcome.changed) applySyncedPlaylists(outcome.snapshot)   // 写回 playlistStore
  if (config.direction !== 'pullOnly') await plugin.push?.(config, outcome.snapshot, ctx)
  if (lan) await lan.publish(outcome.snapshot)
```

- 串行锁：同一 config 同时只跑一次；不同 config 可并行但每个 `await` 点之间不交错写 store。
- 触发：启动后 3s、歌单 store 变更后 2s 防抖、每 5 分钟一次、局域网收件箱事件到达时。
- 失败：`lastError = encodeErrorInfo(...)`，退避 30s→2min→10min，成功后清空。
- `applySyncedPlaylists(snapshot)`：只增改删 playlists（按 tombstone），**不碰**
  `playCount/liked/lastPlayedAt`；未解析出本机曲目的引用登记为占位 `importedTracks`
  （`id = 'sync:' + hash(ref)`，`path: ''`），解析出的一律用**本机 trackId**。

