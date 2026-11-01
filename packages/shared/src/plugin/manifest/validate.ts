/**
 * 插件清单校验（A 档：声明式，不执行任何代码）。
 *
 * ## 校验为什么要在**安装期**做完，而且失败要逐条给路径
 *
 * 声明式插件的全部行为都由清单决定。一份写错的清单若被"宽松接受"，症状是**运行期静默
 * 失效**：搜索永远返回空、歌词永远是 null、取址永远回落——用户看到的是"这插件不好用"，
 * 却没有任何线索指向"清单里 title 的路径写错了"。这与仓库既往教训同源
 * （兜底模板漏一个占位符 → 功能静默失效，见 `auroraPreset.ts` 顶部注释）。
 *
 * 所以：
 * - 结构问题一律在安装期报错并**指到具体字段路径**；
 * - 校验器**绝不**"猜作者的意图"去补默认值（唯一例外：`lyrics.format` 缺省 `json`，
 *   因为它有一个明确且安全的历史默认值）。
 *
 * ## 边界
 *
 * 本文件只做**清单自身的合法性**检查（形状 / 类型 / 权限 / 端点模板的占位符）。
 * 它不校验远端可达性、不校验字段映射指向的响应真的长那样 —— 那需要发请求，
 * 属于"测试连接"（`probe`）而不是"安装"。
 */

import {
  PLUGIN_MANIFEST_FORMAT,
  PLUGIN_ID_PATTERN,
  SUPPORTED_MANIFEST_FORMATS,
  type DeclarativeSearchEndpoint,
  type ManifestIssue,
  type ManifestValidation,
  type PluginManifest,
  type PluginPermission,
} from './types'
import { parsePath } from './path'

/**
 * 允许的权限。
 *
 * `filesystem` **不在其中**：无论 A 档还是 B 档，插件都没有文件读写能力
 * （脚本也拿不到 fs —— 见 `lxHost` 的伪全局遮蔽）。声明它等于越权意图。
 * `script` 允许，但必须与清单里的 `script` 块**配平**（见下方校验）。
 */
const ALLOWED_PERMISSIONS: readonly PluginPermission[] = ['network', 'credential', 'script']

/**
 * 各项能力的**必填占位符**。
 *
 * 为什么这是硬校验：一个不含 `{query}` 的搜索模板等于"每个搜索词都打同一个地址"，
 * 用户搜什么都拿到同一份结果 —— 表面能跑，实际完全错误。歌词侧同理
 * （既有执行器 `lyricsSource.searchLyricsSource` 对这一点也是硬校验）。
 *
 * 歌词是唯一的"多选一"：`{track}` 与 `{query}` 在歌词语境里是**同一个值**的两个别名
 * （既有 `LyricsSourceConfig` 支持两种写法），要求两个都写没有意义。见
 * `LYRICS_PLACEHOLDER_ANY_OF`。
 */
const REQUIRED_PLACEHOLDERS = {
  search: ['query'],
  resolveTrack: ['id'],
  playlistTracks: ['playlistId'],
  lyrics: [],
  // 在线发现三端点**都不强制占位符**：推荐歌单的分类/排序参数是上游专有的，
  // 很多实现的地址就是固定的（`/api/recommend`）；强制写一个假占位符只会逼作者
  // 编一个没用的参数。榜单详情不收 `{id}` 也没问题——那种实现的"详情"就是全量列表。
  recommend: [],
  toplists: [],
  toplistDetail: [],
} as const

/** 歌词模板至少要含其中之一（两者等价，都是歌名） */
const LYRICS_PLACEHOLDER_ANY_OF = ['track', 'query'] as const

/** 占位符语法：`{name}`，name 为小写字母开头的标识符 */
const PLACEHOLDER_RE = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g

/**
 * 各能力实际可用的占位符（多写的占位符是作者的错，必须报出来）
 *
 * `baseUrl` / `secret` 是**服务地址形态**引入的两个新占位符（见 `service.ts`）：
 * 它们由用户填的那条链接在运行期算出，所以任何能力的模板里都可以用。
 */
const SERVICE_PLACEHOLDERS = ['baseUrl', 'secret'] as const

const KNOWN_PLACEHOLDERS = {
  search: [...SERVICE_PLACEHOLDERS, 'query', 'quality'],
  resolveTrack: [...SERVICE_PLACEHOLDERS, 'id', 'quality'],
  playlistTracks: [...SERVICE_PLACEHOLDERS, 'playlistId'],
  lyrics: [...SERVICE_PLACEHOLDERS, 'track', 'query', 'artist', 'album', 'duration'],
  recommend: [...SERVICE_PLACEHOLDERS, 'categoryId', 'sortId', 'page', 'limit'],
  toplists: [...SERVICE_PLACEHOLDERS, 'preview'],
  toplistDetail: [...SERVICE_PLACEHOLDERS, 'id', 'page', 'limit'],
} as const

/** 版本号形状：宽松的 semver（`1`、`1.0`、`1.0.0`、`1.0.0-beta.1` 都收） */
const VERSION_RE = /^\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?$/

/**
 * 主机名形状：必须是一个**具体域名或 IP**。
 *
 * 明确拒绝：`*`、`*.example.com`、`example.*`、空串、带协议头的 URL、带路径的字符串。
 * 理由见 `types.ts` 文件头第 1 条：插件能发请求到哪个主机必须有限可枚举。
 */
function isConcreteHost(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const host = value.trim()
  if (!host) return false
  if (host.includes('*')) return false
  // 只接受 host[:port]：带 scheme / path / query 的写法一律非法（作者想写 URL 了）
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) return false
  if (host.includes('/') || host.includes('?') || host.includes('#')) return false
  // IPv6 字面量（[::1]:8080）与域名/IPv4 都放过，其余按 hostname 字符集校验
  if (/^\[[0-9a-fA-F:.]+\](:\d+)?$/.test(host)) return true
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d+)?$/i.test(host)
}

/** HTTP(S) 地址形状（只做粗略校验：真正的可达性要发请求，不属于安装期） */
function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 取出模板里出现的全部占位符名（去重，保留出现顺序） */
function placeholdersOf(template: string): string[] {
  const out: string[] = []
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    if (!out.includes(match[1])) out.push(match[1])
  }
  return out
}

/** 累加器：把"发现问题"从控制流里摘出来，读起来是线性的校验流程 */
class IssueLog {
  readonly issues: ManifestIssue[] = []

  add(path: string, code: ManifestIssue['code'], value?: unknown): void {
    this.issues.push({
      path,
      code,
      ...(value === undefined ? {} : { value: truncate(value) }),
    })
  }

  get ok(): boolean {
    return this.issues.length === 0
  }
}

/** 诊断值截断：清单可能很长，错误信息里带整段原文没有价值 */
function truncate(value: unknown): string {
  const text = typeof value === 'string' ? value : safeStringify(value)
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 校验端点模板：URL 形状 + 必填占位符 + 未知占位符 + 请求头形状。
 *
 * `where` 是能力名（`search` / `resolveTrack` / `playlistTracks` / `lyrics`），
 * 同时用于错误路径与占位符白名单查表。
 */
function checkEndpointTemplate(
  log: IssueLog,
  path: string,
  template: unknown,
  where: keyof typeof KNOWN_PLACEHOLDERS
): void {
  if (typeof template !== 'string' || !template.trim()) {
    log.add(path, 'missing')
    return
  }
  if (!isHttpUrl(template)) {
    log.add(path, 'invalid-url', template)
    return
  }

  const present = placeholdersOf(template)
  for (const required of REQUIRED_PLACEHOLDERS[where]) {
    if (!present.includes(required)) {
      // 路径后不加后缀：`ManifestIssue.path` 指向的是"哪个字段写错了"
      log.add(path, 'missing', `{${required}}`)
    }
  }
  // 歌词：{track} 与 {query} 二选一即可（两者在歌词语境里是同一个值的别名）
  if (where === 'lyrics' && !LYRICS_PLACEHOLDER_ANY_OF.some((name) => present.includes(name))) {
    log.add(path, 'missing', LYRICS_PLACEHOLDER_ANY_OF.map((name) => `{${name}}`).join(' | '))
  }
  const known: readonly string[] = KNOWN_PLACEHOLDERS[where]
  for (const name of present) {
    if (!known.includes(name)) {
      // 未声明的占位符在运行期会原样留在 URL 里（不会报错，只会请求一个错误的地址），
      // 所以必须在这里挡下来
      log.add(path, 'invalid-type', `{${name}}`)
    }
  }
}

/** 校验请求头：字符串 → 字符串的平表 */
function checkHeaders(log: IssueLog, path: string, headers: unknown): void {
  if (headers === undefined) return
  if (!isPlainObject(headers)) {
    log.add(path, 'invalid-type', headers)
    return
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string') log.add(`${path}.${key}`, 'invalid-type', value)
  }
}

/**
 * 校验一条取值路径（`map` 的某个值）。
 *
 * `|` 分隔多条路径是**合法语法**（上游字段名不统一时的表达方式，如
 * `title|name|songName`）：每条各自校验，任一条非法即报错 —— 有一支写错就等于
 * 那一支永远取不到值，而作者会以为自己覆盖了那种形态。
 */
function checkPath(log: IssueLog, path: string, value: unknown, required: boolean): void {
  if (value === undefined) {
    if (required) log.add(path, 'missing')
    return
  }
  if (typeof value !== 'string' || !value.trim()) {
    log.add(path, 'invalid-type', value)
    return
  }
  const branches = value.split('|').map((part) => part.trim())
  for (const branch of branches) {
    if (!branch || !parsePath(branch)) {
      // 语法不合法（表达式、问号链、函数调用、空分支）：装上去只会永远取不到值
      log.add(path, 'invalid-type', value)
      return
    }
  }
}

/** 校验曲目字段映射 */
function checkTrackMap(log: IssueLog, path: string, map: unknown, needsAudioUrl: boolean): void {
  if (!isPlainObject(map)) {
    log.add(path, 'missing')
    return
  }
  checkPath(log, `${path}.title`, map.title, true)
  checkPath(log, `${path}.artist`, map.artist, false)
  checkPath(log, `${path}.album`, map.album, false)
  checkPath(log, `${path}.duration`, map.duration, false)
  checkPath(log, `${path}.durationMs`, map.durationMs, false)
  checkPath(log, `${path}.coverUrl`, map.coverUrl, false)
  checkPath(log, `${path}.id`, map.id, false)
  checkPath(log, `${path}.audioUrl`, map.audioUrl, needsAudioUrl)

  // `duration` 与 `durationMs` 同时声明是作者的混乱：一个字段不可能既是秒又是毫秒。
  // 这里报错而不是"后者优先"——静默择一会让作者的意图永久丢失。
  if (map.duration !== undefined && map.durationMs !== undefined) {
    log.add(`${path}.durationMs`, 'duplicate')
  }
}

/**
 * 校验列表型端点（搜索 / 歌单曲目）。
 *
 * **`audioUrl` 的必填性按端点区分**，这是一条容易写错的契约：
 * - `search`：必填。搜索结果是给用户点的，没有播放地址的条目对播放器毫无意义
 *   （既有执行器也是直接跳过这类条目）。
 * - `playlistTracks`：**可选**。真实形态是"歌单只给元信息，地址在播放时按 id 现取"
 *   （汽水 / 洛雪脚本都是这条路），空 `audioUrl` + `trackRef` 是**一等协议语义**，
 *   详见 `../types.ts` 文件头第 2 条。要求它必填等于把一整类合法插件挡在门外。
 */
function checkListEndpoint(
  log: IssueLog,
  path: string,
  spec: unknown,
  where: 'search' | 'playlistTracks'
): void {
  if (!isPlainObject(spec)) {
    log.add(path, 'invalid-type', spec)
    return
  }
  checkEndpointTemplate(log, `${path}.url`, spec.url, where)
  checkHeaders(log, `${path}.headers`, spec.headers)
  if (spec.items !== undefined) checkPath(log, `${path}.items`, spec.items, false)
  checkTrackMap(log, `${path}.map`, spec.map, where === 'search')
}

/**
 * 校验一份清单。
 *
 * 返回联合类型而不是抛错：调用方（安装器）要把 issues 逐条渲染给用户，
 * 抛错就只能拿到第一条，用户改完一条又撞下一条。
 */
export function validatePluginManifest(input: unknown): ManifestValidation {
  const log = new IssueLog()

  if (!isPlainObject(input)) {
    log.add('', 'not-object', input)
    return { ok: false, manifest: null, issues: log.issues }
  }

  // ─── 顶层标识 ───────────────────────────────────────────────

  if (input.format !== PLUGIN_MANIFEST_FORMAT) {
    // 格式不对时**不做**后续校验：其余字段的形状取决于 format 版本，硬校验只会
    // 报出一堆误导性的错（用户看到的应该是"这份清单是别的格式的插件"）
    log.add('format', 'invalid-format', input.format)
    return { ok: false, manifest: null, issues: log.issues }
  }

  if (typeof input.id !== 'string' || !PLUGIN_ID_PATTERN.test(input.id)) {
    // id 会成为文件名与凭证键，非法形状必须挡在安装这一关（与内置注册表同一正则）
    log.add('id', 'invalid-id', input.id)
  }

  if (typeof input.version !== 'string' || !VERSION_RE.test(input.version.trim())) {
    log.add('version', 'invalid-version', input.version)
  }

  // name / description：字符串或按语言的字面量映射
  checkLocalizedText(log, 'name', input.name, true)
  checkLocalizedText(log, 'description', input.description, false)

  if (input.author !== undefined && typeof input.author !== 'string') {
    log.add('author', 'invalid-type', input.author)
  }
  if (input.homepage !== undefined && !isHttpUrl(input.homepage)) {
    log.add('homepage', 'invalid-url', input.homepage)
  }

  // ─── 权限与主机 ─────────────────────────────────────────────

  const permissions = input.permissions
  if (!Array.isArray(permissions) || permissions.length === 0) {
    // 至少声明一项：`network` 是声明式插件的必然需求（它只能发 HTTP）。
    // 空数组意味着作者没想过"我要什么权限"——安装确认框也就无从展示。
    log.add('permissions', 'missing')
  } else {
    const seen = new Set<string>()
    permissions.forEach((permission, index) => {
      const path = `permissions[${index}]`
      if (typeof permission !== 'string') {
        log.add(path, 'invalid-type', permission)
        return
      }
      if (seen.has(permission)) log.add(path, 'duplicate', permission)
      seen.add(permission)
      if (!ALLOWED_PERMISSIONS.includes(permission as PluginPermission)) {
        // `filesystem` 落到这里：声明式插件没有文件能力，声明它是越权意图
        log.add(path, 'unsupported-permission', permission)
      }
    })
  }

  // ─── 白名单：service 形态允许 hosts 为空（改由用户地址决定）──────────
  //
  // 常规形态要求 `hosts` 必填非空：固定上游的主机是作者**知道**的，写不出来
  // 说明他自己也不清楚插件会请求哪里。但服务地址形态（`service` + `allowlist:
  // 'configured-origin'`）恰恰相反：主机由**用户**决定，作者不可能穷举，
  // 硬要求非空只会逼他写假数据（那样白名单就变成装饰，正是要防的事）。
  const isServiceAllowlist =
    input.allowlist === 'configured-origin' && Boolean(input.service)

  if (!Array.isArray(input.hosts) || input.hosts.length === 0) {
    if (isServiceAllowlist) {
      // 允许为空：运行期由 `configured-origin` 从用户填的 sourceUrl 推导
    } else {
      log.add('hosts', 'missing')
    }
  } else {
    const seen = new Set<string>()
    input.hosts.forEach((host, index) => {
      const path = `hosts[${index}]`
      const normalized = typeof host === 'string' ? host.trim().toLowerCase() : ''
      if (typeof host === 'string' && host.includes('*')) {
        // 通配符是**硬拒绝**而不是"降级为精确匹配"：作者写 `*.example.com` 是想访问
        // 全部子域，静默改成精确匹配会让插件在运行期莫名失败，而用户看不出原因
        log.add(path, 'wildcard-host', host)
        return
      }
      if (!isConcreteHost(host)) {
        log.add(path, 'invalid-type', host)
        return
      }
      if (seen.has(normalized)) log.add(path, 'duplicate', host)
      seen.add(normalized)
    })
  }

  // ─── 白名单模式与 service 必须配套 ─────────────────────────────
  //
  // `configured-origin` 依赖 `service` 派生出的主机来放行；没有 `service` 时
  // 运行期白名单恒为空 → 插件的**每一个**请求都会被拒。这种组合只会让人一头雾水，
  // 所以在安装期就拦下，而不是等装好之后"插件什么都拉不到"。
  if (input.allowlist === 'configured-origin' && !input.service) {
    log.add('allowlist', 'missing', 'service')
  }
  if (input.service && input.allowlist !== 'configured-origin') {
    // 反向提示：声明了 service 却忘了切白名单模式，会导致自建主机全部被拒
    log.add('allowlist', 'missing', 'configured-origin')
  }

  // ─── service 块的形状 ────────────────────────────────────────

  if (input.service !== undefined) {
    const service = input.service
    if (!service || typeof service !== 'object') {
      log.add('service', 'not-object', service)
    } else {
      const spec = service as Record<string, unknown>
      const endpoints = spec.endpoints
      if (!endpoints || typeof endpoints !== 'object') {
        log.add('service.endpoints', 'missing')
      } else {
        const known = ['search', 'track', 'playlist', 'lyric', 'recommend', 'toplists', 'toplist']
        for (const [key, value] of Object.entries(endpoints as Record<string, unknown>)) {
          const path = `service.endpoints.${key}`
          if (!known.includes(key)) {
            log.add(path, 'unsupported-domain', key)
            continue
          }
          if (typeof value !== 'string' || !value.trim()) {
            log.add(path, 'empty', value)
            continue
          }
          // 端点模板必须是 http(s) 或含 {baseUrl}：否则是「相对路径当绝对地址用」，
          // 运行期会拼出一个非法 URL，而作者看不出哪里错了
          if (!/^https?:\/\//i.test(value) && !value.includes('{baseUrl}')) {
            log.add(path, 'invalid-url', value)
          }
        }
      }
      const selfDescribe = spec.selfDescribe
      if (selfDescribe !== undefined) {
        if (!selfDescribe || typeof selfDescribe !== 'object') {
          log.add('service.selfDescribe', 'not-object', selfDescribe)
        } else {
          const sd = selfDescribe as Record<string, unknown>
          const url = typeof sd.url === 'string' ? sd.url : ''
          if (!url.trim()) log.add('service.selfDescribe.url', 'missing')
          else if (!/^https?:\/\//i.test(url) && !url.includes('{baseUrl}')) {
            log.add('service.selfDescribe.url', 'invalid-url', url)
          }
          if (typeof sd.endpoints !== 'string' || !sd.endpoints.trim()) {
            log.add('service.selfDescribe.endpoints', 'missing')
          }
        }
      }
    }
  }

  // ─── 能力域 ─────────────────────────────────────────────────

  const hasSource = input.source !== undefined
  const hasLyrics = input.lyrics !== undefined

  // 注意判据里含 `script`：只有脚本能力的插件同样是完整插件
  // （洛雪脚本正是这种形态 —— 它只提供取址，没有声明式端点）
  if (!hasSource && !hasLyrics && input.script === undefined) {
    // 什么都不声明的插件装上去什么也不做：是安装期的错，不是运行期的静默降级
    log.add('source', 'no-capability')
  }

  if (hasSource) {
    if (!isPlainObject(input.source)) {
      log.add('source', 'invalid-type', input.source)
    } else {
      const source = input.source
      const capabilityKeys = [
        'search',
        'resolveTrack',
        'playlistTracks',
        'recommend',
        'toplists',
        'toplistDetail',
      ] as const
      const declared = capabilityKeys.filter((key) => source[key] !== undefined)
      if (declared.length === 0) {
        log.add('source', 'no-capability')
      }
      if (source.search !== undefined) {
        checkListEndpoint(log, 'source.search', source.search, 'search')
      }
      if (source.playlistTracks !== undefined) {
        checkListEndpoint(log, 'source.playlistTracks', source.playlistTracks, 'playlistTracks')
      }
      if (source.resolveTrack !== undefined) {
        checkResolveEndpoint(log, 'source.resolveTrack', source.resolveTrack)
      }
      if (source.recommend !== undefined) {
        checkRecommendEndpoint(log, 'source.recommend', source.recommend)
      }
      if (source.toplists !== undefined) {
        checkToplistsEndpoint(log, 'source.toplists', source.toplists)
      }
      if (source.toplistDetail !== undefined) {
        checkToplistDetailEndpoint(log, 'source.toplistDetail', source.toplistDetail)
      }
    }
  }

  if (hasLyrics) {
    if (!isPlainObject(input.lyrics)) {
      log.add('lyrics', 'invalid-type', input.lyrics)
    } else {
      checkLyricsSpec(log, 'lyrics', input.lyrics)
    }
  }

  // ─── B 档：受限脚本 ─────────────────────────────────────────
  //
  // 三条强制配平，每一条都对应一次真实的误判风险：
  // 1. 有 script 块必须有 `script` 权限 —— 否则用户看确认框时不知道有代码要执行
  // 2. 有 `script` 权限必须有 script 块 —— 否则是在申请一个用不上的高危权限
  // 3. script 块让插件**算有能力的插件**（即使没有任何声明式端点）
  const hasScript = input.script !== undefined
  const declaresScriptPermission =
    Array.isArray(permissions) && permissions.includes('script' as PluginPermission)
  if (hasScript !== declaresScriptPermission) {
    log.add(hasScript ? 'permissions' : 'script', 'duplicate')
  }
  if (hasScript) {
    if (!isPlainObject(input.script)) {
      log.add('script', 'invalid-type', input.script)
    } else {
      checkScriptSpec(log, 'script', input.script)
    }
  }
  // 只有脚本能力的插件同样是完整插件（洛雪脚本正是这种形态：只有取址）
  if (!hasSource && !hasLyrics && !hasScript) {
    // 上面那条 no-capability 已经报过；这里只补"脚本也算能力"的例外，
    // 避免出现"合法清单却报 no-capability"的矛盾
  }

  if (!log.ok) return { ok: false, manifest: null, issues: log.issues }

  // 校验通过后**重建**一份干净对象，而不是把入参原样返回：
  // 入参可能带着未知字段（作者的笔误或未来字段），让它们进入运行期会产生
  // "配置里明明写了却没生效"的迷雾。这里只保留契约里声明过的键。
  return { ok: true, manifest: buildManifest(input), issues: [] }
}

function checkLocalizedText(log: IssueLog, path: string, value: unknown, required: boolean): void {
  if (value === undefined) {
    if (required) log.add(path, 'missing')
    return
  }
  if (typeof value === 'string') {
    if (!value.trim()) log.add(path, 'empty', value)
    return
  }
  if (!isPlainObject(value)) {
    log.add(path, 'invalid-type', value)
    return
  }
  const entries = Object.entries(value)
  if (entries.length === 0) {
    log.add(path, 'empty', value)
    return
  }
  for (const [locale, text] of entries) {
    if (typeof text !== 'string' || !text.trim()) {
      log.add(`${path}.${locale}`, 'invalid-type', text)
    }
  }
}

/** 校验取址端点（单对象响应） */
function checkResolveEndpoint(log: IssueLog, path: string, spec: unknown): void {
  if (!isPlainObject(spec)) {
    log.add(path, 'invalid-type', spec)
    return
  }
  checkEndpointTemplate(log, `${path}.url`, spec.url, 'resolveTrack')
  checkHeaders(log, `${path}.headers`, spec.headers)
  if (!isPlainObject(spec.map)) {
    log.add(`${path}.map`, 'missing')
    return
  }
  const map = spec.map
  checkPath(log, `${path}.map.audioUrl`, map.audioUrl, true)
  checkPath(log, `${path}.map.quality`, map.quality, false)
  checkPath(log, `${path}.map.coverUrl`, map.coverUrl, false)
  checkPath(log, `${path}.map.expireAt`, map.expireAt, false)
  checkPath(log, `${path}.map.isPreview`, map.isPreview, false)
}

/**
 * 校验 B 档脚本块。
 *
 * `url` 必须是 http(s)：脚本是第三方代码，不该能从 `file://` 或 `data:` 引入
 * （本地文件走"选文件"那条路时，脚本仍是 URL 或内联在清单里 —— 见下）。
 *
 * `sha256` 给就必须是 64 位 hex：拼错一个字符会让"校验"变成永远失败，
 * 而那种失败看起来像"上游改了脚本"。
 */
function checkScriptSpec(log: IssueLog, path: string, spec: Record<string, unknown>): void {
  if (typeof spec.url !== 'string' || !spec.url.trim()) {
    log.add(`${path}.url`, 'missing')
  } else if (!isHttpUrl(spec.url)) {
    log.add(`${path}.url`, 'invalid-url', spec.url)
  }
  if (spec.sha256 !== undefined) {
    if (typeof spec.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(spec.sha256)) {
      log.add(`${path}.sha256`, 'invalid-type', spec.sha256)
    }
  }
  checkHeaders(log, `${path}.headers`, spec.headers)
  if (spec.platforms !== undefined) {
    if (!Array.isArray(spec.platforms) || spec.platforms.some((item) => typeof item !== 'string')) {
      log.add(`${path}.platforms`, 'invalid-type', spec.platforms)
    }
  }
}

// ─── 在线发现（推荐歌单 / 榜单）──────────────────────────────

/**
 * 校验推荐歌单端点。
 *
 * `id` 与 `name` 必填：没有 id 的歌单卡片点不开（取不了曲目），没有名字的卡片是空白。
 * 这两条与 `musicHall.fetchRecommendPlaylists` 的既有丢弃规则一致
 * （它也是「无 id 或无名直接丢弃」）——校验期报错比运行期静默丢弃好：
 * 后者会让作者看到「我的源推荐列表总是空」，却不知道是字段映射写错了。
 */
function checkRecommendEndpoint(log: IssueLog, path: string, spec: unknown): void {
  if (!isPlainObject(spec)) {
    log.add(path, 'invalid-type', spec)
    return
  }
  checkEndpointTemplate(log, `${path}.url`, spec.url, 'recommend')
  checkHeaders(log, `${path}.headers`, spec.headers)
  if (spec.items !== undefined) checkPath(log, `${path}.items`, spec.items, false)
  if (!isPlainObject(spec.map)) {
    log.add(`${path}.map`, 'missing')
    return
  }
  const map = spec.map
  checkPath(log, `${path}.map.id`, map.id, true)
  checkPath(log, `${path}.map.name`, map.name, true)
  checkPath(log, `${path}.map.coverUrl`, map.coverUrl, false)
  checkPath(log, `${path}.map.listenNum`, map.listenNum, false)
  checkPath(log, `${path}.map.creatorName`, map.creatorName, false)
  checkPath(log, `${path}.map.createTime`, map.createTime, false)
}

/** 校验榜单列表端点（分组 → 组内榜单 → 可选预览曲目） */
function checkToplistsEndpoint(log: IssueLog, path: string, spec: unknown): void {
  if (!isPlainObject(spec)) {
    log.add(path, 'invalid-type', spec)
    return
  }
  checkEndpointTemplate(log, `${path}.url`, spec.url, 'toplists')
  checkHeaders(log, `${path}.headers`, spec.headers)
  if (spec.groups !== undefined) checkPath(log, `${path}.groups`, spec.groups, false)

  if (!isPlainObject(spec.map)) {
    log.add(`${path}.map`, 'missing')
    return
  }
  const map = spec.map
  // 组名可以不给（界面用通用标题兜底），但组内榜单的位置与字段必须说清
  checkPath(log, `${path}.map.groupName`, map.groupName, false)
  checkPath(log, `${path}.map.groupId`, map.groupId, false)
  checkPath(log, `${path}.map.toplists`, map.toplists, false)

  if (!isPlainObject(map.item)) {
    log.add(`${path}.map.item`, 'missing')
    return
  }
  const item = map.item
  checkPath(log, `${path}.map.item.id`, item.id, true)
  checkPath(log, `${path}.map.item.name`, item.name, true)
  checkPath(log, `${path}.map.item.updateTime`, item.updateTime, false)
  checkPath(log, `${path}.map.item.period`, item.period, false)
  checkPath(log, `${path}.map.item.listenNum`, item.listenNum, false)
  checkPath(log, `${path}.map.item.coverUrl`, item.coverUrl, false)
  checkPath(log, `${path}.map.item.songs`, item.songs, false)

  // 预览曲目是可选的：给了 songs 路径就必须给 title 映射，否则取不到可展示的内容
  if (item.songs !== undefined) {
    if (!isPlainObject(item.song)) {
      log.add(`${path}.map.item.song`, 'missing')
      return
    }
    const song = item.song
    checkPath(log, `${path}.map.item.song.title`, song.title, true)
    checkPath(log, `${path}.map.item.song.rank`, song.rank, false)
    checkPath(log, `${path}.map.item.song.artist`, song.artist, false)
    checkPath(log, `${path}.map.item.song.coverUrl`, song.coverUrl, false)
  }
}

/** 校验榜单详情端点 */
function checkToplistDetailEndpoint(log: IssueLog, path: string, spec: unknown): void {
  if (!isPlainObject(spec)) {
    log.add(path, 'invalid-type', spec)
    return
  }
  checkEndpointTemplate(log, `${path}.url`, spec.url, 'toplistDetail')
  checkHeaders(log, `${path}.headers`, spec.headers)
  if (spec.items !== undefined) checkPath(log, `${path}.items`, spec.items, false)

  if (spec.meta !== undefined) {
    if (!isPlainObject(spec.meta)) {
      log.add(`${path}.meta`, 'invalid-type', spec.meta)
    } else {
      checkPath(log, `${path}.meta.name`, spec.meta.name, false)
      checkPath(log, `${path}.meta.updateTime`, spec.meta.updateTime, false)
      checkPath(log, `${path}.meta.total`, spec.meta.total, false)
    }
  }

  if (!isPlainObject(spec.map)) {
    log.add(`${path}.map`, 'missing')
    return
  }
  const map = spec.map
  checkPath(log, `${path}.map.title`, map.title, true)
  checkPath(log, `${path}.map.artist`, map.artist, true)
  checkPath(log, `${path}.map.rank`, map.rank, false)
  checkPath(log, `${path}.map.album`, map.album, false)
  checkPath(log, `${path}.map.duration`, map.duration, false)
  checkPath(log, `${path}.map.durationMs`, map.durationMs, false)
  checkPath(log, `${path}.map.coverUrl`, map.coverUrl, false)
  checkPath(log, `${path}.map.songmid`, map.songmid, false)
  // 同一个坑在曲目映射里已经踩过：秒与毫秒不能同时声明
  if (map.duration !== undefined && map.durationMs !== undefined) {
    log.add(`${path}.map.durationMs`, 'duplicate')
  }
}

/** 校验歌词声明 */
function checkLyricsSpec(log: IssueLog, path: string, spec: Record<string, unknown>): void {
  checkEndpointTemplate(log, `${path}.url`, spec.url, 'lyrics')
  checkHeaders(log, `${path}.headers`, spec.headers)
  if (spec.format !== undefined && spec.format !== 'json' && spec.format !== 'lrc') {
    log.add(`${path}.format`, 'invalid-type', spec.format)
  }
}

/**
 * 由已校验的入参构造清单对象。
 *
 * 只挑契约里声明过的键，且**不做**隐式补全（除了 `lyrics.format` 的默认值，
 * 它有明确的历史语义：JSON 是既有执行器的解析路径）。
 */
function buildManifest(input: Record<string, unknown>): PluginManifest {
  const manifest: PluginManifest = {
    format: PLUGIN_MANIFEST_FORMAT,
    id: input.id as string,
    name: input.name as PluginManifest['name'],
    version: (input.version as string).trim(),
    permissions: [...(input.permissions as PluginPermission[])],
    // 主机名统一小写去空白：运行期的白名单比对不应受作者书写习惯影响
    hosts: (input.hosts as string[]).map((host) => host.trim().toLowerCase()),
  }
  if (input.description !== undefined) manifest.description = input.description as PluginManifest['description']
  if (input.author !== undefined) manifest.author = input.author as string
  if (input.homepage !== undefined) manifest.homepage = input.homepage as string
  if (input.source !== undefined) manifest.source = input.source as PluginManifest['source']
  if (input.script !== undefined) manifest.script = input.script as PluginManifest['script']
  if (input.lyrics !== undefined) {
    const lyrics = input.lyrics as Record<string, unknown>
    manifest.lyrics = {
      url: lyrics.url as string,
      format: (lyrics.format as 'json' | 'lrc' | undefined) ?? 'json',
      ...(lyrics.headers === undefined ? {} : { headers: lyrics.headers as Record<string, string> }),
    }
  }
  return manifest
}

/**
 * 格式标识的展示用名字（供错误信息渲染：只说"格式不对"用户不知道怎么办，
 * 得告诉他"支持哪些"）。
 */
export function supportedFormatsLabel(): string {
  return SUPPORTED_MANIFEST_FORMATS.join(', ')
}
