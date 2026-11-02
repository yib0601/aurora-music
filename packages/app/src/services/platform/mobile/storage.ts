/**
 * 网络存储来源（移动端实现）。
 *
 * ## 为什么移动端现在能配了
 *
 * 改造前移动端**故意**不给存储插件的齿轮：《pluginConfig》的能力探测只看
 * `platform.scanLibrarySource` 是否存在，而移动端没有主进程侧的那套代理与扫描。
 * 现在补齐了这条链路，但形态与桌面端**恰好相反**：
 *
 * | 环节 | 桌面端 | 移动端（本文件） |
 * |---|---|---|
 * | 插件执行 | 主进程（`ipc/librarySource.ts`） | **渲染进程内**（注册表本来就在同一进程） |
 * | 口令 | `safeStorage` 加密，渲染层永不回读 | Android Keystore 加密后落盘，渲染层不回读 |
 * | 播放 | `aurora-remote://` 自定义协议代理 | 带鉴权头**下载到媒体缓存**后播本地文件 |
 * | 封面 | 主进程 `ensureRemoteCover` 按需 Range 提取 | 渲染层 `ensureStorageCover`，同一策略 |
 * | 元数据解析 | node 版 `music-metadata` 的 `parseBuffer` | `music-metadata-browser` 的 `parseBlob` |
 *
 * 能这样做的前提是移动端已经有原生 HTTP（`setCustomFetch(createNativeFetch())`），
 * 于是 `@aurora/shared` 的 `walkWebdavAudio` / `openWebdavRange` 在这里原样可用 ——
 * 本文件只负责"配置、口令、入库、取地址"四件事，不重写协议实现。
 *
 * ## 口令：Android Keystore 加密后落盘
 *
 * 手机上没有 `safeStorage` 那样的 keyring，但 Android 有 Keystore（密钥在 TEE 里、
 * 不可导出）。本轮补上了最小原生桥 `SecureStoragePlugin`（AES-256-GCM），
 * 口令文件因此变成**密文容器**（`{format:'keystore-v1', data:'<base64(iv||ct)>'}`），
 * 落在 `Directory.Data`（Android 为 `/data/data/<pkg>/files/`）。
 *
 * 三层如实标注，不冒充、也不自贬：
 * - 有 Keystore 且已加密 → `protection: 'keystore'`（UI：「口令已安全保存」）；
 * - 插件缺失（老包 / iOS）→ 退回明文写入，`protection: 'app-private'`
 *   （UI：「口令保存在应用私有目录（未加密）」）；
 * - 用户恢复备份 / 换机重装导致密钥失效 → 密文解不开，按"未保存口令"处理，
 *   提示用户重填（这正是唯一可行的补救动作）。
 *
 * 历史明文文件会被**原地迁移**成密文：触发点是「保存」与「查询状态」（用户打开来源卡片时），
 * 都在串行写队列里重读一次再写，绝不拿旧快照覆盖刚存进去的口令。
 *
 * 与桌面端同一份纪律：口令**不进 localStorage**（`libraryStore` 的持久化投影会剥掉
 * `settings.password`），只在调用插件前的一瞬间并进配置副本。
 *
 * ## 封面为什么按需提取
 *
 * 远端曲目的内嵌封面在**扫描阶段不碰**（与桌面端 `ensureRemoteCover` 同一策略）：
 * 扫描已经为元数据读过一次文件头，但把图片解出来再落盘会让一次扫描平白多出
 * 几百次写盘；而封面只在对用户可见时才需要。于是提交流程里的 `coverPath` 留空，
 * 由渲染层在 `<CoverImage>` 挂载时调 `ensureCover`（本文件的 `ensureStorageCover`）
 * 现读一段头字节、解出图片、落盘并回写数据库。
 */

import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import * as mm from 'music-metadata-browser'
import {
  METADATA_HEAD_BYTES,
  auroraError,
  guessAudioMime,
  isStorageTransportError,
  listStoragePluginMeta,
  markTransportError,
  normalizeHeadParsedDuration,
  storagePathFor,
  storagePathPrefix,
  storagePluginOf,
  type LibrarySourceConfig,
  type RemoteEntry,
  type StoragePlugin,
  type StoragePluginMeta,
} from '@aurora/shared'
import type { StorageCredentialState, Track } from '@/types'
import { saveCoverImage } from './coverFile'
import type { MobileDatabase } from './database'
import { awaitCachedAudio } from './mediaCache'
import { keystoreAvailable, keystoreDecrypt, keystoreEncrypt } from './secureStorage'

/** 口令文件（相对 `Directory.Data`，应用私有目录） */
const CREDENTIALS_FILE = 'aurora-music/storage-credentials.json'

/** 口令文件的加密容器标记：出现它即表示 `data` 是 Keystore 密文 */
const ENCRYPTED_FORMAT = 'keystore-v1'

/** 远端元数据的并发解析上限：与桌面端同一数值（NAS 会话数与网络往返的折中） */
const REMOTE_CONCURRENCY = 4

/** 口令文件形状：sourceId → { 字段键: 值 } */
type CredentialFile = Record<string, Record<string, string>>

/** 读出的口令文件状态：本体 + 这份文件当前是不是密文（决定 UI 用哪句文案） */
interface CredentialFileState {
  creds: CredentialFile
  encrypted: boolean
}

/** 密文容器的落盘形态 */
interface CredentialEnvelope {
  format: typeof ENCRYPTED_FORMAT
  data: string
}

/**
 * 来源配置表（sourceId → 配置）。
 *
 * 由渲染层的 `libraryStore` 在启动与每次变更时推过来（`pushLibrarySources`），
 * 与桌面端主进程里那张 `registry` 是同一份语义：**只存可公开字段**。
 */
const registry = new Map<string, LibrarySourceConfig>()

/** 同步来源配置（渲染层调用；配置文件里不含口令） */
export function syncLibrarySources(sources: readonly LibrarySourceConfig[]): void {
  registry.clear()
  for (const source of sources) {
    if (source?.id) registry.set(source.id, source)
  }
}

/** 取出某条来源配置（诊断与单测用） */
export function getLibrarySource(sourceId: string): LibrarySourceConfig | undefined {
  return registry.get(sourceId)
}

// ─── 口令文件 ────────────────────────────────────────────────────

/**
 * 把任意 JSON 归一成口令表：只留非空字符串字段。
 *
 * 容错优先（坏字段直接丢，不抛错）：口令文件在启动、扫描、探测三条路上都会被读，
 * 为一个字段形态不对把整次扫描打挂不值得。
 */
function normalizeCredentialMap(parsed: unknown): CredentialFile {
  if (!parsed || typeof parsed !== 'object') return {}
  const out: CredentialFile = {}
  for (const [sourceId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const fields: Record<string, string> = {}
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw === 'string' && raw.length > 0) fields[key] = raw
    }
    if (Object.keys(fields).length > 0) out[sourceId] = fields
  }
  return out
}

/** 是不是密文容器（形状判定，不做任何解密尝试） */
function isCredentialEnvelope(value: unknown): value is CredentialEnvelope {
  if (!value || typeof value !== 'object') return false
  const env = value as Record<string, unknown>
  return env.format === ENCRYPTED_FORMAT && typeof env.data === 'string' && env.data.length > 0
}

/**
 * 写操作串行队列。
 *
 * save / clear / 明文迁移都是"读-改-写"三步，并发交错会互相覆盖 —— 最坏的一种是
 * 用户刚存的口令被迁移步骤拿**旧快照**写回去（表现为"存了但下次连不上"）。
 * 全部写操作排队执行，读操作不排队（读到旧值无害，写到旧值有害）。
 */
let writeChain: Promise<unknown> = Promise.resolve()
function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task)
  writeChain = run.catch(() => {})
  return run
}

/**
 * 读口令文件。
 *
 * 任何失败（文件不存在、坏 JSON、密钥失效）都按"没有口令"处理并**不抛错**：
 * 这是一条在启动/探测时都会走的路径，为读不到一个可选文件把整次扫描打挂不值得；
 * 用户看到的是"未保存口令"，正好对应他要做的动作（重新填一次）。
 */
async function readCredentialFile(): Promise<CredentialFileState> {
  let text = ''
  try {
    const result = await Filesystem.readFile({
      path: CREDENTIALS_FILE,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    })
    text = typeof result.data === 'string' ? result.data : ''
  } catch {
    return { creds: {}, encrypted: false }
  }
  if (!text.trim()) return { creds: {}, encrypted: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { creds: {}, encrypted: false }
  }
  if (!isCredentialEnvelope(parsed)) {
    // 明文形态（本轮改造前写下的文件）：照常可用，下次保存/查状态时迁成密文
    return { creds: normalizeCredentialMap(parsed), encrypted: false }
  }
  const plain = await keystoreDecrypt(parsed.data)
  if (plain === null) {
    // 密钥失效（恢复备份 / 换机重装 / 清了数据）：密文还在但再也解不开。
    // 不能当成"读到空口令"的普通失败、也不能删文件 —— 原样留着，等用户重填时覆盖。
    console.warn('[MobileStorage] 口令解密失败（KeyStore 密钥可能已失效），按未保存处理')
    return { creds: {}, encrypted: true }
  }
  try {
    return { creds: normalizeCredentialMap(JSON.parse(plain)), encrypted: true }
  } catch {
    return { creds: {}, encrypted: true }
  }
}

/**
 * 写口令文件：有 Keystore 就写密文容器，没有就写明文。
 *
 * 返回值带 `encrypted` —— 调用方据此回报 `protection`，UI 必须能如实说出
 * "这份口令是怎么存的"（`pluginConfigCards` 的文案分支吃这个字段）。
 */
async function writeCredentialFile(creds: CredentialFile): Promise<{ encrypted: boolean }> {
  const plain = JSON.stringify(creds)
  const sealed = (await keystoreAvailable()) ? await keystoreEncrypt(plain) : null
  const data = sealed
    ? JSON.stringify({ format: ENCRYPTED_FORMAT, data: sealed } satisfies CredentialEnvelope)
    : plain
  await Filesystem.writeFile({
    path: CREDENTIALS_FILE,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    data,
    recursive: true,
  })
  return { encrypted: Boolean(sealed) }
}

/**
 * 把历史明文口令文件迁到密文形态（幂等，必须在写队列里跑）。
 *
 * 之所以重读一次而不是用调用方手里的快照：队列里前一个任务可能刚改过文件
 * （用户保存了口令），拿旧快照写回就是数据丢失。
 */
async function ensureEncryptedCredentialFile(): Promise<CredentialFileState> {
  const current = await readCredentialFile()
  if (current.encrypted) return current
  if (Object.keys(current.creds).length === 0) return current
  if (!(await keystoreAvailable())) return current
  try {
    await writeCredentialFile(current.creds)
    return { creds: current.creds, encrypted: true }
  } catch (err) {
    console.warn('[MobileStorage] 口令迁移加密失败:', err)
    return current
  }
}

/** 后台迁移只做一次（拿配置去探测/扫描时顺手触发，不阻塞调用方） */
let migrationStarted = false
function migrateInBackground(): void {
  if (migrationStarted) return
  migrationStarted = true
  void serializeWrite(ensureEncryptedCredentialFile).catch((err) => {
    console.warn('[MobileStorage] 口令后台迁移失败:', err)
  })
}

/** 口令存放形态：已加密就是 keystore；未加密时看这台设备有没有加密能力 */
async function protectionOf(encrypted: boolean): Promise<'keystore' | 'app-private'> {
  if (encrypted) return 'keystore'
  return (await keystoreAvailable()) ? 'keystore' : 'app-private'
}

/** 把口令并进配置副本（settings 优先的取值逻辑由插件的 `storageFieldValue` 负责） */
function withSecrets(
  cfg: LibrarySourceConfig,
  secrets: Record<string, string> | undefined
): LibrarySourceConfig {
  if (!secrets || Object.keys(secrets).length === 0) return cfg
  return { ...cfg, settings: { ...(cfg.settings || {}), ...secrets } }
}

async function sealedConfigOf(sourceId: string): Promise<LibrarySourceConfig | undefined> {
  const cfg = registry.get(sourceId)
  if (!cfg) return undefined
  const state = await readCredentialFile()
  // 明文文件在第一次"拿出来用"时就后台迁掉：用户不必为了加密重输一次口令
  if (!state.encrypted) migrateInBackground()
  return withSecrets(cfg, state.creds[sourceId])
}

/**
 * 保存口令（按 sourceId 存，同一插件的多台设备互不覆盖）。
 *
 * 失败的 `saved` 取**写入前**的真实状态：写挂了但旧口令还在，就不能回报"未保存"，
 * 那会让 UI 提示用户重填一份其实已经存住的口令。
 */
export async function saveStorageCredential(
  sourceId: string,
  payload: Record<string, string>
): Promise<{ ok: boolean } & StorageCredentialState> {
  const id = typeof sourceId === 'string' ? sourceId.trim() : ''
  const protection = await protectionOf(false)
  if (!id) {
    return { ok: false, saved: false, encryptionAvailable: true, protection }
  }
  return serializeWrite(async () => {
    const { creds } = await readCredentialFile()
    const hadBefore = Object.keys(creds[id] || {}).length > 0
    const next: Record<string, string> = { ...(creds[id] || {}) }
    for (const [key, value] of Object.entries(payload || {})) {
      if (typeof value === 'string' && value.length > 0) next[key] = value
    }
    creds[id] = next
    try {
      const { encrypted } = await writeCredentialFile(creds)
      return {
        ok: true,
        saved: true,
        encryptionAvailable: true,
        protection: encrypted ? ('keystore' as const) : ('app-private' as const),
      }
    } catch (err) {
      // 写失败不静默：口令没存住时用户下一次连接必然失败，必须让他当场知道
      console.warn('[MobileStorage] 口令写入失败:', err)
      return {
        ok: false,
        saved: hadBefore,
        encryptionAvailable: true,
        protection: await protectionOf(false),
      }
    }
  })
}

/** 口令状态（**不含原文**）：是否已保存、按什么方式存的 */
export async function storageCredentialState(sourceId: string): Promise<StorageCredentialState> {
  // 用户打开来源卡片是唯一确定"此刻没有并发写"的时机，顺手把明文迁成密文
  const state = await serializeWrite(ensureEncryptedCredentialFile)
  const fields = state.creds[sourceId]
  return {
    saved: Boolean(fields && Object.keys(fields).length > 0),
    // 能存住（应用私有目录 + Keystore 加密），不存在"无处可存"这一档
    encryptionAvailable: true,
    protection: await protectionOf(state.encrypted),
  }
}

/** 清除口令 */
export async function clearStorageCredential(
  sourceId: string
): Promise<{ ok: boolean } & StorageCredentialState> {
  return serializeWrite(async () => {
    const { creds } = await readCredentialFile()
    const existed = Boolean(creds[sourceId])
    delete creds[sourceId]
    try {
      const { encrypted } = await writeCredentialFile(creds)
      return {
        ok: true,
        saved: false,
        encryptionAvailable: true,
        protection: encrypted ? ('keystore' as const) : ('app-private' as const),
      }
    } catch (err) {
      console.warn('[MobileStorage] 清除口令失败:', err)
      return {
        ok: false,
        saved: existed,
        encryptionAvailable: true,
        protection: await protectionOf(false),
      }
    }
  })
}

// ─── 插件与能力 ─────────────────────────────────────────────────

/**
 * 可添加的存储协议（纯数据 meta）。
 *
 * `available === false` 的插件（移动端的 SFTP / SMB）照样返回 —— 过滤是**调用方**
 * 的事（设置页据此只给可跑协议的新增入口）。在这里偷偷剔掉会让卡片凭空消失，
 * 用户就再也看不到"这台设备不支持该协议"的解释。
 */
export function listMobileStoragePlugins(): StoragePluginMeta[] {
  return listStoragePluginMeta()
}

/** 取来源对应的插件（唯一查法：配置 → 插件 id → 注册表 + 启停门禁） */
function pluginFor(cfg: LibrarySourceConfig): StoragePlugin {
  const plugin = storagePluginOf(cfg)
  if (!plugin) {
    throw auroraError('runtime.error.sourcePluginUnsupported', {
      pluginId: cfg.pluginId || cfg.kind || '',
    })
  }
  return plugin
}

function requireCapability<K extends keyof StoragePlugin>(
  plugin: StoragePlugin,
  capability: K
): NonNullable<StoragePlugin[K]> {
  const fn = plugin[capability]
  if (typeof fn !== 'function') {
    throw auroraError('runtime.error.sourceCapabilityMissing', {
      capability: String(capability),
    })
  }
  return fn.bind(plugin) as NonNullable<StoragePlugin[K]>
}

// ─── 探测 ───────────────────────────────────────────────────────

/** 探测来源可用性（设置页「测试连接」）：只列举根目录，不递归、不入库 */
export async function probeLibrarySource(
  sourceId: string
): Promise<{ ok: boolean; message: string; sample?: string[] }> {
  const cfg = await sealedConfigOf(sourceId)
  if (!cfg) return { ok: false, message: auroraError('runtime.error.sourceNotFound').message }
  const plugin = storagePluginOf(cfg)
  if (!plugin) {
    return {
      ok: false,
      message: auroraError('runtime.error.sourcePluginUnsupported', {
        pluginId: cfg.pluginId || cfg.kind || '',
      }).message,
    }
  }
  if (typeof plugin.probe !== 'function') {
    return {
      ok: false,
      message: auroraError('runtime.error.sourceCapabilityMissing', { capability: 'probe' }).message,
    }
  }
  try {
    return await plugin.probe(cfg)
  } catch (err) {
    // 插件按契约已把失败编码成结构化信封；这里只兜"它自己抛了"的意外
    return { ok: false, message: (err as Error).message }
  }
}

// ─── 扫描入库 ───────────────────────────────────────────────────

/**
 * 占位元数据（文件名兜底）。
 *
 * 与桌面端 `ipc/librarySource.ts` 的 `fallbackMetaFromName` 同一规则、同一落库哨兵：
 * "未知艺术家"/"未知专辑"参与 shared 的封面匹配与占位判定，不本地化。
 */
function fallbackMetaFromName(name: string): { title: string; artist: string } {
  const stem = name.replace(/\.[^.]+$/, '')
  const matched = stem.match(/^(.{1,50}?)\s*-\s*(.{1,100})$/)
  if (matched) return { title: matched[2].trim(), artist: matched[1].trim() }
  return { title: stem, artist: '未知艺术家' } // i18n-exempt: 落库哨兵值，参与匹配
}

/**
 * 读文件头并解析元数据（`openRange` 走原生 HTTP，Range 语义由插件负责）。
 *
 * 失败分两类（与桌面端同一判据）：
 * - 传输层失败（401/5xx/超时）→ 打上标记后**向上抛**，调用方保留旧记录、不写新记录；
 * - 格式解析失败 → 由调用方按文件名兜底入库。
 */
async function readTrackMeta(
  plugin: StoragePlugin,
  cfg: LibrarySourceConfig,
  entry: RemoteEntry
): Promise<Partial<Track>> {
  const openRange = requireCapability(plugin, 'openRange')
  const headLength = Math.max(1, Math.min(entry.size || METADATA_HEAD_BYTES, METADATA_HEAD_BYTES))
  const response = await openRange(cfg, entry.path, 0, headLength - 1)
  if (!response.ok && response.status !== 206) {
    // 2xx 之外的响应一律按传输层失败：远端拒绝/文件已消失时不该写占位记录
    throw markTransportError(
      auroraError('runtime.error.sourceReadFailed', { status: response.status })
    )
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  // Blob 的 BlobPart 只认 ArrayBuffer/字符串：Uint8Array 的 buffer 是 ArrayBufferLike，
  // 这里切出独立的 ArrayBuffer 再包（与 nativeFetch 的处理同一理由）
  const head = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const parsed = await mm.parseBlob(new Blob([head], { type: guessAudioMime(entry.name) }), {
    duration: true,
    skipCovers: true,
  })
  const duration = normalizeHeadParsedDuration(parsed.format, bytes.length, entry.size || bytes.length)
  const fallback = fallbackMetaFromName(entry.name)
  const title = parsed.common.title || fallback.title
  let artist = parsed.common.artist || fallback.artist
  if (!artist) artist = '未知艺术家' // i18n-exempt: 落库哨兵值，参与匹配
  return {
    title,
    artist,
    album: parsed.common.album || '未知专辑', // i18n-exempt: 落库哨兵值，参与匹配
    year: parsed.common.year,
    genre: parsed.common.genre?.[0],
    duration,
    trackNumber: typeof parsed.common.track?.no === 'number' ? parsed.common.track.no : undefined,
  }
}

/** 远端目录项 → 库内 Track（id / 播放统计 / 收藏从旧记录沿用） */
async function buildRemoteTrack(
  plugin: StoragePlugin,
  cfg: LibrarySourceConfig,
  entry: RemoteEntry,
  existing: Track | undefined
): Promise<Track> {
  let meta: Partial<Track>
  let fileSize: number | undefined = entry.size || undefined
  try {
    meta = await readTrackMeta(plugin, cfg, entry)
  } catch (err) {
    if (isStorageTransportError(err)) throw err
    const fallback = fallbackMetaFromName(entry.name)
    console.warn('[MobileStorage] 元数据解析失败，按文件名兜底入库:', entry.path, (err as Error).message)
    meta = { title: fallback.title, artist: fallback.artist, album: '未知专辑', duration: 0 } // i18n-exempt: 落库哨兵值
    // 刻意不写 fileSize：跳过重解析的条件是"大小未变"，留空可让下次扫描重试
    fileSize = undefined
  }
  return {
    id: existing?.id ?? crypto.randomUUID(),
    path: storagePathFor(cfg.id, entry.path),
    sourceId: cfg.id,
    // **不写 remoteUrl**：`aurora-remote://` 是桌面端主进程注册的自定义协议，
    // 移动端没有它。播放地址由 `resolveStorageAudio` 现算（带鉴权头落缓存后本地播）。
    title: meta.title || fallbackMetaFromName(entry.name).title,
    artist: meta.artist || '未知艺术家', // i18n-exempt: 落库哨兵值，参与匹配
    album: meta.album || '未知专辑', // i18n-exempt: 落库哨兵值，参与匹配
    year: meta.year,
    genre: meta.genre,
    duration: meta.duration ?? 0,
    trackNumber: meta.trackNumber,
    // 扫描阶段不提取远端封面（与桌面端同一策略）：要额外读一段字节 + 解图片 + 写盘，
    // 而封面只在对用户可见时才需要。留空由 `ensureStorageCover` 按需补（见文件头）。
    coverPath: existing?.coverPath,
    fileSize,
    addedAt: existing?.addedAt ?? Date.now(),
    lastPlayedAt: existing?.lastPlayedAt,
    playCount: existing?.playCount ?? 0,
    liked: existing?.liked ?? false,
  }
}

export interface MobileLibraryScanResult {
  tracks: Track[]
  /** 本次扫描是否完整可信（不完整时**不得**据此清理旧记录） */
  complete: boolean
  /** 列举失败的目录数（供 UI 提示） */
  failedDirs: number
}

/**
 * 扫描一个来源并入库。
 *
 * 清理策略与桌面端**逐条一致**：只有「根目录列举成功 + 全部子目录无失败」时才删除
 * 远端已不存在的记录。否则出门在外连不上 NAS 一次，回来就会发现曲库空了。
 */
export async function scanLibrarySource(
  sourceId: string,
  deps: { db: MobileDatabase; ensureDbInited: () => Promise<void> }
): Promise<MobileLibraryScanResult> {
  const cfg = await sealedConfigOf(sourceId)
  if (!cfg) throw auroraError('runtime.error.sourceNotFound')
  // 与桌面端同一语义：`enabled` 只管"启动时要不要自动重扫"，
  // 用户在面板里手动点「扫描入库」时不看它（否则关掉开关就再也扫不动了）
  const plugin = pluginFor(cfg)
  const listAudio = requireCapability(plugin, 'listAudio')

  const failedDirs: string[] = []
  const entries = await listAudio(cfg, {
    concurrency: REMOTE_CONCURRENCY,
    onError: (dir, err) => {
      failedDirs.push(dir)
      console.warn('[MobileStorage] 目录列举失败，已跳过:', cfg.name, dir || '/', err?.message)
    },
  })

  await deps.ensureDbInited()
  const storagePaths = entries.map((entry) => storagePathFor(cfg.id, entry.path))
  const existingByPath = await deps.db.getTracksByPaths(storagePaths)

  const tracks: Track[] = []
  const toInsert: Track[] = []

  for (let i = 0; i < entries.length; i += REMOTE_CONCURRENCY) {
    const batch = entries.slice(i, i + REMOTE_CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (entry) => {
        const storagePath = storagePathFor(cfg.id, entry.path)
        const existing = existingByPath.get(storagePath)
        // 大小未变直接复用：保留播放统计/收藏，也省掉一次 Range 请求
        if (existing && existing.fileSize && existing.fileSize === entry.size) return existing
        try {
          return await buildRemoteTrack(plugin, cfg, entry, existing)
        } catch (err) {
          // 到这里只可能是传输层失败：保留旧记录，新文件本次跳过、下次再试
          console.warn('[MobileStorage] 读取失败，本次跳过:', entry.path, (err as Error).message)
          return existing ?? null
        }
      })
    )
    for (const track of results) {
      if (!track) continue
      tracks.push(track)
      const existing = existingByPath.get(track.path)
      if (!existing || existing.fileSize !== track.fileSize) toInsert.push(track)
    }
  }

  // 串行写库：Capacitor SQLite 的并发写行为在本机没有可验证的保障
  for (const track of toInsert) {
    try {
      await deps.db.insertTrack(track)
    } catch (err) {
      console.error('[MobileStorage] 写入曲目失败:', track.path, err)
    }
  }

  const complete = failedDirs.length === 0
  if (complete) {
    const removed = await deps.db.deleteTracksBySourcePrefix(
      storagePathPrefix(cfg.id),
      new Set(storagePaths)
    )
    if (removed > 0) console.log('[MobileStorage] 清理已不存在的远端曲目:', removed)
  } else {
    console.warn(
      `[MobileStorage]「${cfg.name}」有 ${failedDirs.length} 个目录列举失败，本次跳过缺失清理，避免误删曲库` // i18n-exempt: 开发者日志，不进界面
    )
  }

  return { tracks, complete, failedDirs: failedDirs.length }
}

/** 移除某个来源的全部曲目（用户删除来源时调用），返回移除后的全库 */
export async function removeLibrarySource(
  sourceId: string,
  deps: { db: MobileDatabase; ensureDbInited: () => Promise<void> }
): Promise<Track[]> {
  await deps.ensureDbInited()
  const removed = await deps.db.deleteTracksBySourcePrefix(storagePathPrefix(sourceId))
  if (removed > 0) console.log('[MobileStorage] 已移除来源曲目:', sourceId, removed)
  return deps.db.getAllTracks()
}

// ─── 播放地址 ───────────────────────────────────────────────────

/** `webdav:<sourceId>/<相对路径>` → 相对路径（不是该来源的坐标则 null） */
function relPathOf(path: string, sourceId: string): string | null {
  const prefix = storagePathPrefix(sourceId)
  if (typeof path !== 'string' || !path.startsWith(prefix)) return null
  return path.slice(prefix.length)
}

/**
 * 把远端曲目解析成**本机可播地址**。
 *
 * 移动端没有 `aurora-remote://` 协议代理，`<audio>`/原生播放器也带不上鉴权头，
 * 所以这里的做法是：拿插件给的可直连地址 + 鉴权头，交给媒体缓存**整首下载**到
 * 应用私有目录，然后把本地文件地址返回给播放器。
 *
 * 代价如实记录：首次播放要等整首下载完（之后走缓存命中）；大文件（无损 30–80MB）
 * 在慢网下会有可感知的等待。换来的是"能播、能 seek、能锁屏"三者都成立
 * —— 让播放器去啃需要 Basic Auth 的 Range 流，在当前架构里做不到。
 */
export async function resolveStorageAudio(
  track: Pick<Track, 'sourceId' | 'path'>
): Promise<{ src: string | null }> {
  const sourceId = track?.sourceId
  if (!sourceId) return { src: null }
  const cfg = await sealedConfigOf(sourceId)
  if (!cfg) return { src: null }
  const plugin = storagePluginOf(cfg)
  if (!plugin || typeof plugin.directUrl !== 'function') return { src: null }
  const relPath = relPathOf(track.path, sourceId)
  if (!relPath) return { src: null }
  const url = plugin.directUrl(cfg, relPath)
  const headers = typeof plugin.directHeaders === 'function' ? plugin.directHeaders(cfg) : undefined
  return awaitCachedAudio({ url, key: `storage|${sourceId}|${relPath}`, headers })
}

// ─── 远端封面 ───────────────────────────────────────────────────

/**
 * 判断一张图片字节是否**完整**（不是被头段截断的半张图）。
 *
 * 为什么需要这一步：Range 只读了文件头 1 MiB，若内嵌封面比这段还大，
 * 解析库会把"读到的部分"当整张图返回（有些格式还会按声明长度补零）。
 * 半张图落盘的症状是列表里一格碎图，而且因为 `coverPath` 已写入，
 * 渲染层不会再触发提取 —— 比"没有封面"更糟。因此宁可判成"本曲无封面"。
 */
function isCompleteImage(data: Uint8Array): boolean {
  if (!data || data.length < 64) return false
  // JPEG：SOI ... EOI
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9
  }
  // PNG：签名 ... IEND（末尾固定 12 字节：长度 + 'IEND' + CRC）
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    const tail = data.subarray(Math.max(0, data.length - 12))
    for (let i = 0; i + 4 <= tail.length; i++) {
      if (tail[i] === 0x49 && tail[i + 1] === 0x45 && tail[i + 2] === 0x4e && tail[i + 3] === 0x44) {
        return true
      }
    }
    return false
  }
  // GIF：'GIF8' ... 0x3B
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return data[data.length - 1] === 0x3b
  }
  // 其余（WEBP/BMP，以及声明不规范的格式）：头部自述长度的格式无法在不解码的前提下
  // 判定完整性，只要求"不是刚开头就被切断"，剩下的交给 <img> 的 onError 兜底
  return data.length >= 128
}

/**
 * 按需提取远端曲目的内嵌封面并落盘，返回可加载地址；确认无封面时返回 null。
 *
 * ## 与桌面端 `ensureRemoteCover` 逐条对齐的错误语义
 *
 * **传输层失败必须抛错，不能返回 null。** 渲染层（`CoverImage`）只对
 * "确认无内嵌封面"缓存 null；NAS 短暂不可达时若返回 null，会被当成
 * "这首本来就没封面"记一整个会话，网络恢复后封面也补不回来。
 * 反过来，解析失败（标签损坏 / 封面被头段截断）是**文件的固有事实**，
 * 返回 null 让渲染层别反复重试用同一份字节打远端。
 *
 * ## 覆盖面
 *
 * 只读文件头 1 MiB（内嵌封面按惯例就在前部）。封面落在文件尾部的少数 MP4
 * 变体取不到 —— 与桌面端同一个已知边界，不为此引入"整文件下载"。
 */
export async function ensureStorageCover(
  track: Pick<Track, 'id' | 'path' | 'sourceId' | 'fileSize'>
): Promise<string | null> {
  const sourceId = track?.sourceId
  if (!sourceId || !track?.id) return null
  const cfg = await sealedConfigOf(sourceId)
  if (!cfg) return null
  const plugin = storagePluginOf(cfg)
  if (!plugin || typeof plugin.openRange !== 'function') return null
  const relPath = relPathOf(track.path, sourceId)
  if (!relPath) return null

  const headLength = Math.max(
    1,
    Math.min(track.fileSize && track.fileSize > 0 ? track.fileSize : METADATA_HEAD_BYTES, METADATA_HEAD_BYTES)
  )
  const response = await plugin.openRange(cfg, relPath, 0, headLength - 1)
  if (!response.ok && response.status !== 206) {
    // 2xx 之外一律按传输层失败：远端拒绝 / 文件已消失时不该把它记成"无封面"
    throw markTransportError(auroraError('runtime.error.sourceReadFailed', { status: response.status }))
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

  let parsed: Awaited<ReturnType<typeof mm.parseBlob>>
  try {
    parsed = await mm.parseBlob(new Blob([buffer], { type: guessAudioMime(relPath) }), {
      duration: false,
    })
  } catch (err) {
    // 头段解析不出标签（含"封面比头段大导致解析失败"）：认定为本次取不到封面，
    // 不让渲染层拿着同一段字节反复重试
    console.warn('[MobileStorage] 头段封面解析失败，按无封面处理:', track.path, (err as Error).message)
    return null
  }
  const pic = parsed.common.picture?.[0]
  if (!pic) return null
  const data = pic.data instanceof Uint8Array ? pic.data : new Uint8Array(pic.data)
  if (!isCompleteImage(data)) {
    console.warn('[MobileStorage] 内嵌封面不完整（超出头段），已跳过:', track.path)
    return null
  }
  return await saveCoverImage(track.id, data, pic.format)
}

/**
 * 按需补齐某首曲目的内嵌封面，并把结果**写回数据库**。
 *
 * 为什么写库这件事在这一层而不是渲染层：渲染层的 `updateTrack` 只改 store
 * （见 `libraryStore` 的实现），不落库。桌面端由主进程 `ensureCover` 负责持久化，
 * 移动端没有第二层进程，所以这条职责跟着实现一起走 —— 否则每次冷启动都要为
 * 同一首歌再读一遍同一张封面。
 *
 * 本地曲目（无 `sourceId`）直接返回 null：它们在扫描阶段就已经落过封面，
 * 这里不做第二套提取逻辑。
 */
export async function ensureStorageCoverForTrack(
  trackId: string,
  deps: { db: Pick<MobileDatabase, 'getTrackById' | 'updateTrack'> }
): Promise<string | null> {
  const track = await deps.db.getTrackById(trackId)
  if (!track?.sourceId) return null
  const coverPath = await ensureStorageCover(track)
  if (coverPath) await deps.db.updateTrack(trackId, { coverPath })
  return coverPath
}
