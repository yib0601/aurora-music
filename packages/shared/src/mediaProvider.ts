/**
 * 媒体库来源的能力抽象与注册表（**兼容垫片，已委托给存储插件注册表**）。
 *
 * ## 这个文件现在是什么
 *
 * 改造前它自己维护 `MEDIA_PROVIDERS` 这个 Map，并把 webdav 实现注册进去——那是
 * 一套与「存储插件」并行的第二份真源。现在唯一的真源是
 * `plugin/storage/registry.ts`：本文件的所有函数都只是**转发**，
 * 不再持有一份自己的表（持有两份必然分叉：注册到一边的协议另一边查不到）。
 *
 * ## 为什么还要留着它
 *
 * `getMediaProvider` / `registerMediaProvider` / `registeredMediaProviderKinds` /
 * `MediaProvider` 已经出现在平台层（`desktop/src/ipc/librarySource.ts`）与公开导出里。
 * 一次性删掉会打断 desktop 侧编译，所以保留为 `@deprecated` 的兼容垫片；
 * 新代码请直接用 `getStoragePlugin` / `storagePluginOf` / `listStoragePlugins`。
 *
 * 关于「本地来源」为何不实现为插件：
 * 本机目录的扫描管线是既有且经过实战打磨的（fs.watch 增量监听、GBK 标签兜底、
 * 内嵌封面按需提取、外置盘未挂载时不误删库等），这些能力都绑在 fs 上。把它硬套进
 * 这个只有三四个方法的接口，要么丢掉这些行为、要么在插件内部再长出一套平行实现——
 * 两种结果都比保留它现有的专用管线更差。因此本机目录继续走
 * desktop/ipc/scanner.ts，本接口服务于「网络来源」这一族。
 */

import type { LibrarySourceConfig, RemoteEntry, WalkOptions } from './webdav'
import {
  DEFAULT_STORAGE_PLUGIN_ID,
  getStoragePlugin,
  listStoragePlugins,
  registerStoragePlugin,
  storagePluginOf,
  webdavStoragePlugin,
  type StoragePlugin,
  type StorageProbeResult,
} from './plugin/storage'

/**
 * 来源可用性探测结果（设置页「测试连接」）。
 * @deprecated 用 `StorageProbeResult`（同一形状，改名为与新契约一致）
 */
export type MediaProbeResult = StorageProbeResult

/**
 * 一个媒体库来源类型的能力。
 * @deprecated 用 `StoragePlugin`（能力方法同名，另加 `openStream` 与声明式 `fields`）
 */
export interface MediaProvider {
  /** 与 LibrarySourceConfig 的插件 id 对应 */
  readonly kind: string
  /** 递归列举来源中的全部音频文件（路径相对来源根目录） */
  listAudio(cfg: LibrarySourceConfig, options?: WalkOptions): Promise<RemoteEntry[]>
  /**
   * 读取某个文件的一段字节。
   * 服务器不支持 Range 时可能返回整文件（status 200），调用方需按 status 判断。
   */
  openRange(cfg: LibrarySourceConfig, relPath: string, start: number, end: number): Promise<Response>
  /** 探测可用性：只列举根目录，不递归、不入库 */
  probe(cfg: LibrarySourceConfig): Promise<MediaProbeResult>
}

/**
 * 把一个存储插件投影成旧的 `MediaProvider` 形状（只保留旧接口定义了的三件套）。
 *
 * 为什么需要投影而不是直接返回插件：`MediaProvider` 的三个方法都是**必选**的，
 * 而 `StoragePlugin` 的能力全是可选的。若某个插件只实现了 `openStream`，
 * 直接 `as` 会骗过类型系统、调用时炸在运行时。这里把缺失的能力补成「明确不可用」
 * 的拒绝，旧调用方拿到的是可判定的错误而不是 undefined is not a function。
 */
function asMediaProvider(plugin: StoragePlugin): MediaProvider {
  return {
    kind: plugin.id,
    listAudio: (cfg, options) => {
      if (typeof plugin.listAudio !== 'function') {
        throw new Error(`[mediaProvider] storage plugin "${plugin.id}" does not implement listAudio`)
      }
      return plugin.listAudio(cfg, options)
    },
    openRange: (cfg, relPath, start, end) => {
      if (typeof plugin.openRange !== 'function') {
        throw new Error(`[mediaProvider] storage plugin "${plugin.id}" does not implement openRange`)
      }
      return plugin.openRange(cfg, relPath, start, end)
    },
    probe: (cfg) => {
      if (typeof plugin.probe !== 'function') {
        throw new Error(`[mediaProvider] storage plugin "${plugin.id}" does not implement probe`)
      }
      return plugin.probe(cfg)
    },
  }
}

/**
 * WebDAV（群晖 / 威联通 / Nextcloud / rclone serve webdav 等标准实现）
 * @deprecated 用 `webdavStoragePlugin`（从 `@aurora/shared` 或 `plugin/storage` 取）
 */
export const webdavMediaProvider: MediaProvider = asMediaProvider(webdavStoragePlugin)

/**
 * 按来源类型取 provider；未注册（尚未支持的协议）返回 undefined。
 * @deprecated 用 `getStoragePlugin(id)` 或 `storagePluginOf(cfg)`（后者直接吃配置）
 */
export function getMediaProvider(kind: string): MediaProvider | undefined {
  const id = typeof kind === 'string' && kind ? kind : DEFAULT_STORAGE_PLUGIN_ID
  const plugin = getStoragePlugin(id)
  return plugin ? asMediaProvider(plugin) : undefined
}

/**
 * 注册新的来源类型实现（扩展点）。
 * @deprecated 用 `registerStoragePlugin(plugin)` —— 要注意本函数会**丢弃**
 * 声明式 `fields` 与 `openStream` 能力（旧形状装不下），新协议请直接写存储插件。
 */
export function registerMediaProvider(provider: MediaProvider): void {
  if (!provider || typeof provider !== 'object') {
    throw new Error('[mediaProvider] invalid provider')
  }
  const id = typeof provider.kind === 'string' ? provider.kind : ''
  const existing = getStoragePlugin(id)
  registerStoragePlugin({
    // 保留既有插件的展示信息与字段（若它本来就是个存储插件，这里只是补方法）
    displayNameKey: existing?.displayNameKey ?? 'sources.webdav.title',
    descriptionKey: existing?.descriptionKey,
    version: existing?.version ?? '1.0.0',
    fields: existing?.fields ?? [],
    ...(provider.listAudio ? { listAudio: provider.listAudio } : {}),
    ...(provider.openRange ? { openRange: provider.openRange } : {}),
    ...(provider.probe ? { probe: provider.probe } : {}),
    openStream: existing?.openStream,
    id,
  })
}

/**
 * 已注册的来源类型（供设置页列出可添加的来源）。
 * @deprecated 用 `registeredStoragePluginIds()`（顺序语义相同）
 */
export function registeredMediaProviderKinds(): string[] {
  return listStoragePlugins().map((p) => p.id)
}

/**
 * 取某条来源配置对应的 provider（**旧调用方的单一入口**）。
 *
 * 保留它是为了让平台层不必再写 `getMediaProvider(cfg.kind)` ——那个写法就是把
 * 「配置 → 插件」的判定抄了第二遍。新代码请用 `storagePluginOf(cfg)`。
 * @deprecated 用 `storagePluginOf(cfg)`
 */
export function mediaProviderOf(cfg: LibrarySourceConfig | null | undefined): MediaProvider | undefined {
  const plugin = storagePluginOf(cfg)
  return plugin ? asMediaProvider(plugin) : undefined
}
