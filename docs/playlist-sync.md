# 歌单同步（插件域 `sync`）

> 目标：在**多台桌面设备**之间同步歌单（名称、顺序、成员）与收藏（每首歌的收藏/取消状态），
> 支持两条链路——用户自己的 Web 网络存储（任意 WebDAV），以及局域网内直连自动同步。
>
> 本文只写**当前实现**的事实与理由。做完的、没做的、为什么这么做，都在这里。

---

## 1. 范围

同步的内容：

- **歌单**：`name`、创建/更新时间、曲目顺序（`trackIds` 的**顺序是有意义的**）
- **收藏**：每首歌的「收藏 / 取消」状态及其动作时刻（§5.1）
- **曲目元数据**：曲名 / 歌手 / 专辑 / 时长，以及「本机文件在哪」或「在线曲目是谁」

不同步的内容：播放次数、最近播放、播放队列、当前选中歌单、音源凭证。

> 「收藏」在侧栏里位于**歌单分组的第一位**，但它不是 `playlistStore` 里的 `Playlist` 记录：
> 没有 `updatedAt`、不能改名/删除，路由仍是 `/liked`。它是「系统歌单」——在结构上站在歌单组里，
> 在同步上却是另一套冲突单元（集合 of 每首歌，而不是一条有序记录），见 §5.1。

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
  ],
  "likes": [                     // 可选；缺字段 = 对方版本不认识收藏同步（不是「收藏为空」）
    {
      "id": "…",                 // 跨设备歌曲身份（歌名+歌手+整秒时长），同时是合并键
      "likedAt": 1762400000123,  // 收藏时刻
      "removedAt": null,         // 取消时刻（墓碑）：> likedAt 表示当前不收藏
      "ref": { /* SyncTrackRef，定位口径与歌单成员相同 */ }
    }
  ]
}
```

**为什么 `likes` 是可选字段而不是新格式号**：格式号一改，对方那份旧文件会被整份拒绝
（`sync.error.snapshotVersion`），升级期间连歌单一起停摆。`likes` 缺失只表示「这份快照
没有收藏意见」，合并时按空集处理，不会删掉任何本机记录；两端的写法都能被对方读懂。

**为什么全量**：几十个歌单、几千条曲目引用，序列化后几十 KB 量级；增量同步要为
「顺位 / 补偿 / 乱序到达」再写一套状态机，收益为零而失败模式多一倍。
收藏会再叠一层：每条记录约 200–300 字节，几千首收藏约 1 MB 以内——仍在局域网
`PUT /v1/snapshot` 的 5 MB 上限之内，所以不为它单独设计增量通道。

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

### 5.1 收藏：每条记录一首歌，逐条 LWW

歌单的冲突单元是「整条歌单」，收藏的冲突单元是「每首歌」——共用一个集合级的 LWW 会整片丢数据：

| 场景 | 整条集合 LWW | 逐条 LWW（当前实现） |
|---|---|---|
| 手机连点 20 首，电脑点了 3 首 | 以较晚的整份集合为准，另一侧整片消失 | 23 首都在 |
| A 取消 X，B 收藏 Y | 一侧全部作废 | X 被取消、Y 被收藏 |
| 同一首歌两端一收一取 | 看整份集合的时间 | 看**这首歌**谁的动作更晚 |

**记录形状**（`SyncedLike`）：`{ id, likedAt, removedAt?, ref }`——与歌单记录同构
（稳定 id + 时刻 + 墓碑 + `SyncTrackRef`），只是成员只有一个。

- `id` = 跨设备歌曲身份：`likeKeyOf(ref)` = 归一化「歌名 + 歌手 + 四舍五入到整秒的时长」，
  三者**严格相等**才算同一首。时长取整秒是因为本地是完整解析、远端媒体库是头部概算
  （§4 的同一理由）。
  它**不是**展示去重（`dedupeTracksForDisplay`）的口径：展示去重先按「歌名 + 歌手」分桶，
  再与桶内代表值比时长做 **±1s 容差聚类**（`DURATION_MATCH_TOLERANCE`，容差不传递：
  A≈B、B≈C 推不出 A≈C）。两者共用同一套归一化与同样三个字段，差别只在时长判据——
  合并键必须是稳定、可逆的等价关系，容差聚类给不出这样的键。
  已知代价：同一首歌的两个副本时长相差 ≤1s 但取整后落在相邻两秒时，展示去重会合成 1 行、
  同步却保留 2 条记录（两条都指向这一行）。三副本以上两组甚至可能**交叉分组**（展示并
  {100.0,100.5}、同步并 {100.5,101.4}）——判据不同，不存在「谁比谁粗」的定论。
  这些记录若解析到同一首本机曲目而状态相左，
  可见状态由 `applySyncedLikes` 按记录 id 顺序逐条 `setLiked` 决定（**后者覆盖前者**），
  不保证等于用户最后一次点击——这是逐条 LWW 与展示去重判据不同带来的已知边界。
  不含 `kind` / 路径 / `sourceId` / `onlineId`：前三个设备相关，`onlineId` 只在一侧存在。
- `likedAt` / `removedAt`：最近一次动作的真实时刻，**取大者**参与裁决（`likeActionAt`）。
- 同一毫秒的「收藏 vs 取消」判为取消（`likeIsActive` 的并列口径，宁可少显示一首，
  也不让已取消的收藏在两端反复复活）。
- 取消的墓碑保留 90 天（与歌单同一 `SYNC_TOMBSTONE_TTL_MS`），过期后不再压制重新收藏。

**记录落在哪**：`libraryStore.likeRecords`（按 `id` 键，随 persist 落 localStorage）。
`likedTracks` 仍是「现在收藏了哪些」的真相源，`likeRecords` 只补「什么时候、怎么找回这首歌」。
没有它就比不出「谁更晚」——重启后所有收藏都变成「时刻未知」（`likedAt: 0`）。

**采集快照时的三路来料**（`collectSnapshotLikes`）：

1. 当前收藏着的本机曲目：有记录就沿用记录里的引用与时刻（合并已裁决过，每轮重算会让两端
   对同一首歌给出不同引用、内容哈希每轮都"变了"）；历史收藏没有记录 → `likedAt: 0`。
2. 取消收藏的墓碑（TTL 内）：带上才能压住对端那份更旧的收藏。
3. 曲目已不在本机的已收藏记录：照样带出去——删掉本地文件不等于不喜欢，对端还有这份文件。

**落盘**（`applySyncedLikes`）：整体采用合并结果（不是增量，否则第二轮仍判"变了"）；
找不到本机曲目的引用**只留记录、不造占位曲目**（收藏页只展示曲库里的歌，占位曲目在那儿
看不见，还会污染歌单的占位登记）；真正的写入走 `setLiked`（幂等 set）而不是 `toggleLiked`
——后者会以「现在」记一次动作，时间戳被单方面推进，两端永远收敛不了。

**已知道的边界**：曲目被改名/重打标签后内容身份变了，会被当成另一首歌；旧身份的收藏记录
会在本机留一条不再被采纳的记录（不影响播放与展示，也不会每轮重推）。这是「跨设备身份只能
靠内容」的固有代价——与展示去重同前提、但判据不同（见上）。

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

## 8. 哪些端支持

| 需要的能力 | 桌面 | Android | Web |
|---|---|---|---|
| 监听局域网端口 + UDP 广播 | ✅ 主进程 `node:http`/`node:dgram` | ✅ 原生 `ServerSocket`/`DatagramSocket` + `dataSync` 前台服务 | ❌ |
| 存口令/配对码 | ✅ `safeStorage` | ✅ Keystore（`SecureStorage` + 原生凭证文件） | ❌ |
| WebDAV 代发 HTTP（绕 CORS） | ✅ 主进程 `sync:fetch` | ✅ `NativeHttp`（OkHttp，支持 PROPFIND） | ❌ |
| 长驻调度（5 分钟定时 + 变更防抖） | ✅ | ✅（进程存活期间；由前台服务延长） | ❌ |

入口判定仍只有一条：`platform.supportsPlaylistSync === true`（桌面端与 Android 为 true，
Web 与未知环境为 false），**不按插件 `available()` 分散判断**——一处判定，避免出现
「插件显示可用但点了没反应」。Android 的实现与可靠性说明见 §17。

移动端两条链路（WebDAV / 局域网）都可用：WebDAV 不需要监听端口，局域网需要前台服务兜住监听
（Doze 与厂商省电策略仍可能掐掉，见 §17 的遗留风险）。

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
| `likes.test.ts` | 收藏逐条裁决（两端各收藏不同歌都保留）、并列判取消、墓碑 TTL、缺 `likes` 的旧快照、身份判据、内容哈希 |
| `trackRef.test.ts` | 五种解析路径、路径归一化（Windows 反斜杠）、占位回落 |
| `snapshot.test.ts` | 版本/格式校验拒绝、坏 JSON 不抛到调用点 |
| `webdavSyncPlugin.test.ts` | 列举→合并、404 视为空、401 映射、PUT 失败映射（用 stub fetch） |
| desktop `lanAuth.test.ts` | 签名正确/篡改/过期/重放、密钥派生对称性、发现包解析 |
| app `playlistSync.service.test.ts` | 引擎应用快照：本地匹配、占位登记、删除、`changed=false` 不写 store |
| desktop `lanPair.test.ts` | 配对金标（ECDH/GCM/AAD 可复现）、端到端 A↔B（允许/拒绝/取消/self/busy）、`adoptPairedCode` 落到 configId 后能被凭证读回 |
| app `playlistSync.pair.test.ts` | 配对后的编排：先落码再入 store、两端对称建配置、失败原因透传、码没落住不留无凭据配置 |

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

快照里含：歌单名、曲名/歌手/专辑/时长、**本机绝对路径**（可能含用户名）、
收藏的**动作时刻**（不是播放统计）。

- 文件只写进**用户自己的** WebDAV 目录，或只在**配对过**的设备间传输；
- 不传播放次数 / 最近播放 / 收藏以外的任何行为统计；收藏只传「哪首歌 + 收藏或取消的时刻」；
- 不传音源凭证、任何音频内容；
- UI 的同步面板明示这一点（`sync.panel.privacyNote`）；
- 局域网快照是**明文**（见 §7 的信任边界），不宣称加密。

---

## 14. 未做（明确的下一步）

- 播放统计 / 最近播放的同步（数据模型不同，需要单独定冲突语义；收藏已按「每条一首歌」落地，见 §5.1）
- 移动端的真机回归（协议已用金标与桌面端逐字节对齐，UDP 广播 / `MulticastLock` /
  Keystore 落盘 / 前台服务生命周期仍需真机 A↔B 验证）
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
  __tests__/{merge,likes,trackRef,snapshot,webdavSyncPlugin}.test.ts
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
export function snapshotContentHash(snapshot: SyncSnapshot): string   // 跨设备可比的「歌单 + 收藏内容」哈希

// canonical.ts（收藏身份与合并键；app 侧写本地记录时用同一口径）
export function likeKeyOf(ref: SyncTrackRef): string        // 跨设备歌曲身份（歌名+歌手+整秒时长）
export function canonicalLike(like: SyncedLike): string     // 收藏记录的规范化内容串

// snapshot.ts（收藏的墓碑与时刻口径，合并与清理共用，避免两处各判一套）
export function likeActionAt(like: SyncedLike): number              // 最近一次动作时刻 = max(likedAt, removedAt)
export function likeIsActive(like: SyncedLike): boolean             // 并列判为未收藏
export function isLikeTombstoneExpired(like: SyncedLike, now?: number): boolean

// trackRef.ts
export interface SyncMatchTrack { id: string; title: string; artist: string; duration: number; path: string; sourceId?: string }
export interface SyncMatchIndex { /* 由 buildMatchIndex 产出，结构自定 */ }
export function buildMatchIndex(tracks: readonly SyncMatchTrack[], opts?: { online?: ReadonlyMap<string, string> }): SyncMatchIndex
export function toSyncTrackRef(track: SyncMatchTrack, storagePluginIdOf?: (sourceId: string) => string | undefined): SyncTrackRef
export function resolveSyncTrackRef(ref: SyncTrackRef, index: SyncMatchIndex): string | null

// merge.ts
export interface MergeOutcome {
  snapshot: SyncSnapshot; changed: boolean
  added: number; updated: number; removed: number
  likesAdded: number; likesRemoved: number   // 只算可见状态变化，不含纯时间戳采纳
}
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
| `lan:pairStart` | `LanPairPeer` | `LanPairStartResult`（长轮询，最长 `LAN_PAIR_TTL_MS`） |
| `lan:pairRespond` | `pairId, accept: boolean` | `{ accepted: boolean }` |
| `lan:pairCancel` | `pairId?: string` | `void` |
| `lan:adoptPaired` | `configId, deviceId` | `boolean`（码是否落到该配置名下） |
| `lan:pairRequest`（下行事件） | — | `LanPairRequest` |
| `lan:paired`（下行事件） | — | `LanPairPeer` |
| `sync:fetch` | `{ url, method?, headers?, body?, timeoutMs? }` | `{ status, statusText, headers, bodyText }` |

preload 暴露为两个**顶层**对象（`preloadApi.test.ts` 只认两空格缩进的顶层键）：

```ts
sync:    { device, saveCredential, credentialState, clearCredential, getCredential, fetch }
lanSync: {
  status, setEnabled, rotateCode, discover, publish, pull, push, takeInbox,
  pairStart, pairRespond, pairCancel, adoptPairedCode,
  onInbox, onPairRequest, onPaired,
}
```

全部事件订阅都返回退订函数（与既有事件同形）。配对相关的通道语义见 §16.6。

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
  device = await ensureDevice()                       // 设备身份先就位：ctx 与快照都要它
  secrets = platform.sync.getCredential(config.id)
  ctx = { fetch, secrets, device, log, lan: getLanSyncBridge() ?? undefined }
  remote = config.direction === 'pushOnly' || !plugin.pull ? [] : await plugin.pull(config, ctx)
  local  = snapshotFromStores(device)                 // 由 playlistStore + importedTracks 构造
  outcome = mergeSnapshots(local, remote.filter(r => !isSnapshotOfDevice(r, device.deviceId)))
  if (outcome.changed) {                                      // 两个 store 各写各的
    applySyncedPlaylists(outcome.snapshot)                    // → playlistStore
    applySyncedLikes(outcome.snapshot)                        // → libraryStore.likeRecords
  }
  // 不动点：内容没变就不写对端，否则两台设备会以「一次 HTTP 往返」为周期无限互推
  contentHash = snapshotContentHash(outcome.snapshot)
  shouldWrite = outcome.changed || lastPushedHash(config.id) !== contentHash
  wrotePeer = false
  if (shouldWrite && config.direction !== 'pullOnly' && plugin.push) {
    await plugin.push(config, outcome.snapshot, ctx); wrotePeer = true
  }
  // 服务没开时不 publish 是常态，失败吞掉，不让整轮同步因此算失败
  if (shouldWrite && lan) { await lan.publish(outcome.snapshot).catch(() => {}); wrotePeer = true }
  if (wrotePeer) markPushed(config.id, contentHash)
```

- 串行锁：同一 config 同时只跑一次；不同 config 可并行但每个 `await` 点之间不交错写 store。
- **`lan:inbox` 走同一套合并与落盘**：合并结果当场写**两个** store（歌单 + 收藏），再按内容
  哈希决定是否回推、按冷却触发一轮同步。收藏不能留给收件箱触发的那轮 `syncOnce` 去补：
  配置未开 `autoSync`、方向是 `pushOnly`、或插件 `pull` 不可用时那轮根本不会跑，
  对端推来的收藏就永远不落盘，而回推出去的却是「含收藏」的内容。
- 触发：启动后 3s、歌单 store 变更后 2s 防抖、每 5 分钟一次、局域网收件箱事件到达时。
- 失败：`lastError = encodeErrorInfo(...)`，退避 30s→2min→10min，成功后清空。
- `applySyncedPlaylists(snapshot)`：只增改删 playlists（按 tombstone），**不碰**
  `playCount/liked/lastPlayedAt`；未解析出本机曲目的引用登记为占位 `importedTracks`
  （`id = 'sync:' + hash(ref)`，`path: ''`），解析出的一律用**本机 trackId**。
- `applySyncedLikes(snapshot)`：只改收藏（与上一条互不牵连，见 §5.1）。记录整体采用合并结果，
  已解析出本机曲目的按 `likeIsActive` 调 `setLiked`，解析不出的只留记录不造占位曲目。


## 16. 一键配对（协议 `pair/v1`，免手抄配对码）

发现到设备后点「配对」，对端弹一次确认框点「允许」，两端各自建一条**双向**同步目标。
配对码全程不进用户手也**不进明文网络**：双方用临时 ECDH 交换出共享密钥，把各自的码
AES-GCM 封好再互相递过去。

### 16.1 信任边界

- **接收方的用户确认是唯一的授权闸门**：没有确认，任何设备都拿不到本机配对码；
  确认弹窗里显示的是发起方自报的设备名（与广播包同一字段，可伪造，但不构成授权）。
- 未认证路由只有两条：`POST /v1/pair/request` 与 `GET /v1/pair/status`；其余
  （含 `/v1/pair/reply`、`/v1/hello`、`/v1/snapshot`）一律走 §7 的 HMAC 签名。
- 同网段的**旁听者**拿不到任何一把码（AEAD 封的是密文）。主动 MITM 不在威胁模型内，
  与 §7 一致：局域网快照本身是明文，配对只解决「谁有权写歌单」，不宣称建立加密信道。
- 配对码、共享密钥、私钥**绝不进日志**：日志只出现 deviceId 前 8 位与 pairId 前 8 位。

### 16.2 端点

| 方法 | 路径 | 认证 | 请求体 | 响应 |
|---|---|---|---|---|
| POST | `/v1/pair/request` | 无 | `{v:1, pairId, deviceId, deviceName, port, pub}` | 202 `{state:'pending'}` / 409 `{code:'busy'}` / 403 `{code:'disabled'}` / 400 `{code:'invalid'\|'self'}` |
| GET | `/v1/pair/status?pairId=<32hex>` | 无 | — | 200 `{state:'pending'}`、`{state:'accepted', deviceId, deviceName, port, pub, sealed}`、`{state:'denied'}` / 404 `{code:'unknown'}` |
| POST | `/v1/pair/reply?pairId=<32hex>` | **HMAC**（密钥 = 对端这次给出的配对码） | `{v:1, pairId, sealed}` | 200 `{state:'done'}` / 401 `{code:'auth'}` / 404 `{code:'unknown'}` / 409 `{code:'state'}` |

状态码的补充说明（都比「500」更能说清发生了什么，客户端据此归类失败原因）：
- `request` 的 400：body/公钥/端口不合法 → `invalid`；`deviceId` 等于本机 → `self`；
- `reply` 的 409 `state`：签名对，但这条配对还没被用户确认（`pending`）或已被拒绝 ——
  没有用户点过「允许」就递回执，不该被当成「认证通过」；
- 已 `done` 的 pairId：`status` 仍回 `accepted` 那份（只有发起方私钥解得开），`reply` 回 200，
  两者都幂等（发起方在回执丢了之后会重试）；
- 服务关闭时三条配对路由都回 403 `disabled`（与 §7 的其它路由同一道闸）。

`pub` = 非压缩 P-256 点（65 字节）base64；`sealed` 见 16.3。`port` 是发起方本机 HTTP 服务端口
（应答方据此回连；地址一律取 TCP 源地址，不信 body 里自报的 host）。
`pairId` = 16 字节随机 hex（32 字符），既是幂等键也是 AEAD 的 AAD。

### 16.3 密码学

```
shared = ECDH(P-256, privLocal, pubPeer)          // 32 字节 X 坐标
K      = HMAC-SHA256(key = shared, data = "aurora-lan-sync/pair/v1")
sealed = base64(nonce(12) || AES-256-GCM(K, iv = nonce, aad = pairId, plaintext = <配对码>))
```

- 明文就是 §7 那个 10 位 Crockford base32 码本身，不做二次编码。
- `K` 只用于这一次配对；两边各自封自己那把码（`sealed` 分别来自 A 与 B，互不通用）。
- 实现必须逐字节一致，否则两端互相解不开：Node 用 `crypto.createECDH('prime256v1')` +
  `createCipheriv('aes-256-gcm')`；Android 用 `KeyPairGenerator("EC")` + `KeyAgreement("ECDH")` +
  `Cipher("AES/GCM/NoPadding")`。

### 16.4 时序

```
A（发起方）                                        B（应答方）
用户点「配对」
 ① 生成 pairId / ECDH 密钥对
 ② POST /v1/pair/request ───────────────────────▶ 存 pending（TTL 120s）
                                                  推渲染层事件 ──▶ 弹「允许/拒绝」
   每 1s GET /v1/pair/status?pairId=… ──────────▶
 ⑤ 拿到 {accepted, pub, sealed}
   解出 B 的配对码（留在主进程）
 ⑥ 带 B 的码签名 POST /v1/pair/reply ───────────▶ 解密得到 A 的配对码
                                                   建配置 + adoptPairedCode()
                                                  推「已配对」事件 ──▶ 建配置 + adopt
 ⑦ 200 {done} → 建配置 + adoptPairedCode()
```

- 渲染层只做三件事：`pairStart(peer)`、`pairRespond(pairId, accept)`、
  在「已配对」后建一条 `direction: 'bidirectional'` 的配置并调 `adoptPairedCode(configId, deviceId)`。
  码永远不经过渲染层（与 §10 的凭证纪律一致）。
- 两端都建配置：单向建一份只能保证一轮双向收敛，对端自己的改动仍推不回来（§7「方向」）。
- 幂等：A 在 ⑥ 失败后会重试同一个 `pairId`；B 对已 `done` 的 pairId 直接回 200。

### 16.5 状态与限制

- `LAN_PAIR_TTL_MS = 120_000`；发起方轮询间隔 `1_000`，到 TTL 判 `timeout` 并清状态。
- 待处理上限 `LAN_PAIR_MAX_PENDING = 8`；同一 deviceId 只保留一个（新的顶掉旧的）；
  同一 `pairId` 重复 request 视为重试，返回 200/202 而不是报错。
- 拒绝 → 清状态、A 收到 `denied`；`/v1/pair/reply` 用 `pairId` 取状态，取不到回 404。
- **取消**（`pairCancel` / 发起方关掉等待框）→ `pairStart` 立刻 resolve `{ok:false, reason:'cancelled'}`，
  与「对端拒绝」（`denied`）分开：两者文案不同，一个是「我不等了」、一个是「对方不同意」。
  TTL 到点仍是 `timeout`。取消时对端那条 pending 不会被撤销（跨进程没有撤销通道），
  由它自己的 TTL 收尾。
- 手机端（§17）与桌面端同一套；对端不支持配对时 ① 得到 404/405 → `unsupported`，
  UI 提示改用「手动填码」（字段仍在，见 16.6）。

### 16.6 通道与降级

| 层 | 名字 |
|---|---|
| 主进程 IPC | `lan:pairStart` / `lan:pairRespond` / `lan:pairCancel` / `lan:adoptPaired` |
| 主进程 → 渲染层 | `lan:pairRequest` / `lan:paired` |
| Capacitor 插件 | `LanSync.pairStart` / `pairRespond` / `pairCancel` / `adoptPairedCode`，事件 `pairRequest` / `paired` |
| shared 桥 | `LanSyncBridge.pairStart` / `pairRespond` / `pairCancel` / `adoptPairedCode` |

手动填码保留：老版本对端、发现被防火墙挡掉、或配对反复失败时的唯一退路。
配对成功 → 自动建配置后不再需要用户碰 `code` 字段。

## 17. 移动端（Android）

桌面端与手机端用**同一份** `lan-sync` 协议、同一套快照合并与同步引擎；差别只在实现的宿主：

| 能力 | 桌面 | Android |
|---|---|---|
| HTTP 服务（`node:http` / `ServerSocket`） | 主进程 | 原生插件 + 前台服务（`dataSync`） |
| UDP 发现（`node:dgram` / `DatagramSocket`） | 主进程 | 原生插件（`MulticastLock` + 广播地址按网卡算） |
| 配对码/凭证（`safeStorage`） | 主进程 | `SecureStorage` 插件（Android Keystore） |
| 调度（5 分钟 + 变更防抖） | 渲染层定时器 | 同左（进程存活期间） |

- 端口、路径、头字段、签名公式、配对封装**全部与桌面一致**，两端必须能互换角色。
- 手机端起服务时申请前台服务（`FOREGROUND_SERVICE_DATA_SYNC` + 常驻通知），
  否则 Doze 会掐掉监听；用户关掉开关即停服务与广播。
- 移动端 `platform.supportsPlaylistSync = true`；`lanSync` 桥由 Capacitor 插件提供，
  `sync` 凭证网关走 `SecureStorage`，`syncFetch` 走 `NativeHttp`（WebDAV 因此同样可用）。
- Web 端仍为 `false`（浏览器没有监听端口与凭证存储的能力）。
