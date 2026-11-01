/**
 * 洛雪（lx-music）脚本源 → 插件适配器。
 *
 * **只做转发**：脚本宿主、能力探测、取址编排的实现仍在
 * `lxHost.ts` / `lxResolver.ts` / `sourceProbe.ts`，本文件只把它们包成插件契约的形状。
 *
 * 这个插件是「能力缺失」的最佳示例：绝大多数洛雪脚本**只实现取址、没有公共搜索接口**，
 * 所以 `search` 在契约上是可选的——缺失时上层降级（该源不参与搜索聚合），
 * 而不是靠 `kind === 'lx'` 判断后跳过。
 */

import type {
  DownloadQuality,
  OnlineSourceConfig,
  OnlineTrackSearchResult,
  SourceProbeResult,
  SourceTrackRef,
} from '../types'
import type {
  PluginCapability,
  PluginContext,
  PreflightResult,
  ResolvedAudio,
  SourcePlugin,
} from './types'
import { getLxHostDeps, inspectLxSource, searchLxSource } from '../lxHost'
import { resolveLxScript, resolveLxTrack, searchLxSourceForAggregate } from '../lxResolver'
import { lxInspectionToProbe } from '../sourceProbe'

/** 脚本形态的令牌带 `platform` 与原始 meta（见 `SourceTrackRef` 注释） */
function asLxRef(config: OnlineSourceConfig, ref: SourceTrackRef) {
  return {
    sourceId: ref?.sourceId || config.id,
    platform: ref?.platform || '',
    meta: ref?.meta || {},
  }
}

export const lxPlugin: SourcePlugin = {
  id: 'lx',
  displayNameKey: 'sources.form.kindLx',
  descriptionKey: 'sources.form.kindLxHint',
  version: '1.0.0',
  // 脚本源没有标准歌词能力（见 lyrics.service 既有行为），故不声明 lyrics；
  // playlistParse 也不声明：脚本协议里没有歌单解析入口。
  capabilities: ['probe', 'search', 'resolveTrack'] as const,

  /**
   * 依赖声明：**脚本源的本质就是「要宿主给我一个脚本沙箱」**。
   *
   * 这条以前只写在 `preflight` 里（`if (!getLxHostDeps())` → 运行时才发现不可用），
   * 现在提前到注册期：浏览器端没有 `script.host`，于是 lx 在那里**不会被注册**，
   * 设置页显示"当前平台缺少脚本宿主"，而不是让用户填完链接、点完测试才被拒。
   * 这同时替掉了 `pluginForm.ts` 里那张按插件 id 硬编码的 `pluginAvailableOn` 表。
   */
  requires: [
    { id: 'http.fetch', version: 1 },
    { id: 'script.host', version: 1 },
    { id: 'log', version: 1, optional: true },
  ],

  /**
   * 前置检查：脚本源要真能跑，需要「宿主已装配」+「脚本源码可下载」。
   *
   * 这两件事缺任一，搜索必然失败；若不在这里摘掉，用户看到的是
   * 「所有音源请求失败」，而真正原因（宿主没初始化 / 脚本拉不下来）被掩盖。
   * 改造前这段判断写在 musicSource 的聚合循环里，还带 `kind === 'lx'` 分支。
   */
  async preflight(config: OnlineSourceConfig): Promise<PreflightResult> {
    if (!getLxHostDeps()) {
      return { ok: false, reason: 'core.error.lxHostNotReady' }
    }
    const script = await resolveLxScript(config)
    if (!script) {
      return { ok: false, reason: 'core.error.lxSourceNoScript' }
    }
    return { ok: true }
  },

  async probe(config: OnlineSourceConfig): Promise<SourceProbeResult> {
    // 脚本要拉下来在宿主里跑一遍才能问出能力；源码不写进配置，只在本次探测中存在
    const inspection = await inspectLxSource(config)
    return lxInspectionToProbe(inspection)
  },

  /**
   * 搜索：脚本自带 search / musicSearch 能力时才有结果。
   * 脚本没这能力时返回空数组（不是抛错）——上层把空结果当作「该源没搜到」处理。
   */
  async search(
    config: OnlineSourceConfig,
    query: string,
    _quality: DownloadQuality | undefined
  ): Promise<OnlineTrackSearchResult[]> {
    // 宿主依赖由全局注册（setLxHostDeps）提供；未装配时该函数抛结构化错误，
    // 由调用方按「本环境不具备该能力」处理
    return searchLxSourceForAggregate(config, query)
  },

  /**
   * 取址：脚本形态的令牌是**不透明**的，原样交回脚本。
   * 失败返回 null（调用方回落按名搜索），不抛错——这是既有编排的约定。
   */
  async resolveTrack(
    config: OnlineSourceConfig,
    ref: SourceTrackRef,
    quality: DownloadQuality | undefined
  ): Promise<ResolvedAudio | null> {
    const outcome = await resolveLxTrack({
      lx: asLxRef(config, ref),
      meta: ref?.meta || null,
      onlineSource: config,
      quality,
    })
    if (!outcome.url) return null
    return { url: outcome.url, quality: outcome.quality }
  },
}

/**
 * 脚本形态的「自带搜索」走另一条入口（`searchLxSource` 直接执行脚本 search）。
 * 单列一个导出而不塞进契约：它的入参是脚本源码，属于插件内部实现细节。
 */
export { searchLxSource }

export const LX_PLUGIN_CAPABILITIES: readonly PluginCapability[] = lxPlugin.capabilities
