/**
 * 内置歌词插件：LRCLIB 兜底。
 *
 * ## 为什么它要成为插件（v15）
 *
 * 改造前 LRCLIB 是 `lyricsSource.ts` 里的两个**模块级常量**，由 `searchLyrics`
 * 无条件追加到源列表末尾。后果有三条，都属于「隐式原始能力」的典型问题：
 *
 * 1. **用户看不到它**：设置页的插件列表里没有这一项，用户不知道歌词是从哪来的；
 * 2. **用户关不掉它**：LRCLIB 实测会回 503 ServerOverloaded，那时每次取词都要
 *    在它身上白等一轮超时（排在用户源之后，前档全部落空才会轮到），
 *    而设置里没有任何开关能止损；
 * 3. **它和「用户源」的关系说不清**：`BUILTIN_LYRICS_IDS` 只是把它从用户列表里
 *    过滤掉，没有一个地方表达「这是一条内置的、可停用的实现」。
 *
 * 现在它是一条 `domain: 'lyrics'` 的内置插件：进目录、可停用、`requires` 声明
 * 出网能力。歌词**聚合策略**（用户源优先、延迟对冲、首个非空胜出）仍归
 * `lyricsSource.searchLyrics` —— 插件只回答「我给哪条源」，与别的歌词插件同一契约。
 *
 * ## 为什么 id 与两个歌词源 id 都不同
 *
 * - 插件 id：`builtin-lyrics-lrclib`（`BUILTIN_LYRICS_PLUGIN_ID`，启停门禁用）
 * - 源 id：`builtin-lrclib-get` / `builtin-lrclib`（两条上游端点，聚合用）
 *
 * 粒度不同不能混用：一个插件派生两条源，用源 id 做启停键会让「关掉这个插件」
 * 变成「只关掉其中一条」，用户完全无法预期。
 */

import type { LyricsSourceConfig, OnlineSourceConfig } from '../types'
import type { SourcePlugin } from './types'
import {
  BUILTIN_LYRICS_GET_SOURCE,
  BUILTIN_LYRICS_PLUGIN_ID,
  BUILTIN_LYRICS_SOURCE,
} from '../lyricsSource'

export const lrclibPlugin: SourcePlugin = {
  id: BUILTIN_LYRICS_PLUGIN_ID,
  displayNameKey: 'core.platform.builtinLyricsLrclib',
  descriptionKey: 'sources.plugins.builtinLyricsDesc',
  version: '1.0.0',

  /**
   * 只要求出网。`log` 可选（缺了照常工作，只是少一条排查线索）。
   *
   * 不需要 `credential`：LRCLIB 是开放接口，没有账号体系。
   * 不需要 `script.host`：它是纯 HTTP 声明，不执行任何代码。
   */
  requires: [
    { id: 'http.fetch', version: 1 },
    { id: 'log', version: 1, optional: true },
  ],

  // 能力清单里只有歌词：它不搜索、不取址、不解析歌单
  capabilities: ['lyrics'] as const,

  /**
   * 交出「精确取词」这条源。
   *
   * 为什么只交一条而不是两条：聚合器（`searchLyrics`）自己就知道该用两条 ——
   * 它把 `BUILTIN_LYRICS_GET_SOURCE` 与 `BUILTIN_LYRICS_SOURCE` 按「精确 → 模糊」
   * 的顺序追加（见该函数注释：/api/get 命中时 7.7KB/1~2s，/api/search 是
   * 154KB/p50 3~7s，宁可多一次 404 也不让常见情形先等那 154KB）。
   *
   * 这里返回第一条，语义是「本插件提供这条内置源」，聚合仍归聚合器。
   * 返回 null 表示「此刻不提供」—— 本插件没有这种情形（端点写死、无用户配置）。
   */
  lyricsSource(_config: OnlineSourceConfig): LyricsSourceConfig | null {
    return BUILTIN_LYRICS_GET_SOURCE
  },
}

/** 静态展示用的能力清单（与其它内置插件同一导出形态） */
export const LRCLIB_PLUGIN_CAPABILITIES = lrclibPlugin.capabilities
