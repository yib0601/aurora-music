# 歌单同步 —— 对抗性验证报告（task-4 首轮 + task-9 复验）

> 验证者：verifier（只读为主）。仓库（工作区根），工作区**未提交**改动。
> 结论基于**独立读实现 + 自造用例实跑**，不采信三个实现者的自述。
> 两轮共新增 **6 个**测试文件（`__tests__/`，可随时删；首轮 4 个、复验轮 2 个），**未改动任何实现文件**。
>
> **两轮结构**：§1–§5 是 task-4 首轮的原始结论（保留原文，含当时的定级与证据行号）；
> §6 是 task-6/7/8 修复后的 **task-9 复验结论**——逐条写「已修（证据）/ 仍有风险 / 降级为已知限制」。
> 判断当前状态请看 §6.0，不要只看 §1/§2 的旧定级。

## 0. 结论

| 分级 | 条数 | 摘要 |
| --- | --- | --- |
| **阻断** | 2 | 局域网双向同步会形成无节流互推环；打包桌面端 WebDAV 同步被 CORS 拦死（无主进程 fetch 接缝） |
| **应修** | 7 | 收敛性（changed 恒 true）、merge 不满足结合律、配对码进 localStorage、文档与鉴权实现四处不一致、坏快照可让 merge 抛错、短口令脱敏盲区、`deletedAt:0` 边界 |
| **建议** | 6 | 无变化也 push、占位曲目只增不减、inbox 无去重、测试钩子出生产口、bridge 注入时机、周期同步不消费 inbox |

工程门禁（首轮）：`app tsc --noEmit` ✅ / `shared test` ✅ / `desktop test` ✅ / `verify:i18n` ✅（见 §5）。

**复验后现状（task-9，见 §6）**：阻断 2 条**已修**、应修 7 条**全部已修**（S-5 口径变更为「边界上移」）、
建议 6 条中 4 条已修、**仍有 2 条接受风险**（N-2 占位曲目只增不减、N-4 测试钩子仍出生产出口），
另有 2 条「接缝已闭合但需人工真机回归」（B-2 的打包产物 + 真实 WebDAV、双机真实局域网）。
门禁复跑：shared build/typecheck/test ✅、app tsc ✅、app test 仅既有 lxSourceForm 1 条失败、
desktop typecheck ✅ / test ✅、verify:i18n ✅、**app build ✅**。

---

## 1. 阻断

### B-1 局域网双向同步会形成**无节流的互推环**

> **复验（task-9）：已修。** 证据 §6.1：新增 `verifySyncConvergence.test.ts`（两端各一份独立模块图 + 假 `LanSyncBridge`，A→B→A 往返），断言轮数有界、两端 `snapshotContentHash` 相等、最后一轮 publish=0、手动再同步计数不增；服务端收件箱改按 `deviceId` 去重、`handleLanInbox` 改为「不回推才 publish」并受 5s 冷却 + 退避约束。

- **位置**
  - `packages/app/src/services/playlistSync.service.ts:496-502`（每轮同步**无条件** `push` + **无条件** `lan.publish`）
  - `packages/app/src/services/playlistSync.service.ts:651-661`（`handleLanInbox`：merge → apply → **无条件** `publish` → **无条件** `void syncAllAuto()`）
  - `packages/desktop/src/ipc/lanSyncServer.ts:327-336`（**每一个**合法 PUT 都 `onSnapshot` → 渲染层 `lan:inbox`）
  - `packages/desktop/src/ipc/lanSyncServer.ts:238-241`（收件箱只限制容量 20，**不按 `(deviceId, revision)` 去重**）
  - `packages/desktop/src/ipc/lanSync.ts:521-531`（`lan:publish` 只缓存快照，无节流）
- **复现**（已固化为测试）：`packages/app/src/services/__tests__/verifyPlaylistSync.behaviour.test.ts:283` 起的用例 —— 注册一个 lan config 的 bridge，`initPlaylistSync()` 后向 `onInbox` 回调**喂一份与本地完全一致、changed=false 的快照**，观测到：
  - 这一轮 inbox 触发 **publish ≥ 2 次**（`handleLanInbox` 自己 publish 一次 + `syncAllAuto()` 成功路径再 publish 一次）；
  - 同时触发 `plugin.pull`（即一次完整的远端拉取）。
  手工复现：A、B 两台各建一条指向对方的 `lan-sync` 配置并开启本机服务，打开任意一台的 DevTools 观察 `lan:publish` / `pullPeer` 调用速率。因为 B 收到 PUT 会 `publish`+`syncAllAuto`（→ 向 A PUT），A 收到 PUT 又 `publish`+`syncAllAuto`（→ 向 B PUT），两机以「一次 HTTP 往返」为周期的速度互推，没有任何退避/去重/最小间隔。
- **期望 vs 实际**：期望「无变化不传播、收件箱事件幂等、inbox 处理不放大成主动同步」；实际是闭环正反馈。文档 §9 承诺的退避（30s→2min→10min）只作用于 `runSync` 的失败路径，对这个环完全不生效。
- **影响面**：两台机器都按文档配好「局域网双向同步」后 100% 命中；CPU/网络/电池持续占用，快照文件被高频写入，且每轮都在 `markSyncOk` 写 zustand（触发 localStorage 写入）。这是最容易在真实用户手里发生的故障，必须修。
- **建议修法**（任一，建议组合）：
  1. `plugin.push` / `lan.publish` 都改成 `if (merged.changed || 首次)`；inbox 处理完成的 publish 也判 changed；
  2. `pushInbox` 按 `deviceId + revision + updatedAt` 去重，重复快照不再触发 `onSnapshot`；
  3. `handleLanInbox` 里去掉无条件 `void syncAllAuto()`（改为只 apply+publish，让周期同步负责后续拉取），或给它加最小间隔。

### B-2 打包桌面端的 **WebDAV 同步被 CORS 拦死**（缺主进程 fetch 接缝）

> **复验（task-9）：已修（接缝闭合），真机打包回归待人工。** 证据 §6.2：`webdav.ts` 加 `setWebdavFetch` 且 6 处请求全部走注入、无裸 `fetch(` 残留；`initPlaylistSync` 注入 `platform.syncFetch`、`disposePlaylistSync` 还原 null；`platform.syncFetch → preload sync.fetch → IPC sync:fetch（主进程代发）` 三链实测闭合。打包产物 + 真实 WebDAV 服务器的端到端仍**未实测**（§6.6）。

- **位置**
  - `packages/desktop/src/main.ts:203` `webSecurity: !isDev` → 打包版为 `true`（CORS 生效）
  - `packages/desktop/src/main.ts:224-228` 生产环境 `win.loadFile(htmlPath)` → 页面 origin 是 `file://`（opaque origin）
  - `packages/shared/src/webdav.ts:485,569,719,763,807` 所有请求都走 `fetchWithTimeout`（内部即**全局 fetch**），函数签名 `listWebdavDir(cfg, relPath, timeoutMs)` / `readWebdavText` / `writeWebdavText` / `ensureWebdavDir` **都不接受注入的 fetch**
  - `packages/shared/src/plugin/sync/webdavSyncPlugin.ts:143,162,192` 直接调用上述函数，**从不使用 `ctx.fetch`**
  - `packages/app/src/services/platform/index.ts:1011-1017` 注释自述：「WebDAV 的跨域头由服务端决定，渲染层直连常被 CORS 拦；真要在桌面端根治，只能由主进程提供一条 fetch 代理通道。目前还没有这条通道，所以不声明」（`syncFetch` 可选字段 `:368`，桌面实现未提供）
  - 同一仓库的存储侧已经因为**完全相同的原因**把网络存储扫描搬到主进程：`packages/desktop/src/ipc/librarySource.ts:3-8`「渲染层的 fetch 受 CORS 约束，而多数网络存储实现不会返回 Access-Control-Allow-Origin」
- **复现**：
  1. `pnpm --filter @aurora/desktop build:dir` 后运行打包产物（不要用 dev：dev 下 `webSecurity=false` 掩盖问题）；
  2. 插件设置 → 歌单同步 → WebDAV，填一个正常的 Nextcloud/坚果云地址 + 账号应用密码；
  3. 点「同步」→ 失败；DevTools Console 可见 `Access to fetch ... has been blocked by CORS policy`；`lastError` 落在 `sync.error.webdavConnect`。
  纯逻辑复现（不依赖真实服务器）：`PROPFIND`/`PUT`/`MKCOL` 都**不是** CORS safelisted 方法与 safelisted header 组合，必然先发 `OPTIONS` 预检；`webdav.ts:485` 的 `listWebdavDir` 还带 `Depth` 与 `Authorization` 头，预检必触发。绝大多数 WebDAV 服务端不返回 `Access-Control-Allow-Origin`，也不实现 `OPTIONS` 的 CORS 响应。
- **期望 vs 实际**：期望插件在桌面端可用（文档 §6 把它写成正式功能，§14「未做」里没有这条）；实际是「装了能配、点了必失败」，且失败信息是笼统的连接错误，用户无法自查。
- **影响面**：桌面端两条同步路径之一（WebDAV）整体不可用；局域网路径不受影响（主进程发 HTTP）。对只用 WebDAV 的用户，这个功能等于没做。
- **建议修法**：二选一（都需要 Lead 决策，属实现改动）：
  1. **补接缝**：主进程加一条 `sync:fetch`（或 `webdav:*`）通道，`webdav.ts` 的函数接受可选 `fetch` 实现，`webdavSyncPlugin` 把 `ctx.fetch` 透传下去；平台层实现 `syncFetch`（`platform/index.ts:368` 已经预留了字段）；
  2. **降级为明示限制**：若本轮不做，必须把「WebDAV 同步仅开发模式可用」写进 §14，并在 UI 上禁用/标注，不能让它以「看起来能用」的形态发布。

---

## 2. 应修

### S-1 内容相同但 `updatedAt` 落后 → **changed 恒 true**、每轮都写对端

> **复验（task-9）：已修。** 证据 §6.3：`applySyncedPlaylists` 新增 `restampedUpserts`（`playlistSync.service.ts:398-400`）只采纳时间戳、不动内容；行为测试改为常规断言：远端时间戳被采纳、连续两轮第二轮 `changed=false`。

- **位置**：`packages/app/src/services/playlistSync.service.ts:299-307`（`samePlaylist` 只比 `name + trackIds`，不比时间戳）、`:356`（用 `samePlaylist` 过滤 upsert）；`packages/shared/src/plugin/sync/merge.ts:86-92`（`canonicalPlaylist` 把 `updatedAt` 纳入比较）。
- **复现**（已固化）：`packages/app/src/services/__tests__/verifyPlaylistSync.behaviour.test.ts:154` 的 `it.fails` + `:166` 的正向用例。远端快照 `updatedAt=500`、本地 `100`、内容（name+trackIds）一致 → `applySyncedPlaylists` 不写 store（`updated=0`），本地仍是 `100`；再跑一轮，`mergeSnapshots` 的 `changed` 仍为 `true`。
- **期望 vs 实际**：期望「内容一致即视为已同步，`updatedAt` 取两者较大值写回」；实际是每次同步都判 changed，于是每轮都 push（并叠加 B-1 的 publish），`lastSyncAt`/localStorage 也每轮被写。
- **影响面**：常态。只要两端时间戳不同（几乎必然），同步就永远「有变化」；配合 B-1 直接变成放大器。
- **建议修法**：`applySyncedPlaylists` 里对「内容相同」的条目仍写回 `updatedAt = max(local, remote)`（只改时间戳、不动内容），或把 `canonicalPlaylist` 的时间戳从「changed 判定」里拆出去、只用于 LWW 比较。

### S-2 `mergeSnapshots` **不满足结合律**，而 §15.2 把它列为硬要求；§14 未登记

> **复验（task-9）：已修。** 证据 §6.3：tiebreak 从「快照头 deviceId」改为「歌单规范化串字典序」（新增 `canonical.ts`，与 `snapshotContentHash` 共用同一口径）；新增 `verifySyncAssociativity.test.ts`（3 条）：同 `updatedAt` 内容不同的三份快照做 `(a∘b)∘c` vs `a∘(b∘c)` 对拍、6 种排列、并列 + 墓碑混合，全部结果一致。

- **位置**：`packages/shared/src/plugin/sync/merge.ts:24-27`（代码注释自认「格式里没有 per-playlist 的 deviceId，一次合并后输出的快照头只带本机 deviceId，于是『远端记录在同毫秒并列』这一信息在二次合并时会丢失…本轮不做」）、`:96-105`（并列时按 `candidate.deviceId`，而 `deviceId` 来自**快照头**）；`docs/playlist-sync.md` §15.2「硬要求：幂等、交换、结合」、§14 未列该限制。
- **复现**（已固化）：`packages/shared/src/plugin/sync/__tests__/verifySyncMerge.test.ts:95` 的 `it.fails` —— 三份快照同 `updatedAt`，`a.deviceId='dev-a'`、`b.deviceId='dev-c'`、`c.deviceId='dev-b'`，两首歌单 id 分别来自不同设备：`(a∘b)∘c` 得到 `'C'`，`a∘(b∘c)` 得到 `'B'`。
- **期望 vs 实际**：契约要求可结合（任意合并顺序结果一致，这对「三台设备/重放」很重要）；实际在同毫秒并列场景下依赖合并顺序。
- **影响面**：只在 `updatedAt` 完全相等（同毫秒）时触发，概率低但会在多设备快速编辑时出现；更关键的是**文档承诺与实际不符**——将来若把 merge 做成可重放/可同步增量，就会踩坑。
- **建议修法**：短期在 §14 登记已知限制并加注释指向用例；长期给 `SyncedPlaylist` 加 `originDeviceId`（改快照格式 → 版本号 `aurora-playlist-sync/2`），或把并列兜底改成「内容 canonical 字典序」这种与来源无关的全序。

### S-3 对端**配对码进 settings → localStorage**，并明文显示在卡片副标题

> **复验（task-9）：已修。** 证据 §6.3：`lanSyncPlugin` 的 `code` 字段改为 `kind:'password'`，`syncStore` 新增 `stripSecretSettings`（落盘前剥 `password/code/token/secret/sessionid`）与 `migratePersistedSyncState`（历史 `settings.code` 剥离并排队迁移到 safeStorage，版本 1→2）；行为测试覆盖「settings 只剩 host/port」「迁移后 `saveCredential` 被调用」。

- **位置**
  - `packages/app/src/components/plugin/PlaylistSyncPanel.tsx:112-124`：`handleAddPeer` 把 `{ host, port, code }` 直接写进 `config.settings`；
  - `packages/app/src/stores/syncStore.ts`：`persist(name:'aurora-sync-state', partialize: state => ({ configs: state.configs }))`（`:136-140`）→ `settings` 整块落 localStorage；
  - `packages/shared/src/plugin/sync/lanSyncPlugin.ts:49-73`：`code` 字段是 `kind:'text'`（不是 `password`）；
  - `packages/app/src/components/plugin/syncConfigCards.tsx:123-131`（`settingsSummaryOf` 只过滤 `kind==='password'`）、`:255`（subtitle 拼接）→ 配对的**对端设备**的 code 明文出现在设置卡片副标题里。
- **复现**：桌面端配一条 LAN 目标 → 关掉应用 → 打开 `~/.config/<app>/Local Storage/leveldb`（或 DevTools → Application → Local Storage → `aurora-sync-state`）→ 明文可见 `settings.code`；设置页把鼠标停在 LAN 卡片上，副标题也含该 code。
- **期望 vs 实际**：文档 §7 对**本机**配对码要求「safeStorage 加密落 userData、不广播不落日志」；§10 对 WebDAV `password` 要求不落 settings。但**对端**的 code 走的却是明文 settings —— 同一个秘密两种待遇。`pluginCredentials.ts:4-8` 正好把「渲染层 persist → localStorage 是明文」列为必须避免的缺陷。
- **影响面**：拿到本机 localStorage 只读副本（备份、同步盘、同机其它用户）即可冒充本机客户端访问对端，读/推快照。缓解因素：仍需与对端同网段。等级定为应修而非阻断。
- **建议修法**：把 `code` 字段改成 `kind:'password'` 并让它走 `sync:credential:save`（与 WebDAV password 同一条路），`lanSyncPlugin.targetOf` 从 `ctx.secrets.code` 读；UI 侧 `handleAddPeer` 只存 host/port，code 单独 saveCredential。

### S-4 文档 §7 与局域网鉴权实现**四处不一致**

> **复验（task-9）：已修。** 证据 §6.3：`docs/playlist-sync.md` §7/§15.3 已按实现改写——K 上下文串 `aurora-lan-sync/v1`、nonce 5 分钟 / 4096 上限、`GET /v1/hello` 一律验签、错误码表补全。

| # | 文档 §7 | 实现 |
| --- | --- | --- |
| a | `K = HMAC-SHA256(code, "aurora-sync/1\|" + min(deviceA,deviceB) + "\|" + max(...))` | `deriveKey(code) = HMAC-SHA256(normalizedCode, "aurora-lan-sync/v1")` —— `packages/desktop/src/ipc/lanSyncAuth.ts:93-96`，**不含双方 deviceId** |
| b | nonce「10 分钟内不复用」 | `LAN_NONCE_TTL_MS = 300_000`（5 分钟）—— `lanSyncAuth.ts:47` |
| c | `GET /v1/hello`「未鉴权（发现与配对前探测）」 | 也走完整验签：`packages/desktop/src/ipc/lanSyncServer.ts:280-300`（验签在路径分支之前） |
| d | 端点表只写了 200/202/401/404 | 实际还有 `400 {code:'snapshot'}`、`403 {code:'disabled'}`、`405 {code:'method'}`、`413 tooLarge`、`404 {code:'notFound'}`、`500 {code:'internal'}` —— `lanSyncServer.ts:305-352` |

- **复现**：`grep -n "aurora-lan-sync/v1" packages/desktop/src/ipc/lanSyncAuth.ts`；`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:45871/v1/hello`（未开服务时先 `lan:setEnabled`）→ 401。
- **期望 vs 实际**：文档是实现契约（§15 明写「实现契约」），第三方按文档实现会对不上；尤其 (a) 若将来有移动端/第三方客户端，密钥派生公式不一致会直接互通失败。
- **影响面**：文档/实现漂移；本机两端都走 `lanSyncAuth` 所以功能上暂时没坏。
- **建议修法**：以实现为准改 §7（把 K 的上下文串、TTL、hello 鉴权、错误码表补全），并在 §15.3 注明「hello 需签名」。

### S-5 `isSyncSnapshot` 只验外壳 → 坏快照能让 **merge 抛 TypeError**

> **复验（task-9）：已修（口径变更为「边界上移」，按 Lead 判定）。** 证据 §6.4：`parseSnapshot` 是唯一结构边界，`isSyncSnapshot` 改用 `parseSnapshot` 逐条校验；生产五条入口（WebDAV pull、LAN PUT、`lan:pull`、`lan:push`、`lan:publish`）全部先过它，因此两处 `mergeSnapshots` 的入参必然已归一化。`verifySyncMerge.test.ts:199`「坏输入 → 抛错」按口径**保留为期望**。

- **位置**：`packages/desktop/src/ipc/lanSyncServer.ts:112-126`（只校验 `format/deviceId/deviceName/revision/updatedAt/playlists is Array`）；`packages/desktop/src/ipc/lanSync.ts` 的 `pushToPeer`/`publishSnapshot` 复用同一函数；消费端 `playlistSync.service.ts:651-661` 直接把它交给 `mergeSnapshots`。
- **复现**（已固化）：`packages/shared/src/plugin/sync/__tests__/verifySyncMerge.test.ts:199` —— 一份「外壳合法、`playlists[0].tracks` 缺失」的快照喂给 `mergeSnapshots` 会抛 `TypeError: ... is not iterable`。LAN 侧 `GET /v1/snapshot` 也一样把未净化快照原样回给渲染层。
- **期望 vs 实际**：期望「外部输入先按 `parseSnapshot` 净化/整份拒绝，再进合并」；实际是「外壳校验通过即信任」。当前后果是被 `runSync` 的 catch 兜成「同步失败」（不崩、不丢数据），但 `handleLanInbox` 在 renderer 事件回调里同样会抛，异常会打到 DevTools。
- **影响面**：恶意/版本错配的对端可让本机同步长期失败（DoS 级别有限：用户能看到 lastError 并删配置）；不是数据破坏。
- **建议修法**：把 `isSyncSnapshot` 升级成「外壳 + 逐条 playlist/ref 结构校验」，或 LAN 路径也走 `parseSnapshot(text)`（注意其语义是整份拒绝，需接受「某台设备发坏包 → 该轮跳过」）。

### S-6 **<4 字符口令漏进 `lastError`，并随 configs 落 localStorage**

> **复验（task-9）：已修。** 证据 §6.3：`redactSecrets`（`playlistSync.service.ts:467-474`）去掉长度阈值，按值全量替换为 `***`；行为测试改为常规断言（3 字符口令不出现在 `lastError`）。

- **位置**：`packages/app/src/services/playlistSync.service.ts:406-413`（`redactSecrets`：`if (!value || value.length < 4) continue`）、`:520`（catch 里 `redactSecrets(...)` 后 `markSyncFailed`）；`packages/app/src/stores/syncStore.ts` `markSyncFailed` 把 payload 写进 `config.lastError`，而 `configs` 是 persist 的白名单。
- **复现**（已固化）：`packages/app/src/services/__tests__/verifyPlaylistSync.behaviour.test.ts:256` 的 `it.fails` —— 口令 `'abc'`（3 字符，例如某些 NAS 的短口令 / 用户输错的配对码），让 fetch 抛一个把 URL 带上的错误，`runtime.lastError`/`config.lastError` 里出现明文 `abc`；随后 `aurora-sync-state` 的 localStorage 里同样可见。
- **期望 vs 实际**：文档 §10/§15.3 要求「口令绝不进 lastError / 日志」；实现的有效性依赖口令长度 ≥4。
- **影响面**：短口令的直接泄漏（localStorage 与 UI 错误条）；概率取决于用户口令。
- **建议修法**：去掉长度阈值（宁可把短字符串也抹掉）；或按 secret 的 **key 名**脱敏（`password/code/token/sessionid`）而不是按值长度。

### S-7 `deletedAt: 0` 被当作墓碑起算 → 超 90 天的**活歌单**会被丢弃

> **复验（task-9）：已修。** 证据 §6.3：`isTombstoneExpired` 只认「正有限数」的 `deletedAt`（`snapshot.ts:197-201`），与 `merge.ts` 的 `tombstoneAtOf` 同口径；`verifySyncMerge.test.ts` 的 `deletedAt:0` 用例改为常规断言。

- **位置**：`packages/shared/src/plugin/sync/snapshot.ts:192-196`（`isTombstoneExpired`：`deletedAt` 非有限时回落 `updatedAt`；`deletedAt === 0` 也走回落）。对比 `merge.ts:61-62` 的 `isTombstone` 要求 `deletedAt` 是**有限正数**——两处口径不一致。
- **复现**（已固化）：`packages/shared/src/plugin/sync/__tests__/verifySyncMerge.test.ts:153` 的 `it.fails` —— 快照里一条 `deletedAt: 0`、`updatedAt` 为 100 天前的**活**歌单，在合并时被当作「过期墓碑」丢弃（`removed=1`）。
- **期望 vs 实际**：`0` 在 JSON 里常被当成「没有墓碑」的哨兵值（`merge.ts:90` 的 `deletedAt ?? 0` 也这么用）；期望「`deletedAt` 只有 >0 才算墓碑」。
- **影响面**：需要「外部快照显式写 0」才会触发；本仓库自己的 `serializeSnapshot` 不写 `deletedAt:0`（缺省省略），所以自产快照不受影响。属于跨实现/手写快照的边界。
- **建议修法**：`isTombstoneExpired` 改成 `if (!(typeof deletedAt === 'number' && Number.isFinite(deletedAt) && deletedAt > 0)) return false`，与 `merge.ts` 的 `isTombstone` 统一。

---

## 3. 建议

### N-1 无变化也 push / publish（每 5 分钟一次远端写入）

> **复验（task-9）：已修。** 内容哈希门控：`shouldWrite = merged.changed || lastPushedHash !== contentHash`（`playlistSync.service.ts:577-594`），push 与 publish 都受它约束。
`playlistSync.service.ts:496-502`：`push` 与 `lan.publish` 都不看 `merged.changed`。后果：WebDAV 场景下每台设备每 5 分钟 `PUT` 一次自己的快照文件，NAS 硬盘/笔记本电池长期被叫醒。配合 B-1 更糟。建议 `changed` 或「首次/设备信息变化」才写。

### N-2 占位曲目只增不减 + 占位 id 用 32 位哈希

> **复验（task-9）：部分修 → 仍有风险（接受）。** 占位 id 已升级为 64 位两段 FNV-1a（`playlistSync.service.ts:284-289`），碰撞面大幅收窄；**「占位只增不减」未改**，见 §6.7 风险 R-1（触发条件与影响已写清）。
`playlistSync.service.ts:268-270,359-367`：占位只补新 id、从不清理；`stableHash` 是 FNV-1a **32 位**（`:258-265`），两首不同歌理论上可撞成同一个 `sync:` id → 列表里显示成同一首。建议 64 位（或 UUIDv5(namespace, refIdentity)），并在歌单被删/引用消失时清理孤儿占位。

### N-3 收件箱无去重，且只有事件一条消费路径

> **复验（task-9）：已修。** 服务端收件箱改 `Map<deviceId, snapshot>`（每设备留最高 revision、同/低 revision 不覆盖也不触发回调、上限 20 按 LRU）；`initPlaylistSync` 启动时主动 `takeInbox()` 消费一次（`playlistSync.service.ts:890-896`）。
`lanSyncServer.ts:238-241`（只按容量 20 截断）、`packages/desktop/src/ipc/lanSync.ts` 的 `takeInbox` 只在 `lan:inbox` 事件里被渲染层消费。若渲染层尚未 ready（窗口未创建/刷新中），快照会堆到 20 条被旧数据挤掉。建议启动时（`initPlaylistSync`）主动 `takeInbox()` 消费一次。

### N-4 `clearSyncPluginsForTest` 从生产出口导出

> **复验（task-9）：未修 → 仍有风险（接受）。** 仍在 `packages/shared/src/plugin/sync/index.ts:39` 的导出列表；生产无调用点、无安全面，见 §6.7 风险 R-2。
`packages/shared/src/plugin/sync/index.ts`：测试钩子随 `export * from './plugin/sync'` 出到 `@aurora/shared` 公共 API。无实际攻击面（渲染层能清空注册表也只是让功能坏掉），但建议加 `if (import.meta.env?.MODE === 'test')` 或挪到 `__tests__/helpers`。

### N-5 `lan-sync` 卡片可见性依赖 bridge 注入时机

> **复验（task-9）：已修（顺序保证）/ 降级为理论风险。** `initPlaylistSync` 在 AppLayout mount 的 effect 里注入 bridge，设置面板只能在之后被用户打开；残余风险仅「未来若有代码在 init 之前渲染面板」。
`lanSyncPlugin.ts:174` 的 `available()` 判 `getLanSyncBridge() !== null`，bridge 在 `initPlaylistSync()`（`App.tsx:627-633` 的 effect）才注入；`PlaylistSyncPanel.tsx:55-58` 按 `available && enabled` 过滤。极早打开设置（首帧前）理论上会出现「卡片消失」。React effect 先于用户交互，实际几乎不可能命中，仅记录。

### N-6 周期同步不消费收件箱

> **复验（task-9）：已修。** `initPlaylistSync` 启动即 `bridge.takeInbox()` 消费积压（`:890-896`），并逐条走 `handleLanInbox`。
`handleLanInbox` 只在事件到达时处理；对端若在渲染层离线期间推送（服务在跑、窗口没开），inbox 里的快照不会被后续周期同步使用（周期同步走 pull）。不丢数据（对端会重推/可 pull），但与 B-1 的修复方向相关，记录。

---

## 4. 逐项核验记录（通过项）

### 4.1 安全（清单 1）
| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| 配对码/派生 key 是否进日志 | **未进**。全部 `createLogger` 调用点只记 `device` 前缀（8 位）、`port`、`status`、`reason`、`path`、`method`、`revision`、`inbox` 长度 | `lanSync.ts:161-605`、`lanSyncServer.ts:287,328,346,426`、`lanSyncDiscovery.ts:154-287` 逐一读过 |
| UDP 广播包是否含配对码 | **不含**。`parsePacket` 白名单 `kind/proto/deviceId/deviceName/port`，无 code | `lanSyncDiscovery.ts:79-102` |
| `lastError` 是否泄漏秘密 | **大部分安全**（走 `redactSecrets`），但 <4 字符盲区见 S-6 | `playlistSync.service.ts:406-420` |
| persist settings / localStorage 是否含秘密 | WebDAV `password` **不进**（`syncConfigCards.tsx:199-217` 只把 `kind==='password'` 喂 secrets）；LAN 对端 code **进了**（S-3） | `syncStore.ts:136-140`、`PlaylistSyncPanel.tsx:112-124` |
| safeStorage 不可用时是否拒绝写明文 | **拒绝**。口令：`syncCredentials.ts:86-89` 返回 `{saved:false}` 且不建目录；底层 `pluginCredentials.ts:65-67` 也 throw。配对码：`persistPairCode` 直接 return、`ensurePairCode` 只 log「kept in memory only」 | 新增测试 `packages/desktop/src/ipc/__tests__/verifySyncCredentials.test.ts`（6 passed，含「加密不可用 → 目录都不创建」「磁盘不含原文」「0600」） |
| nonce 重放窗口 / 时间偏差 | ±300s 时钟偏差；nonce TTL 300s、容量 4096（文档写 10 分钟 → S-4b）；**验签通过后才 remember** | `lanSyncAuth.ts:44-50,186-291` |
| HMAC 是否常量时间 | **是**：先比长度（不等直接 false）再 `timingSafeEqual` | `lanSyncAuth.ts:235-240` |
| `PUT /v1/snapshot` body 上限 / JSON 校验 / 路径与方法校验 | 5MB 上限（超限 `resume()`+reject）、非 `snapshot` 结构 400、非 `/v1/snapshot` 404、非 GET/PUT 405 | `lanSyncServer.ts:173-202,305-352` |
| `lan:publish` 是否原样接受快照 | **先验 format**：`isSyncSnapshot` 不过直接 throw `sync.error.snapshotInvalid`；`lan:push` 同样先验 | `lanSync.ts:521-531`、`pushToPeer` 首行 |

### 4.2 隐私（清单 2）
- 快照字段白名单：`SyncTrackRef` 只有 `title/artist/album/duration` + 三档坐标（local.path / storage.pluginId+relPath / meta.onlineId+platform+coverUrl），**无** `playCount/liked/lastPlayedAt/sourceId`，**无**音频地址。测试钉住：`verifyPlaylistSync.behaviour.test.ts:182`（序列化文本不含 `playCount/liked/lastPlayedAt/sourceId/http`）。
- 占位 `importedTracks` **不污染曲库**：`importedTracks` 只在 `packages/app/src/pages/PlaylistPage.tsx:64,79-81` 用于歌单成员解析（`tracks.find(...) || importedTracks[tid]`），`libraryStore` 不读它。

### 4.3 合并正确性（清单 3）
`packages/shared/src/plugin/sync/__tests__/verifySyncMerge.test.ts`（12 passed）钉住：幂等 ✓；交换 ✓（歌单级）；同 `updatedAt` 按快照 deviceId 字典序 ✓；恰好 90 天仍算墓碑 / +1ms 过期 ✓；`deletedAt` 缺失=活歌单 ✓；`pruneSnapshot` 幂等且不抬 `updatedAt` ✓；缺 format / 旧 format / `playlists` 非数组 → 整份拒绝且错误码可区分（`snapshotInvalid` / `snapshotVersion`）✓；单条坏 playlist → 整份拒绝 ✓。不满足项见 S-2（结合律）、S-7（`deletedAt:0`）、S-5（未净化快照让 merge 抛错）。

### 4.4 曲目身份五档（清单 4）
`packages/shared/src/plugin/sync/__tests__/verifySyncTrackRef.test.ts`（10 passed）：
1. 本机绝对路径：大小写不同 ✓；Windows 反斜杠 ↔ 正斜杠互命中 ✓（`normalizePathKey`）；
2. 同名+时长：差 ≤1s 命中 ✓；同名不同版本（差 >1s）→ `null` ✓；
3. storage 相对路径：同一插件、**不同 sourceId / 不同挂载点**仍命中 ✓；relPath 带反斜杠/前导斜杠 ✓；
4. 在线身份：`platform+onlineId` 命中 ✓；platform 不同不误配 ✓；
5. `null` 时 app 侧登记占位而非丢曲 ✓（`applySyncedPlaylists:340-342` + `verifyPlaylistSync.behaviour.test.ts:217`「同快照应用两次不会重复登记占位」）。
另：`toSyncTrackRef` 对 storage 路径编码时**不带绝对路径** ✓；无 path 的占位编码成 `meta`、不伪造 local path ✓。

### 4.5 破坏性风险（清单 5）
- **不覆盖统计**：`applySyncChanges` 只替换 `{id,name,createdAt,updatedAt,trackIds}` 五个字段（`Playlist` 类型就只有这些，`packages/app/src/types/index.ts:160-166`；`playlistStore.ts:155-196` 的 upsert 是原位替换），`playCount/liked/lastPlayedAt` 在 `Track` 上、不在歌单上，且 `libraryStore` 从不被 `applySyncedPlaylists` 写。
- **不删快照里没有的本地歌单**：`deletes` 只来自 `tombstones ∩ 本地存在`（`playlistSync.service.ts:354`）；测试 `verifyPlaylistSync.behaviour.test.ts:203` 确认 absent 歌单保留。
- **不重复登记占位**：`:362` `if (store.importedTracks[id]) continue`，测试确认第二次 0。
- **串行锁真实有效**：`running: Map<configId, Promise>`（`:391,456-464`），撞车复用同一 Promise；测试 `verifyPlaylistSync.behaviour.test.ts:233` 确认失败后锁释放、runtime 能回 `ok`（不会永久 running）。早退路径（plugin 不存在/不可用，`:473-477`）在 try 内、finally 仍执行。
- 唯一与「破坏性」相关的真实问题是 B-1（互推环）与 S-1（changed 恒 true）。

### 4.6 平台边界（清单 6）
- web：`packages/app/src/services/platform/web.ts` `supportsPlaylistSync: false, lanSync: null`；mobile：`mobile/index.ts` 同（类型 + 实现）；`createPlatform` 兜底同样为 `false`（`platform/index.ts:1181-1183`）。
- 入口判定：`PluginManagerPanel.tsx` / `PluginSettingsDialog.tsx` 的 sync 面只由 `syncCapabilityOf(platform.supportsPlaylistSync)` 提供，`pluginConfig.ts` 的 `configsOfPlugin` 也不会给非 sync 插件配 sync 配置 → web/mobile 无入口 ✓；`PlaylistSyncPanel.tsx:126-128` 还有一层 `supported` 兜底。
- LAN 未开启时的行为：引擎每轮仍 `lan.publish`（只写主进程内存缓存，见 N-1），不会报错；`lan:status` 返回 `running:false`；UI 显示未开启 ✓。
- 端口占用顺延：`lanSyncServer.ts` 仅 `EADDRINUSE` 才 +1，最多 20 次；已有测试 `lanSyncServer.test.ts:252-270` 覆盖「耗尽 → EADDRINUSE」✓。
- `available()` / bridge 注入时机：见 N-5（低风险）。

### 4.7 工程门禁（清单 7，本机实测）
| 命令 | 退出码 | 输出摘要 |
| --- | --- | --- |
| `pnpm --filter @aurora/app exec tsc --noEmit` | 0 | 无输出（app 无 `typecheck` script，按任务要求用 `exec tsc`） |
| `pnpm --filter @aurora/shared test` | 0 | `Test Files 68 passed (68)` / `Tests 1359 passed`（含我新增的 2 个 shared 用例文件 22 条） |
| `pnpm --filter @aurora/desktop test` | 0 | `Test Files 22 passed (22)` / `Tests 287 passed`（含我新增的 6 条） |
| `pnpm verify:i18n` | 0 | 未国际化中文 0 条；en 字典无中文残留 |

既有失败 `packages/app/src/components/common/__tests__/lxSourceForm.test.ts:95`（工作区未提交的 i18n 文案导致）**未触碰、未修**，与本任务无关。

---

## 5. 我实际验证过什么 / 没验证到什么

### 实际做过（可复核，首轮记录；复验轮见 §6.6）
1. **逐行读过**全部 shared sync 实现、desktop 五个 IPC 文件、app 引擎/商店/三个组件/平台层，并用 `git diff` 核对了 `handlers.ts`、`preload.ts`、`main.ts`、`App.tsx`、`playlistStore.ts`、`platform/*` 的接线（只读）。
2. **自造用例实跑**（4 个新文件，共 37 条用例，全部通过；其中 3 条是 `it.fails` 固化的「当前实现不满足契约」）：
   - `packages/shared/src/plugin/sync/__tests__/verifySyncMerge.test.ts`（12）：幂等/交换/并列/结合律反例/墓碑 90 天边界/坏快照。
   - `packages/shared/src/plugin/sync/__tests__/verifySyncTrackRef.test.ts`（10）：五档解析 + 跨平台路径。
   - `packages/app/src/services/__tests__/verifyPlaylistSync.behaviour.test.ts`（9）：收敛性、不误删、占位幂等、锁释放、短口令泄漏、无变化仍 push、inbox 放大、字段白名单。
   - `packages/desktop/src/ipc/__tests__/verifySyncCredentials.test.ts`（6）：加密不可用拒绝写盘、0600、无明文、空载荷清除、非法 id。
3. **跑过**上表四条门禁命令；另外单独跑过 `vitest run` 单个新文件（用于调试 API 形状，最终全绿参与套件）。
4. **静态审计**：对所有 `createLogger` / `log.*` 调用点做泄漏面复核；对 `webdav.ts` 的 fetch 出口做全仓搜索（确认无注入接缝）；对 `Access-Control-Allow-Origin` / `webSecurity` / `loadFile` 做全仓搜索（确认 B-2）。

### 没验证到 / 未跑的命令（原因）
- **没有真的双机跑局域网互推环**（B-1）：只跑了一个单机的行为测试（一次 inbox → ≥2 次 publish + 触发 pull），以及读了服务端/引擎代码推导出闭环。真实两机观测需要两台机器或两个 Electron 实例 + 不同 userData，本轮不具备条件。**建议 Lead 让 owner 修完后用两个实例回归**。
- **没有在打包产物里实测 WebDAV CORS**（B-2）：需要 `build:dir` + 一个真实 WebDAV 服务器（本机没有可用账号，且打包耗时）；结论由「webSecurity/loadFile/全局 fetch/无注入接缝」四条静态事实推出，属于高置信度推断而非实测。**建议 owner 修完后用打包产物 + 任意 Nextcloud 复验**。
- **没有跑桌面端手动 UI 回归**（打开设置页、配对、轮换配对码、端口占用时开启服务）：需要 GUI 交互与第二台设备；只核对了 IPC 通道名与 preload 形状。
- **没有跑 mobile/web 端的实际构建**：只核对了 `supportsPlaylistSync: false` 与 surface 判定；`pnpm --filter @aurora/mobile ...` 未执行（与本任务无关且耗时长）。
- **没有验证 Windows/macOS 的真实路径行为**：Windows 反斜杠只在单测里用字符串模拟（`verifySyncTrackRef.test.ts`），未在 Windows 上跑。
- **没有验证 `safeStorage` 在真实无 keyring 的 Linux 上的行为**：用 `vi.mock('electron')` 模拟 `isEncryptionAvailable() === false`（`verifySyncCredentials.test.ts`），未在真机上验证 `sync:credential:state` 的 UI 提示。
- 没有跑 `pnpm -r build` / `pnpm --filter @aurora/desktop build`（本轮只做静态 + 单测验证，构建链不在任务范围）。

---

## 6. 复验结论（task-9）

> 复验对象：task-6（shared-core）、task-7（desktop-lan）、task-8（app-sync）修复后的当期工作区。
> 口径按 Lead 三条判定：**S-5 = 边界上移**（`parseSnapshot` 是唯一结构边界，不复要求 merge 自防御）、
> **S-2 用对拍**（`merge(merge(a,b),c)` vs `merge(a,merge(b,c))`，输入必须含「时间戳完全并列但内容不同」）、
> **`sync:fetch` 的 tooLarge 是抛错 + `detail:'tooLarge'`**（不是 413），3xx 原样返回是设计。
> 所有门禁都是**复验当期本人实跑**（命令与退出码见 §6.5）。

### 6.0 结论表

| 条目 | 首轮定级 | 复验状态 | 关键证据 |
| --- | --- | --- | --- |
| B-1 局域网互推环 | 阻断 | **已修** | 双引擎收敛测试（§6.1）：轮数有界、两端内容哈希相等、publish 收敛到 0 |
| B-2 WebDAV 被 CORS 拦 | 阻断 | **已修（接缝闭合）**／真机回归待人工 | `setWebdavFetch` + `sync:fetch` 三链闭合（§6.2） |
| S-1 changed 恒 true | 应修 | **已修** | `restampedUpserts` 只采纳时间戳；第二轮 `changed=false` |
| S-2 不满足结合律 | 应修 | **已修** | `canonical.ts` 内容全序；3 条对拍用例全绿 |
| S-3 配对码进 localStorage | 应修 | **已修** | `code` 改 password 字段 + `stripSecretSettings` + 历史迁移 |
| S-4 文档与鉴权不一致 | 应修 | **已修** | 文档 §7/§15.3 已按实现改写 |
| S-5 坏快照让 merge 抛错 | 应修 | **已修（边界上移）** | 五条入口全部先过 `parseSnapshot`（§6.4） |
| S-6 短口令脱敏盲区 | 应修 | **已修** | `redactSecrets` 去掉长度阈值 |
| S-7 `deletedAt:0` 边界 | 应修 | **已修** | `isTombstoneExpired` 只认正有限数 |
| N-1 无变化也写远端 | 建议 | **已修** | 内容哈希门控 `shouldWrite` |
| N-2 占位只增不减 / 32 位 id | 建议 | **部分修 → 接受风险 R-1** | id 已 64 位；清理逻辑未做 |
| N-3 收件箱无去重 | 建议 | **已修** | 按 `deviceId` 去重 + 启动主动 `takeInbox()` |
| N-4 测试钩子出生产口 | 建议 | **未修 → 接受风险 R-2** | 仍在导出列表 |
| N-5 bridge 注入时机 | 建议 | **已修（顺序保证）** | init 在面板打开前完成 |
| N-6 周期同步不消费收件箱 | 建议 | **已修** | 启动消费积压 |

**一句话结论**：两条阻断与七条应修在**代码接缝层面都已闭合，并有本人实跑证据**；剩余 2 条接受风险
（R-1/R-2）都不影响数据正确性、不需要 release 前处理；但 **B-2 的端到端（打包产物 + 真实 WebDAV）与
双机真实局域网仍未实测**，建议在 release 前手工回归一次（清单见 §6.6）。

---

### 6.1 B-1（互推环）——双引擎收敛证明 ★本轮最重要证据

**测试**：`packages/app/src/services/__tests__/verifySyncConvergence.test.ts`（1 条，通过）。

**构造**：用 `vi.resetModules()` 给 A/B 两台「设备」各一份**独立模块图**（各自独立的
`playlistSync.service` 单例、独立的 zustand store、独立的 shared 注册表），`vi.hoisted` 共享一个
`mocks.platform`（`sync.device` 按当前设备返回、`onLanSyncInbox` 捕获回调），并把 `lanSync` 换成
**假 `LanSyncBridge`**：

- `publish(snapshot)` / `pushPeer(target, snapshot)` → 投递到 `bus.toPeer`，同步调用对端 `deliver(inbox)`；
- `pullPeer()` → 返回对端**当前**的 `snapshotFromStores()`（模拟真实 `GET /v1/snapshot`）；
- `takeInbox()` 取走本端收件箱。

**场景**：两端各有 `pl-0`（updatedAt 100，内容相同），A 本地新建 `pl-1`（updatedAt 200）；
`await A.svc.syncAllNow()` 触发首轮（先断言 `A.counters.publish + A.counters.push > 0`，证明场景非空转；
若首轮就是 0，说明测试根本没打到同步路径，后面的收敛断言毫无意义），随后循环最多 10 轮「互投 + flush」。

**断言（全部通过）**：

| 断言 | 期望 | 旧实现的预期行为 |
| --- | --- | --- |
| `rounds < 10` | 轮数有界（实际 2 轮即静默） | 跑满 10 轮（每轮都有 publish 投递，永远不静默） |
| `A.snapshotContentHash(snapA) === B.snapshotContentHash(snapB)` | 两端最终内容完全一致 | 内容可能一致，但会持续互推 |
| 最后一轮 `publishesInLastRound === 0` | 收敛后不再 publish | 恒 > 0 |
| `A.counters.publish <= 1 && B.counters.publish <= 1` | 每端最多一次主动发布 | 每端每轮一次，10 轮 ≥10 次 |
| 两端 playlist ids 都是 `['pl-0','pl-1']` | 数据正确 | — |
| 再手动 `syncAllNow()` 两端 → 总计数不变 | 不动点**不依赖冷却计时器**（不是靠 5s 冷却「看起来停了」） | 每轮计数 +2 |

**对应的实现改动（复验时逐一读过原文）**：

- 内容哈希门控：`playlistSync.service.ts:577-594`
  `const contentHash = snapshotContentHash(merged.snapshot); const lastPushedHash = runtime[config.id]?.lastPushedHash ?? null; const shouldWrite = merged.changed || lastPushedHash !== contentHash;`
  → 只有 `shouldWrite` 才 `plugin.push` / `lan.publish`，写入成功才 `markPushed(config.id, contentHash)`。
- `handleLanInbox`（`:776-801`）：先算 `mergedHash` 与本轮 `incomingHashes`；
  `if (incomingHashes.has(mergedHash)) lastInboxPublishHash = mergedHash`（**对端给的就是我合并后的内容 → 不回推**），
  `else if (mergedHash !== lastInboxPublishHash) publish(...)`。
- `syncConfigsAfterInbox`（`:808-820`）：只同步 enabled + autoSync + 不在 `INBOX_SYNC_COOLDOWN_MS`（5000ms）
  冷却 + 不在退避窗口内的配置，且先统一记账再逐个 `syncOnce`（不会自激）。
- 服务端收件箱：`lanSyncServer.ts` 的 `pushInbox` 改 `Map<deviceId, snapshot>`，每设备留最高 `revision`，
  同/低 revision 的重复 PUT 既不覆盖也不触发 `onSnapshot`（`lanSyncServer.test.ts:195/207/220/236/256`）。

**仍未覆盖**：假桥是**同进程同步投递**，没有真实 HTTP 往返延迟、没有时钟偏差、没有「PUT 在途时又来一份」
的竞态；这些留给双机回归（§6.6）。

---

### 6.2 B-2（CORS）——三链闭合

| 链 | 事实 | 位置 |
| --- | --- | --- |
| ① 注入 | `initPlaylistSync` 调 `setWebdavFetch(platform.syncFetch ?? null)`；`disposePlaylistSync` 调 `setWebdavFetch(null)` 还原 | `playlistSync.service.ts:861` / `:910` |
| ② 传输 | `platform.syncFetch = createSyncFetch(api)` → `api.sync.fetch`（preload）→ `ipcRenderer.invoke('sync:fetch')` → 主进程 `registerLanSyncIpc` 注册的通道 | `platform/index.ts:1019,1313-1352`；`preload.ts:261-277` |
| ③ shared 出口 | `webdav.ts` 的 6 处 `fetchWithTimeout(...)` 全部把 `webdavFetch()` 作为第 4 参传入；全仓 `grep "[^a-zA-Z.]fetch("` **无命中** | `webdav.ts:517/602/643/758/807/852`（`webdavFetch()` 共 7 处命中） |

`sync:fetch` 的主进程实现（task-7）已由 15 条测试覆盖：仅 `http:`/`https:`（拒 `file:`/`data:`/相对地址/URL 内嵌凭据）、
拒 CRLF 头注入与 `CONNECT`/`TRACE`、`redirect:'manual'`（3xx 原样返回）、默认 15s / 上限 60s / 响应体 8MB、
超限抛结构化错误（`detail:'tooLarge'`）、日志只记 method + host + status + 耗时、
错误用 `AURORA_ERR` 信封回传（`syncFetch.test.ts:108-321`）。

**残余**：
1. `createSyncFetch` 在 `api.sync.fetch` 不存在时返回 `undefined` → 引擎回落到全局 fetch（老 preload 的 profile
   仍会被 CORS 拦）。同版本 preload 与渲染层一起发版，因此只影响「旧 preload + 新 bundle」的错配（热更新/半升级），
   不构成 release 阻断，但值得在升级说明里提一句（R-3）。
2. `init.signal` 被忽略（主进程通道无 AbortSignal 语义），取消依赖 `timeoutMs`；对 WebDAV 插件无影响（它本就不传 signal）。
3. **端到端未实测**：打包产物 + 真实 WebDAV 服务器（见 §6.6）。这是「接缝闭合」而非「功能已验证」的分界。

---

### 6.3 S-1～S-7 逐条复核

| 条目 | 状态 | 复验证据（cat 过的原文 / 实跑） |
| --- | --- | --- |
| S-1 | 已修 | `applySyncedPlaylists` 新增 `restampedUpserts`（`:398-400`）：内容相同但 `updatedAt/createdAt` 不同 → 只写时间戳；`hit` 用例：远端 500 / 本地 100 → 本地变 500，第二轮 `changed=false` |
| S-2 | 已修 | `canonical.ts` 的 `canonicalPlaylist` 参与 tiebreak（`merge.ts` 判定顺序 updatedAt → `tombstoneAtOf` → canonical 字典序，与来源设备无关）；`verifySyncAssociativity.test.ts` 3 条对拍全绿 |
| S-3 | 已修 | `lanSyncPlugin` 的 `code` 改 `kind:'password'`；`syncStore.ts:12,103-122,131-143,156,167`（`SECRET_SETTING_KEYS`、`stripSecretSettings`、`pendingSecretMigrations`、`migratePersistedSyncState`、add/update 剥字段）；`initPlaylistSync:864` 的 `flushSecretMigrations()` 把历史 code 送 `saveCredential`；行为测试断言 `settings` 只剩 host/port 且迁移调用发生 |
| S-4 | 已修 | `docs/playlist-sync.md:235`（hello 一律验签）、`:246`（K 上下文串 `aurora-lan-sync/v1`）、`:252`（nonce 5 分钟/4096/验签后入表）、`:528-532`（头与 payload、`|now-ts| <= 300_000`、常量时间） |
| S-5 | 已修（边界上移） | 见 §6.4 |
| S-6 | 已修 | `redactSecrets`（`:467-474`）遍历所有 secret 值做 split/join → `***`，无长度阈值；行为测试：3 字符口令不出现在 `lastError` |
| S-7 | 已修 | `isTombstoneExpired`（`snapshot.ts:197-201`）只认正有限数；`deletedAt:0` + 超 90 天的活歌单保留（`verifySyncMerge.test.ts` 常规断言） |

---

### 6.4 S-5 边界清单（「所有生产入口都先过 `parseSnapshot`」）

| 入口 | 调用链 | 结论 |
| --- | --- | --- |
| WebDAV pull 解析文件 | `webdavSyncPlugin.ts:168` `parseSnapshot(text, file)`，坏文件只跳过该文件 | ✅ |
| LAN `PUT /v1/snapshot` | `lanSyncServer.ts:142` `normalizeSyncSnapshot` → `:131` `parseSnapshot(JSON.stringify(value))` | ✅（坏包 400 `snapshot`） |
| `lan:pull` | `lanSync.ts:470` `normalizeSyncSnapshot(parsed)` 后返回 | ✅ |
| `lan:push` | `lanSync.ts:493` 发送前 `normalizeSyncSnapshot(snapshot)` | ✅ |
| `lan:publish` | `lanSync.ts:532` 缓存前 `normalizeSyncSnapshot(snapshot)` | ✅ |

`mergeSnapshots` 的生产调用点只有两处：`playlistSync.service.ts:565`（`runSync` 的 pull 结果）与
`:783`（`handleLanInbox` 的 inbox 快照），两者入参均来自上述已归一化路径 —— 边界上移成立。

口径细节（与 task-9 原文「缺 tracks 的 PUT 返回 400」的差异，按 Lead 后续口径判定为**合法**）：
`normalizePlaylist`（`snapshot.ts:101-128`）对 `tracks` **缺失**是宽容的（归一化成 `[]`，老快照不崩渲染层），
只有 `tracks` **不是数组**才 throw 整份拒绝（`lanSyncServer.test.ts:299` / `:315`）。
两种处理都发生在边界内，merge 永远拿不到非数组 `tracks`；如果团队后续要求「缺 tracks 也整份拒绝」，
那是在边界策略上更严的一档，不影响本轮「无坏结构进 merge」的结论。
`verifySyncMerge.test.ts:199` 的「坏输入 → 抛错」按口径**保留为期望**，不是缺陷。

---

### 6.5 工程门禁（复验当期，工作目录为仓库根）

| 命令 | 退出码 | 输出摘要 |
| --- | --- | --- |
| `pnpm --filter @aurora/shared build` | **0** | `tsc && tsc -p tsconfig.esm.json`，dist 含 `snapshotContentHash` / `setWebdavFetch` |
| `pnpm --filter @aurora/shared typecheck` | **0** | 无输出 |
| `pnpm --filter @aurora/shared test` | **0** | `Test Files 71 passed (71)` / `Tests 1389 passed`（含我新增的 3 条结合律用例） |
| `pnpm --filter @aurora/app exec tsc --noEmit` | **0** | 无输出（app 无 `typecheck` script） |
| `pnpm --filter @aurora/app test` | **1** | `64 files / 775 tests`，**唯一失败** `src/components/common/__tests__/lxSourceForm.test.ts:95`（既有 i18n 文案，任务明确不修）；其余 774 全绿（含我 12 条） |
| `pnpm --filter @aurora/desktop typecheck` | **0** | `tsc --noEmit -p tsconfig.electron.json && tsc -p tsconfig.test.json` |
| `pnpm --filter @aurora/desktop test` | **0** | `23 files / 311 tests passed`（含 lanSyncServer 27、syncFetch 15、verifySyncCredentials 6） |
| `pnpm verify:i18n` | **0** | 未国际化中文 0 条；白名单 4 项；en 无中文残留 |
| `pnpm --filter @aurora/app build` | **0** | `tsc && vite build`，`dist/assets/index-*.js 1,643.73 kB`（仅既有 chunk 体积告警） |

**如实记录一次 flake**：desktop 套件的首跑是与 `app test`、`app build` 三套**并发**执行的，
结果是 `1 failed | 310 passed`（tail 截断没捕获到用例名）；随后**隔离复跑 311/311 全绿**（EXIT 0）。
判定为并发负载下的既有超时 flake（`pluginHost` 系列本就有 5s 超时），不是本轮改动引入；
但我没有复现出原始失败用例名，这一条按「未定因」记录。

---

### 6.6 复验轮我实际验证过什么 / 没验证到什么

**新增/修改的证据测试（全部本人实跑通过）**

| 文件 | 条数 | 用途 |
| --- | --- | --- |
| `packages/app/src/services/__tests__/verifySyncConvergence.test.ts`（新增） | 1 | B-1 双引擎收敛（§6.1） |
| `packages/shared/src/plugin/sync/__tests__/verifySyncAssociativity.test.ts`（新增） | 3 | S-2 结合律对拍（并列 + 墓碑混合） |
| `packages/app/src/services/__tests__/verifyPlaylistSync.behaviour.test.ts`（扩展） | 11 | S-3 剥秘密字段/迁移、S-1 时间戳收敛、脱敏、字段白名单等 |
| `packages/shared/src/plugin/sync/__tests__/verifySyncMerge.test.ts`（注释更新） | 12 | 幂等/交换/并列/墓碑边界（两条 `it.fails` 已转常规断言） |

**实际做过的核验**：逐行读过 task-6/7/8 的 diff 与最终文件（`canonical.ts`、`snapshot.ts`、`merge.ts`、
`lanSyncPlugin.ts`、`webdav.ts`、`syncFetch` 主进程实现、app 引擎/inbox/迁移、syncStore、platform 层）；
`grep` 核过「`mergeSnapshots` 调用点」「`parseSnapshot` 调用点」「`normalizeSyncSnapshot` 用户」
「裸 `fetch(`」「`it.fails(`」「`clearSyncPluginsForTest`」；跑了 §6.5 全部 9 条命令。

**没验证到（含原因）**

1. **B-2 端到端**：没有用 `pnpm --filter @aurora/desktop build:dir` 打产物 + 真实 WebDAV 账号实测。
   原因：本机没有可用 WebDAV 凭据，且打包耗时；结论以「三链接缝闭合 + 主进程通道 15 条测试」为依据。
   **建议 release 前手工回归**：打包 → 配任意 Nextcloud/坚果云 → 同步成功且 DevTools 无 CORS 报错。
2. **双机真实局域网**（真实 HTTP、时钟偏差、并发 PUT）：只有同进程假桥的收敛证据。
   **建议**：两个 Electron 实例（不同 userData）+ 同一网段，互配 lan-sync，观察 10 分钟内 `lan:publish` 次数。
3. **GUI 手工回归**：配对、轮换配对码、端口占用提示、设置面板迁移提示均未点过。
4. **Windows/macOS 路径**、**真实无 keyring 的 Linux safeStorage**、**mobile/web 构建**、**desktop 打包链**：未跑。
5. docs 只在 §7/§15 口径层面核对了一致性，未做第三方按文档实现的互通验证。

---

### 6.7 剩余风险（release 前判断）

| # | 风险 | 来源 | 触发条件 | 影响 | release 前是否必须处理 |
| --- | --- | --- | --- | --- | --- |
| R-1 | 占位曲目只增不减（`importedTracks` 里的 `sync:` 条目永不清理） | N-2 未修部分 | 长期同步、对端曲目在本机持续解析不到 | 占位条目随歌单引用累积；不污染曲库列表，只占 persist 空间与内存 | **不必**；建议在后续版本做「引用消失即清理」 |
| R-2 | `clearSyncPluginsForTest` 仍从 `@aurora/shared` 导出 | N-4 | 渲染层/第三方代码误用 | 仅能让同步功能失效，无安全面 | 不必 |
| R-3 | 旧 preload（缺 `sync.fetch`）+ 新渲染层 → `syncFetch` undefined → 回落全局 fetch，仍受 CORS | B-2 残余 | 半升级/热更新 | WebDAV 同步失败（报 `webdavConnect`） | 不必（同版本一起发）；升级说明提一句 |
| R-4 | `init.signal` 被忽略、假桥未覆盖真实网络时序 | B-1/B-2 测试边界 | 真实网络 | 取消不及时；收敛行为需真机确认 | 不必，但**建议**按 §6.6 做一次真机回归 |
| R-5 | inbox 冷却（5s）期间到达的快照不会立即触发主动拉取，靠 5 分钟周期兜底 | task-8 设计 | 高频双端编辑 | 最坏 5 分钟延迟，不丢数据 | 不必 |
| R-6 | `pnpm --filter @aurora/app test` 仍有 1 条既有失败（lxSourceForm i18n 文案） | 既有工作区改动 | 每次跑 app 套件 | 门禁「非全绿」需人工辨识 | 不必（任务明确不修），但**发布前应让文案 owner 收口** |
