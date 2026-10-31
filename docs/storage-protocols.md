# 存储协议插件：SMB / SFTP 的实现策略

> 本文回答一个问题：**为什么 SMB 与 SFTP 不能像音源那样"装一份 JSON 就能用"，
> 以及它们的依赖为什么不该进应用本体。**

## 1. 结论先说

| 协议 | 能否用声明式清单表达 | 实现路线 |
|---|---|---|
| WebDAV | **能**（HTTP + XML 响应，已有内置实现） | 内置插件 `webdav` |
| SMB2/3 | **不能**（二进制协议、NTLM/Kerberos 握手、协商方言） | 需要**真实代码** |
| SFTP | **不能**（SSH2 传输层、密钥交换、通道复用） | 需要**真实代码** |
| NFS | 不需要（通常以本地挂载点出现） | 走 `scanner.ts` 的本地目录 |

原因很直接：声明式清单能表达的全部内容是「一条 HTTP 请求模板 + 响应字段映射」。
SMB 与 SFTP 都不是 HTTP —— 它们没有"端点模板"，没有"JSON 响应"。
强行套用只会做出一个只能连 demo 服务器的玩具。

## 2. 依赖策略：进插件，不进应用

这是本项目的一个明确决定：

> **SMB/SFTP 的协议实现依赖（`ssh2`、`smb2` 等）不加入应用本体。**

### 为什么

1. **体积**：`ssh2` + `smb2` 及它们的原生/可选的 crypto 依赖会让安装包明显变大，
   而绝大多数用户根本不用这两个协议（多数 NAS 支持 WebDAV）。
2. **安全**：这两个库处理的是**认证握手与密钥交换**，是攻击面最密集的一段代码。
   把它们的漏洞周期绑进应用发版节奏，等于让"只想听歌"的用户承担他们没用到的风险。
3. **升级**：协议库修 CVE 的频率远高于播放器。放在插件里，用户能独立升级协议实现，
   不必等一次应用发版。
4. **信任模型一致**：这与 A/B 档插件的思路相同 —— 用户按需引入能力，
   不用的能力不进入他的攻击面。

### 代价（要如实承认）

- **插件不能再是纯 JSON**：SMB/SFTP 插件必须带**代码**（B 档或 C 档），
  而目前 B 档只支持洛雪格式的音源脚本（取址），不支持存储协议。
- 所以这两个协议在当前版本**不可用**，需要先扩展 B 档的脚本能力面
  （让脚本能实现 `StoragePlugin` 的 `listAudio` / `openStream`），
  或者引入一个受控的 C 档（原生模块）加载器。

## 3. 当前版本提供了什么

契约与 UI 已经就绪，只差协议实现：

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

## 4. 为什么这条路要等 B 档扩展，而不是现在硬塞

存储协议与音源脚本的**能力形状不同**：

| 维度 | 洛雪音源脚本（当前 B 档） | 存储协议需要 |
|---|---|---|
| 输入 | 一条曲目的定位令牌 | 目录路径 / 区间 |
| 输出 | 一个 URL 字符串 | 目录条目数组 / 可读字节流 |
| 状态 | 无（每次现取） | 连接池、会话、重连 |

当前 B 档的脚本宿主（`lxHost.ts`）暴露的是洛雪协议的 `lx.request` + `musicUrl` 回调，
它的"输出"只能是一个地址字符串。存储插件要返回**结构化目录列表**与**字节流**，
这需要给沙箱补两样东西：

1. 一个能返回结构化值的调用通道（`lxHost` 的 `lx.request` 已经能拿到响应体，缺的是"把解析结果交回宿主"）
2. 字节流能力（`Response` 携带 ArrayBuffer；`openStream` 的语义是**原样透传 Range**）

这两样都不是小改动，且会扩大沙箱的能力面（从"取一个地址"变成"读任意字节"）——
按项目一贯的做法，边界要先写清再动手，而不是先做出来再补文档。

## 5. NFS 与本地挂载点

NFS 在桌面 Linux 上通常已经挂载到本地路径（`/mnt/nas`）。那种情况**不是**存储插件，
而是**本地目录**：用户在「我的音乐」里添加扫描目录即可，走 `packages/desktop/src/ipc/scanner.ts`。

这条边界值得写下来，因为用户很容易以为"连 NAS"必须配一个插件 ——
实际上最快的路径往往是把 NAS 挂载成本地目录。

## 6. 自检（将来真做 SMB/SFTP 时）

- 协议实现是否**没有**进入应用本体的 `dependencies`？
- 新增协议是否只加了**一个插件文件 + 字段声明**，设置页/扫描/播放代理零改动？
- 口令是否只在主进程、只经 `safeStorage`、且按 `sourceId` 存？
- `openStream` 是否**原样透传** `Range`（含 `bytes=-N` 尾段）？
  回落 `openRange` 时是否明确降级而不是报错？
- 连接是复用的还是每次新建？NAS 对并发连接数很敏感（SMB 会话数有上限）。
