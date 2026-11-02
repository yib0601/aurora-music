# 存储协议插件：SMB / SFTP 的实现策略

> 本文回答一个问题：**为什么 SMB 与 SFTP 不能像音源那样"装一份 JSON 就能用"，
> 以及它们的依赖为什么不该进应用本体。**

## 1. 结论先说

| 协议 | 能否用声明式清单表达 | 实现状态 |
|---|---|---|
| WebDAV | **能**（HTTP + XML 响应） | 内置插件 `webdav`（既有） |
| SFTP | **不能**（SSH2 传输层、密钥交换） | **已实现**：`ssh2`，注入式依赖 |
| SMB2/3 | **不能**（二进制协议、NTLM 握手、协商方言） | **已实现**：`@marsaud/smb2`，注入式依赖 |
| NFS | 不需要（通常以本地挂载点出现） | 走 `scanner.ts` 的本地目录 |

原因很直接：声明式清单能表达的全部内容是「一条 HTTP 请求模板 + 响应字段映射」。
SMB 与 SFTP 都不是 HTTP —— 它们没有"端点模板"，没有"JSON 响应"。
强行套用只会做出一个只能连 demo 服务器的玩具。

## 2. 依赖策略：装进桌面端，但不进 shared

> **现状：`ssh2` 与 `@marsaud/smb2` 已作为 `@aurora/desktop` 的依赖安装。**

原本的设想是"依赖完全由插件携带"，但实现时撞上一个无法绕过的矛盾：

- SMB/SFTP 需要**原始 TCP**（NTLM 握手 / SSH 密钥交换）
- 渲染层是 `nodeIntegration: false`，只有主进程能用 `node:net`
- 而"把第三方代码加载进主进程" = C 档 = 文档里明确"永不做"

所以最终采用的是**折中但可解释**的方案：**依赖进桌面端主进程，但不进 `shared`**。

### 实现方式：注入而不是 import

`shared` 里的 `sftpStoragePlugin.ts` / `smbStoragePlugin.ts` 只声明接口，不 import 依赖：

```ts
// shared：只有形状，没有依赖
export interface Ssh2Module { Client: new () => Ssh2Client }
export function setSsh2Module(mod: Ssh2Module | null): void

// desktop：启动时把真实模块传进去（懒加载）
export function installStorageProtocolDeps() {
  const ssh2 = require('ssh2')
  setSsh2Module(ssh2)
}
```

好处：
1. `shared` 的 `dependencies` 保持干净（只有 `lz-string`），打包不会把 ssh2 拖进渲染层
2. 移动端不注入 → SFTP/SMB 插件仍在列表里，但 `probe` 返回「本机不支持」
   （比"插件凭空消失"更好解释）
3. 一个包装坏了不影响另一个（两个协议各自 try/catch）

代价（如实记录）：
- 依赖仍在安装包里（约 +2MB），与"不用的能力不进入攻击面"的初衷有偏差
- `ssh2` 的原生 crypto 绑定编译失败时会回退纯 JS（功能等价、握手略慢）。
  日志里看到 "Failed to build optional crypto binding" 是**预期降级**，不是故障

### 为什么当初想"不进本体"（保留这段判断依据）

1. **体积**：`ssh2` + `smb2` 会让安装包明显变大，而多数 NAS 支持 WebDAV。
2. **安全**：这两个库处理**认证握手与密钥交换**，是攻击面最密集的一段代码。
3. **升级**：协议库修 CVE 的频率远高于播放器，独立升级比等应用发版好。
4. **信任模型一致**：按需引入能力，不用的能力不进入攻击面。

这四条仍然成立，只是"完全由插件携带依赖"在 Electron 架构下做不到
（主进程不能安全加载第三方原生代码）。折中方案保住了第 1 条的大部分与第 2 条的实质
（依赖不进渲染层、不进 shared），放弃了"用户按需安装"。

## 3. SFTP 与 SMB 的实现要点

### 连接生命周期：一次操作一个连接

两个协议都**不维护连接池**：

- NAS 的 SFTP 会话数与 SMB 会话数都有上限，长连容易撞上限且用户看不到原因
- 连接泄漏在 NAS 侧是硬故障（会话占满后管理员都进不去）
- 扫描是批量操作，单次握手 100~300ms，相对整体耗时可忽略

代价：播放时每次 seek 都要重新握手。这是真实的体验代价，换来的是"不会泄漏"。

### SMB 的一个硬限制：**不是流式**

`@marsaud/smb2` 的 `readFile` 一次性返回整个 Buffer，没有"读一块回调一次"的接口。
所以 SMB 的 `openStream` 是**把请求的那一段读进内存再包成 Response**：

- 三种 Range 形态都正确支持（`bytes=a-b` / `bytes=a-` / `bytes=-N`）
- 但大文件（无损音乐常 30~80MB）的 seek 有内存与延迟开销

如实写在这里，不假装它是流式的。SFTP 侧同理（`createReadStream` 是被动的数据流，
也是先收集完再返回）。

### Range 解析是 seek 正确性的前提

`parseRangeHeader`（SFTP）与 `parseSmbRangeHeader`（SMB）各自独立实现，
但**语义必须一致**，所以有一条测试专门比对两者对同一输入的输出
（防止两处实现漂移）。

`bytes=-N`（尾段）是必须靠 `openStream` 才能表达、`openRange` 表达不了的形态 ——
这正是存储契约里把 `openStream` 定为优先路径的原因（见 `storage/types.ts` 的注释）。

## 4. 契约与 UI 本来就留好的位置

- **契约**：`packages/shared/src/plugin/storage/types.ts` 的 `StoragePlugin`
  （三个可选方法 + 声明式 `fields`）
- **声明式字段**：`StorageFieldDef` 让设置页**通用渲染表单** ——
  新增协议只需声明自己的字段（主机/端口/共享名/用户名/口令/根路径），设置页零改动
- **口令分离**：`kind: 'password'` 的字段由调用方分流到主进程 `safeStorage`
  （按 `sourceId` 存，不是按 pluginId —— 用户可能加三台 NAS）
- **注册表**：`registerStoragePlugin()` 让任何实现自动出现在「可添加的来源类型」里

所以将来补 SMB/SFTP 只需要：

```ts
// packages/shared/src/plugin/storage/smbStoragePlugin.ts（示例骨架）
export const smbStoragePlugin: StoragePlugin = {
  id: 'smb',
  displayNameKey: 'sources.smb.title',
  version: '1.0.0',
  fields: [
    { key: 'host', labelKey: 'sources.smb.hostLabel', kind: 'text', required: true },
    { key: 'share', labelKey: 'sources.smb.shareLabel', kind: 'text', required: true },
    { key: 'username', labelKey: 'sources.smb.usernameLabel', kind: 'text' },
    { key: 'password', labelKey: 'sources.smb.passwordLabel', kind: 'password' },
    { key: 'rootPath', labelKey: 'sources.smb.rootLabel', kind: 'path' },
  ],
  async listAudio(config, options) { /* 遍历目录，返回 RemoteEntry[] */ },
  async openStream(config, relPath, init) { /* 返回带 Range 的 Response */ },
  async probe(config) { /* 列举根目录 */ },
}
```

设置页、播放代理、扫描流程**一行都不用改** —— 这是 `StoragePlugin` 契约
（尤其是声明式 `fields` 与 `openStream` 的 Range 透传语义）设计时就留好的位置。

## 4.5 移动端（Capacitor / Android）：同契约、不同链路

移动端现在**也能配网络存储**，但只有 WebDAV —— 原因不在产品取舍，而在协议本身：
SFTP / SMB 需要原始 TCP 连接，WebView 里没有；那两个依赖（`ssh2` / `@marsaud/smb2`）
也只注入了桌面端主进程。`StoragePlugin.available()` 把这件事交给插件自己回答，
设置页据此只给本端跑得动的协议放"新增来源"入口。

桌面端与移动端的差异（都是环境决定的）：

| 环节 | 桌面端 | 移动端 |
|---|---|---|
| 插件执行 | 主进程（`desktop/src/ipc/librarySource.ts`） | 渲染进程（`app/src/services/platform/mobile/storage.ts`） |
| 列目录 | 主进程 fetch | `NativeHttp` 原生插件（OkHttp） |
| 播放 | `aurora-remote://` 协议代理，流式 + Range 透传 | 整首下载进媒体缓存后播本地文件 |
| 口令 | `safeStorage`（系统密钥环） | Android Keystore（AES-256-GCM）加密后落盘 |
| 封面 | 主进程 `ensureRemoteCover` 按需 Range 提取 | 渲染层 `ensureStorageCover`，同一策略 |

### 为什么列目录必须走原生插件

`CapacitorHttp` 在 Android 上最终调 `HttpURLConnection`，它只放行 RFC 2616 的
标准动词，`PROPFIND` 会抛 `ProtocolException`（JDK 自 1.6 起的行为，见 JDK-7017158）。
WebDAV 列目录只有 PROPFIND 一条路，因此移动端加了一个最小的原生桥
`NativeHttpPlugin`（OkHttp）：接受任意 method，响应以 base64 回传（顺带解决
"文本通道损坏二进制"的问题 —— 读元数据头与封面都要原始字节）。

JS 侧的分流在 `app/src/services/platform/mobile/nativeFetch.ts`：**非标准动词**
或**带 `Range` 的请求**走原生插件，其余仍走 `CapacitorHttp`。

### 播放为什么是"先下载再播"

`<audio>` 与原生 `MediaPlayer` 都无法给请求附加 `Authorization` 头，WebView 里也没有
自定义协议可以拦截。可用的通道只有 `Filesystem.downloadFile({url, headers})`（原生 HTTP，
可带鉴权头、可带 UA、不受 CORS 限制），于是远端曲目先整首落进媒体缓存（同一份配额与
LRU 驱逐），再把本地文件地址交给播放器。

代价如实记录：首次播放要等整首下载完（之后走缓存命中）；大文件（无损 30–80MB）在慢网
下有可感知的等待。换来的是"能播、能 seek、锁屏能控"三者同时成立。桌面端不受此限，
仍然是流式代理。

### 口令：Keystore 加密，且有降级与如实标注

移动端没有 `safeStorage` 的等价物，但 Android 有 Keystore —— 密钥由系统生成、
不可导出，密文离了这台设备就是废字节。为此加了一个最小原生桥
`SecureStoragePlugin`（`AES/GCM/NoPadding`、AES-256、随机 IV、128 位认证标签），
JS 侧包装在 `app/src/services/platform/mobile/secureStorage.ts`。

口令文件因此不再是明文表，而是密文容器：

```json
{ "format": "keystore-v1", "data": "<base64(iv(12) || ciphertext+tag)>" }
```

`storageCredentialState` 回报三档，UI 各有对应文案，不冒充也不自贬：

| 情形 | `protection` | UI 文案 |
|---|---|---|
| 有 Keystore，已加密 | `keystore` | 口令已安全保存 |
| 插件缺失（老包 / iOS） | `app-private` | 口令保存在应用私有目录（未加密） |
| 密钥失效（恢复备份 / 换机重装） | 按 `saved: false` 处理 | 未保存口令（提示重填） |

两个实现细节值得记住：

1. **历史明文文件会被原地迁移。** 触发点是「保存」与「查询口令状态」（用户打开来源卡片时），
   都在串行写队列里**重读一次再写** —— 拿旧快照写回会把用户刚存进去的口令抹掉。
2. **密钥失效不是错误，是事实。** 恢复备份或换机后密文还在、密钥没了，解密必然失败；
   这时唯一可行的补救就是让用户重填，所以按"未保存"处理，并保留旧密文等它被覆盖。

不要求 `setUserAuthenticationRequired`：曲库扫描在后台跑，要求解锁会让息屏时的扫描与
取址失败。威胁模型的边界是"拿到应用私有目录文件的人"，这一点已在 UI 里说清。

与桌面端同一条纪律不变：**口令不进 localStorage**，只在调用插件前的一瞬间并进配置副本。

### 封面：按需提取，扫描不碰

远端曲目的内嵌封面在扫描阶段**不提取**（与桌面端 `ensureRemoteCover` 同一策略）：
扫描已经为元数据读过文件头，但把图片解出来再落盘会让一次扫描平白多出几百次写盘，
而封面只在对用户可见时才需要。所以提交时 `coverPath` 留空，由 `<CoverImage>` 挂载时
调 `platform.ensureCover` → `ensureStorageCover`：Range 读 1 MiB 头段、`parseBlob`
解出图片、落 `aurora-music/covers/<trackId>.<ext>`、转 `convertFileSrc` 地址，
并**写回数据库**（移动端没有第二层进程，持久化由这里负责）。

三条错误语义与桌面端对齐：

- **传输层失败抛错**，不返回 null：渲染层只对"确认无内嵌封面"缓存 null，
  若把 NAS 短暂不可达记成"这首没封面"，封面就再也补不回来了；
- **解析失败按无封面处理**：标签损坏或封面大于头段时，不拿同一段字节反复打远端；
- **半张图不落盘**：按图片格式校验尾部（JPEG 的 EOI、PNG 的 IEND、GIF 的 0x3B），
  免得留下一个"有 coverPath 但显示碎图"的记录。

已知边界：封面位于文件尾部的少数 MP4 变体取不到（头段里没有 moov）。这与桌面端一致，
不为此引入"整文件下载"。

### 数据库

移动端 `tracks` 表补了 `source_id` 列（幂等迁移，见
`app/src/services/platform/mobile/database.ts` 的 `migrateSchema`）。与桌面端同一套理由：
远端曲目把来源编进 `path`（`webdav:<sourceId>/...`），天然按来源隔离，
**不动 `UNIQUE(path)` 约束**（重建表会因外键级联清空歌单条目）。

## 5. NFS 与本地挂载点

NFS 在桌面 Linux 上通常已经挂载到本地路径（`/mnt/nas`）。那种情况**不是**存储插件，
而是**本地目录**：用户在「我的音乐」里添加扫描目录即可，走 `packages/desktop/src/ipc/scanner.ts`。

这条边界值得写下来，因为用户很容易以为"连 NAS"必须配一个插件 ——
实际上最快的路径往往是把 NAS 挂载成本地目录。

## 6. 自检（改存储协议时）

- 协议实现是否**没有**进入 `shared` 的 `dependencies`？（依赖只该在 `desktop`）
- 用了带原生绑定的依赖时，编译失败是否**优雅降级**（ssh2 的 crypto binding 就是可选的），
  而不是让整个应用启动失败？
- 新增协议是否只加了**一个插件文件 + 字段声明**，设置页/扫描/播放代理零改动？
- 口令 / 私钥是否只在主进程、只经 `safeStorage`、且按 `sourceId` 存？
  （注意 `privateKey` 与 `passphrase` 也是敏感字段，与 `password` 同一条路径）
- `openStream` 是否**正确支持** `bytes=-N` 尾段？回落 `openRange` 时是否明确降级？
- 连接是否保证收场（try/finally + 超时）？NAS 对会话数很敏感，
  泄漏一次就可能让管理员都连不上。
- 若协议**不是**流式的（如 SMB 的 readFile），是否在文档里如实写明代价？
