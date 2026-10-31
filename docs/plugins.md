# 插件化架构

> 应用对外只有一个概念：**插件（plugin）**。一个插件是一组可选能力（登录 / 搜索 / 取址 / 歌单 / 歌词 …），
> 能力缺失用「方法不存在」表达，调用方**不得**用 `kind === 'xxx'` 分支判断形态。
>
> 本文记录框架契约、注册表、以及为什么这样设计。具体插件清单见文末。

## 为什么改

改造前的「音源」是两种硬编码形态（`OnlineSourceKind = 'aurora' | 'lx'`），形态判定散落在
**4 层 15 个文件 31 处**：shared 适配层 16 处、三端平台层 10 处、桌面 IPC 1 处、设置页 UI 4 处，
另有两份互不同步的 kind 联合定义（`types.ts` 与 `auroraPreset.ts`）。

具体代价：

- 加第三种形态要同时改 15 个文件，漏一处只有 tsc 在别处才会炸
- 「这条源能不能搜索」有**四种不同写法**（`searchEndpointOf` / `isSearchableSource` /
  `isLxUsable` / UI 里各写一遍），判定口径一旦分叉就会出现「界面说能搜、实际搜不出」
- 持久化是**白名单**（`libraryStore.ts` 的 `partialize`），插件私有配置写进去等于丢
- 没有登录概念：全仓 `safeStorage` 零引用，无 cookie jar、无 token 生命周期
- 主进程没有通用请求通道，每个能力一条命名通道，插件无法表达「我要发一个请求」

## 框架契约

### 插件 = 一组可选能力

```ts
interface SourcePlugin {
  readonly id: string
  /** UI 展示名：给文案键，渲染期 t() 取值，不在本层烧中文 */
  readonly displayNameKey: MessageKey
  readonly version: string
  readonly capabilities: readonly PluginCapability[]

  /** 以下全部可选：不存在 = 不支持，调用方据此降级，不做形态判断 */
  probe?(config, ctx): Promise<SourceProbeResult>
  search?(config, query, quality, ctx): Promise<OnlineTrackSearchResult[]>
  resolveTrack?(config, ref, quality, ctx): Promise<ResolvedAudio | null>
  listUserPlaylists?(config, ctx): Promise<PluginPlaylist[]>
  getPlaylistTracks?(config, playlistId, ctx): Promise<OnlineTrackSearchResult[]>
  login?(ctx): Promise<PluginCredential>
  checkAuth?(credential, ctx): Promise<AuthState>
  logout?(ctx): Promise<void>
}
```

三点强约束（都是从既有代码里踩出来的，别丢）：

1. **能力用「方法是否存在」表达**。这是 `platform/index.ts` 里 `PlatformExtension` 的既有范式
   （`typeof platform.xxx === 'function'`），沿用即可，不引入第二套机制。
2. **`SourceTrackRef` 保持不透明**。应用只携带、不解释，取址时原样交回插件。
3. **空 `audioUrl` + `trackRef` = 惰性取址**，这是一等协议语义，不是补丁。

### 注册表

对齐仓库里唯一存在的注册表范式 `mediaProvider.ts`（`registerMediaProvider` / `getMediaProvider`）：
`registerPlugin` / `getPlugin` / `listPlugins` / `hasCapability`。注册顺序稳定，UI 列出的顺序不随刷新变化。

### 凭证

凭证**不进** `OnlineSourceConfig`——那个类型会被 persist 白名单截断。单独一份 credential 形状，
由桌面端用 `safeStorage` 加密后落盘；渲染层只持有「是否已登录」的状态，不持有明文。

> 现状对照：WebDAV 口令目前是**明文进 localStorage** 的（`webdav.ts` 自述「后续应迁移到 safeStorage」），
> 新框架不要复制这个缺陷。

## 汽水音乐插件（第一个验证框架的插件）

平台：汽水音乐（抖音音乐版）。

### 已验证事实（2026-10-31 实测）

| 能力 | 端点 | 登录 | 签名 | 结果 |
|---|---|---|---|---|
| 拉歌单曲目 | `GET api.qishui.com/luna/pc/playlist/detail` | 不需要 | 不需要 | ✅ 22/22 首 |
| 取播放地址 | `GET beta-luna.douyin.com/luna/h5/seo_track` | 不需要 | 不需要 | ✅ 全曲 |
| 拉「我的歌单」 | `GET api.qishui.com/luna/pc/me/playlist` | **需要 `sessionid`** | 不需要 | 需凭证 |
| 封面图 | `urls[0] + uri + "~" + template_prefix + "-15.webp"` | — | — | ✅ 200 webp |

**关键实现细节**：

- `track_player.video_model` 是 **JSON 字符串**，需二次 `JSON.parse`
- 封面裸 `uri` 会 **400**，必须拼模板后缀
- 音频防盗链：无 Referer → 200；`douyin.com` / `qishui.com` Referer → 200；**第三方 Referer → 403**
- 音频 URL 约 24h 过期（`<8位hex>` 路径段即过期时间戳），必须随取随用、不持久化
- **带 `Origin` 头请求 API 会 403**（实测：无 Origin → 200/8564B，带 Origin → 403/0B）→ 只能在主进程请求

### VIP 限制（必须如实标注，不能假装可用）

实测 22 首歌单中 **13 首为 VIP-only**。取址时这些曲目只返回 **29–60 秒试听**片段：

- 判定方法：`video_model.video_duration * 1000` 与 `track.duration` 差 > 3 秒即为试听片段
- 元信息里可提前判断：`label_info.only_vip_playable`
- **插件行为**：照常返回地址但标记 `isPreview: true` + `previewDurationMs`，由播放器决定提示方式，
  **不得**让用户听到一半突然断掉——那是「播放失败」的观感，而不是「试听」的观感

### 登录：扫码走不通，用粘贴 cookie

实测结论（五种请求头组合并发验证，全部失败）：

| 变体 | 结果 |
|---|---|
| 无 Referer / 完整浏览器头 / +csrf / 站内 Referer+csrf / 官方 LunaPC UA | **全部 `error_code=1049`** |

`1049` 文案为「当前应用版本过低或经非官方渠道下载」。它校验的是**发起请求的客户端是否为官方签名应用**，
不在请求头层面：扫码能成功（`status:"scanned"` 并返回用户头像），确认一步必被拦。

因此登录只用**粘贴 cookie**：用户从官方客户端取 `sessionid`，插件校验一次（拉 `/me/playlist`）后交给
桌面端 `safeStorage` 加密保存。纯 HTTP、无浏览器。

> 若将来上游放开或拿到 bdms 原生签名能力，`login()` 钩子已在契约里，补实现即可，上层不用改。

## 迁移路径

1. **shared 建注册表 + 契约**，把 aurora / lx 包成插件（内部逻辑不重写，直接转发既有函数）
2. **三端平台层改为查表**：`probeSource` / `resolveTrackAudio` / `search` 从 `listPlugins()` 取实现
3. **持久化加插件字段**：`OnlineSourceConfig` 增 `pluginId`，persist 白名单同步放行白名单内字段
4. **设置页 UI 参数化**：形态选择从写死的两项数组改为 `listPlugins()` 驱动；新增插件登录面板
5. **汽水插件**作为第三个插件落地，验证框架

每一步都要保持既有测试全绿：shared 637 / app 348 / desktop 50（2026-10-31 基线）。

## 自检清单（改插件层时）

- 上层是否还出现 `kind === 'xxx'` 或形态字样？应为零。
- 新增能力是「加一个可选方法」，还是要改 N 个文件的分支？
- 能力缺失时，调用方是否降级而不是抛错？
- 凭证是否落在 `safeStorage`，而不是 localStorage 明文？
- 试听片段是否被标记出来，而不是伪装成完整曲目？

---

# 存储插件（曲库来源）

> 与上面「音源插件」是两个域，共用同一套设计语言，但**契约不同**：
> 音源是「用完即弃的在线查询」，存储是「入库、地址长期有效、需要鉴权」的持久库。

## 为什么也要插件化

改造前曲库只有两种来源形态，但网络存储只有 WebDAV 一种实现，且形态是硬编码的：

- `LibrarySourceConfig.kind` 是字面量联合 `'local' | 'webdav'`，字段（`baseUrl` /
  `username` / `password` / `rootPath`）是 WebDAV 专有的扁平结构；
- `'webdav'` 字面量散在 4 处（配置类型、设置页、主进程 `aurora-remote://` 代理、provider 注册）；
- 新增 SMB / SFTP 必须改这些字段和每一处判断。

于是加第二种协议的成本，与「再写一遍 WebDAV 客户端」一样高。

## 契约

```ts
interface StoragePlugin {
  readonly id: string
  readonly displayNameKey: MessageKey
  readonly descriptionKey?: MessageKey
  readonly version: string
  /** 声明式字段：设置页据此**通用渲染**表单，不写死任何协议的输入框 */
  readonly fields: readonly StorageFieldDef[]

  listAudio?(config, options?): Promise<RemoteEntry[]>
  openRange?(config, relPath, start, end): Promise<Response>
  openStream?(config, relPath, init?: { range?: string }): Promise<Response>
  probe?(config): Promise<StorageProbeResult>
}
```

`StorageFieldDef` 是「字段自描述」：`{ key, labelKey, kind: 'text'|'password'|'url'|'path',
required?, placeholderKey?, hintKey? }`。新增协议只需声明自己的字段，**设置页零改动**。

### 四条硬约束

1. **能力用「方法是否存在」表达**，与音源插件同一范式。`capabilities` **不是**插件自报的
   第二份真源，而是 `storageCapabilitiesOf()` 按方法存在性**派生**的（一份实现只能有一种说法）。

2. **`openStream` 优先于 `openRange`**。`aurora-remote://` 播放代理需要把 `Range` 头**原样**透传
   （含 `bytes=-N` 尾段形态、`Content-Range` 回传）。`openRange` 只收数值区间，回落路径上
   表达不了尾段/开区间请求——那是能力缺失时的正常降级，不是错误。

3. **`webdav:` 路径前缀永不改**。`tracks.path` 存量全是 `webdav:<sourceId>/...`，前缀形状由
   shared 的 `storagePathPrefix()` 唯一决定，上层不许复写字面量，更不许改成 `storage:`——
   那会让全量存量曲目失联、必须写数据库迁移。

4. **敏感字段不进持久化**。`fields` 里 `kind: 'password'` 的值由调用方分流：不写进 `settings`，
   走主进程 `safeStorage`（`desktop/src/ipc/storageCredentials.ts`，按 **sourceId** 存，
   不是按 pluginId——用户可能加三台 NAS，按 pluginId 会互相覆盖）。

   注意 `storageFieldValue()` 的「settings 优先、旧扁平字段兜底」只解决**读**兼容，
   **不负责**把口令移出持久化；后者是调用方迁移的职责。

### 单一入口

```ts
librarySourcePluginId(cfg)   // pluginId → kind → 默认，上层永不写 cfg.kind === 'webdav'
storagePluginOf(cfg)         // 一步拿到插件
storageErrorStatus(err)      // 错误 → HTTP 状态（结构化判定，不用 instanceof）
isStorageTransportError(err) // 传输层失败（可重试）vs 内容格式问题
```

改造前平台层存在「`providerFor()`」与「又直接 `getMediaProvider(cfg.kind)` 一次」两套查法，
第二套正是形态判断分叉的典型来源。现在只有 `storagePluginOf()` 这一个入口。

`mediaProvider.ts` 的 `getMediaProvider` / `registerMediaProvider` 保留为 `@deprecated` 垫片，
但**它装不下 `fields` 与 `openStream`**——用它注册新协议会得到隐性缺陷。迁移完成后应删除。

## 当前内置插件

只有 `webdav`（群晖 / 威联通 / Nextcloud / rclone serve webdav）。SMB / SFTP / NFS
按本契约各写一个文件 + 注册即可，设置页会自动出现对应表单。

> 注：NFS 通常以本地挂载点形式出现，那属于**本机目录**来源，走 `scanner.ts`，不需要存储插件。

## 存储侧自检清单

- 上层是否还出现 `kind === 'webdav'` 或 `webdav:` 字面量？应为零（用上面两个 single entry）。
- 新增协议是「加一个插件文件 + 声明字段」，还是又要改设置页/配置类型/IPC？
- `openStream` 缺失时，代理是否**降级**而不是抛错？
- 口令是否只在主进程、只经 `safeStorage`、且按 sourceId 存？
- 插件抛的错误是否带 `status`（让代理能映射 502/上游状态）？

---

## 后续：从 URL / GitHub 导入插件

> 本节是**设计约束**，尚未实现。现在写下来，是为了让将来的导入器不必回头推翻既有契约。

现在的插件是**编译进应用**的（`plugin/builtins.ts` 注册）。用户提出希望将来在设置里填一个
URL 或 GitHub 地址就能导入插件。这件事可以做，但有四条边界必须先定下来，否则会打开
一个比它解决的问题大得多的口子。

### 1. 插件形态：声明式优先，代码执行是最后手段

按风险从低到高，插件可以分三档：

| 档位 | 形态 | 能力 | 风险 |
|---|---|---|---|
| A | **声明式 HTTP 协议**（JSON 描述端点与字段映射） | 搜索 / 取址 / 歌单 | 低：不执行任何代码 |
| B | **受限脚本**（洛雪那套宿主，遮蔽 Node 标识 + vm 超时） | 取址 | 中：执行第三方代码，但已在沙箱里 |
| C | **原生模块** | 任意 | 高：等同于运行任意程序 |

**导入器只应支持 A 与 B。** 理由：`lxHost.ts` 已经把 B 档的沙箱做完了（遮蔽 `process` /
`require`，桌面端用 `node:vm` 超时打断同步死循环），复用它即可；而 C 档一旦开放，
应用就有了「下载并执行任意二进制」的能力，这与「用户可配置音源」是完全不同量级的信任模型。

### 2. 供应链：URL 必须能钉死内容，而不是钉死地址

「填一个 GitHub 地址」的天然问题是**同一个地址的内容会变**：

- 仓库可以 force-push，raw 链接随之改变
- 分支会前进，`main` 今天和明天不是同一份代码

所以导入时必须记录**内容哈希**而不是地址：`{ url, sha256, version }`。
之后每次加载校验哈希，不匹配就拒绝加载并提示「插件已更新，需要重新确认」。

这与既有教训一致：洛雪脚本的实例缓存键曾经用「长度 + 首尾片段」，
主体被改写而首尾未变时不会失效，导致取址一直沿用旧脚本行为——那是最难查的一类问题。
**全量内容哈希是唯一可靠的做法。**

### 3. 权限：插件申请什么，就要让用户看见什么

插件契约现在没有权限概念。导入前必须补上，最小集合：

- `network`：能访问哪些域名（不能是 `*`）
- `credential`：是否需要保存凭证
- `filesystem`：是否有文件读写（默认应当为**无**）

UI 要在确认对话框里逐条列出，用户勾选后才安装。这与应用现有的做法一致：
`librarySources` 的口令只在主进程内存里，`pluginCredentials` 走 `safeStorage`，
都不给插件直接读取的接口。

### 4. 签名：可选，但要有

自建托管可以要求插件清单带签名（Ed25519），公钥内置在应用里。
这不能防住「用户主动装了一个恶意插件」，但能防住「下载链路被中间人替换」——
后者才是真正防不胜防的那种。

### 实现顺序建议

1. 先做 A 档：纯 JSON 的协议插件，导入 = 校验 JSON 结构 + 下载并缓存 → 立刻可用，零代码执行
2. 再做 B 档：复用 `lxHost` 的沙箱，把「脚本源」从内置改成可导入
3. C 档不做

前两档都不需要改动 `SourcePlugin` 契约——导入的插件同样实现那几个可选方法，
只是实现来源从 `builtins.ts` 换成了磁盘上的文件。这正是当前契约设计的价值所在。
