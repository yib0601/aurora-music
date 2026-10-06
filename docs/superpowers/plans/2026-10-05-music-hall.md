# 音乐馆（推荐歌单 + 排行榜）实施计划

> **Goal:** 新增顶级页「音乐馆」——推荐歌单 + 歌曲排行榜 + 点开的歌单/榜单详情，数据由本地 QQ_Music 服务新增的三个只读端点提供。原「音乐库」页当时更名「本地音乐」（**路由 `/library` 保持不变**）。不做电台。
>
> **命名现状（2026-10-06 两轮修订后，以此为准）**：曲库页 = **我的音乐**（`LIBRARY_LABEL`），
> 本页 = **在线音乐**（`HALL_LABEL`），导航按「我的」/「在线」分组。
> 文中「音乐库 / 本地音乐 / 音乐馆」均为历史称谓，见 §一「修订」与「修订二」。

**Architecture（三层，全部走既有协议，不新增第三方依赖）：**

1. **QQ_Music**（`/home/yibin/Code/QQ_Music`）：新增 `lib/qqchart.js` + 三条只读路由，复用既有鉴权、脱敏、歌单直取链路。上游全走 QQ legacy 接口，**无签名、无 g_tk、无 Cookie**（已实测）。
2. **@aurora/shared**：`AuroraEndpoints` 由 2 个端点扩到 5 个，新增只读执行器 `musicHall.ts`（容错解析），与 `musicSource.ts` 同构。
3. **@aurora/app**：新增 `MusicHallPage`（推荐歌单 + 排行榜）+ `MusicHallDetailPage`（歌单/榜单共用），**在线即点即播、不入库不下载**；点开歌单后按名搜索取址，复用既有 `ensurePlayableTrack` 链路。

**Tech Stack:** Node 20（零依赖服务端）/ TypeScript / React 18 / Zustand 5 / react-router 6 / Tailwind / Vitest。

---

## 一、已冻结的决策

| 项 | 决定 | 理由 |
| --- | --- | --- |
| 原「音乐库」 | 更名**本地音乐**，路由 `/library` 不动 | 文案与 label 已全部改完（见 §2.3）；**已两次推翻**，见下方「修订」 |
| 新页名 | **音乐馆** | 用户指定；**已于 2026-10-06 改为「在线音乐」**，见「修订二」 |
| 数据来源 | QQ_Music 服务端新增端点 | 保持项目「应用不内置任何平台抓取器」的免责架构；客户端只认协议 |
| 歌单交互 | 在线**即点即播**，歌单临时展示 | 用户选定；不落库、不下载，在线地址易失问题天然规避 |
| 电台 | **不做** | 用户明确排除；图片中的「有声电台/推荐有声电台」区块不实现 |
| 顶部轮播 banner | **首版不做** | QQ 无对应免登录上游；若要做需另找接口，列为 P2 |
| 排行榜 | 做「榜单列表 + 榜单详情（含排名序号）」 | 用户明确要「歌曲排行的功能」 |
| 主屏语义 | **保持 `/library`（我的音乐）为首页与「再按一次退出」主屏** | 用户否决「音乐馆当首页」；在线音乐是普通页 |
| 路径字面量 | **收敛到 `lib/routes.ts` 唯一事实源** | 用户要求；已完成（见 §2.3） |

### 修订（2026-10-06）：页面名回到「音乐库」

用户要求改回「音乐库」，理由是**应用默认落地页就是这一页**，它就是产品口中的「音乐库」。
改名不是逐处替换字面量，而是新增 `LIBRARY_LABEL` 常量（`lib/routes.ts`）作为该页用户可见名称的
唯一事实源，导航 label、页面标题、两处 toast、三处空态按钮、设置页章节标题与两处移除确认文案、
歌曲详情加载态、搜索浮层提示均由它渲染；下次改名只动一行。设置页的「音乐库根目录」
（WebDAV 来源配置项）语义不同，不参与改名，保持字面量。

### 修订二（2026-10-06）：两页改名「我的音乐 / 在线音乐」＋ 导航分组

用户反馈**「音乐库和音乐馆这个标识不够明确，分不清楚什么是做什么的」**。诊断出三个叠加缺陷：

1. **同词根 + 同语义维度**：「音乐**库**」与「音乐**馆**」都是「盛放音乐的容器」隐喻的近义词，
   只差一个字，扫读时必须读到第二个字才能分辨。
2. **图标不承载语义**：`Music` 音符是「音乐」泛称、两页都适用；`Compass` 罗盘是「探索」隐喻，
   与「馆」字不合拍，也没表达「在线/别人提供的」这层关键差异。
3. **无分组**：本地资产与在线来源平铺在同一层，结构上看不出它们不是一类东西。

**改法（换到互斥属性轴：所有权/来源）**：

| 项 | 旧 | 新 | 理由 |
| --- | --- | --- | --- |
| 曲库页名 | 音乐库（→本地音乐） | **我的音乐** | 用户扫描入库的本地/WebDAV 资产，长期有效、离线可播 |
| 在线页名 | 音乐馆 | **在线音乐** | 音源服务实时提供的推荐与榜单，即点即播、不入库 |
| 曲库项图标 | `Music` | `Library` | 「我的收藏库」意象，与 `Radio` 构成「本机 vs 广播」对照 |
| 在线项图标 | `Compass` | `Radio` | 表达「由外部服务实时提供」，不再用「探索」隐喻 |
| 导航结构 | 平铺 5 项 | 组「我的」（我的音乐/收藏/最近播放）+ 组「在线」（在线音乐）+ 组外「设置」 | 从结构层画出「东西从哪来」 |

**关键约束（改动时勿违反）**：

- 组标题用「我的」「在线」，**不能**写成「我的音乐」「在线音乐」：会与项名逐字重复。
  组名称「我的」的依据是「收藏 / 最近播放」跨来源：**最近播放**确实统一登记本地与在线曲目
  （`libraryStore.recentPlayedTracks` 的「本地 + 在线统一记录」）；**收藏**入口对在线曲目开放
  （`SongDetailPage` 与 `MobileNowPlaying` 都调 `toggleLiked`），但 `toggleLiked` 只在本地
  `tracks` 里查 id，在线曲目命中不到、**静默空转**（既有缺陷，不在本次范围内）。
  两者都属「你的行为记录」，故组名取「我的」而非暗示本地专属的「我的音乐」。
- 「在线音乐」非新造词：改动前已作为**来源泛称**用于 `SearchOverlay` 的来源徽章兜底名与
  结果分组名、`SongDetailPage` 的来源标签（`'在线音乐' : '本地'`）。那是「曲目来自哪个源」的
  标签，与导航项「在线音乐」字面相同但**语义层不同**，无运行时冲突，不因本次改名而动。
- `LIBRARY_LABEL` 是**页面名**，不能代入「构建你的专属 X」一类修饰句（「专属我的音乐」不通）；
  那类文案用普通名词「曲库」（`LibraryPage.tsx` 的空态副标题即如此）。
- 注释里 `音乐库` 有两种语义：指**页面**的写「我的音乐」，指**数据集合**的写「曲库」，
  WebDAV 服务器端的「音乐库根目录」保留原样。
- 设置页的「音乐库根目录」（WebDAV 来源配置项）与 `packages/shared` 里的 `MusicHall*` 类型名
  属**另一层语义/标识符**，不参与本次改名（仅注释措辞同步）。

### 否决项（勿再讨论）

- 不做客户端直连 QQ 上游：与既有架构冲突，且要处理签名/CORS/反爬。
- 不做电台、不做播客、不做数字专辑/分类歌单的独立 tab（分类筛选合并进推荐歌单页的筛选器）。
- 不新增第三方 HTTP 依赖，不引入新的玻璃材质类。
- **音乐馆不当主屏、不常驻挂载**：只有 `KEEP_ALIVE_ROUTE`（`/library`）常驻。

---

## 二、事实基线（已核验，实现者必读）

### 2.1 服务端（QQ_Music）

- 现有 5 条路由：`/`、`/health`、`/aurora`、`/aurora/playlist`、`/s|/c/<token>`。
- **鉴权是硬编码路径白名单** `index.js:548`：新路径不加进去 = 无鉴权裸奔。
- 端点自描述 `index.js:113-116` 只有 `search` / `playlist` 两项，且被 `test/endpoints.test.js:73` 锁死字面量。
- 歌单按 id 直取**已实现**：`lib/playlist.js:423`（`direct = Boolean(opts.server && opts.id)`），HTTP 层 `index.js:613-615`。
- 上游**无任何**榜单/推荐调用（全仓 `toplist|榜单|排行|推荐` 零命中），缺的只是编排层。
- 脱敏白名单 `lib/mask.js:56-65` 按 `qq.com` 后缀匹配：`qpic.y.qq.com` 通过，**`y.gtimg.cn` 会被拒**（`lib/mask.js:269-280`）。
- 部署：systemd --user `qq-music.service` 在跑，监听 :3201，已设 `API_KEY`，进程环境**无 QQ_COOKIE**。
- `npm test` = 73 tests / 73 pass（改动前基线，已实测）。

### 2.2 客户端（aurora-music）

- 端点自描述白名单硬编码 `shared/src/auroraPreset.ts:271`（`['search','playlist']`），**新端点会被静默丢弃**。
- 平台能力表新增在线方法需同步 6 处：`app/src/types/index.ts`、`desktop/src/preload.ts`、`desktop/src/ipc/handlers.ts`、`services/platform/index.ts`、`services/platform/mobile/index.ts`、`services/platform/web.ts` + Noop 回退。
- **web 端无在线能力**（`platform/web.ts:262-264` 返回空），音乐馆在浏览器必空 → 必须做空态。
- 播放链路（即点即播复用）：`playQueue`（`playerStore.ts:253-268`）→ `audio.service.ts:106`（`onlineUrl || remoteUrl || path`）；取址 `ensurePlayableTrack`（`playlistIO.service.ts:102-137`）→ `searchOnlineTracks` → `scoreOnlineResult` 打分选最佳。
- 持久化：`libraryStore` key `aurora-library-state` version **10**（`libraryStore.ts:331`）；新增字段五步 = State 字段 + setter → `partialize`（`:262-278`）→ version 递增 → `migrate` 分支（`:291-330`）→ 结构变形才写 `sourceMigration.ts` 纯函数。
- 设计系统硬约束（`docs/design-system.md`）：长列表卡片只能 `.card-solid` / `.card-list`（禁 `backdrop-filter` 上大面积滚动区）；一屏一个强调色（mint）；禁 `>0.4s` 交互过渡；禁 `rounded-[10px]` 字面量（用 `rounded-ds-*`）；新玻璃类必须同步 `globals.css:1476-1487` 降级清单与 `style-sheet.md:307-311`。

### 2.3 已完成的前置工作（本计划落地前已经改完并验证）

**A. 路径字面量收敛 —— `packages/app/src/lib/routes.ts`（新建，唯一事实源）**

```ts
ROUTES = { root:'/', library:'/library', hall:'/hall', liked:'/liked', recent:'/recent', settings:'/settings' }
HOME_ROUTE       = ROUTES.library   // 主屏：冷启动落地、返回兜底、移动端「再按一次退出」
KEEP_ALIVE_ROUTE = ROUTES.library   // 唯一常驻挂载页（离开时 visibility 隐藏而非卸载）
ROUTE_PATHS      = { songDetail:'/song/:id', playlist:'/playlist/:id', hallPlaylist, hallToplist }
ROUTE_BUILDERS   = { songDetail(id), playlist(id), hallPlaylist(id), hallToplist(id) }
isRoute(pattern, pathname)          // 段数严格一致的路径匹配，替代手写 startsWith
NavItem                             // 两处导航表共用形状（icon: LucideIcon）
```

`HOME_ROUTE` 与 `KEEP_ALIVE_ROUTE` 是**两个独立语义**（主屏 / 常驻挂载），当前同值但未来可分离 —— 这正是把「哪些页是主屏」从字符串判断里提出来的原因。

改动落点：`App.tsx`（`:98`/`:104`/`:270-278`/`:876`/`:884`/`:894-899`）、`lib/navigation.ts`（`useGoBack` 默认值与 `useOpenSongDetail`）、`Sidebar.tsx`、`MobileNav.tsx`、`LikedPage.tsx`、`RecentPage.tsx`、`PlaylistPage.tsx`、`SearchOverlay.tsx`。

**B. 「音乐库」→「本地音乐」改名**：`Sidebar.tsx`、`MobileNav.tsx`、`LibraryPage.tsx:465/311/560`、`LikedPage.tsx`、`RecentPage.tsx`、`PlaylistPage.tsx`（空态/toast/返回按钮）、`Sidebar.tsx` toast、`SearchOverlay.tsx:653`、`SettingsPage.tsx`（章节标题 + 两处移除确认文案 + tooltip）、`SongDetailPage.tsx`、`PageLayout.tsx` 注释。SettingsPage 的「音乐库根目录」（WebDAV 语义）与代码内部注释保持不变。
（**该改名已于 2026-10-06 按用户要求回退，见 §1 修订**。）

**验证已通过**：`grep -rn "'/library'\|'/song/\|'/liked'\|'/recent'\|'/settings'\|'/playlist/"` 在 `lib/routes.ts` 之外**零命中**；`pnpm --filter @aurora/app exec tsc --noEmit` 无错；`pnpm --filter @aurora/app exec vitest run` = 49 passed。

> ⚠️ 改动基线提醒：同工作区还有未提交的在线下载相关改动（`services/onlineDownload.service.ts`、`lib/onlineTrack.ts`、`hooks/useDownloadOnlineTrack.ts`、`desktop/src/main.ts`、`SongDetailPage.tsx` 的下载入口）。实现本计划时若与其写域重叠（`SongDetailPage.tsx`），需先与用户确认该批改动是否已定稿。

---

## 三、端到端流程（数据流）

```
用户在设置页填「音源地址」= http://127.0.0.1:3201?key=<API_KEY>
        ↓ probeAuroraService 读 GET / 自描述 → endpoints{search,playlist,recommend,toplists,toplist}
        ↓ 存入 OnlineSourceConfig.endpoints（缓存，服务端改路径时客户端无需改配置）
音乐馆页
  ├─ 推荐歌单：searchEndpointOf 同款取 → /aurora/recommend?categoryId&sortId&page → 卡片网格
  │     点卡片 → /aurora/playlist?server=qq&id=<dissid> → 曲目清单（临时展示）
  └─ 排行榜：/aurora/toplists → 榜单卡片（榜单名 + 前三预览）
        点榜单 → /aurora/toplist?id=&limit= → 曲目清单（带排名序号）
              ↓ 点某首 → ensurePlayableTrack（本地有就播本地，没有按名搜索取址）
                    → playQueue / playTrack（在线，不落库）
```

**为什么详情走名搜索而不是拿 songmid 直取**：`/aurora/playlist` 与 `/aurora/toplist` 都是**批量返回歌名+歌手**的形态，逐首调用 vkey 解析意味着一次点击几十个上游请求且会触发限流。既有 `ensurePlayableTrack`（点哪首取哪首、并发 4）已是验证过的路径，复用即可。

---

## 四、任务分解

> 写域互斥；`App.tsx` 仅由 T4 持有，T5 不得触碰。

### T1 · QQ_Music 服务端三个端点

**Files:** `lib/qqchart.js`（新建）、`index.js`、`docs/music-hall-endpoints.md`（已落盘，作为契约冻结）、`test/chart.test.js`（新建）、`test/endpoints.test.js`。

- [ ] 新建 `lib/qqchart.js`，导出 `fetchRecommendPlaylists` / `fetchToplistGroups` / `fetchToplistSongs`，自带 15s 超时 + UA + `Referer: https://y.qq.com/`（`Referer` 对 `fcg_get_diss_by_tag` 是**必需**，缺失返回 `code:-2 parameter failed!`）。
- [ ] `index.js:113-116` 的 `ENDPOINTS` 增补三项，同步更新 `test/endpoints.test.js:73`。
- [ ] `index.js:548` 鉴权白名单加入 `/aurora/recommend`、`/aurora/toplists`、`/aurora/toplist`。
- [ ] 三分支路由插在 `index.js:633` 之后，响应经 `masker.scrub`；封面 URL 按 `MASK_URLS` 决定是否封装。
- [ ] **`lib/mask.js:56-65` 白名单加 `y.gtimg.cn`**（否则榜单封面全挂）。
- [ ] 新增环境变量 `RECOMMEND_MAX`（默认 60）、`TOPLIST_MAX`（默认 100），照 `index.js:108` 的 `PLAYLIST_MAX` 写法。
- [ ] `test/chart.test.js`：三端点正常解析、上游缺字段容错、无 key 401、`limit` 上限截断、`preview=0` 不返回预览（打桩上游，照 `test/playlist.test.js` + `test/stub-playlist.js`）。

**验收：** `npm test` 全绿；`curl "http://127.0.0.1:3999/aurora/toplists?preview=3"` 返回 `groups[]`；`/aurora/recommend?limit=5` 返回 5 条含 `id/name/coverUrl`；`/aurora/toplist?id=26&limit=5` 返回含 `songmid` 的 5 首；无 key 时三端点均 401。

### T2 · shared 协议扩展

**Files:** `packages/shared/src/auroraPreset.ts`、`packages/shared/src/types.ts`、`packages/shared/src/musicHall.ts`（新建）、`packages/shared/src/index.ts`、`packages/shared/src/__tests__/auroraPreset.test.ts`、`packages/shared/src/__tests__/musicHall.test.ts`（新建）。

- [ ] `AuroraEndpoints` 扩为 5 字段；`AURORA_ENDPOINT_FALLBACK` 补三项默认模板（`/aurora/recommend?...`、`/aurora/toplists?...`、`/aurora/toplist?...`）。
- [ ] `parseAuroraEndpoints` 的白名单 `:271` 由 `['search','playlist']` 扩为 5 项（**漏改即静默丢弃**）。
- [ ] `buildAuroraEndpoints` 扩 5 项；新增 `recommendEndpointOf` / `toplistsEndpointOf` / `toplistEndpointOf` 三个取值函数（服务地址形态派生；接口模板形态返回空）。
- [ ] `SourceEndpointInput.endpoints` 与 `OnlineSourceConfig.endpoints` 类型扩字段。
- [ ] 新建 `musicHall.ts`：`fetchRecommendPlaylists(source, opts)` / `fetchToplistGroups(source, opts)` / `fetchToplistSongs(source, opts)`，沿用 `musicSource.ts` 的容错解析风格（数组 / `list` / `results` / `data` 包裹，字段名宽松兼容），**请求失败抛带源名的中文错误**。
- [ ] 补单测：5 端点组装、白名单扩项、`{query}` 缺失时不误判、容错解析、上游结构缺失返回空数组而非崩。
- [ ] `pnpm --filter @aurora/shared build`（app/desktop 的 types 指向 `shared/dist`，改 shared 后必须先构建）。

**验收：** `pnpm --filter @aurora/shared test` 全绿（基线 305 tests）；`auroraPreset.test.ts` 覆盖 5 端点自描述解析。

### T3 · app / desktop 平台能力桥

**Files:** `packages/app/src/types/index.ts`、`packages/app/src/services/platform/index.ts`、`packages/app/src/services/platform/web.ts`、`packages/app/src/services/platform/mobile/index.ts`、`packages/desktop/src/preload.ts`、`packages/desktop/src/ipc/handlers.ts`。

- [ ] `PlatformInterface` 增 `getMusicHall`（或按既有粒度：`recommendPlaylists` / `toplists` / `toplistSongs` 三方法）。
- [ ] 桌面：preload 转发 → ipc/handlers 执行（渲染层持有音源配置，与 `searchOnlineTracks` 同款传参）。
- [ ] 移动：`mobile/index.ts` 直调 shared（fetch 已换成 CapacitorHttp）。
- [ ] **web / Noop 给空实现**（`web.ts:262-264` 同款），漏改即运行时崩。

**验收：** `pnpm --filter @aurora/app exec tsc --noEmit`、`pnpm --filter @aurora/desktop typecheck` 均无错。

### T4 · 音乐馆页 + 详情页

**Files:** `packages/app/src/pages/MusicHallPage.tsx`、`packages/app/src/pages/MusicHallDetailPage.tsx`、`packages/app/src/stores/musicHallStore.ts`（新建）、`packages/app/src/App.tsx`、`packages/app/src/components/layout/Sidebar.tsx`、`packages/app/src/components/layout/MobileNav.tsx`。

- [ ] `musicHallStore`（zustand，**不持久化或只持久化筛选条件**）：推荐歌单/榜单的加载态、错误态、筛选条件（categoryId/sortId/page）、详情缓存。
- [ ] `MusicHallPage`：骨架照 `RecentPage.tsx:75-90`（`PageLayout` + 头部 + 工具栏），两块内容——「推荐歌单」卡片网格、「排行榜」榜单卡。卡片用 `.card-solid`（长列表禁 blur），圆角 `rounded-ds-card`，hover 只改背景+描边（禁位移）。
- [ ] 点推荐歌单 → `navigate(ROUTE_BUILDERS.hallPlaylist('diss-' + dissid))`；点榜单 → `navigate(ROUTE_BUILDERS.hallToplist(topId))`。**不写字面量路径**。
- [ ] `MusicHallDetailPage`：一个组件按 route 参数分派两种加载（歌单走 `/aurora/playlist?server=qq&id=`，榜单走 `/aurora/toplist?id=`），曲目列表复用 `VirtualTrackTable`；榜单显示排名序号列。
- [ ] 点击曲目：转 `Track`（含 `onlineUrl` 与否均可）→ 计入 `ensurePlayableTrack` 按需取址 → `playQueue(list, index)`；本地已有同曲优先播本地（复用 `matchTracksByNames`）。
- [ ] `App.tsx`：import 两页 + `Routes` 增 `ROUTES.hall` / `ROUTE_PATHS.hallPlaylist` / `ROUTE_PATHS.hallToplist`（**全部取常量，计划里已预留语义注释位**）。`HOME_ROUTE` 与 `KEEP_ALIVE_ROUTE` **均保持 `/library` 不变**；返回键分层走 `isRoute`，音乐馆因不是主屏，返回键自动落回 `HOME_ROUTE`，无需额外分支。
- [ ] `Sidebar.tsx` 与 `MobileNav.tsx` 的 `navItems` 各加「音乐馆」项（静息放**首位**，图标用 `Compass`），`MobileNav.tsx` 文件头注释的入口数量同步。
- [ ] 空态：未配音源 → 引导跳设置页（`navigate(ROUTES.settings)`）；web 端 → 明确提示该能力不可用。

**验收：** `pnpm --filter @aurora/app exec tsc --noEmit`；桌面端手动跑通「音乐馆 → 榜单 → 点歌出声」；无音源时显示引导空态；从音乐馆返回键/返回按钮落到音乐库。

### T5 · 已完成（并入 §2.3）

### T6 · 验证与冒烟

- [ ] 新增 `packages/desktop/scripts/smoke-music-hall.js`（照 `smoke-webdav.js` 风格）：起一个打桩上游，断言推荐/榜单/详情三条链路返回结构可被 `musicHall.ts` 消费。
- [ ] 端到端联调：起 `PORT=3999 node index.js`（**不导出 API_KEY**，否则 401）→ 客户端音源填 `http://127.0.0.1:3999` → 音乐馆三块内容可见、点歌出声。
- [ ] 回归：`pnpm --filter @aurora/shared test`、`pnpm --filter @aurora/app exec tsc --noEmit`、QQ_Music `npm test` 三者全绿。

**任务依赖：** T1 与 T2 可并行（契约已冻结在 `docs/music-hall-endpoints.md`）→ T3 依赖 T2 类型 → T4 依赖 T3 → T6 依赖全部。（T5 改名与路径收敛已完成，见 §2.3，不再占任务槽。）

---

## 五、风险与坑（按严重度）

1. **端点自描述白名单**（`auroraPreset.ts:271`）：不扩 5 项的话，服务端自描述的三个新端点被静默丢弃，页面永远空 —— 且不报错，最难查。
2. **服务端鉴权白名单**（`index.js:548`）：漏加即无鉴权裸奔。
3. **脱敏白名单**（`lib/mask.js:56-65`）：`y.gtimg.cn` 不在册，榜单封面全挂。
4. **常驻挂载**：`KEEP_ALIVE_ROUTE` 只有 `/library` 一个，音乐馆**按需渲染**（与 `liked`/`recent` 同款）。不要顺手把音乐馆也加进常驻判定 —— 两个虚拟列表同时挂载会让内存与 ResizeObserver 翻倍。
5. **主屏语义**：`HOME_ROUTE = /library`（已按用户要求冻结）。音乐馆不是主屏，移动端返回键在音乐馆按「非主屏页」处理，自动回主屏。
6. **在线地址易失**：`playerStore.ts:92-100`、`playlistStore.ts:121-127`、`libraryStore.ts:158-165` 三处剥离 `onlineUrl`；音乐馆曲目进「最近播放」后重启无地址，靠 `ensurePlayableTrack` 重取，**未配音源时返回 null**，要有兜底提示。
7. **web 端无在线能力**（`platform/web.ts:262-264`）：必须空态，否则浏览器里是一屏死内容。
8. **平台能力五处一致性**：新增在线方法漏 web/Noop 会运行时崩。
9. **设计系统硬约束**：长列表禁 `backdrop-filter`、一屏一强调色、禁 `>0.4s` 过渡、禁 `rounded-[10px]` 字面量、动效需 `prefers-reduced-motion` 降级。
10. **构建顺序**：改 `shared` 后必须先 `pnpm --filter @aurora/shared build`，否则 app/desktop 的 types 仍指向旧 `dist`。

---

## 六、验收命令

```bash
# 服务端
cd /home/yibin/Code/QQ_Music && npm test
PORT=3999 node index.js            # 3201 已被 systemd qq-music.service 占用

# 协议层
cd /home/yibin/Code/aurora-music
pnpm --filter @aurora/shared test
pnpm --filter @aurora/shared build

# 客户端
pnpm --filter @aurora/app exec tsc --noEmit
pnpm --filter @aurora/desktop typecheck
pnpm --filter @aurora/desktop dev
```

```bash
# 端点连通（无 key 时应 401）
curl -s "http://127.0.0.1:3999/aurora/toplists?preview=3" | head -c 400
curl -s "http://127.0.0.1:3999/aurora/recommend?limit=5" | head -c 400
curl -s "http://127.0.0.1:3999/aurora/toplist?id=26&limit=5" | head -c 400
```

---

## 七、分期

- **P0（本计划）**：三个服务端端点 + 协议扩展 + 音乐馆页（推荐歌单网格 + 榜单卡）+ 详情页 + 即点即播 + 冒烟。（改名与路径常量收敛已完成。）
- **P1**：推荐歌单分类筛选（categoryId/sortId 下拉，需先实测枚举全集）、榜单分页、详情页「收藏到我的歌单」（`addImportedTracks` + `createPlaylist`）。
- **P2**：焦点轮播卡（需另找上游）、搜索直达音乐馆、榜单更新提醒。

---

## 八、待实测确认（实现时补，勿照抄猜测值）

- `sortId` 1/2/3/5 的确切语义；`categoryId` 子类目 id 全集（仅 `10000000` 已确认）。
- 榜单 `ein` 上限与 `page` 边界。
- 带 `QQ_COOKIE` 时是否有额外榜单/推荐字段。
- `GetAll` 的 `song[].songId`（数字）能否喂 vkey（vkey 需 `songmid` + `media_mid`）——影响 P1「精确取址」是否可行。