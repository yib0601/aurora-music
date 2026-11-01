/**
 * 已安装插件的歌词能力登记处（**零依赖**）。
 *
 * ## 为什么需要这一层，而不是让 `lyricsSource.ts` 直接 import `installed.ts`
 *
 * 那条 import 会成环，而且是**求值期**的环：
 *
 *   `lyricsSource` → `installed` → `builtins` → `lrclibPlugin` → `lyricsSource`
 *
 * 实测后果不是"报个错就算了"，而是内置插件集体注册失败：`lrclibPlugin` 的模块体
 * 里就有 `id: BUILTIN_LYRICS_PLUGIN_ID`，而此刻 `lyricsSource` 还没执行到那一行，
 * 拿到的是 `undefined` → `registerPlugin` 抛「invalid plugin id: undefined」。
 * 启动日志里只会看到一句"内置插件加载失败"，业务功能静默少一块。
 *
 * `builtins.ts` 顶部注释记着同一个坑（`auroraPlugin` vs `musicSource`），本文件
 * 是照着它那套办法处理的：**把方向反过来** —— 持有实现的模块把自己登记进来，
 * 需要它的模块读登记表，两者都不 import 对方。
 *
 * ## 为什么是同步登记、而不是 `import()`
 *
 * 调用点（`searchLyrics`）是同步组装的源列表，动态 import 会把整条聚合链变成异步
 * 才能拿到候选。而登记发生在本包被 import 的瞬间，本来就不需要 await。
 *
 * ## 没登记时返回空
 *
 * 空数组 = 「这个进程里没有已安装插件的歌词源」。桌面端渲染进程就是这种情况
 * （插件注册在主进程），那里本来也不该由本层回答 —— 聚合在主进程跑。
 */
import type { LyricsSourceConfig } from '../types'

/** 已安装插件能提供什么（由 `plugin/installed.ts` 在模块求值期登记） */
export interface InstalledLyricsProvider {
  /** 已安装插件里自带歌词源的那些（纯歌词插件） */
  sources(): LyricsSourceConfig[]
  /**
   * 某已安装插件声明的 `hosts`；**不是已安装插件时返回 `undefined`**。
   *
   * 返回 `undefined` 与返回 `[]` 必须区分：前者是"这条源不受清单规则约束"
   * （内置源、用户自填源），后者是"已安装但没声明主机"（只有 `configured-origin`
   * 形态才会出现，那时按 fail-closed 处理）。
   */
  hostsOf(pluginId: string): readonly string[] | undefined
}

let provider: InstalledLyricsProvider | null = null

/** 登记实现（幂等：重复调用只替换，保留最后一次） */
export function setInstalledLyricsProvider(next: InstalledLyricsProvider | null): void {
  provider = next
}

/** 当前登记的已安装歌词源；未登记返回空数组（不是错误，见文件头） */
export function installedLyricsSources(): LyricsSourceConfig[] {
  try {
    return provider?.sources() ?? []
  } catch {
    // 插件实现抛错不该让整条歌词聚合失败：它只是众多候选里的一档，
    // 少了它用户仍可能从内置源或其它源取到歌词
    return []
  }
}

/** 某已安装插件的 hosts（见接口注释里的三态语义） */
export function installedPluginHosts(pluginId: string): readonly string[] | undefined {
  try {
    return provider?.hostsOf(pluginId)
  } catch {
    return undefined
  }
}
