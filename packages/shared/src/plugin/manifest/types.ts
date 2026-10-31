/**
 * 声明式插件清单（manifest）契约 —— 全仓唯一真源。
 *
 * ## 这一层解决什么
 *
 * 现有插件（`../types.ts` 的 `SourcePlugin`、`../storage/types.ts` 的 `StoragePlugin`）
 * 都是**编译进应用**的 TypeScript 实现：写一个插件 = 改仓库 + 重新打包。
 * 用户要「在设置里填一个地址就能加插件」，缺的正是**一份可分发、可校验、不执行代码**的
 * 描述物 —— 那就是本文件定义的 manifest。
 *
 * 三档形态（风险从低到高）：
 *
 * | 档 | 形态 | 能力 | 是否实现 |
 * |---|---|---|---|
 * | A | 声明式 HTTP（本文件） | 搜索 / 取址 / 歌单 / 歌词 / 在线发现 | **是** |
 * | B | 受限脚本（复用 `lxHost` 沙箱） | 取址（+ 脚本自带搜索） | **是**（`script` 字段） |
 * | C | 原生模块 | 任意 | 永不做 |
 *
 * A 与 B **不是二选一**：一份清单可以同时带声明式端点与脚本块，各自独立生效
 * （例如「协议源负责搜索，脚本负责取址」）。两者的信任模型不同，安装确认框
 * 必须分别告知用户（见 `permissions` 与 `script` 的说明）。
 *
 * 只支持 A 档的理由：A 档**不执行任何第三方代码**，它与「用户填一个音源地址」是同一个
 * 信任量级；B 档要执行脚本，C 档等于下载并运行任意二进制。把 A 档做成唯一默认通道，
 * 才能让「装插件」这件事不要求用户具备安全判断力。
 *
 * ## 四条硬约束（每一条都对应一次会静默失效的坑）
 *
 * 1. **`hosts` 必填且禁止通配**。插件能访问哪些域名必须是**有限可枚举**的：声明 `*`
 *    的清单直接判非法。理由：声明式插件里最危险的动作是「把用户查询词发到任意主机」，
 *    而用户看不出一个域名跟另一个域名的区别。
 * 2. **内容哈希钉死，地址不算数**。安装记录里存 `sha256`（按**文件字节**算）而不是
 *    「URL + 版本号」：仓库可以 force-push、`main` 每天不同，而哈希是唯一的身份。
 *    （既有教训：洛雪脚本缓存键曾用「长度 + 首尾片段」，主体被改写而首尾未变时不失效。）
 * 3. **清单里不出现类型可执行的表达式**。字段映射只允许**取值路径**（`a.b[0].c`），
 *    不允许模板求值、不允许函数、不允许条件分支 —— `eval` 一进来，A 档就退化成 B 档。
 * 4. **文案不是 `MessageKey`**。内置插件的展示名是字典键（`MessageKey`，随应用语言走），
 *    而外部插件的名字写在清单里，应用字典里不可能有它的键 —— 所以清单用
 *    `LocalizedText`（按语言的字面量）。UI 侧两者都要能渲染，见 `PluginCatalogEntry`。
 */

/**
 * 清单格式标识。**带版本号**：将来若改结构，旧清单能被明确判成「不支持的格式」
 * 而不是在解析期炸出莫名其妙的字段错误。
 */
export const PLUGIN_MANIFEST_FORMAT = 'aurora-plugin/1'

/** 支持的格式（当前只有 1；数组形式让「拒绝原因」可以说清「支持哪些」） */
export const SUPPORTED_MANIFEST_FORMATS = [PLUGIN_MANIFEST_FORMAT] as const

/**
 * 插件 id 的合法形状。
 *
 * 与内置插件注册表（`../registry.ts` 的 `PLUGIN_ID_RE`）、凭证文件名
 * （`pluginCredentials.safeFileName`）**同一正则（含 `i` 标志）**。
 *
 * 三处口径必须一致的理由：id 同时是注册表键、落盘文件名与凭证文件名。
 * 校验器比注册表严一格，会出现"清单校验通过却注册失败"；比注册表松一格，
 * 会出现"装上了但注册表拒绝"，两种静默不一致都极难查。
 */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/**
 * 能力域。
 *
 * - `source`：在线音源（搜索 / 取址 / 歌单曲目）
 * - `lyrics`：歌词文本来源
 * - `storage`：持久媒体库协议（**声明式不支持**：WebDAV 的 PROPFIND/XML、SMB 的握手
 *   都不是「一条 HTTP 模板 + 字段映射」能表达的，硬套只会做出一个只能连 demo 服务器的玩具）
 *
 * 域名是「这份清单在哪个注册表里生效」，不是权限，也不是 UI 分类。
 */
export type PluginDomain = 'source' | 'lyrics' | 'storage'

/**
 * 权限项。
 *
 * 三项都必须在安装确认框里逐条列出、由用户勾选后才安装（见 docs/plugins.md
 * 「权限：插件申请什么，就要让用户看见什么」）。当前 A 档只可能用到 `network` 与
 * `credential`；`filesystem` 保留给将来，声明它的清单在 A 档下**判为不支持**。
 */
export type PluginPermission =
  | 'network'
  | 'credential'
  | 'filesystem'
  /**
   * 脚本执行（B 档）。与 `network` 分开是刻意的：A 档插件只需要 `network`，
   * 而一旦声明了 `script`，用户在确认框里看到的措辞必须不同 ——
   * "会运行作者提供的代码"与"只会发 HTTP 请求"是完全不同的信任量级。
   */
  | 'script'

/**
 * 本地化文本：字面量，或按语言标记映射。
 *
 * 映射的键用 BCP-47 语言标记（`zh-CN` / `en`），取值顺序：精确匹配 → 主语言匹配
 * （`zh-CN` 命中 `zh`）→ `en` → 任意第一个非空值。取不到就回落 `id`，
 * **任何情况下都不显示空白**（显示空白的插件在列表里等于消失）。
 */
export type LocalizedText = string | Record<string, string>

/**
 * 音源域声明：每条能力 = 一个端点模板 + 一份字段映射。
 *
 * ## 占位符
 *
 * 模板里的 `{name}` 由应用在执行时替换（值统一 `encodeURIComponent`）：
 *
 * | 能力 | 可用占位符 |
 * |---|---|
 * | `search` | `query` `quality` |
 * | `resolveTrack` | `id` `quality` |
 * | `playlistTracks` | `playlistId` |
 *
 * 模板里**没出现**的占位符被忽略，出现但取值为空 → **整段参数被剔除**
 * （复用 `auroraPreset.dropUnfilledParams` 的既有语义：留成 `artist=` 空参数会被上游当成
 * 错误，LRCLIB 实测 `artist_name=` 回 503）。
 *
 * ## 字段映射
 *
 * `map` 的值是**取值路径**，语法只有三种成分：`a`、`a.b`、`a[0].b`。
 * 不存在、类型不符、数组越界一律得到 `undefined`（**不抛错**）：第三方接口的字段
 * 缺失是常态，一次缺字段不该让整条源报错。
 */
export interface DeclarativeSourceSpec {
  /** 搜索：不声明 = 该插件不提供搜索（能力缺失用「不存在」表达，与内置插件同一范式） */
  search?: DeclarativeSearchEndpoint
  /** 惰性取址：按源内 id 取直链 */
  resolveTrack?: DeclarativeResolveEndpoint
  /** 歌单曲目：`{playlistId}` 为歌单定位串 */
  playlistTracks?: DeclarativeSearchEndpoint
  /** 在线发现 · 推荐歌单 */
  recommend?: DeclarativeRecommendEndpoint
  /** 在线发现 · 榜单列表 */
  toplists?: DeclarativeToplistsEndpoint
  /** 在线发现 · 榜单详情 */
  toplistDetail?: DeclarativeToplistDetailEndpoint
}

/** 列表型端点（搜索 / 歌单曲目）：响应里取一个数组，逐条按 `map` 转成曲目 */
export interface DeclarativeSearchEndpoint {
  /** 请求地址模板（必须含该能力要求的占位符，见上表） */
  url: string
  /** 附加请求头（同名覆盖应用默认值） */
  headers?: Record<string, string>
  /**
   * 数组所在的取值路径（如 `data.songs`）。**留空**时按既有容错顺序尝试：
   * 数组本身 → `results` → `data` → `songs` → `list`（与 `musicSource.extractItems` 同口径）。
   */
  items?: string
  /** 单条曲目字段映射，键是应用的字段名，值是源字段路径 */
  map: DeclarativeTrackFieldMap
}

/**
 * 曲目字段映射。
 *
 * `audioUrl` 在搜索端点里**必填**（没有播放地址的搜索条目对播放器毫无意义，
 * 既有执行器也是直接跳过这类条目）；在取址端点里同理（那就是取址的目的）。
 */
export interface DeclarativeTrackFieldMap {
  /** 源内 id：取址时原样交回插件，是「按 id 取址」的前提；缺失则回落列表序号 */
  id?: string
  title: string
  artist?: string
  album?: string
  /** 时长（**秒**）。上游给毫秒的话用 `durationMs` 声明，由应用换算，别指望上游 */
  duration?: string
  /** 声明该字段是毫秒，应用按 /1000 取整 */
  durationMs?: string
  coverUrl?: string
  /** 播放地址（列表型端点里必填；取址端点里必填） */
  audioUrl?: string
}

/** 取址端点：单对象响应（不是数组），映射到一条可播放地址 */
export interface DeclarativeResolveEndpoint {
  url: string
  headers?: Record<string, string>
  map: DeclarativeResolveFieldMap
}

export interface DeclarativeResolveFieldMap {
  /** 播放地址（必填） */
  audioUrl: string
  quality?: string
  coverUrl?: string
  /** 地址过期时间（毫秒时间戳）：有则上层据此决定是否需要重新取址 */
  expireAt?: string
  /** 是否为试听片段（布尔）。**必须如实标注**：把试听当完整曲目交给播放器，
   *  用户会在中途被截断，观感是「播放失败」而不是「试听」（汽水 VIP 曲目实测 29–60 秒） */
  isPreview?: string
}

// ─── 在线发现（推荐歌单 / 榜单）────────────────────────────────

/**
 * 推荐歌单端点。
 *
 * 可用占位符：`categoryId` `sortId` `page` `limit`。
 * **全部可选**——真插件里分类/分页参数常常是上游专有的，写不出通用占位符的插件
 * 直接写死固定值即可（模板里没有的占位符会被忽略，不需要删参数）。
 */
export interface DeclarativeRecommendEndpoint {
  url: string
  headers?: Record<string, string>
  /** 数组所在路径；留空按 `list` → `playlists` → `results` → `data` 容错 */
  items?: string
  map: DeclarativeRecommendFieldMap
}

export interface DeclarativeRecommendFieldMap {
  /** 歌单 id（必填：没有 id 就无法点开取曲目） */
  id: string
  name: string
  coverUrl?: string
  listenNum?: string
  creatorName?: string
  createTime?: string
}

/** 榜单列表端点。可用占位符：`preview` */
export interface DeclarativeToplistsEndpoint {
  url: string
  headers?: Record<string, string>
  /**
   * 分组数组所在路径；留空按 `groups` → `data` 容错。
   * 响应是裸数组时视为**单组**（组名留空，由界面用通用标题兜底）。
   */
  groups?: string
  map: DeclarativeToplistGroupFieldMap
}

export interface DeclarativeToplistGroupFieldMap {
  /** 组名；不给则由界面用通用标题兜底（数据层不烧文案） */
  groupName?: string
  groupId?: string
  /** 组内榜单数组所在路径；留空按 `toplists` → `toplist` → `list` 容错 */
  toplists?: string
  /** 单个榜单的字段映射（相对**组内每一条**对象） */
  item: DeclarativeToplistBriefFieldMap
}

export interface DeclarativeToplistBriefFieldMap {
  /** 榜单 id（必填：回传给详情端点） */
  id: string
  name: string
  updateTime?: string
  period?: string
  listenNum?: string
  coverUrl?: string
  /** 预览曲目数组路径；不给 = 该源不提供预览曲目（允许，界面只是少几行） */
  songs?: string
  /** 预览曲目字段映射（相对每条预览） */
  song?: DeclarativeToplistPreviewFieldMap
}

export interface DeclarativeToplistPreviewFieldMap {
  rank?: string
  title: string
  artist?: string
  coverUrl?: string
}

/** 榜单详情端点。可用占位符：`id` `page` `limit` */
export interface DeclarativeToplistDetailEndpoint {
  url: string
  headers?: Record<string, string>
  /** 曲目数组所在路径；留空按 `songs` → `songlist` → `list` → `data` 容错 */
  items?: string
  /** 榜单元信息（名称 / 更新时间 / 总数）的字段路径；全部可选 */
  meta?: {
    name?: string
    updateTime?: string
    total?: string
  }
  map: DeclarativeToplistSongFieldMap
}

export interface DeclarativeToplistSongFieldMap {
  rank?: string
  title: string
  artist: string
  album?: string
  duration?: string
  durationMs?: string
  coverUrl?: string
  songmid?: string
}

/**
 * 歌词域声明。
 *
 * 不复用 `DeclarativeSearchEndpoint`：歌词的**响应形状只有两种**，而既有执行器
 * （`lyricsSource.ts`）的字段容错已经覆盖了 JSON 形态的全部常见写法。所以这里只让插件
 * 声明「取哪个地址、返回 JSON 还是裸 LRC」——声明得越少，写错的可能越少。
 */
export interface DeclarativeLyricsSpec {
  /**
   * 请求地址模板。必须含 `{track}` 或 `{query}`（既有执行器的硬校验：
   * 没有占位符的地址等于「每个歌都取同一份歌词」）。
   *
   * 可用占位符：`track` `query` `artist` `album` `duration`。
   */
  url: string
  /**
   * 响应体格式：
   * - `json`（默认）：按既有容错解析（`syncedLyrics` / `lrc` / `lyric` / `plainLyrics` / `lyrics`）
   * - `lrc`：响应体**本身就是 LRC 文本**（多数歌词站如此），直接当同步歌词用
   */
  format?: 'json' | 'lrc'
  headers?: Record<string, string>
}

/**
 * B 档：受限脚本块（洛雪格式的音源脚本）。
 *
 * ## 与声明式（A 档）的根本差别
 *
 * A 档**不执行任何第三方代码**；B 档会。所以它单独一个字段、单独的权限项
 * （`script`），并且安装确认框必须明确告知"这个插件会在沙箱里运行作者提供的代码"。
 *
 * ## 沙箱边界（复用 `lxHost.ts` 的既有实现，不新写一套）
 *
 * - 脚本在参数遮蔽的伪全局里执行：`document` / `navigator` / `location` / `localStorage`
 *   与 Node 标识一律 `undefined`，拿不到宿主配置、数据库与文件系统
 * - 网络请求只能经宿主的 `lx.request` 转发（宿主负责 UA / 超时），不能直连
 * - 桌面端用 `node:vm` 注入超时，同步死循环可被打断
 *
 * ## 供应链：脚本内容**由应用拉取并钉死哈希**
 *
 * `url` 是脚本地址，但**不是身份**：与清单本身一样，仓库可以 force-push、分支每天前进。
 * 所以安装时把脚本源码完整拉下来、算 sha256、与清单一起落盘；运行期只跑**落盘的那一份**，
 * 不再回源。这同时解决了两件事：
 * 1. 内容哈希可校验（作者改了脚本，用户会看到"需要重新安装"而不是静默换行为）
 * 2. 离线可用（脚本已在本地，断网也能取址）
 *
 * `sha256` 可选：作者可以在清单里预先声明期望的脚本哈希，安装时强制比对。
 * 不给则由安装器在拉取后记录实测值（首次信任模型 —— 用户看到的就是他此刻安装的内容）。
 */
export interface DeclarativeScriptSpec {
  /** 脚本地址（http(s)）。安装时拉取一次，之后运行本地的副本 */
  url: string
  /**
   * 期望的脚本 sha256（可选）。给了就必须匹配，否则拒绝安装 ——
   * 这是"用户确认过的是这一份代码"的唯一凭证。
   */
  sha256?: string
  /** 附加请求头（拉脚本时用，如私有托管的 Authorization） */
  headers?: Record<string, string>
  /**
   * 脚本声明的平台能力（可选，仅供 UI 展示）。
   * **不参与执行判定**：真实能力以脚本初始化时自报的为准（`inspectLxSource`），
   * 这里写一份是为了在装之前就能告诉用户"这个脚本支持哪些平台"。
   */
  platforms?: string[]
}

/**
 * 插件清单。
 *
 * `source` / `lyrics` 至少声明一个（都不声明的插件装上去什么也不做，
 * 那是安装期的错误而不是运行期的静默降级）。
 */
export interface PluginManifest {
  format: typeof PLUGIN_MANIFEST_FORMAT
  /** 插件 id：落盘文件名、凭证键、注册表键都用它 */
  id: string
  /** 展示名（清单里是字面量，不是字典键，理由见文件头第 4 条） */
  name: LocalizedText
  /** 一句话说明 */
  description?: LocalizedText
  /** 插件自身版本（与 App 版本无关）。只用于展示与「已更新」提示，**不参与**身份判定 */
  version: string
  author?: string
  /** 主页 / 仓库地址（只用于展示与「查看来源」，应用不从这里下载任何东西） */
  homepage?: string
  /** 申请的权限，逐条在安装确认框里列出 */
  permissions: PluginPermission[]
  /**
   * 允许访问的主机名（精确匹配，忽略大小写；可写成 `api.example.com`）。
   *
   * 必填非空、**禁止通配符**（`*` / `*.example.com` 一律判非法）：运行期据此在
   * `PluginContext.fetch` 外层做域名白名单，越界请求直接失败。
   */
  hosts: string[]
  /** 音源域能力 */
  source?: DeclarativeSourceSpec
  /** 歌词域能力 */
  lyrics?: DeclarativeLyricsSpec
  /**
   * B 档：受限脚本（洛雪格式）。声明它等于"本插件会运行第三方代码"，
   * 必须同时申请 `script` 权限（校验器强制配平）。
   */
  script?: DeclarativeScriptSpec
  /**
   * 可选的 Ed25519 签名块。
   *
   * 签名覆盖的是**去掉本字段后的规范化清单**（见 `signature.ts` 的
   * `signableBytes`）。它防的是"下载链路被中间人替换"，防不住
   * "作者本身就写了恶意插件" —— 后者只有用户自己的判断能挡。
   *
   * 语义分三档：未签名 / 签名者未知（公钥不在信任表）/ 已验证。
   * **签名存在但校验失败必须拒绝安装**。
   */
  signature?: {
    algorithm: 'ed25519'
    /** 作者自定的公钥标识（应用据此在信任表里查公钥，而不是盲信清单附带的公钥） */
    keyId: string
    /** Ed25519 签名，64 字节的 hex（128 个字符） */
    sig: string
  }
}

// ─── 校验 ────────────────────────────────────────────────────

/**
 * 一条校验问题。
 *
 * `path` 用点号路径指向清单里的位置（`source.search.map.title`），
 * 便于 UI 直接告诉用户「哪个字段不对」——只说「清单无效」等于让用户自己猜。
 */
export interface ManifestIssue {
  path: string
  /** 机器可读的原因码（供字典翻译；不要在这里烧中文，shared 层不烧界面文案） */
  code:
    | 'not-object'
    | 'missing'
    | 'invalid-format'
    | 'invalid-id'
    | 'invalid-version'
    | 'invalid-type'
    | 'invalid-url'
    | 'empty'
    | 'wildcard-host'
    | 'unsupported-permission'
    | 'unsupported-domain'
    | 'no-capability'
    | 'duplicate'
  /** 出错的原始值（截断后），仅用于诊断 */
  value?: string
}

export type ManifestValidation =
  | { ok: true; manifest: PluginManifest; issues: [] }
  | { ok: false; manifest: null; issues: ManifestIssue[] }

// ─── 安装 / 目录 ─────────────────────────────────────────────

/**
 * 插件来源：内置（编译进应用）还是已安装（磁盘上的清单）。
 *
 * 这个字段只驱动 UI 展示（「内置」标签、卸载按钮是否可用），**不参与**执行分派：
 * 执行侧只认注册表。
 */
export type PluginProvenance = 'builtin' | 'installed'

/**
 * 插件目录条目：**跨域统一的可展示元信息**。
 *
 * 为什么需要它：音源插件与存储插件各自有注册表（历史原因，两套契约长得不一样），
 * 而「插件管理」页面要列出**全部**插件。这个形状把两个注册表 + 已安装清单
 * 投影成一份列表，且**只含纯数据**（可安全过 IPC —— 插件对象上挂着函数，
 * structured clone 会直接抛 `DataCloneError`）。
 */
export interface PluginCatalogEntry {
  id: string
  /** 生效的注册表 */
  domain: PluginDomain
  /**
   * 展示名。内置插件给 `displayNameKey`（字典键，渲染期 `t()` 取值）；
   * 已安装插件给 `displayName`（清单里的字面量）。**两者必有一个**，UI 按存在性取。
   */
  displayNameKey?: string
  displayName?: string
  descriptionKey?: string
  description?: string
  version: string
  /** 能力标识（供 UI 渲染徽章；调用前判定仍用方法是否存在） */
  capabilities: readonly string[]
  provenance: PluginProvenance
  /** 已安装插件的文件哈希（内置插件没有） */
  sha256?: string
  /** 已安装插件申请的权限（内置插件为空数组：它随应用发布，不存在安装期授权） */
  permissions?: readonly PluginPermission[]
  /** 允许访问的主机（已安装插件才有） */
  hosts?: readonly string[]
  /** 是否可卸载（内置插件不可） */
  removable: boolean
}

/**
 * 已安装插件的安装记录（落盘伴生文件，**不是**清单本身）。
 *
 * 单独一份的理由：清单是**作者写的**，安装记录是**本机写的**。
 * 把 `installedAt` / `sha256` 写回清单会让「作者的内容」与「本地的状态」混在一处，
 * 校验哈希时反而要剔除自己写的字段（既容易漏，也让第三方工具无法逐字节复现）。
 */
export interface PluginInstallRecord {
  id: string
  version: string
  /** 清单文件字节的 sha256（小写 hex） */
  sha256: string
  /** 安装时间（毫秒时间戳） */
  installedAt: number
  /** 安装来源：URL 或本地文件路径（仅用于展示与「重新安装」） */
  origin: string
}

/** 安装请求：从 URL 装，或从本地文件装 */
export type PluginInstallRequest =
  /** `sha256` 可选：给了就必须匹配（`file://` / 手工确认的场景用得上） */
  | { kind: 'url'; url: string; sha256?: string }
  | { kind: 'file'; path: string; sha256?: string }

/** 安装结果：失败时带可读原因（用户能据此改输入），不抛到 UI 层当异常 */
export interface PluginInstallResult {
  ok: boolean
  /** 成功时的目录条目（供 UI 立即刷新列表，免一次往返） */
  entry?: PluginCatalogEntry
  /** 失败原因（结构化信封或自由文本，由显示端渲染） */
  message?: string
  /** 校验问题清单（清单结构不对时逐条给出，比一句「格式错误」有用） */
  issues?: ManifestIssue[]
}

/** 已安装插件在磁盘上的样子：清单 + 安装记录 */
export interface InstalledPlugin {
  manifest: PluginManifest
  record: PluginInstallRecord
  /** 清单文件的绝对路径（诊断与「打开所在目录」用） */
  path: string
  /**
   * B 档脚本的**正文**（已落盘的那一份）。
   *
   * 为什么正文随扫描一起返回而不是运行期按需读：插件的执行上下文里没有文件系统
   * （`PluginContext` 只有 fetch），脚本必须由宿主侧读好后塞进源配置的 `script` 字段。
   * 扫描时一并读出来，正好是"一次 I/O 换后面每次取址都不用再碰磁盘"。
   *
   * 没有脚本块（或脚本文件缺失）时为 undefined。
   */
  scriptBody?: string
}

/**
 * 扫描磁盘得到的结果。
 *
 * `broken` 单���列出而不是混进成功列表：一个坏清单**不能**让整个插件目录加载失败
 * （用户会表现为「所有插件都消失了」，而真实原因只是其中一个文件写坏了）。
 */
export interface InstalledPluginScan {
  plugins: InstalledPlugin[]
  broken: Array<{ path: string; issues: ManifestIssue[]; message?: string }>
}
