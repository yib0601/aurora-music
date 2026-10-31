/**
 * B 档：从清单的 `script` 块构造音源插件。
 *
 * ## 这一层做什么、不做什么
 *
 * **做**：把「清单里声明了一份洛雪脚本」翻译成 `SourcePlugin` 的 `resolveTrack` / `search`，
 * 让 `lxHost.ts` 已有的沙箱去跑脚本。
 *
 * **不做**：沙箱、Liscript 解包、能力探测、平台字段映射 —— 那些全在
 * `../lxHost.ts` / `../lxResolver.ts` 里，且带实测结论（见那两处注释）。本文件
 * 只负责"把清单的脚本与这些既有函数接起来"。
 *
 * ## 为什么脚本内容必须落盘、运行期不回源
 *
 * `script.url` 是地址不是身份：仓库可以 force-push、分支每天前进。若运行期每次
 * 回源拉脚本，用户装的那份"我确认过的代码"会在下一次播放时变成别的东西 ——
 * 这正是供应链攻击最省事的形式。
 *
 * 所以安装器把脚本**完整拉下来**并与清单一起落盘（见 desktop 的 `pluginStore`），
 * 运行期只跑本地副本。`script.sha256` 给了就在安装时强制比对；没给则记录实测值。
 *
 * 本文件的 `scriptBodyOf()` 就是这个约定的读取端：它要求调用方把**已落盘的脚本文本**
 * 塞进 `OnlineSourceConfig.script`，绝不在这里发起网络请求。
 */

import type { OnlineSourceConfig, OnlineTrackSearchResult, SourceTrackRef } from '../../types'
import type { PluginContext, ResolvedAudio, SourcePlugin } from '../types'
import type { DeclarativeScriptSpec, PluginManifest } from './types'
import { resolveLocalized } from './localize'
import { getLxHostDeps, inspectLxSource } from '../../lxHost'
import { resolveLxTrack, searchLxSourceForAggregate } from '../../lxResolver'
import { lxInspectionToProbe } from '../../sourceProbe'

/**
 * 一条"脚本源"配置：与洛雪宿主要求的形状一致。
 *
 * 关键点：`script` 字段装的是**脚本源码正文**（已落盘的那一份），不是 URL。
 * `sourceUrl` 保留清单里的脚本地址，仅用于展示与"重新拉取"。
 */
export interface ScriptSourceConfig extends OnlineSourceConfig {
  /** 脚本源码（运行本地副本，绝不回源） */
  script?: string
}

/**
 * 从配置里取已落盘的脚本文本。
 *
 * 找不到时返回 null 而不是抛错：调用方（`preflight`）据此给出「脚本不可用」的
 * 可读原因，而不是让上层看到一句网络错误。这与内置 `lxPlugin.preflight`
 * 的语义一致（那里检查的是「宿主是否装配 + 脚本能否下载」）。
 */
export function scriptBodyOf(config: OnlineSourceConfig | null | undefined): string | null {
  const body = (config as ScriptSourceConfig | null | undefined)?.script
  return typeof body === 'string' && body.trim() ? body : null
}

/**
 * 声明该插件会执行第三方代码时，`PluginContext` 里**必须**有脚本宿主。
 *
 * 为什么要有这条检查：宿主依赖（`setLxHostDeps`）是平台层在启动时注入的。
 * 桌面端有（Node 网络栈 + `node:vm`），Web 端没有（浏览器里既没有 vm 也没有
 * 不受 CORS 约束的请求通道）。缺宿主时脚本源必须**明确不可用**，
 * 而不是等到取址时才抛一个看不懂的错误。
 */
function hostReady(): boolean {
  // `getLxHostDeps()` 每次现读模块级单例：平台层可能在插件注册**之后**才装配宿主
  // （桌面端在 app ready 后才 setLxHostDeps）。所以这里不能在模块顶层求值。
  const deps = getLxHostDeps()
  return Boolean(deps && typeof deps.request === 'function')
}

/**
 * 清单 → 脚本插件。
 *
 * 返回 null 表示"这份清单没有脚本块"（没有 B 档能力，调用方不该注册）。
 */
export function buildScriptPlugin(manifest: PluginManifest, locale = 'zh-CN'): SourcePlugin | null {
  const spec = manifest.script
  if (!spec) return null

  // 展示名用清单的字面量（外部插件不进应用字典，理由见 types.ts 文件头第 4 条）。
  // 契约字段是 `MessageKey`，这里塞 id 作为技术兜底；用户看到的名字来自
  // `PluginCatalogEntry.displayName`（catalog 层解析）。
  const displayName = resolveLocalized(manifest.name, locale, manifest.id)

  /** 把应用侧配置翻译成洛雪宿主认识的形状 */
  const asLxSource = (config: OnlineSourceConfig): ScriptSourceConfig => ({
    ...config,
    // 脚本地址保留清单声明的那一条（诊断 / 重新拉取要用）
    sourceUrl: config.sourceUrl || spec.url,
    script: scriptBodyOf(config) ?? undefined,
  })

  const plugin: SourcePlugin = {
    id: manifest.id,
    displayNameKey: manifest.id as SourcePlugin['displayNameKey'],
    descriptionKey: `plugin.${manifest.id}.description` as SourcePlugin['descriptionKey'],
    version: manifest.version,
    // 脚本源的能力是**运行期自报**的（`inspectLxSource`），声明式清单这里只能给出
    // 保守集合：取址一定有（洛雪协议的核心），自带搜索可能有。
    capabilities: ['resolveTrack', 'search'] as SourcePlugin['capabilities'],
  }

  /**
   * 前置检查：脚本可用 + 宿主已装配。
   *
   * 这两件事缺任一，取址必然失败。若不在这里摘掉，用户看到的是
   * 「所有音源请求失败」，而真实原因（宿主没初始化 / 脚本没落盘）被掩盖。
   * 这条判断的语义与内置 `lxPlugin.preflight` 完全一致。
   */
  plugin.preflight = async (config) => {
    if (!hostReady()) return { ok: false, reason: 'core.error.lxHostNotReady' }
    if (!scriptBodyOf(config)) return { ok: false, reason: 'core.error.lxSourceNoScript' }
    return { ok: true }
  }

  /** 探测：把脚本跑一遍问出平台能力（与内置 lx 插件同一实现） */
  plugin.probe = async (config) => {
    const body = scriptBodyOf(config)
    if (!body) {
      // 脚本没落盘：给结构化结论而不是抛错（探测是"告诉你能不能用"的动作）
      return {
        ok: false,
        kind: 'aurora',
        capabilities: [],
        error: 'AURORA_ERR:{"code":"core.error.lxSourceNoScript"}',
      }
    }
    try {
      const inspection = await inspectLxSource(asLxSource(config))
      return lxInspectionToProbe(inspection)
    } catch (err) {
      return {
        ok: false,
        kind: 'aurora',
        capabilities: [],
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * 取址：把曲目的定位令牌原样交回脚本（令牌是**不透明**的，见 SourceTrackRef）。
   *
   * 失败返回 null（不抛错）：上层据此回落按名搜索 —— 这是既有编排的约定，
   * 取址失败不该打断播放。
   */
  plugin.resolveTrack = async (
    config: OnlineSourceConfig,
    ref: SourceTrackRef,
    quality,
    _ctx: PluginContext
  ): Promise<ResolvedAudio | null> => {
    const body = scriptBodyOf(config)
    if (!body) return null
    const outcome = await resolveLxTrack({
      lx: {
        sourceId: ref?.sourceId || config.id,
        platform: ref?.platform || '',
        meta: ref?.meta || {},
      },
      meta: ref?.meta || null,
      onlineSource: asLxSource(config),
      quality,
    })
    if (!outcome.url) return null
    return { url: outcome.url, quality: outcome.quality }
  }

  /**
   * 搜索：脚本自带 search / musicSearch 能力时才有结果。
   *
   * 空结果不是错误 —— 大多数脚本只做取址，没有��共搜索接口。这条与内置
   * `lxPlugin.search` 的语义一致（它也是"脚本没这能力就返回空数组"）。
   */
  plugin.search = async (
    config: OnlineSourceConfig,
    query: string
  ): Promise<OnlineTrackSearchResult[]> => {
    const body = scriptBodyOf(config)
    if (!body) return []
    return searchLxSourceForAggregate(asLxSource(config), query)
  }

  // 保留 displayName 到返回值里供诊断（SourcePlugin 契约里没有这个字段，
  // 但调试时能一眼看出"这是哪个插件"，不必再去查清单）
  void displayName
  return plugin
}

/**
 * 清单里的脚本地址（供安装器拉取脚本正文）。
 *
 * 单列一个导出的原因：安装器要么拉脚本、要么从清单里读到它，
 * 而"清单里的哪个字段是脚本地址"这件事不该由调用方拼。
 */
export function scriptUrlOf(manifest: PluginManifest): string | null {
  const url = manifest.script?.url
  return typeof url === 'string' && url.trim() ? url.trim() : null
}

/** 清单里声明的脚本哈希（可选；给了安装器必须比对） */
export function scriptSha256Of(spec: DeclarativeScriptSpec | undefined): string | null {
  const sha = spec?.sha256
  return typeof sha === 'string' && /^[0-9a-f]{64}$/i.test(sha) ? sha.toLowerCase() : null
}

/** 脚本插件的展示名（供 catalog / UI；与 `manifestDisplayName` 同语义） */
export function scriptPluginName(manifest: PluginManifest, locale: string): string {
  return resolveLocalized(manifest.name, locale, manifest.id)
}
