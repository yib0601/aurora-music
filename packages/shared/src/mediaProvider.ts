/**
 * 媒体库来源的能力抽象与注册表。
 *
 * 扫描管线只依赖「能递归列举音频文件」+「能按字节区间读文件」两件事，
 * 因此把这两件事抽成 MediaProvider 后，扫描逻辑（渐进式入库、元数据解析、
 * 缺失清理策略）与具体协议完全解耦：新增 SMB / SFTP / Jellyfin / Subsonic
 * 只需实现本接口并 registerMediaProvider，不必改动扫描代码。
 *
 * 关于「本地来源」为何不实现为 provider：
 * 本机目录的扫描管线是既有且经过实战打磨的（fs.watch 增量监听、GBK 标签兜底、
 * 内嵌封面按需提取、外置盘未挂载时不误删库等），这些能力都绑在 fs 上。把它硬套进
 * 这个只有两个方法的接口，要么丢掉这些行为、要么在 provider 内部再长出一套
 * 平行实现——两种结果都比保留它现有的专用管线更差。因此本机目录继续走
 * desktop/ipc/scanner.ts，本接口服务于「网络来源」这一族。
 */

import {
  walkWebdavAudio,
  openWebdavRange,
  testWebdavConnection,
  type LibrarySourceConfig,
  type RemoteEntry,
  type WalkOptions,
} from './webdav'

/** 来源可用性探测结果（设置页「测试连接」） */
export interface MediaProbeResult {
  ok: boolean
  message: string
  /** 根目录下的示例文件名 */
  sample?: string[]
}

/** 一个媒体库来源类型的能力 */
export interface MediaProvider {
  /** 与 LibrarySourceConfig.kind 对应 */
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

/** WebDAV（群晖 / 威联通 / Nextcloud / rclone serve webdav 等标准实现） */
export const webdavMediaProvider: MediaProvider = {
  kind: 'webdav',
  listAudio: (cfg, options) => walkWebdavAudio(cfg, options),
  openRange: (cfg, relPath, start, end) => openWebdavRange(cfg, relPath, start, end),
  probe: (cfg) => testWebdavConnection(cfg),
}

const MEDIA_PROVIDERS = new Map<string, MediaProvider>([
  [webdavMediaProvider.kind, webdavMediaProvider],
])

/** 按来源类型取 provider；未注册（尚未支持的协议）返回 undefined */
export function getMediaProvider(kind: string): MediaProvider | undefined {
  return MEDIA_PROVIDERS.get(kind)
}

/** 注册新的来源类型实现（扩展点：SMB / SFTP / 音乐服务器 API） */
export function registerMediaProvider(provider: MediaProvider): void {
  MEDIA_PROVIDERS.set(provider.kind, provider)
}

/** 已注册的来源类型（供设置页列出可添加的来源） */
export function registeredMediaProviderKinds(): string[] {
  return [...MEDIA_PROVIDERS.keys()]
}
