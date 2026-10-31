/**
 * 插件管理的纯逻辑（可单测，不含 JSX）。
 *
 * 职责边界：
 * - 本文件：读目录、装、卸、渲染失败原因、算"能不能用哪些入口"——**不碰 JSX**
 * - `PluginManagerPanel.tsx`：只负责渲染
 *
 * 为什么拆出来：`SettingsPage.tsx` 已经 2700 行，而插件管理是"列出 → 安装 → 确认权限
 * → 卸载 → 展示坏文件"的多状态流程，塞进页面组件就只能靠手点验证。拆出来才能被单测覆盖。
 *
 * ## 一条贯穿本文件的原则：**失败必须可归因**
 *
 * 安装失败的原因有六种以上（清单非法 / id 冲突 / 哈希不符 / 下载失败 / 不是 UTF-8 /
 * 磁盘写失败）。若统一显示"安装失败"，用户唯一的补救方式是反复重试。所以这里的每个
 * 出口都尽量产出**具体**的原因，且清单结构问题要逐条列出字段路径。
 */

import type {
  ManifestIssue,
  PluginCatalogEntry,
  PluginInstallResult,
  PluginPermission,
} from '@aurora/shared'
import { catalogByDomain, entryHasCapability } from '@aurora/shared'
import { platform } from '@/services/platform'
import { appTranslate } from '@/i18n'
import type { MessageKey } from '@aurora/shared'
import { renderErrorMessage } from '@/lib/utils'

/** 目录快照的渲染态 */
export interface PluginCatalogState {
  /** 全部插件（内置 + 已安装），已按域分组前的原始顺序 */
  entries: PluginCatalogEntry[]
  /** 读不出来的插件文件 */
  broken: Array<{ path: string; message?: string }>
  /** 本端是否具备插件管理能力（老 preload / 移动端 / Web 都没有） */
  manageable: boolean
  /** 本端是否具备插件执行能力（与 manageable 分开：能执行不一定能装） */
  executable: boolean
}

const EMPTY_CATALOG: PluginCatalogState = {
  entries: [],
  broken: [],
  manageable: false,
  executable: false,
}

/** 本端是否具备插件执行能力（与 `pluginAuth.pluginLayerAvailable` 同判据） */
export function pluginExecutionAvailable(): boolean {
  return typeof platform.plugins?.list === 'function'
}

/**
 * 本端是否具备**安装**能力。
 *
 * 判据是 `installFromUrl` 或 `installFromFile` 存在，而不是某个 flag：
 * 老版本 preload 有执行通道、没有安装通道，那种组合必须表现为"能看列表、不能装"，
 * 而不是整个插件页消失。
 */
export function pluginInstallAvailable(): boolean {
  const gateway = platform.plugins
  if (!gateway) return false
  return typeof gateway.installFromUrl === 'function' || typeof gateway.installFromFile === 'function'
}

/**
 * 读插件目录。
 *
 * 失败时返回空目录而不是抛错：插件页是设置里的一个分区，读失败不该让整个设置页白屏。
 * 但 `manageable` 会如实反映能力，UI 据此显示"当前环境不支持"而不是"一个插件都没有"
 * —— 那两句话对用户的含义完全不同。
 */
export async function loadPluginCatalog(locale: string): Promise<PluginCatalogState> {
  const gateway = platform.plugins
  if (!gateway) return EMPTY_CATALOG

  if (typeof gateway.catalog !== 'function') {
    // 有执行能力但没有目录通道：退回只用执行侧的元信息列表（老 preload 的兼容路径）
    const executable = pluginExecutionAvailable()
    if (!executable) return EMPTY_CATALOG
    try {
      const metas = await gateway.list()
      return {
        entries: metas.map((meta) => ({
          id: meta.id,
          domain: 'source' as const,
          displayNameKey: meta.displayNameKey,
          ...(meta.descriptionKey ? { descriptionKey: meta.descriptionKey } : {}),
          version: meta.version,
          capabilities: meta.capabilities,
          provenance: 'builtin' as const,
          removable: false,
        })),
        broken: [],
        manageable: false,
        executable: true,
      }
    } catch (err) {
      console.warn('[插件] 读取插件列表失败:', err)
      return { ...EMPTY_CATALOG, executable: true }
    }
  }

  try {
    const snapshot = await gateway.catalog(locale)
    return {
      entries: Array.isArray(snapshot?.entries) ? snapshot.entries : [],
      broken: Array.isArray(snapshot?.broken) ? snapshot.broken : [],
      manageable: pluginInstallAvailable(),
      executable: true,
    }
  } catch (err) {
    console.warn('[插件] 读取插件目录失败:', err)
    return { ...EMPTY_CATALOG, executable: true, manageable: pluginInstallAvailable() }
  }
}

/** 已安装（可卸载）的条目 */
export function installedEntries(entries: readonly PluginCatalogEntry[]): PluginCatalogEntry[] {
  return entries.filter((entry) => entry.removable)
}

/** 内置条目（不可卸载） */
export function builtinEntries(entries: readonly PluginCatalogEntry[]): PluginCatalogEntry[] {
  return entries.filter((entry) => !entry.removable)
}

/** 能当音源用的条目（搜索或歌单能力），供「添加音源」的形态列表复用 */
export function sourceEntriesOf(entries: readonly PluginCatalogEntry[]): PluginCatalogEntry[] {
  return catalogByDomain(entries, 'source').filter(
    (entry) => entryHasCapability(entry, 'search') || entryHasCapability(entry, 'playlistParse')
  )
}

/**
 * 条目的展示名 → 成品文案。
 *
 * 内置插件给的是**字典键**（`displayNameKey`），已安装插件给的是**字面量**
 * （`displayName`，已由主进程按当前语言解析）。两者必有一个 ——
 * 都没有时回落 id，绝不让展示名变成空白（空白条目在列表里等于消失）。
 */
export function displayNameOf(
  entry: PluginCatalogEntry,
  t: (key: MessageKey) => string
): string {
  if (entry.displayName) return entry.displayName
  if (entry.displayNameKey) return t(entry.displayNameKey as MessageKey)
  return entry.id
}

/** 条目的说明文案（同上的双形态；没有说明返回空串，UI 自行决定是否显示副标题） */
export function displayDescriptionOf(
  entry: PluginCatalogEntry,
  t: (key: MessageKey) => string
): string {
  if (entry.description) return entry.description
  if (entry.descriptionKey) return t(entry.descriptionKey as MessageKey)
  return ''
}

/**
 * 能力徽章的文案键。
 *
 * 与 `sources.capability.*`（音源卡片上的徽章）分开用一套 `sources.plugins.capability.*`：
 * 那套的后缀是插件契约的能力名（`pluginSearch` / `pluginAuth`…），这套是插件管理页的短标签。
 * 未知能力**不回落到原文**而是返回 null：契约里出现新能力时，宁可少显示一个徽章，
 * 也不要在界面上露出 `someNewCapability` 这种实现词。
 */
const CAPABILITY_LABEL_KEYS: Record<string, MessageKey> = {
  search: 'sources.plugins.capability.search',
  resolveTrack: 'sources.plugins.capability.resolveTrack',
  playlistParse: 'sources.plugins.capability.playlistParse',
  lyrics: 'sources.plugins.capability.lyrics',
  // 存储插件的四个能力归并为一个"存储"标签：插件管理页不需要区分 openRange / openStream
  listAudio: 'sources.plugins.capability.storage',
  openRange: 'sources.plugins.capability.storage',
  openStream: 'sources.plugins.capability.storage',
  probe: 'sources.plugins.capability.storage',
  playlistTracks: 'sources.plugins.capability.playlistParse',
  userPlaylists: 'sources.plugins.capability.playlistParse',
  auth: 'sources.plugins.capability.search',
  // 在线发现（v14 起属于插件能力）
  recommendPlaylists: 'sources.plugins.capability.recommendPlaylists',
  toplists: 'sources.plugins.capability.toplists',
  toplistDetail: 'sources.plugins.capability.toplists',
}

/** 条�� → 去重后的能力文案（同一标签只出现一次，如 webdav 的四个存储能力合成一条） */
export function capabilityLabelsOf(
  entry: PluginCatalogEntry,
  t: (key: MessageKey) => string
): string[] {
  const out: string[] = []
  for (const capability of entry.capabilities) {
    const key = CAPABILITY_LABEL_KEYS[capability]
    if (!key) continue
    const label = t(key)
    if (!out.includes(label)) out.push(label)
  }
  return out
}

/**
 * 权限 → 给人看的句子。
 *
 * 这就是"插件申请什么，就要让用户看见什么"的落点（docs/plugins.md）。
 * 关键的是 `network` 要把**具体域名**列出来：只说"访问网络"等于什么都没说。
 */
export function permissionLinesOf(
  permissions: readonly PluginPermission[] | undefined,
  hosts: readonly string[] | undefined,
  t: (key: MessageKey, params?: Record<string, string | number>) => string
): string[] {
  if (!permissions || permissions.length === 0) return [t('sources.plugins.permissionNone')]
  const out: string[] = []
  for (const permission of permissions) {
    if (permission === 'network') {
      const list = (hosts || []).join('、')
      out.push(t('sources.plugins.permissionNetwork', { hosts: list || '—' }))
      continue
    }
    if (permission === 'credential') {
      out.push(t('sources.plugins.permissionCredential'))
      continue
    }
    if (permission === 'script') {
      // B 档：措辞必须与「只发 HTTP 请求」明显不同 —— 用户有权知道有代码要跑
      out.push(t('sources.plugins.permissionScript'))
      continue
    }
    // filesystem 在 A 档被校验器挡掉，理论上到不了这里；保留兜底避免未知权限静默消失
    out.push(String(permission))
  }
  return out
}

/**
 * 把 `ManifestIssue` 渲染成"哪个字段 + 什么问题"。
 *
 * 逐条渲染而不是汇总成一句：清单问题常有多处，用户改完一条再撞下一条是最消耗耐心的
 * 体验（这是校验器"一次返回全部 issues"的设计目的）。
 */
const ISSUE_TEMPLATE: Record<ManifestIssue['code'], MessageKey> = {
  'not-object': 'sources.plugins.issue.notObject',
  missing: 'sources.plugins.issue.missing',
  'invalid-format': 'sources.plugins.issue.invalidFormat',
  'invalid-id': 'sources.plugins.issue.invalidId',
  'invalid-version': 'sources.plugins.issue.invalidVersion',
  'invalid-type': 'sources.plugins.issue.invalidType',
  'invalid-url': 'sources.plugins.issue.invalidUrl',
  empty: 'sources.plugins.issue.empty',
  'wildcard-host': 'sources.plugins.issue.wildcardHost',
  'unsupported-permission': 'sources.plugins.issue.unsupportedPermission',
  'unsupported-domain': 'sources.plugins.issue.unsupportedDomain',
  'no-capability': 'sources.plugins.issue.noCapability',
  duplicate: 'sources.plugins.issue.duplicate',
}

export function describeIssues(
  issues: readonly ManifestIssue[] | undefined,
  t: (key: MessageKey, params?: Record<string, string | number>) => string
): Array<{ field: string; message: string }> {
  // 这里刻意不用 `Array.isArray` 做守卫：它对 `readonly T[]` 的收窄结果是 `any[]`，
  // 后续 `issue.code` 就退化成 any，`ISSUE_TEMPLATE` 的类型约束随之失效 ——
  // 将来 ManifestIssue 加一个新 code 时，编译器不会再提醒你补文案。
  if (!issues || issues.length === 0) return []
  return issues.map((issue) => ({
    // 空 path 是"整个清单"层面的问题（如 not-object），不显示"字段："前缀
    field: issue.path ? t('sources.plugins.issue.field', { path: issue.path }) : '',
    message: t(ISSUE_TEMPLATE[issue.code] ?? 'sources.plugins.issue.invalidType'),
  }))
}

/**
 * 安装结果 → 可读文案。
 *
 * 主进程返回的 `message` 两种可能：结构化码（`AURORA_PLUGIN_*`）或已渲染的自由文本
 * （来自 `mainErrorText`，主进程已按当时语言渲染）。前者在这里按当前语言翻，
 * 后者原样透出 —— 不吞技术细节是既有约定（`renderErrorMessage` 同此纪律）。
 */
const ERROR_CODE_KEYS: Record<string, MessageKey> = {
  AURORA_PLUGIN_BUSY: 'sources.plugins.error.busy',
  AURORA_PLUGIN_BUILTIN_ID: 'sources.plugins.error.builtinId',
  AURORA_PLUGIN_DUPLICATE_ID: 'sources.plugins.error.duplicateId',
  AURORA_PLUGIN_HASH_MISMATCH_REQUESTED: 'sources.plugins.error.hashMismatch',
  AURORA_PLUGIN_NOT_INSTALLED: 'sources.plugins.error.notInstalled',
  AURORA_PLUGIN_PATH_OUTSIDE_ROOT: 'sources.plugins.error.pathOutsideRoot',
  AURORA_PLUGIN_SCRIPT_HASH_MISMATCH_REQUESTED: 'sources.plugins.error.scriptHashMismatch',
  AURORA_PLUGIN_SCRIPT_HASH_MISMATCH: 'sources.plugins.error.scriptHashMismatch',
}

export interface InstallOutcome {
  ok: boolean
  /** 成功时的插件展示名（用于"已安装「X」"） */
  name?: string
  /** 失败原因（已按当前语言渲染） */
  message?: string
  /** 清单结构问题（逐条，供 UI 列表展示） */
  issues?: Array<{ field: string; message: string }>
}

/** 把安装/卸载结果包装成可渲染的形状 */
export function describeInstallResult(
  result: PluginInstallResult | undefined,
  t: (key: MessageKey, params?: Record<string, string | number>) => string
): InstallOutcome {
  if (!result) {
    return { ok: false, message: t('sources.plugins.installFailed', { reason: '—' }) }
  }
  if (result.ok) {
    // 成功的返回里 entry 一定在（主进程装配时取的），但类型上可选 ——
    // 兜底用空串而不是 id：调用方拿 name 拼"已安装「X」"，拿不到就显示通用成功文案
    const name = result.entry ? displayNameOf(result.entry, t) : ''
    return { ok: true, name }
  }

  const issues = describeIssues(result.issues, t)
  const raw = String(result.message || '')

  // 结构化码：`AURORA_PLUGIN_X` 或 `AURORA_PLUGIN_X:{...}`（后者带诊断参数）
  const codeMatch = /^(AURORA_PLUGIN_[A-Z_]+)/.exec(raw)
  if (codeMatch) {
    const code = codeMatch[1]
    const key = ERROR_CODE_KEYS[code]
    if (key) {
      // 只有「撞名」这一类的文案带 `{id}` 占位符：给不需要 id 的码也塞一个空参数，
      // 会让翻译层收到无关键（当前插值实现会忽略它，但那是巧合而不是契约）。
      // 需要 id 时才解析，避免这里变成一个"总是传参"的模糊接口。
      const needsId = code === 'AURORA_PLUGIN_BUILTIN_ID' || code === 'AURORA_PLUGIN_DUPLICATE_ID'
      const idMatch = needsId ? /\{id:([^}]*)\}/.exec(raw) : null
      return {
        ok: false,
        message: needsId ? t(key, { id: idMatch ? idMatch[1] : '' }) : t(key),
        ...(issues.length > 0 ? { issues } : {}),
      }
    }
    // 已知前缀但没有对应键：说明这条错误忘了配文案。
    // 不静默吞掉 —— 把原码透出来，让开发者一眼看到缺的是哪条。
    return { ok: false, message: raw, ...(issues.length > 0 ? { issues } : {}) }
  }

  // 自由文本（主进程已渲染）：原样透出 + 统一前缀，用户知道这是"安装失败"
  return {
    ok: false,
    message: raw
      ? t('sources.plugins.installFailed', { reason: raw })
      : t('sources.plugins.installFailed', { reason: '—' }),
    ...(issues.length > 0 ? { issues } : {}),
  }
}

/** 坏文件条目的展示：把结构化后缀（`AURORA_PLUGIN_HASH_MISMATCH:{...}`）翻成一句话 */
export function describeBrokenReason(
  message: string | undefined,
  t: (key: MessageKey, params?: Record<string, string | number>) => string
): string {
  if (!message) return t('sources.plugins.brokenHint')
  if (message.startsWith('AURORA_PLUGIN_SCRIPT_HASH_MISMATCH')) {
    // 脚本被改过：与清单哈希不符同一性质，需要用户重新安装
    return t('sources.plugins.error.scriptHashMismatch')
  }
  if (message.startsWith('AURORA_PLUGIN_HASH_MISMATCH')) {
    // 哈希不符 = 内容被改过：这是需要用户"重新安装"的动作，不是普通格式问题
    return t('desktop.error.plugin.hashMismatch')
  }
  if (message.startsWith('AURORA_PLUGIN_RECORD_INVALID')) {
    return t('sources.plugins.brokenHint')
  }
  if (message.startsWith('AURORA_PLUGIN_DIR_MISMATCH')) {
    return t('sources.plugins.brokenHint')
  }
  if (message.startsWith('AURORA_PLUGIN_NOT_UTF8')) return t('sources.plugins.error.notUtf8')
  if (message.startsWith('AURORA_PLUGIN_BAD_JSON')) {
    const reason = /AURORA_PLUGIN_BAD_JSON:[^:]*:(.*)$/.exec(message)?.[1] || ''
    return t('sources.plugins.error.badJson', { reason })
  }
  return message
}

// ─── 动作 ────────────────────────────────────────────────────

/** 从本地文件安装（先弹文件选择框；取消返回 null） */
export async function installFromFileDialog(locale: string): Promise<InstallOutcome | null> {
  const gateway = platform.plugins
  if (!gateway?.pickManifest) return { ok: false, message: appTranslate()('sources.auth.unsupportedEnv') }
  const filePath = await gateway.pickManifest()
  if (!filePath) return null
  if (!gateway.installFromFile) {
    return { ok: false, message: appTranslate()('sources.auth.unsupportedEnv') }
  }
  try {
    const result = await gateway.installFromFile(filePath, locale)
    return describeInstallResult(result, appTranslate())
  } catch (err) {
    return { ok: false, message: renderErrorMessage(err) }
  }
}

/** 从网址安装 */
export async function installFromUrl(url: string, locale: string): Promise<InstallOutcome> {
  const gateway = platform.plugins
  if (!gateway?.installFromUrl) {
    return { ok: false, message: appTranslate()('sources.auth.unsupportedEnv') }
  }
  const text = String(url || '').trim()
  if (!text) {
    return { ok: false, message: appTranslate()('sources.plugins.installFailed', { reason: '—' }) }
  }
  try {
    const result = await gateway.installFromUrl(text, undefined, locale)
    return describeInstallResult(result, appTranslate())
  } catch (err) {
    return { ok: false, message: renderErrorMessage(err) }
  }
}

/** 卸载 */
export async function uninstallPlugin(pluginId: string, locale: string): Promise<InstallOutcome> {
  const gateway = platform.plugins
  if (!gateway?.uninstall) {
    return { ok: false, message: appTranslate()('sources.auth.unsupportedEnv') }
  }
  try {
    const result = await gateway.uninstall(pluginId, locale)
    const outcome = describeInstallResult(result, appTranslate())
    // 卸载成功的返回里没有 entry（插件已经没了），UI 需要知道被卸的是哪个
    return outcome.ok ? { ok: true, name: pluginId } : outcome
  } catch (err) {
    return { ok: false, message: renderErrorMessage(err) }
  }
}

/** 打开插件目录（排障用） */
export async function openPluginDir(): Promise<boolean> {
  const gateway = platform.plugins
  if (!gateway?.openDir) return false
  try {
    const result = await gateway.openDir()
    return Boolean(result?.ok)
  } catch (err) {
    console.warn('[插件] 打开插件目录失败:', err)
    return false
  }
}

/** 删除一个读不出来的插件目录 */
export async function removeBrokenPlugin(dirPath: string): Promise<boolean> {
  const gateway = platform.plugins
  if (!gateway?.removeBroken) return false
  try {
    const result = await gateway.removeBroken(dirPath)
    return Boolean(result?.ok)
  } catch (err) {
    console.warn('[插件] 删除坏插件失败:', err)
    return false
  }
}
