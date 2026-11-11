import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  mergeLegacyPlaylistSources,
  migrateOnlineSources,
  clearSearchCache,
  clearLxSourceCache,
  clearTrackEndpointCache,
  DEFAULT_AUDIO_FOCUS_YIELD_BEHAVIOR,
  normalizeAudioFocusYieldBehavior,
  librarySourcePluginId,
  likeActionAt,
  likeKeyOf,
} from '@aurora/shared'
import type { Track, Album, Playlist, ViewMode, LibraryTab, SortField, SortOrder, OnlineSourceConfig, DownloadQuality, LibrarySourceConfig, LyricsSourceConfig, EncryptedAudioFile } from '@/types'
import type { AudioFocusYieldBehavior, SyncedLike, SyncTrackRef } from '@aurora/shared'
import {
  DEFAULT_DOWNLOAD_QUALITY,
  DEFAULT_THEME,
  type ThemePreference,
} from '@/lib/settingOptions'
import { toSyncRefOf } from '@/lib/syncTrack'
import { audioEvents } from '@/services/audioEvents'
import { platform } from '@/services/platform'
import { configureAudioCache } from '@/services/audioCache.service'

/** 历史搜索记录最大保留条数 */
const MAX_SEARCH_HISTORY = 20

/** 最近播放记录最大保留条数（本地 + 在线统一记录在此，重启不丢） */
const MAX_RECENT_PLAYED = 100

/** 缓存容量自定义档位的合法区间（MB，十进制口径，与设置页输入框一致） */
const AUDIO_CACHE_LIMIT_MIN_MB = 64
const AUDIO_CACHE_LIMIT_MAX_MB = 102400

/** 未手填（或填了非法值）时的容量：默认按平台给，手机存储紧张，1GB 起步偏重。
 *  导出给设置页复用：提示行要展示「默认 X GB」，与真正生效的默认值必须同源 */
export function defaultAudioCacheLimitMB(): number {
  return platform.platform === 'mobile' ? 512 : 1024
}

// ─── 存储来源的持久化形态（口令不进 localStorage） ──────────────────
//
// 为什么要有这一层：`librarySources` 里曾有 `password`（webdav 明文口径）。
// zustand persist 写的是 localStorage，等于把 NAS 口令明文落在磁盘上。
// 现在口令只经主进程 `safeStorage` 加密保存（见 desktop/ipc/storageCredentials），
// 持久化只写**非敏感**字段，`password` 在写盘前就被剥掉。
//
// 为什么列白名单而不是「删掉 copy.password 就完事」：白名单能兜住「将来某个插件
// 在 settings 里塞了新的敏感键」——只有显式允许的键才会落盘。

/**
 * 单条来源的持久化投影。
 *
 * 保留 `id` / `kind` / `pluginId` / `name` / `settings` / `enabled`；
 * `kind` 作为只读兼容层一并带出（老代码与老数据仍可能在读它）。
 * **`settings` 内的 `password` 会被剥除**——它属于口令，归主进程保管。
 */
function toPersistedLibrarySource(source: LibrarySourceConfig): LibrarySourceConfig {
  const settings = source.settings ? { ...source.settings } : undefined
  if (settings) delete settings.password
  return {
    id: source.id,
    kind: source.kind,
    name: source.name,
    ...(typeof source.pluginId === 'string' ? { pluginId: source.pluginId } : {}),
    ...(settings && Object.keys(settings).length > 0 ? { settings } : {}),
    enabled: source.enabled,
  }
}

/**
 * 迁移期间暂存的口令（**只在内存**，刻意不落 localStorage）。
 *
 * 老版本把 webdav 口令明文存在 localStorage 里；迁移必须把它**摘出去**，
 * 但摘掉的同时不能凭空吞掉用户的口令（那样用户升级后必须重填，且不知道自己
 * 为什么连不上）。因此迁移时把口令搬到这里，等 store 建好后再写进主进程的
 * 加密存储。
 *
 * 三条纪律：
 * 1. 只在内存：不写 localStorage、不进日志、不进任何上报；
 * 2. **写成功才删**：`flushPendingStorageSecrets` 只在 IPC 返回成功时清条目，
 *    失败则保留（下次启动重试），避免「静默丢口令」；
 * 3. 用户重新填写口令时覆盖同名条目（同一 sourceId 只留最新一份）。
 */
const pendingStorageSecrets = new Map<string, Record<string, string>>()

/** 迁移时登记待写入的口令 */
function queuePendingStorageSecret(sourceId: string, secrets: Record<string, string>): void {
  if (!sourceId || Object.keys(secrets).length === 0) return
  pendingStorageSecrets.set(sourceId, { ...pendingStorageSecrets.get(sourceId), ...secrets })
}

/**
 * 把暂存口令写进主进程的加密存储。
 *
 * 时机：store hydrate 完成之后（persist 是异步 hydrate，早于它的调用会漏）。
 * 平台没有该能力（Web / 移动端 / 旧版 preload）时**保留 pending 不删**：
 * 这类端本来就没有主进程凭证存储，清了才是真丢。
 */
export async function flushPendingStorageSecrets(): Promise<void> {
  if (pendingStorageSecrets.size === 0) return
  if (typeof platform.saveStorageCredential !== 'function') return
  for (const [sourceId, secrets] of [...pendingStorageSecrets]) {
    try {
      const result = await platform.saveStorageCredential(sourceId, secrets)
      if (result?.ok) {
        pendingStorageSecrets.delete(sourceId)
      } else {
        // 未成功（如本机加密不可用）：保留 pending，并让 UI 显示「需重新输入」
        console.warn('[libraryStore] 存储来源口令暂存失败，保留待重试:', sourceId)
      }
    } catch (err) {
      console.warn('[libraryStore] 存储来源口令写入失败，保留待重试:', sourceId, (err as Error).message)
    }
  }
}

/**
 * 钳制用户手填的缓存容量：非有限值（NaN / Infinity，含输入框空串转出的 NaN）退回
 * 该平台默认值，区间外取最近边界，并统一向下取整为整数 MB。
 * 下界 64 MB；「不限制」不走本函数——它的值是 0，由 setAudioCacheLimitUnlimited 专用入口写入。
 */
function clampAudioCacheLimitMB(mb: number): number {
  if (!Number.isFinite(mb)) return defaultAudioCacheLimitMB()
  return Math.min(AUDIO_CACHE_LIMIT_MAX_MB, Math.max(AUDIO_CACHE_LIMIT_MIN_MB, Math.floor(mb)))
}

interface LibraryState {
  tracks: Track[]
  /**
   * 最近播放记录（本地 + 在线统一记录，最新在前）：
   * 只存歌曲元数据快照（标题/艺术家/专辑/封面等），在线曲目不在本地曲库，
   * 也记录在此，重启后不丢。落盘时剥离会过期的播放地址（同 importedTracks 约定）
   */
  recentPlayedTracks: Track[]
  albums: Album[]
  playlists: Playlist[]
  scanFolders: string[]
  viewMode: ViewMode
  /** 曲库浏览标签：全部歌曲 / 按专辑 / 按艺术家 */
  libraryTab: LibraryTab
  /** 曲库歌曲排序字段与方向 */
  sortBy: SortField
  sortOrder: SortOrder
  /**
   * 主题档位落库值。初值是 `DEFAULT_THEME`（跟随系统，见 lib/settingOptions）：
   * 默认档同时是设置页最左那一格，两处共用同一个常量
   */
  theme: ThemePreference
  currentView: 'library' | 'liked' | 'recent' | 'playlists' | 'search' | 'settings'
  searchQuery: string
  searchResults: Track[]
  /** 历史搜索记录（最新在前，最多保留 MAX_SEARCH_HISTORY 条） */
  searchHistory: string[]
  // 音源配置（应用不内置任何源，全部由用户按协议配置）
  // 音源一条可同时承载多种能力：搜索（{query}）、歌单解析（{url}）与歌词（{track}），
  // 端点地址在执行时由 sourceUrl 解析组装（服务地址由协议派生并读服务端自描述，第三方接口模板原样使用）
  onlineSources: OnlineSourceConfig[]
  /**
   * 媒体库来源（本机目录之外的持久曲库，目前支持 WebDAV 网络存储）。
   * 与 onlineSources（在线搜索歌源，地址易失、不入库）是两类东西：
   * 这里的来源会被扫描入库，曲目长期有效，播放走 aurora-remote:// 协议代理。
   */
  librarySources: LibrarySourceConfig[]
  /**
   * 独立歌词源配置（v15 恢复）。
   *
   * ## 为什么它存在
   *
   * v12 把独立歌词源删掉、并入音源，理由是「一条源同时提供这几种能力」。
   * 那个前提只对 aurora 协议成立：它的服务端自描述里带 `endpoints.lyric`。
   * 但结果是歌词这一维度被**绑死在音源**上：
   *
   * - 洛雪脚本源没有歌词能力（脚本只有 `musicUrl`），配了它就得连带失去歌词；
   * - 用户想「音源用 A、歌词用 B」时无处表达；
   * - 声明式歌词插件的 `domain: 'lyrics'` 没有用户配置可挂。
   *
   * 所以它是一个**独立维度**：为空时行为与 v12 完全一致（歌词跟着音源走 + 内置兜底），
   * 非空时排在这些之前（用户显式配置的东西优先于派生）。
   *
   * 为什么不是 `OnlineSourceConfig[]`：歌词源**不需要** id/pluginId/搜索端点，
   * 也没有歌单与取址语义。用同一个类型会让「这条配置到底该填什么」变得靠猜。
   */
  lyricsSources: LyricsSourceConfig[]

  /** 默认下载目录：null 表示每次下载都弹保存对话框询问 */
  downloadDir: string | null
  /** 默认下载音质：128 标准 / 320 高品质 / flac 无损（源不支持时按其默认地址下载） */
  downloadQuality: DownloadQuality
  /**
   * 「其他应用播放声音时」本应用怎么办：'pause' 暂停播放（默认）/ 'continue' 继续播放。
   *
   * 一个值表达完整语义（早期把它拆成「互斥开关 + 行为选择」两行，设置页读起来像同一个
   * 功能重复了一遍，且总开关关着时行为选择没有执行者）：
   *   'pause'    = 参与互斥：本应用播放时暂停其他播放器；其他应用出声时让位，安静后自动续播。
   *   'continue' = 不干预：不轮询、不暂停也不让位，两边各播各的。
   * 桌面端由主进程执行（'continue' 等价于旧的「互斥开关关闭」：停轮询）；Android 端由
   * 原生播放引擎的音频焦点回调执行（'continue' 即忽略焦点丢失）。
   * 只在本机落盘（persist 白名单显式放行，见 partialize —— 漏了会表现为
   * 「选了继续播放，重启又变回暂停」）。
   */
  audioFocusYieldBehavior: AudioFocusYieldBehavior
  /** 写该设置；主进程/原生侧的同步由 App.tsx 的订阅统一负责（本 store 不碰 IPC） */
  setAudioFocusYieldBehavior: (behavior: AudioFocusYieldBehavior) => void

  setTracks: (tracks: Track[], version?: number) => void
  setAlbums: (albums: Album[]) => void
  addTracks: (tracks: Track[]) => void
  updateTrack: (id: string, updates: Partial<Track>) => void
  /**
   * 从曲库移除单曲（只删记录与封面缓存，不删磁盘音频文件）。
   * 平台无此能力时是 no-op（能力缺失用方法不存在表达，不假装成功）。
   */
  removeTrack: (id: string) => Promise<void>
  /** 登记一条最近播放记录（本地 + 在线统一入口，最新在前，最多保留 MAX_RECENT_PLAYED 条） */
  addRecentPlayed: (track: Track, lastPlayedAt: number, playCount: number) => void
  setPlaylists: (playlists: Playlist[]) => void
  addScanFolder: (path: string) => void
  removeScanFolder: (path: string) => void
  /**
   * 扫描时发现、但解析不出音频内容的**加密文件**（QQ 音乐等平台下载落盘的密文）。
   *
   * 它们是「待处理事项」而不是曲目：内容解不开，进不了曲库也播不了，
   * 只作为 UI 的一条横幅 + 一个对话框存在。**刻意不落盘**（不在 partialize 白名单里）：
   * 每次启动的后台扫描会重新上报一遍，存下来的旧列表只会与磁盘现实脱节
   * （用户可能已经把文件删了或换了目录）。
   */
  encryptedFiles: EncryptedAudioFile[]
  /** 追加一条加密文件上报（按 path 去重；扫描会反复上报同一批文件） */
  addEncryptedFile: (file: EncryptedAudioFile) => void
  /** 处理完（已重下 / 用户放弃）后从待处理列表移除 */
  removeEncryptedFile: (path: string) => void
  /** 清空整个待处理列表（用户点「忽略」） */
  clearEncryptedFiles: () => void
  /**
   * 加密音频对话框的开关。放在 store 而不是曲库页的局部 state：
   * 扫描完成时**自动弹窗**这条链路发生在 App 层（扫描事件订阅在那里），
   * 曲库页横幅也要能打开同一个对话框，局部 state 表达不了「全局唯一一个弹窗」。
   */
  encryptedDialogOpen: boolean
  openEncryptedDialog: () => void
  closeEncryptedDialog: () => void
  /**
   * 本次会话内**已经提示过**的加密文件 path（内存态，不落盘）。
   *
   * 扫描是高频的（启动一次 + 手动重扫 + 文件变化触发的增量重扫都会重报同一批文件），
   * 没有这份记录就会变成「每次重扫都弹一次窗」，用户只能被逼着关掉提示。
   * 按 path 而不是按条数记账：用户忽略掉一批之后，新出现的那几首仍然该提示。
   */
  encryptedPromptedPaths: string[]
  /**
   * 扫描完成时调用：有**尚未提示过**的加密文件就打开对话框（每条只提示一次）。
   * 由 App 层在 `scan:complete` 之后调用——那时本轮的 `scan:encrypted` 已经全部到达。
   */
  promptEncryptedIfNew: () => void
  setViewMode: (mode: ViewMode) => void
  setLibraryTab: (tab: LibraryTab) => void
  setSortBy: (field: SortField) => void
  setSortOrder: (order: SortOrder) => void
  setTheme: (theme: ThemePreference) => void
  setCurrentView: (view: LibraryState['currentView']) => void
  setSearchQuery: (query: string) => void
  setSearchResults: (results: Track[]) => void
  // 历史搜索记录操作
  addSearchHistory: (query: string) => void
  removeSearchHistory: (query: string) => void
  clearSearchHistory: () => void
  toggleLiked: (trackId: string) => void
  toggleLike: (trackId: string) => void
  likedTracks: Set<string>
  likedTrackIds?: string[]
  /**
   * 收藏同步记录（`docs/playlist-sync.md` §5.1）：键是**跨设备歌曲身份**（`likeKeyOf`），
   * 值是「这首歌最近一次被收藏/取消的时刻 + 怎么在别的设备上找回它」。
   *
   * 为什么状态里要留这套记录：同步要裁决的从来不是「现在收藏了哪些」（那由
   * `likedTracks` 表达），而是「**谁的动作更晚**」。没有时刻就只能比集合，
   * 而集合比较必然把「本机收藏了 A、对端收藏了 B」判成冲突，只能选一边——
   * 也就是整片丢收藏（详见 `SyncedLike` 的注释）。
   *
   * 落盘（persist 白名单已放行）：不落盘则重启后所有收藏的时刻都变回「未知」，
   * 对端一个更早的取消动作就能把它们抹掉。
   */
  likeRecords: Record<string, SyncedLike>
  /**
   * 同步用：把 liked 状态**设**成指定值（幂等），且**不**产生新的收藏记录。
   *
   * 与 `toggleLiked` 分开是必须的：应用远端快照时若走 toggleLiked，每次都会以「现在」
   * 记一次动作，时间戳被本机单方面推进 → 对端下一轮又变成更新的动作 → 两端永远收敛不了。
   */
  setLiked: (trackId: string, liked: boolean) => void
  /** 同步用：整体采用合并后的收藏记录（含墓碑与时刻），由引擎在应用快照时调用 */
  applyLikeRecords: (records: Record<string, SyncedLike>) => void
  // 音源配置操作（一条音源可同时含搜索接口与歌单解析接口）
  /**
   * 歌词源的增删改（v15）。
   *
   * 与 `addOnlineSource` 是两套：歌词源不需要搜索端点、没有歌单/取址语义，
   * 合并成一个会让「这条配置该填什么」靠猜。id 由本层生成（调用方不该关心）。
   */
  addLyricsSource: (source: Omit<LyricsSourceConfig, 'id'>) => LyricsSourceConfig
  updateLyricsSource: (id: string, updates: Partial<LyricsSourceConfig>) => void
  removeLyricsSource: (id: string) => void

  addOnlineSource: (source: Omit<OnlineSourceConfig, 'id'>) => void
  updateOnlineSource: (id: string, updates: Partial<OnlineSourceConfig>) => void
  removeOnlineSource: (id: string) => void
  // 媒体库来源操作（WebDAV 网络存储等持久曲库来源）
  addLibrarySource: (source: Omit<LibrarySourceConfig, 'id'>) => string
  updateLibrarySource: (id: string, updates: Partial<LibrarySourceConfig>) => void
  removeLibrarySource: (id: string) => void
  setDownloadDir: (dir: string | null) => void
  setDownloadQuality: (quality: DownloadQuality) => void
  /**
   * 媒体缓存容量上限（MB）：音频 / 封面 / 歌词共用这一份配额并内部按比例分配。
   * 值由设置页的自定义档位写入，区间 64–102400 由 store 钳制（收口在
   * setAudioCacheLimitCustomMB；setAudioCacheLimitMB 仅保留旧调用口径）。
   * 0 = 不限制容量（不驱逐、不上限，仍照常缓存），由 setAudioCacheLimitUnlimited 写入。
   * 桌面端落盘在主进程 userData，移动端落在应用专属存储；Web 平台未实现，
   * 此值不生效（设置页按能力探测隐藏缓存分区）。
   */
  audioCacheLimitMB: number
  setAudioCacheLimitMB: (mb: number) => void
  /**
   * 缓存容量是否为「用户自定义档位」：false = 尚未手填（设置页显示「默认」，
   * 容量按平台给）；true = 用户手填过（设置页显示「自定义」，并给出恢复默认入口）。
   * 仅作标记，实际生效容量始终以 audioCacheLimitMB 为准。
   */
  audioCacheLimitCustomMB: boolean
  /** 提交用户手填的容量（MB）：同一次 set 内写标记与钳制后的值，避免中间态 */
  setAudioCacheLimitCustomMB: (mb: number) => void
  /** 清除自定义标记并回到平台默认容量 */
  resetAudioCacheLimitToDefault: () => void
  /**
   * 切到「不限制」档：容量写 0（后端据此不驱逐、照常缓存）。
   * 必须走专用入口而不是 setAudioCacheLimitCustomMB(0)——后者会被钳到 64 MB。
   */
  setAudioCacheLimitUnlimited: () => void
}

/** 递增版本号：防止 getAllTracks 的延迟响应用旧数据覆盖 scan:complete 的新数据 */
let tracksVersion = 0

/** 来源 id → 存储插件 id（收藏引用要用与歌单同步同一套坐标表达远端曲目） */
function storagePluginIdOfFrom(
  sources: readonly LibrarySourceConfig[]
): (sourceId: string) => string | undefined {
  return (sourceId) => {
    const source = sources.find((s) => s.id === sourceId)
    // 查不到来源就不冒充默认插件：那会让「另一个 webdav 库里的同名文件」被误认
    return source ? librarySourcePluginId(source) : undefined
  }
}

/**
 * 一次「收藏 / 取消收藏」→ 更新后的收藏记录表。
 *
 * 三个时刻约定（与 `@aurora/shared` 的 `likeActionAt` / `likeIsActive` 一一对应）：
 * - 收藏：`likedAt = now`，保留上一次的 `removedAt` 作为历史（它不参与裁决）；
 * - 取消：`removedAt = now`，**不动** `likedAt`（那是「这条收藏何时开始」的事实）；
 * - 同一毫秒并列时取消胜（见 `likeIsActive`）。
 *
 * 时刻取 `max(现在, 这条记录上一次动作 + 1ms)`：**用户刚做的动作必须赢过已有记录**。
 * 对端时钟偏快时，单纯用本机 `Date.now()` 可能比记录里已有的时刻还早 → 取消被判成
 * 「比那次收藏还早」→ 点了取消却仍然算收藏（下轮同步还会把它重新点亮）。
 *
 * 找不到曲目（在线曲目不在曲库里）时不写记录：没有 `Track` 就没有「怎么在别的设备
 * 上找回它」的坐标，硬造一条无引用的记录会让对端多出一首无名曲目。
 */
function recordLikeOf(
  track: Track,
  liked: boolean,
  state: Pick<LibraryState, 'librarySources' | 'likeRecords'>
): Record<string, SyncedLike> {
  const ref = toSyncRefOf(track, storagePluginIdOfFrom(state.librarySources))
  const id = likeKeyOf(ref)
  const previous = state.likeRecords[id]
  const now = Math.max(Date.now(), (previous ? likeActionAt(previous) : 0) + 1)
  const record: SyncedLike = {
    id,
    likedAt: liked ? now : (previous?.likedAt ?? now),
    ...(liked
      ? previous?.removedAt
        ? { removedAt: previous.removedAt }
        : {}
      : { removedAt: now }),
    ref,
  }
  return { ...state.likeRecords, [id]: record }
}

/**
 * 归一化持久化的收藏记录（**外部输入**：老版本、手改、迁移残留都可能）。
 *
 * 为什么必须在入口净化一次：这些记录会被并进同步快照、参与 LWW 比较，
 * 一条 `ref` 缺失/类型不对的记录会让 `canonicalLike` 在合并里抛错——表现是
 * 「同步一直失败」而不是「少一条收藏」，用户没有任何可操作信息。
 * 坏条目丢弃而不是整份放弃：少一条收藏记录不影响其它收藏继续同步。
 */
function sanitizeLikeRecords(raw: unknown): Record<string, SyncedLike> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, SyncedLike> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const candidate = value as Partial<SyncedLike>
    const ref = candidate.ref as SyncTrackRef | undefined
    if (!ref || typeof ref !== 'object') continue
    if (ref.kind !== 'local' && ref.kind !== 'storage' && ref.kind !== 'meta') continue
    const likedAt = Number(candidate.likedAt)
    if (!Number.isFinite(likedAt) || likedAt < 0) continue
    const removedAt = Number(candidate.removedAt)
    const id = typeof candidate.id === 'string' && candidate.id ? candidate.id : key
    out[id] = {
      id,
      likedAt,
      ...(Number.isFinite(removedAt) && removedAt > 0 ? { removedAt } : {}),
      ref,
    }
  }
  return out
}

export const useLibraryStore = create<LibraryState>()(
  persist(
    (set, get) => ({
      tracks: [],
      recentPlayedTracks: [],
      albums: [],
      playlists: [],
      scanFolders: [],
      encryptedFiles: [],
      encryptedDialogOpen: false,
      encryptedPromptedPaths: [],
      viewMode: 'list',
      libraryTab: 'songs',
      sortBy: 'default',
      sortOrder: 'asc',
      theme: DEFAULT_THEME,
      currentView: 'library',
      searchQuery: '',
      searchResults: [],
      searchHistory: [],
      likedTracks: new Set<string>(),
      likeRecords: {},
      onlineSources: [],
      librarySources: [],
      lyricsSources: [],
      downloadDir: null,
      downloadQuality: DEFAULT_DOWNLOAD_QUALITY,
      audioFocusYieldBehavior: DEFAULT_AUDIO_FOCUS_YIELD_BEHAVIOR,

      setTracks: (tracks, version?: number) => {
        // 版本号保护：scan:complete 事件带的版本号比 getAllTracks 的大，
        // 如果 getAllTracks 的延迟响应（version 未传或更小）在 scan:complete 之后到达，
        // 跳过此次写入，避免旧数据覆盖新数据
        if (version !== undefined && version < tracksVersion) return
        // 内容指纹比较：扫描完成事件每次 IPC 传来的都是全新对象引用，
        // 若仅浅比较引用会认为变化了，导致订阅 tracks 的组件（如歌词/详情页）无谓重渲染。
        // 基于 id + 关键字段生成指纹，内容不变则跳过 set。
        const prev = get().tracks
        if (prev === tracks) return
        const fp = (t: Track) => `${t.id}|${t.title}|${t.artist}|${t.coverPath ?? ''}|${t.liked ? 1 : 0}|${t.playCount ?? 0}|${t.lastPlayedAt ?? ''}`
        if (prev.length === tracks.length && prev.map(fp).join('\n') === tracks.map(fp).join('\n')) return
        tracksVersion = version ?? tracksVersion + 1
        set({ tracks, likedTracks: new Set(tracks.filter((t) => t.liked).map((t) => t.id)) })
      },
      setAlbums: (albums) => set({ albums }),
      addTracks: (newTracks) => {
        const existing = get().tracks
        const existingIds = new Set(existing.map((t) => t.id))
        const unique = newTracks.filter((t) => !existingIds.has(t.id))
        if (unique.length === 0) return
        set({ tracks: [...existing, ...unique] })
      },
      updateTrack: (id, updates) => {
        set({
          tracks: get().tracks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
        })
      },
      /**
       * 从曲库移除单曲：只删曲库记录与封面缓存，**磁盘上的音频文件原样保留**。
       *
       * 三条不变量（这也是它必须走平台层而不是纯本地过滤的原因）：
       * 1. 记录删除要落到持久层，否则下次启动扫描会把这首曲目原样写回来，
       *    用户看到的是「移除了又自己回来」；
       * 2. 曲库列表以平台返回的**移除后全库**为准，而不是本地 splice——
       *    远端/移动端可能有本会话尚未拉到的新记录，本地拼接会与库里不一致；
       * 3. 平台没有该能力（老 preload / 未知环境）时返回空数组，此时**不动本地列表**：
       *    本地删了而库里没删，是比「移除失败」更糟的不一致。
       *
       * 收藏集合与最近播放在这里一并收敛：like 的真相源是 tracks 表（liked 列随记录消失），
       * 最近播放是本地快照，保留着会指向一首曲库里已不存在的歌。
       */
      removeTrack: async (id) => {
        if (!get().tracks.some((t) => t.id === id)) return
        // 能力探测先于调用：不能靠「返回了空数组」判失败——移除最后一首歌时
        // 合法的结果也是空数组，两者无从区分（这正是能力缺失用「方法不存在」表达的原因）
        if (typeof platform.removeTrack !== 'function') {
          console.warn('[libraryStore] 当前平台不支持从曲库移除单曲，已忽略:', id)
          return
        }
        let remaining: Track[]
        try {
          remaining = await platform.removeTrack(id)
        } catch (err) {
          console.warn('[libraryStore] 从曲库移除单曲失败:', id, (err as Error).message)
          return
        }
        const likedTracks = new Set(get().likedTracks)
        likedTracks.delete(id)
        set({
          tracks: remaining,
          likedTracks,
          recentPlayedTracks: get().recentPlayedTracks.filter((t) => t.id !== id),
        })
      },
      addRecentPlayed: (track, lastPlayedAt, playCount) => {
        // 记录只留元数据快照：剥离会过期的在线播放地址、实际档位声明与源给的定位令牌，
        // 播放时按元信息重新搜索取址（见 playlistIO.service 的 ensurePlayableTrack）
        const {
          onlineUrl: _omitUrl,
          onlineQualityUrls: _omitQuality,
          onlineQuality: _omitTier,
          trackRef: _omitRef,
          ...meta
        } = track
        const record: Track = { ...meta, lastPlayedAt, playCount } as Track
        const rest = get().recentPlayedTracks.filter((t) => t.id !== record.id)
        set({ recentPlayedTracks: [record, ...rest].slice(0, MAX_RECENT_PLAYED) })
      },
      setPlaylists: (playlists) => set({ playlists }),
      addScanFolder: (path) => {
        if (!get().scanFolders.includes(path)) {
          set({ scanFolders: [...get().scanFolders, path] })
        }
      },
      removeScanFolder: (path) => {
        set({ scanFolders: get().scanFolders.filter((p) => p !== path) })
      },
      addEncryptedFile: (file) => {
        // 扫描会反复上报同一批文件（每次启动 + 每次手动重扫），按 path 去重；
        // 识别结果用**新上报的**覆盖旧值：文件名被改过时 title/artist 会变
        const rest = get().encryptedFiles.filter((f) => f.path !== file.path)
        set({ encryptedFiles: [...rest, file] })
      },
      removeEncryptedFile: (path) => {
        set({ encryptedFiles: get().encryptedFiles.filter((f) => f.path !== path) })
      },
      clearEncryptedFiles: () => set({ encryptedFiles: [] }),
      // 对话框开关与「已提示」记账：都不落盘（见 interface 里的说明）。
      // 忽略（清空列表）**不清** promptedPaths：用户明确表示不想处理这批文件，
      // 下次扫描重报同一批时不该再弹一次；新文件仍会照常提示
      openEncryptedDialog: () => set({ encryptedDialogOpen: true }),
      closeEncryptedDialog: () => set({ encryptedDialogOpen: false }),
      promptEncryptedIfNew: () => {
        const { encryptedFiles, encryptedPromptedPaths, encryptedDialogOpen } = get()
        if (encryptedDialogOpen) return
        const prompted = new Set(encryptedPromptedPaths)
        const fresh = encryptedFiles.filter((f) => !prompted.has(f.path))
        if (fresh.length === 0) return
        set({
          encryptedDialogOpen: true,
          encryptedPromptedPaths: [...encryptedPromptedPaths, ...fresh.map((f) => f.path)],
        })
      },
      setViewMode: (mode) => set({ viewMode: mode }),
      setLibraryTab: (tab) => set({ libraryTab: tab }),
      setSortBy: (field) => set({ sortBy: field }),
      setSortOrder: (order) => set({ sortOrder: order }),
      setTheme: (theme) => set({ theme }),
      setCurrentView: (view) => set({ currentView: view }),
      setSearchQuery: (query) => set({ searchQuery: query }),
      setSearchResults: (results) => set({ searchResults: results }),
      addSearchHistory: (query) => {
        const q = query.trim()
        if (!q) return
        // 去重并置顶：重复关键词移到最前（最近使用优先）
        const rest = get().searchHistory.filter((item) => item !== q)
        set({ searchHistory: [q, ...rest].slice(0, MAX_SEARCH_HISTORY) })
      },
      removeSearchHistory: (query) => {
        set({ searchHistory: get().searchHistory.filter((item) => item !== query) })
      },
      clearSearchHistory: () => set({ searchHistory: [] }),
      toggleLiked: (trackId) => {
        const tracks = get().tracks.map((t) =>
          t.id === trackId ? { ...t, liked: !t.liked } : t
        )
        const track = tracks.find((t) => t.id === trackId)
        const likedTracks = new Set(get().likedTracks)
        if (track?.liked) {
          likedTracks.add(trackId)
        } else {
          likedTracks.delete(trackId)
        }
        set({
          tracks,
          likedTracks,
          // 只有找得到这条曲目才有「跨设备坐标」可写。在线曲目不在 `tracks` 里 →
          // 整个 toggle 在值层面空转（爱心不点亮、`likedTracks` 不变、也不写 `likeRecords`；
          // 仍会 set 一次，引用变、值不变），与「收藏页只列曲库里的歌」一致；
          // 入口开放但不生效是现状，不是已支持。
          ...(track ? { likeRecords: recordLikeOf(track, !!track.liked, get()) } : {}),
        })
      },
      toggleLike: (trackId) => {
        get().toggleLiked(trackId)
      },
      /**
       * 幂等设置 liked 状态（同步应用专用）。
       *
       * 找不到这条曲目就什么都不做：远端收藏的引用可能指向本机没有的歌（那些记录照样
       * 留在 `likeRecords` 里等它出现），不能在曲库里凭空造一条记录。
       */
      setLiked: (trackId, liked) => {
        if (!get().tracks.some((t) => t.id === trackId && t.liked !== liked)) return
        const tracks = get().tracks.map((t) => (t.id === trackId ? { ...t, liked } : t))
        const likedTracks = new Set(get().likedTracks)
        if (liked) likedTracks.add(trackId)
        else likedTracks.delete(trackId)
        set({ tracks, likedTracks })
      },
      applyLikeRecords: (records) => set({ likeRecords: records }),

      addLyricsSource: (source) => {
        // id 生成与在线源同口径：时间戳 + 随机后缀，不引 uuid 依赖
        const id = `lyrics-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
        const next: LyricsSourceConfig = { ...source, id }
        set({ lyricsSources: [...get().lyricsSources, next] })
        return next
      },
      updateLyricsSource: (id, updates) => {
        set({
          lyricsSources: get().lyricsSources.map((s) => (s.id === id ? { ...s, ...updates } : s)),
        })
      },
      removeLyricsSource: (id) => {
        set({ lyricsSources: get().lyricsSources.filter((s) => s.id !== id) })
      },

      addOnlineSource: (source) => {
        const id = `src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        set({ onlineSources: [...get().onlineSources, { ...source, id }] })
        // 音源集合变了，共享层的搜索缓存（30s TTL）、洛雪脚本宿主缓存与
        // 「该源没有单曲取址端点」的记忆必须立即失效，否则刚加/刚改的源在半分钟内
        // 搜不出东西（或刚升级的服务端仍被当成老服务端），看起来像「源没生效」
        clearSearchCache()
        clearLxSourceCache()
        clearTrackEndpointCache()
      },
      updateOnlineSource: (id, updates) => {
        set({
          onlineSources: get().onlineSources.map((s) =>
            s.id === id ? { ...s, ...updates } : s
          ),
        })
        clearSearchCache()
        clearLxSourceCache()
        clearTrackEndpointCache()
      },
      removeOnlineSource: (id) => {
        set({ onlineSources: get().onlineSources.filter((s) => s.id !== id) })
        clearSearchCache()
        clearLxSourceCache()
        clearTrackEndpointCache()
      },

      addLibrarySource: (source) => {
        // id 用作 aurora-remote:// 的 host，必须是小写字母/数字/连字符
        const id = `lib-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        set({ librarySources: [...get().librarySources, { ...source, id }] })
        return id
      },
      updateLibrarySource: (id, updates) => {
        set({
          librarySources: get().librarySources.map((s) => (s.id === id ? { ...s, ...updates } : s)),
        })
      },
      removeLibrarySource: (id) => {
        set({ librarySources: get().librarySources.filter((s) => s.id !== id) })
      },
      setDownloadDir: (dir) => set({ downloadDir: dir || null }),
      setDownloadQuality: (quality) => set({ downloadQuality: quality }),
      // 归一化兜底：调用方（设置页/迁移）传坏值时回落到默认，不让状态里出现第三种取值
      setAudioFocusYieldBehavior: (behavior) =>
        set({ audioFocusYieldBehavior: normalizeAudioFocusYieldBehavior(behavior) }),
      audioCacheLimitMB: defaultAudioCacheLimitMB(),
      setAudioCacheLimitMB: (mb) => set({ audioCacheLimitMB: Math.max(0, Math.floor(mb)) }),
      // 默认视为「未自定义」：容量按平台给，设置页显示「默认」
      audioCacheLimitCustomMB: false,
      setAudioCacheLimitCustomMB: (mb) =>
        set({ audioCacheLimitCustomMB: true, audioCacheLimitMB: clampAudioCacheLimitMB(mb) }),
      resetAudioCacheLimitToDefault: () =>
        set({ audioCacheLimitCustomMB: false, audioCacheLimitMB: defaultAudioCacheLimitMB() }),
      // 「不限制」也算一档自定义：置标记为 true，设置页据此给出「恢复默认」入口
      setAudioCacheLimitUnlimited: () => set({ audioCacheLimitCustomMB: true, audioCacheLimitMB: 0 }),
    }),
    {
      name: 'aurora-library-state',
      // 在线源按**白名单**落盘：配置字段之外的一切（将来的运行期数据、洛雪脚本源码——
      // 可达数百 KB，写进 localStorage 会撑爆配额）都不写库。洛雪脚本按链接拉取并缓存，
      // 本就不该进配置，这里兜住任何意外塞进来的运行期字段。
      partialize: (state) => ({
        recentPlayedTracks: state.recentPlayedTracks,
        scanFolders: state.scanFolders,
        viewMode: state.viewMode,
        libraryTab: state.libraryTab,
        sortBy: state.sortBy,
        sortOrder: state.sortOrder,
        theme: state.theme,
        likedTrackIds: Array.from(state.likedTracks),
        // 收藏的同步记录（时刻 + 跨设备引用）：丢了它 = 重启后所有收藏都变成「时刻未知」，
        // 对端一个更早的取消动作就能把它们抹掉（见 LibraryState.likeRecords）
        likeRecords: state.likeRecords,
        searchHistory: state.searchHistory,
        // 歌词源全部字段都是配置数据、没有运行期字段，直接落盘即可（不做白名单裁剪）
        lyricsSources: state.lyricsSources,
        onlineSources: state.onlineSources.map((s) => ({
          id: s.id,
          name: s.name,
          sourceUrl: s.sourceUrl,
          enabled: s.enabled,
          // 插件 id 是「这条源由谁执行」的唯一标识（v13 起写入）。
          // 白名单必须放行它，否则插件配置写进 store 就等于丢：
          // 表现为「设置页加了源，重启后消失」或「源回落到默认插件执行」。
          ...(s.pluginId ? { pluginId: s.pluginId } : {}),
          // kind 是只读兼容层：老数据仍有该字段，原样带出以免降级
          ...(s.kind ? { kind: s.kind } : {}),
          ...(s.headers ? { headers: s.headers } : {}),
          // 「认领平台」必须显式放行：漏在白名单外不会报错，只会表现为
          // 「设置页选了平台，重启后又变回只参与搜索」，认领关系静默失效
          ...(s.platform ? { platform: s.platform } : {}),
          ...(s.playlistUrl ? { playlistUrl: s.playlistUrl } : {}),
          ...(s.endpoints ? { endpoints: s.endpoints } : {}),
        })),
        librarySources: state.librarySources.map(toPersistedLibrarySource),
        downloadDir: state.downloadDir,
        downloadQuality: state.downloadQuality,
        audioCacheLimitMB: state.audioCacheLimitMB,
        audioCacheLimitCustomMB: state.audioCacheLimitCustomMB,
        // 音频焦点设置：必须显式放行。漏在白名单外不会报错，只会表现为
        // 「选了继续播放，重启又变回暂停」，用户会以为是功能没生效
        audioFocusYieldBehavior: state.audioFocusYieldBehavior,
      }),
      /**
       * 水合时的归一化：持久化数据是**外部输入**（老版本、手改、迁移残留）。
       * 坏值若原样进来，设置页会出现「两格都不亮」的第三态，而主进程/原生仍按默认执行。
       * 与 setter 走同一个归一化函数，保证「写进去合法 ⇒ 读出来也合法」。
       *
       * 只在「存储里确实有数据」时被调用（缺字段的老数据也会走到这里，回落成默认档）。
       */
      merge: (persisted, current) => {
        const incoming = (persisted ?? {}) as Partial<typeof current> & {
          audioFocusYieldBehavior?: unknown
          /** v15 前的旧字段：互斥开关（true=让位 / false=完全关闭），只用于迁移 */
          audioFocusEnabled?: unknown
        }
        // 旧数据只有开关：开着的用户语义就是「让位」，关着的用户语义就是「不干预」，
        // 正好一一映射到新取值；没有旧数据（全新安装）走 shared 的默认值。
        // 用 merge 而不是 bump persist 版本，是为了不跟并行进行中的其它迁移抢版本号。
        const legacyEnabled = incoming.audioFocusEnabled
        const migrated =
          incoming.audioFocusYieldBehavior === undefined
            ? legacyEnabled === true
              ? 'pause'
              : legacyEnabled === false
                ? 'continue'
                : DEFAULT_AUDIO_FOCUS_YIELD_BEHAVIOR
            : normalizeAudioFocusYieldBehavior(incoming.audioFocusYieldBehavior)
        // 旧字段不再进入状态（类型里已删除），避免水合后残留一个无人读取的键
        const { audioFocusEnabled: _legacyEnabled, ...rest } = incoming
        return {
          ...current,
          ...rest,
          audioFocusYieldBehavior: migrated,
        }
      },
      // v1 用合并的 useBuiltinSources 字段；v2 拆为两个独立开关；
      // v3 移除内置源概念（网易云/QQ 开关删除，歌源全部由用户按协议配置）
      // v4 默认下载音质改为无损 FLAC：清除旧持久值，让新默认值生效
      // v5 新增歌单解析源配置（歌单导入功能）
      // v6 新增媒体库来源配置（WebDAV 网络存储）
      // v7 移除扁平玻璃开关（glassMode 与 .glass-flat 规则已删除，代码里从无入口）
      // v8 新增媒体缓存容量配置（audioCacheLimitMB；默认按平台：桌面 1024MB / 移动 512MB）
      // v9 音源合并：独立的「歌单解析源」并入音源（OnlineSourceConfig.playlistUrl），
      //    同一服务的搜索与歌单解析落回同一条配置，删除 playlistResolverSources
      // v10 音源地址归一：端点不再在保存时拼好，配置只留一条 sourceUrl（+ 可选歌单地址与
      //     服务端端点缓存），端点改由执行时解析（auroraPreset 的 searchEndpointOf /
      //     playlistEndpointOf）；preset / baseUrl / apiKey 三个回显字段随之消失
      // v11 缓存容量改版：新增自定义标记（audioCacheLimitCustomMB，旧数据置 false →
      //     设置页显示「默认」）；原「关闭」档（0）随档位改版移除，迁移时归到平台默认容量
      //     v11 之后 0 不再被迁移改写，作为「不限制」档使用（只影响 version < 11 的历史数据）
      // v12 歌词并入音源：删除独立「歌词源」配置（lyricsSources），
      //     歌词能力改由音源服务的端点自描述提供（endpoints.lyric）
      // v13 插件化（同一个版本号下两条迁移，都是「插件化」这一批改造）：
      //   a) 音源：`pluginId` 成为唯一标识，老配置按 kind 补写等价的 pluginId
      //      （lx → lx，其余 → aurora）；kind 保留为只读兼容层
      //   b) 存储来源：`pluginId` 取代 kind、顶层扁平字段搬进 `settings`，
      //      **口令从持久化摘出**转主进程 safeStorage 加密保存
      migrate: (persisted: any, version: number) => {
        if (persisted) {
          if (version < 9) {
            // 独立的「歌单解析源」并入音源（同主机合并成一条，其余转为只做歌单解析的条目）
            persisted.onlineSources = mergeLegacyPlaylistSources(
              persisted.onlineSources,
              persisted.playlistResolverSources
            )
            delete persisted.playlistResolverSources
          }
          if (version < 10) {
            persisted.onlineSources = migrateOnlineSources(persisted.onlineSources)
          }
          if (version < 13) {
            // 存储插件化：曲库来源由「存储插件」实现（见 shared/plugin/storage）。
            // 两件事同时完成——
            // 1. 形状归一：老配置只有 `kind: 'webdav'` + 顶层扁平字段，
            //    补写等价的 `pluginId`，并把字段搬进 `settings`（键同名，零转换）。
            // 2. **把口令摘出持久化**：明文 password 不能继续留在 localStorage。
            //    摘出去的同时不能凭空吞掉（用户会不知道为什么连不上），
            //    所以搬进内存的 pendingStorageSecrets，等 store 建好后写进主进程
            //    的 safeStorage 加密存储（见 flushPendingStorageSecrets）。
            //
            // 顶层旧字段（baseUrl / rootPath / username）**保留不删**：
            // shared 的 storageFieldValue() 以「settings 优先、顶层同名兜底」取值，
            // 删了兜底就失效，老配置反而读不出来。
            if (Array.isArray(persisted.librarySources)) {
              persisted.librarySources = persisted.librarySources.map((s: any) => {
                if (!s || typeof s !== 'object') return s
                const next: any = { ...s }
                // 老配置只有 kind；新版以 pluginId 为准（kind 保留为只读兼容层）
                if (typeof next.pluginId !== 'string' || !next.pluginId) {
                  if (typeof next.kind === 'string' && next.kind) next.pluginId = next.kind
                }
                // 顶层扁平字段搬进 settings（与插件 fields 的 key 同名）
                const settings: Record<string, unknown> = { ...(next.settings || {}) }
                for (const key of ['baseUrl', 'rootPath', 'username'] as const) {
                  if (typeof next[key] === 'string' && next[key] && settings[key] === undefined) {
                    settings[key] = next[key]
                  }
                }
                // 口令：从 settings 与顶层两处摘出，转存内存
                const secret =
                  (typeof settings.password === 'string' && settings.password) ||
                  (typeof next.password === 'string' && next.password) ||
                  ''
                delete settings.password
                delete next.password
                if (secret && typeof next.id === 'string' && next.id) {
                  queuePendingStorageSecret(next.id, { password: secret })
                }
                if (Object.keys(settings).length > 0) next.settings = settings
                else delete next.settings
                return next
              })
            }
          }
          if (version < 12) {
            // 歌词并入音源：独立「歌词源」配置退场，歌词能力改为读音源服务的端点自描述
            // （见 shared/src/auroraPreset.ts 的 lyricEndpointOf）。歌词是「用完即弃」的
            // 在线查询，没有需要保留的用户数据，老字段直接丢弃即可。
            //
            // ⚠️ v15 起这条**只对 version < 12 的历史数据**生效：v12 之后歌词源配置
            // 重新成为一等公民（见 `lyricsSources` 字段注释）。不能再无条件删 ——
            // 否则每次升级都会把用户在 v15 里配的歌词源清空。
            delete persisted.lyricsSources
          }
          if (version < 13) {
            // 插件化：音源由「插件」执行，`pluginId` 取代 `kind` 成为唯一标识。
            // 老配置只有 kind，这里**补写等价的 pluginId**，避免老数据依赖运行期回落：
            // 补写后 store 里的源与新建的源形状一致，减少一处「有时有、有时没有」的分叉。
            // kind 保留不动（只读兼容层），等确认无老配置后再单独清理。
            if (Array.isArray(persisted.onlineSources)) {
              persisted.onlineSources = persisted.onlineSources.map((s: any) => {
                if (!s || typeof s !== 'object') return s
                if (typeof s.pluginId === 'string' && s.pluginId) return s
                return { ...s, pluginId: s.kind === 'lx' ? 'lx' : 'aurora' }
              })
            }
          }
          if (version < 11) {
            persisted.audioCacheLimitCustomMB = false
            // 「关闭」档（0）已随档位改版移除：0 或非数字的旧值归到平台默认容量，
            // 避免设置页显示「默认 0 MB」且上限恒为 0；非 0 旧值原样保留
            if (typeof persisted.audioCacheLimitMB !== 'number' || persisted.audioCacheLimitMB <= 0) {
              persisted.audioCacheLimitMB = defaultAudioCacheLimitMB()
            }
          }
          if (version < 8) {
            if (typeof persisted.audioCacheLimitMB !== 'number') persisted.audioCacheLimitMB = 1024
          }
          if (version < 6) {
            if (!Array.isArray(persisted.librarySources)) persisted.librarySources = []
          }
          if (version < 5) {
            if (!Array.isArray(persisted.playlistResolverSources)) persisted.playlistResolverSources = []
          }
          if (version < 4) {
            delete persisted.downloadQuality
          }
          if (version < 3) {
            delete persisted.useNeteaseSources
            delete persisted.useQQSources
          }
          if (version < 2 && persisted.useBuiltinSources !== undefined) {
            delete persisted.useBuiltinSources
          }
          if (version < 7) {
            delete persisted.glassMode
          }
        }
        return persisted
      },
      // v13 存储插件化：曲库来源由存储插件执行，`pluginId` 取代 `kind` 成为标识；
      //     老配置的顶层扁平字段搬进 `settings`，**口令从持久化里摘出**改由主进程
      //     safeStorage 加密保存（见上方 toPersistedLibrarySource / pendingStorageSecrets）
      // 收藏参与同步新增了 `likeRecords`（收藏/取消的时刻 + 跨设备引用），
      // **版本号仍是 14、刻意不升**：它是纯增量字段，老数据没有它 → 走初始值 {}，
      // 没有任何历史字段需要改写。而 zustand 只在「版本号变了」时才在合并后立即写回一次
      // 持久层，且那次写回发生在 `onRehydrateStorage` 之前——升版本会用一个
      // 「likedTracks 尚未复活」的空数组覆盖掉磁盘上的 `likedTrackIds`。
      // 历史上 `likedTrackIds` 仍原样保留（它表达「现在收藏了哪些」，两套各管一段）。
      version: 14,
      onRehydrateStorage: () => (state) => {
        if (!state) return
        // 只在「持久层确实留下了收藏」或「内存里本来就没有」时采用持久值：
        // 同一次会话里再水合时（`persist.rehydrate()`），磁盘上那份可能是迁移写回的旧快照，
        // 此时内存里的 likedTracks 才是更新的——无条件采用会把这次会话里刚点的收藏清空。
        const persistedLikes = Array.isArray(state.likedTrackIds) ? state.likedTrackIds : null
        if (persistedLikes && (persistedLikes.length > 0 || (state.likedTracks?.size ?? 0) === 0)) {
          state.likedTracks = new Set(persistedLikes)
        }
        // 收藏记录来自 localStorage，是外部输入：合并会直接读它，坏结构必须在入口挡掉
        state.likeRecords = sanitizeLikeRecords(state.likeRecords)
      },
    }
  )
)

// 订阅播放统计事件，独立更新曲库数据（解耦 playerStore 的跨Store副作用）
audioEvents.on('playStatsUpdate', ({ trackId, lastPlayedAt, playCount, track }) => {
  const library = useLibraryStore.getState()
  // 本地曲目同步曲库字段；在线曲目不在曲库，此调用空转
  library.updateTrack(trackId, {
    lastPlayedAt,
    playCount,
  })
  // 统一登记最近播放记录（本地 + 在线），最近播放页从这里取数
  library.addRecentPlayed(track, lastPlayedAt, playCount)
})

// ─── 媒体库来源配置 → 主进程 ──────────────────────────────────
// 远端的扫描与播放都在主进程执行（口令经 safeStorage 单独保存，**不在这些配置里**），
// 因此配置变更后必须同步过去，否则 aurora-remote:// 找不到 sourceId 会直接 404。
// 注意 persist 是异步 hydrate 的：这里先推一次当前快照，再靠订阅捕获
// hydrate 完成后的那次 set，两种情况都能覆盖。
function pushLibrarySources(sources: LibrarySourceConfig[]): void {
  // Web / 移动端未实现该能力，静默跳过（可选方法直接短路）
  void platform.syncLibrarySources?.(sources)
}

pushLibrarySources(useLibraryStore.getState().librarySources)
useLibraryStore.subscribe((state, prev) => {
  if (state.librarySources !== prev.librarySources) pushLibrarySources(state.librarySources)
})

// ─── 迁移期暂存口令 → 主进程加密存储 ──────────────────────────
// 与上面同一套时序：persist 异步 hydrate 完成时，migrate 里登记到
// pendingStorageSecrets 的旧明文口令才有归属，必须在这之后 flush。
// 先尝试一次（覆盖「hydrate 比本模块求值更快」的情况），再靠订阅兜住后半程。
void flushPendingStorageSecrets()
useLibraryStore.subscribe(() => {
  // 任何一次 set 之后都试一次；函数内部在 pending 为空时立即返回，代价可忽略。
  // 不清空 pending 就不重复写盘——只有 IPC 明确成功才删除条目。
  void flushPendingStorageSecrets()
})

// ─── 在线播放缓存容量 → 主进程 ──────────────────────────────────
// 缓存实体在主进程磁盘，容量变更后必须下发，否则驱逐仍按旧限额执行。
// 与媒体库来源同步同理：persist 异步 hydrate，先推一次快照再订阅变更。
// 值 0 会原样下发：主进程按「不限制」处理（不驱逐、照常拉新），这里不做任何替换。
configureAudioCache(useLibraryStore.getState().audioCacheLimitMB)
useLibraryStore.subscribe((state, prev) => {
  if (state.audioCacheLimitMB !== prev.audioCacheLimitMB) {
    configureAudioCache(state.audioCacheLimitMB)
  }
})
