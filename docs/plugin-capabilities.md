# 插件能力注入与乐源插件化

> 本文定义两件事：**插件如何声明自己需要宿主提供什么**，以及**自有乐源（aurora）如何真正变成插件**。
> 契约细节见 [plugins.md](./plugins.md)，分层与安装见 [plugin-system.md](./plugin-system.md)；本文是它们之上的**依赖方向与注入**部分。

## 1. 问题：插件只说了"我能做什么"，没说"我需要什么"

现在的插件契约只有**能力声明**（`SourcePlugin` 的可选方法 + `capabilities` 数组），没有**依赖声明**。宿主那侧靠三端各写一套装配，插件内部再用模块级单例现读：

| 环节 | 现状 | 问题 |
|---|---|---|
| 插件要求宿主能力 | 插件方法签名**根本没有 `ctx` 参数**（`lxPlugin` 四个方法都不声明） | 依赖是隐式的，只能靠读实现代码才知道 |
| 能力从哪来 | 插件内直接 `getLxHostDeps()` 读模块级单例（3 处直读） | 绕过 `PluginContext`，无法按插件差异化 |
| 哪端能用 | `pluginForm.ts` 的 `FORM_KIND_OF` / `pluginAvailableOn()` 按 plugin id 写死 | 新增插件依赖时这张表不会自动更新 |
| 缺了能力怎么办 | 三种写法混用：抛结构化错误 / `?.` 返回 `undefined` / `?? ''` 返回空串 | 后两种是**静默错误答案** |

### 已经造成的具体缺陷

**缺陷 1：`hosts` 白名单声明了但从未生效。**
`installed.ts` 的 `guardedFetchOf()` 在生产代码**零调用方**（只有 `shared/src/index.ts` 转出 + 单测），两处构造 `PluginContext` 都直接给 `globalThis.fetch`（`plugin/executor.ts` 的 `hostContextOf`、`desktop/src/ipc/pluginHost.ts` 的 `buildContext`）。即清单里写的 `hosts` 是纯装饰，作者以为受约束、实际没有。

这与 `manifest/host.ts` 的设计意图直接矛盾——那个文件的存在理由就是"承诺靠自觉不算数，运行期必须强制"。

**缺陷 2：缺能力时的静默错误答案。**
`lxHost.ts` 里三条路径不一致：

- `utils.crypto.md5` 缺失 → 可选链得到 `undefined`，脚本拿着它继续跑，**签名串变成空字符串**
- `utils.buffer.bufToString` 缺失 → `?? ''` 返回**空串**
- `utils.zlib.inflate` 缺失 → 只有这一条显式 reject

前两条比抛错难查得多：脚本不报错，只是结果不对。

**缺陷 3：版本协商是空的。**
`LX_HOST_VERSION = '2.0.0'` 这个常量**只写不读**——两端各自写死 `version: '2.0.0'`，全仓没有任何代码比对它。它是给脚本看的 `lx.version`，不承担宿主与插件的兼容性判定。

### 为什么要在此时改

能力注册表本身不产生新功能，但它把上面四条从"约定"变成"机制"。而且它**不阻塞**已有的签名信任表 / 移动端沙箱——那两个是能力注册表的**内容**，不是它的替代。

## 2. 设计：三个新概念

```
能力 id（稳定字符串 + 主版本）    ←→    插件侧声明 requires     ←→    宿主侧注册实现
```

### 2.1 能力 id 表

先只登记**已经存在**的宿主能力，不发明新能力：

| 能力 id | 版本 | 形状 | desktop | mobile | web |
|---|---|---|---|---|---|
| `http.fetch` | 1 | `(input, init) => Promise<Response>` | Node 原生 fetch | `CapacitorHttp` 包装 | `window.fetch` |
| `credential` | 1 | `{ read, save, clear, encryptionAvailable }` | `safeStorage` | **无** | **无** |
| `script.host` | 1 | 现 `LxHostDeps` 形状（`request` / `evaluate` / `utils.*`） | `node:vm` + Node crypto/zlib | Web Worker 沙箱 | **无** |
| `log` | 1 | `(scope: string) => Logger` | 有 | 有 | 有 |
| `plugin.fs` | 1 | `{ readManifest, readScript }` | `fs` | `@capacitor/filesystem` | **无** |
| `net.allowlist` | 1 | `{ mode, hosts }` | 有 | 有 | 有 |

> `script.host` 在移动端现在有**两条**实现：`lxHost` 的 `new Function` 回退（同步死循环打不断）与新的 Worker 沙箱。注册表化时应把它们表达为「同一能力 id 的两个实现，按可用性择优」，而不是让调用方在 `lxHost.ts` 里 `if (sandboxSupported())` 分支。

### 2.2 插件侧：`requires`

```ts
export interface CapabilityRequirement {
  id: HostCapabilityId
  /** 主版本**精确匹配**。够用，且不需要 semver 求解器 */
  version: number
  /** 缺失时插件仍注册，ctx 里该能力为 undefined，插件**必须**显式分支 */
  optional?: boolean
}
```

**内置插件**：写在 `SourcePlugin` 上，作者手写（他们就是仓库作者）。

**声明式插件**：由清单字段**推导**，禁止作者手填第二份真源：

| 清单里有什么 | 推导出的 requires |
|---|---|
| `permissions: ['network']` | `http.fetch` |
| `permissions: ['credential']` | `credential` |
| `script: { ... }` | `script.host` |
| 任意（清单本身要从磁盘读） | `plugin.fs` |

这条规则必须是**唯一一处映射表**。任何"作者也可以手写 requires"的设计都会重蹈 `capabilities` 与"方法存在性"两份真源的覆辙。

### 2.3 解析结果决定"降级还是可用"

```ts
export type PluginAvailability =
  | { ok: true; resolved: ReadonlyMap<HostCapabilityId, unknown> }
  | { ok: false; missing: ReadonlyArray<CapabilityGap> }
```

> **重要修正（实现 P1 时推翻了初稿）。** 初稿写的是"缺 required → 插件不注册"。落地时发现这是错的，有两个原因：
>
> 1. **"宿主缺能力"与"插件不存在"是两件事。** `lxPlugin.preflight` 已经负责回答"这条源此刻能不能跑"，并给出可读原因（`core.error.lxHostNotReady`）。若在注册期就把 lx 从注册表删掉，调用方看到的是"没有这个插件"，而真实原因是"这个端没有脚本宿主"——后者的可诊断性明显更高。
> 2. **既有降级路径依赖"注册但不可用"。** `musicSourceLx` / `lxVerifier` 里有一批用例专门验证"宿主未注册时跳过 lx 源并告警"。把插件整个摘掉，这些路径就变成"插件不存在"，跳过逻辑再也没被测到。
>
> 所以正确语义是：**注册照常进行，依赖缺口只记账（`degradedBuiltins()`）**，供 UI 与诊断消费；运行期"能不能跑"仍由 `preflight` 判定。两个判定回答的是不同问题，不能合并。

- **缺 required** → 插件**仍然注册**，但登记进降级表（`degradedBuiltins()`）；UI 显示"当前平台缺少 `script.host`"；运行期由插件的 `preflight` 给出最终结论并跳过该源。
- **缺 optional** → `ctx.caps[id]` 为 `undefined`，且契约**禁止**用 `?.` + 默认值把"没有"伪装成"有但是空值"。
- **版本不匹配** → 明确报 `capabilityVersionMismatch`（带 required / actual），不静默降级；且**即使标了 optional 也算方案不成立**——按 v1 用法喂 v2 实现比"完全没有"更危险（可能静默产出错误结果而不是报错）。

顺带解决掉 `pluginAvailableOn()` 的硬编码 id 表：它现在可以由 `requires` 与注册表推导，而不是按 plugin id 写死"哪个端能用"。

### 2.4 `PluginContext` 变成"解析后的能力袋"

```ts
export interface PluginContext {
  /** 由 `http.fetch` 解析；已安装插件此处自动包 createGuardedFetch */
  fetch: typeof globalThis.fetch
  /** 由 `credential` 解析；移动端/浏览器为 undefined，不再恒 false 假装 */
  credential?: PluginCredential
  /** 由 `script.host` 解析，**替掉**插件内直读 getLxHostDeps() */
  scriptHost?: LxHostDeps
  /** 由 `log` 解析（现在是死字段，全仓无生产者也无消费者） */
  log: (message: string, detail?: unknown) => void
}
```

### 2.5 缺失策略（统一口径）

现行三种写法收敛成一条规则：

> **required 缺失 = 插件不可用（注册期就挡）；optional 缺失 = 值必须是 `undefined`，插件显式分支。**

禁止再用 `?.` 后接默认值、`?? ''`、`|| fallback` 表达能力缺失——那等于把"没有"说成"有，但值是空的"。`lxHost.ts` 那三处（`utils.crypto` / `buffer.from` / `bufToString`）随之改为：启动时就知道缺不缺，`preflight` 阶段直接告诉用户"这个脚本需要 md5 但当前环境没有"。

## 3. 乐源（aurora）插件化

### 3.1 现状：名义是插件，实质不是

`plugin/auroraPlugin.ts` import 了 **6 个核心模块**（`musicSource` / `auroraPreset` / `sourceProbe` / `trackResolver` / `playlistResolver` / `musicHall`），8 个方法签名**全部不吃 `ctx`**。它是"零宿主依赖的转发垫片"——能力实现全在 core，插件层只做形状翻译。

更要紧的是**三条能力链路在运行期绕开插件门面**：

| 链路 | 实际走哪 | 插件门面方法 |
|---|---|---|
| 取址 | 平台层分两路：`trackRef` → lx；`onlineId` → 主进程直调 `resolveAuroraTrack` | `resolveTrackViaPlugin` **零生产调用方** |
| 歌单 | `playlistResolver` 只认 `playlistEndpointOf` 派生 | `getPlaylistTracks` **零生产调用方** |
| 歌词 | `lyrics.service` 只认 `lyricEndpointOf` 派生 | `buildLyricsRunner` 除单测外**零调用方** |

后果：装来的声明式插件在这三条能力上**根本用不上**——即使清单里声明了 `resolveTrack` / `playlistTracks` / `lyrics`。

### 3.2 一个契约缺口：`lyrics` 能力没有对应方法

`auroraPlugin.capabilities` 里有 `'lyrics'`，但 `SourcePlugin` 上**没有任何歌词方法**。它实际是"能派生出歌词端点，交给 `lyricsSource` 的聚合器去取"。

声明式插件侧同样：`manifest/lyrics.ts` 的 `buildLyricsRunner` 造的是 `(query, artist, album, duration) => Promise<Hit>` 形状的自由函数，不是 `SourcePlugin` 的方法，因此接不进统一的插件目录。

需要补的方法（一个，覆盖两种来源形态）：

```ts
/** 把"本插件提供的歌词源"交给上层聚合器；不实现 = 该插件不提供歌词 */
lyricsSource?(config: OnlineSourceConfig): LyricsSourceConfig | null
```

插件回答"**哪条源交给聚合**"，而不是自己执行——这样保留既有的 `searchLyrics` 聚合（用户源优先 + 内置 LRCLIB 兜底 + 延迟对冲），又不让每个插件重复实现聚合。

### 3.3 阶段 A：让 aurora 真正吃 `ctx`（结构插件化）

1. 把 `musicSource` / `trackResolver` / `musicHall` / `playlistResolver` 里**aurora 专用**的执行实现挪进 `plugin/aurora/`，改成用 `ctx.fetch`。现在它们直连 `fetchWithTimeout` 的模块级 `customFetch`，等于自带网络栈，违反"插件只依赖注入的 fetch"这条契约。
2. **三条绕道收口到门面**：`resolveTrackAudio` 统一调 `resolveTrackViaPlugin`；歌单导入改调 `playlistTracksViaPlugin`；歌词改走 `lyricsSource`。
3. 补上 3.2 的 `lyricsSource` 方法。

做完之后，`auroraPlugin` 不再是 6 个核心模块的转发器，`musicSource` 里 `if (pluginId === 'aurora' && !searchEndpointOf(source))` 这类形态判断也能删掉。

### 3.4 阶段 B：让"服务地址 + 密钥"可声明

**aurora 无法做成纯声明式清单**，缺的不是字段映射（那部分清单已经覆盖得不错），而是"用户填一个服务地址 + 密钥 → 派生全部端点"这一整层。清单现在的 URL 必须是写死的绝对地址，且执行器**完全不读用户配置的 `sourceUrl`**。

新增清单段（service profile）：

```json
"service": {
  "baseUrlFrom": "sourceUrl",
  "secretFrom": "sourceUrl.query.key",
  "selfDescribe": { "url": "{baseUrl}/", "endpoints": "endpoints" },
  "endpoints": {
    "search":   "{baseUrl}/aurora?query={query}&quality={quality}&key={secret}",
    "track":    "{baseUrl}/aurora/track?id={id}&quality={quality}&key={secret}",
    "lyric":    "{baseUrl}/aurora/lyric?track={track}&artist={artist}&duration={duration}&key={secret}",
    "playlist": "{baseUrl}/aurora/playlist?url={url}&key={secret}",
    "recommend":"{baseUrl}/aurora/recommend",
    "toplists": "{baseUrl}/aurora/toplists",
    "toplist":  "{baseUrl}/aurora/toplist"
  }
}
```

配套三处必须改：

1. **占位符白名单**加 `{baseUrl}` / `{secret}`，并允许 `selfDescribe` 给出的端点在运行期覆盖静态模板。
2. **`hosts` 与自填地址的冲突**：新增 `net.allowlist` 的 `mode: 'configured-origin'`——白名单不写死主机，而是运行期取用户配置的那条 `sourceUrl` 的 origin。仍然禁通配符，仍然由 `http.fetch` 能力层强制。这是"用户自建服务"与"白名单强制"能同时成立的唯一办法。
3. **在线发现的默认参数**：清单 `hallValues` 给空串会被 `dropUnfilledParams` 整段剔除，而 aurora 执行器有硬默认值（`categoryId` / `sortId` / `page` / `limit` / `preview`）。service profile 要能声明默认值。

做完阶段 B，`auroraPlugin` 可退化成一个内置清单 + `requires: [{ id: 'http.fetch' }]`。

## 4. 落地顺序

| 阶段 | 内容 | 触及文件 | 风险 | 状态 |
|---|---|---|---|---|
| **P0** | 接线现有死代码：`guardedFetchOf` 进 ctx 工厂；`ctx.log` 接上 | `executor.ts`、`pluginHost.ts` | 低，但会让已安装插件的白名单**突然真的生效** | 已完成 |
| **P1** | 能力注册表 + `requires` + availability；三端各注册一次 | 新增 `plugin/hostCapabilities.ts`；desktop / mobile 装配点 | 中 | 已完成 |
| **P2** | lx / B 档脚本迁到 `ctx.scriptHost`，删 4 处 `getLxHostDeps()` 直读 | `lxPlugin.ts`、`manifest/script.ts`、`lxResolver.ts`、`lxHost.ts` | 中 | 已完成 |
| **P3** | 三条绕道收口（取址 / 歌单 / 歌词）+ `lyricsSource` 契约 | `plugin/trackAudio.ts`（新）、`lyrics.service.ts`、两端平台层、`auroraPlugin.ts` | **高**：动播放取址主链路 | 已完成 |
| **P4** | service profile + `configured-origin` 白名单 + 占位符扩展 | `manifest/service.ts`（新）、`types.ts`、`validate.ts`、`source.ts`、`host.ts` | 中，纯增量 | 已完成 |

## 4.1 落地时与设计不一致的地方（必读）

实现过程中推翻了初稿的两处，记在这里免得以后被"优化"回去：

### 4.1.1 缺必需能力时**不**把插件踢出注册表

初稿写的是"缺 required → 插件不注册"。实测直接让 shared 挂了 12 个测试，原因有两条：

1. **"宿主缺能力"与"插件不存在"是两件事。** `lxPlugin.preflight` 已经在回答"这条源此刻能不能跑"并给出 `core.error.lxHostNotReady`。在注册期删掉 lx，调用方看到的是"没有这个插件"，可诊断性更差。
2. **既有降级路径依赖"注册但不可用"。** `musicSourceLx` / `lxVerifier` 有一批用例专门验证"宿主未注册时跳过 lx 源并告警"；摘掉插件后这些路径退化成"插件不存在"，跳过逻辑再也没被测到。

现在的实现：注册照常，缺口只进 `degradedBuiltins()` 供 UI 与诊断消费。

### 4.1.2 宿主必须由调用方注入，**不**回落全局单例

`lxResolver` 的两处 `deps ?? getLxHostDeps()` 已删除。回落会让"调用方忘了传宿主"静默变成"用了全局单例"——而那条隐式依赖正是本次要拆掉的东西（它让单测无法按调用点注入替身）。

配套改动：`setLxHostDeps()` 现在**同步登记 `script.host` 能力**。理由是两个入口（平台层、单测）本来就用它，不同步登记会让按新契约取宿主的插件全部拿到 `undefined`，表现为"配了源却不参与搜索"且无任何报错。

### 4.1.3 `lyricsSource` 是"交出配置"而不是"自己取词"

`SourcePlugin.lyricsSource()` 返回 `LyricsSourceConfig | null`，不是歌词文本。既有的 `searchLyrics` 做的是多源聚合（用户源优先 + 内置 LRCLIB 兜底 + 延迟对冲），让每个插件各写一份取词等于把那套策略复写 N 遍。

同时把 `sourceHasLyrics()` 的判定从 `capabilities.includes('lyrics')` 改成 `typeof plugin.lyricsSource === 'function'`——改造前 aurora 声明了 `lyrics` 却**没有对应方法**，声明与实现分叉。

### 4.1.4 `configured-origin` 比 `declared-hosts` 更严，不是更松

两者都禁通配符。区别是 `configured-origin` 要求 **scheme + host + port 全一致**（标准 origin 语义），而 `declared-hosts` 是"同主机任意端口"。理由：前者的字段是**用户地址**，把端口差异一并放行会让"用户以为只授权了一个服务、实际授权了该主机上所有服务"。

### 4.1.5 `hosts` 在 service 形态下允许为空

常规清单 `hosts` 必填非空（固定上游的主机是作者**知道**的，写不出说明他自己也不清楚）。但 service 形态的主机由**用户**决定，硬要求非空只会逼作者写假数据——那正好让白名单变回装饰。

## 4.2 环依赖的最终状态

`musicSource → executor → builtins → auroraPlugin → musicSource` 这个环**仍然存在**（静态 import 图上），但已不是求值期风险：`builtinPlugins()` 是 getter、注册发生在方法调用时、`auroraPlugin` 对核心模块的引用全在方法体内。

`auroraPlugin` 目前仍 import 6 个核心模块（P3 收口的是**调用链路**，不是它的实现位置）。彻底断开需要把 aurora 的执行实现搬进 `plugin/aurora/`，那是比本次更大的重构——P4 完成后它已可退化成一个内置清单，届时那把搬迁才有明确收益。

## 5. 明确不做

### 5.1 不把内置插件注册改成注入式

`builtins.ts` 的惰性注册（getter 数组 + `registered` 标志 + 15 处 `ensureBuiltinsRegistered()`）看着丑，但它确实解决了 `musicSource → executor → builtins → auroraPlugin → musicSource` 这个环：

- `builtinPlugins()` 是 **getter 函数**而非顶层常量数组——求值期不解引用插件对象
- 注册发生在**方法被调用时**，此时所有模块已求值完毕
- `auroraPlugin` 对核心模块的引用**全部只在方法体内**，模块体里没有解引用

改成"启动时显式注册"只是把环换个地方藏，却要动 60+ 个直接 import 内部模块的单测。**环的真实成因是 `auroraPlugin` 反向 import 了 6 个核心模块——P3 做完这条环自己就断了**，不需要额外动注册时机。

唯一残留的求值期副作用是 `plugin/index.ts` 末尾的顶层 `ensureBuiltinsRegistered()`。它目前安全，但是一颗顺序地雷：谁把它挪到 `builtins.ts` 顶层就会立刻 `invalid plugin id: undefined`（`auroraPlugin` 在 TDZ）。P3 完成后应删除。

### 5.2 不把凭证塞进能力注册表的值里

`safeStorage` 的核心不变量是"凭证只在主进程内存里瞬间存在"。注册表里只能登记**解密函数的引用**，绝不能登记解密结果——否则调用方一缓存就破坏这条边界。

### 5.3 不做清单手写 `requires`

见 2.2：声明式插件的 `requires` 一律由 `permissions` / `script` 推导。允许手写必然出现"声明的依赖"与"实际用的能力"两份真源，这正是 `capabilities` 数组今天的问题。

## 6. 自检清单（改这一层时）

- 插件是否还从模块级单例直接读宿主能力（`getLxHostDeps()` 这类）？应为零，一律走 `ctx`。
- 缺能力时是否用 `?.` / `?? ''` 兜底？应改为显式分支或注册期挡下。
- 新增一条宿主能力，是否要改三端 + 一张硬编码 id 表？应只改注册点。
- 已安装插件的越界请求是否**没被发出去**（而不只是报了错）？`guardedFetchOf` 必须真的在 ctx 工厂里。
- `requires` 是否只有一处映射来源（清单字段推导），没有第二份手写清单？
- 版本不匹配是否**明确报错**，而不是悄悄用不兼容的实现跑？
