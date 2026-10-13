import { Filesystem, Directory } from '@capacitor/filesystem'
import { Capacitor } from '@capacitor/core'
import { encodeFilePathToUrl, auroraError } from '@aurora/shared'
import * as mm from 'music-metadata-browser'
import type { Track } from '@/types'
import { MobileDatabase } from './database'
import { registerLyricsFile, touchLyricsFile } from './mediaCache'

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav', '.wma', '.opus',
])

/**
 * 递归遍历目录，收集所有音频文件路径
 * Capacitor Filesystem.readdir 在 Android 上需要以 Directory.ExternalStorage 为根
 */
async function walkDir(dirPath: string, files: string[] = []): Promise<string[]> {
  let entries
  try {
    entries = await Filesystem.readdir({ path: dirPath, directory: Directory.ExternalStorage })
  } catch (err) {
    // 单个目录不可读（权限/损坏）不应中断整个扫描，跳过即可
    console.warn('walkDir: 无法读取目录，已跳过:', dirPath, err)
    return files
  }
  for (const entry of entries.files) {
    const fullPath = dirPath.endsWith('/') ? `${dirPath}${entry.name}` : `${dirPath}/${entry.name}`
    if (entry.type === 'directory' && !entry.name.startsWith('.')) {
      await walkDir(fullPath, files)
    } else if (entry.type === 'file') {
      const ext = entry.name.split('.').pop()?.toLowerCase()
      if (ext && AUDIO_EXTENSIONS.has(`.${ext}`)) {
        files.push(fullPath)
      }
    }
  }
  return files
}

/**
 * 判断封面扩展名：以**真实字节**为准，声明类型仅作兜底。
 * 部分打标工具会把 PNG 封面声明成 image/jpeg，只信 pic.format 会存错扩展名。
 */
function coverExtensionFor(data: Uint8Array, declaredFormat?: string): string {
  if (data && data.length >= 12) {
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return '.jpg'
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return '.png'
    if (
      data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
    ) {
      return '.webp'
    }
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return '.gif'
    if (data[0] === 0x42 && data[1] === 0x4d) return '.bmp'
  }
  const m = (declaredFormat || '').toLowerCase()
  if (m.includes('png')) return '.png'
  if (m.includes('webp')) return '.webp'
  if (m.includes('gif')) return '.gif'
  if (m.includes('bmp')) return '.bmp'
  return '.jpg'
}

/** 获取封面缓存目录路径（应用专属目录下 aurora-music/covers） */
async function getCoverCachePath(trackId: string, ext = '.jpg'): Promise<string> {
  const dir = 'aurora-music/covers'
  try {
    await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true })
  } catch (err: any) {
    // 目录已存在不报错
    if (err?.message && !/exist/i.test(err.message)) throw err
  }
  return `${dir}/${trackId}${ext}`
}

/** 获取歌词缓存目录路径（应用专属目录下 aurora-music/lyrics） */
async function getLyricsPath(trackId: string): Promise<string> {
  const dir = 'aurora-music/lyrics'
  try {
    await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true })
  } catch (err: any) {
    if (err?.message && !/exist/i.test(err.message)) throw err
  }
  return `${dir}/${trackId}.lrc`
}

/**
 * 单文件解析结果：曲目本体 + 封面决策所需的两个事实。
 *
 * 为什么不在这里就地决定封面：专辑内「无内嵌封面的曲目借用同专辑封面」这件事
 * **依赖文件顺序**（并发前是逐文件串行，同专辑里带封面那首只要排在前面就必然已登记）。
 * 并发化后文件完成次序被打乱，「就地查表」会让后面的曲目漏借封面
 * （表现为「同一张专辑部分曲目没封面」，而串行版是全部都有）。
 * 因此解析阶段只负责产出事实，封面借用/登记交给**按文件顺序推进**的提交阶段，
 * 语义与串行版逐字一致。
 */
interface ParsedFile {
  track: Track
  /**
   * 专辑级复用键（专辑与艺术家标签都真实存在时才有，否则为 null）。
   * 为 null 表示本曲**既不登记也不借用**（无标签曲目落到同一个键上会彼此串用封面）。
   */
  albumKey: string | null
  /**
   * 本曲是否要参与封面复用，取值有三种，直接对应旧实现的分支走向：
   *
   * - `'own'`：本曲自带内嵌封面且已成功落盘 → 由提交阶段**登记**到复用表；
   * - `'borrow'`：本曲确认无内嵌封面 → 由提交阶段**借用**表里已有的封面；
   * - `'none'`：本曲有内嵌封面但落盘失败 → **既不登记也不借用**。
   *
   * 最后一个取值是刻意保留旧实现语义的结果：旧代码里落盘失败发生在 `if (picture)`
   * 分支内部，被 catch 吞掉后 `coverPath` 保持 undefined，且因为是 `if/else if`
   * 结构，**根本不会走到借用分支**。若把它降级成「视同无自有封面 → 允许借用」，
   * 这个文件就会拿到别的曲目的封面 —— 那是本次改造不该引入的行为改变。
   */
  coverPlan: 'own' | 'borrow' | 'none'
}

/**
 * 解析单个文件的元数据（**只读文件 + 落本曲自有封面，不碰数据库**）。
 *
 * 与 db 解耦是并发的前提：并发只覆盖「读 blob + 解析标签 + 写封面文件」这段真正的耗时
 * 主体，数据库读写全部留在 scanFolder 的串行阶段 —— Capacitor SQLite 的并发写行为
 * 没有本机可验证的保障（真机才跑得起来），不为一次扫描提速去赌它。
 * 查重（getTrackByPath）同样属于读库，也留在 scanFolder 的串行阶段。
 */
async function parseNewFile(filePath: string): Promise<ParsedFile | null> {
  try {
    const fileName = filePath.split('/').pop() || filePath

    // 流式读取：Filesystem.readFile 会把整个文件转成 base64 字符串，
    // 原生堆在 40MB 级 flac 上直接 OOM 崩溃；改用 fetch(convertFileSrc) 走流式
    const cap = (window as any).Capacitor
    const abs = `/storage/emulated/0/${filePath.replace(/^\/+/, '')}`
    // convertFileSrc 只做字符串拼接（拼成 http://localhost/_capacitor_file_<path>），
    // 不做转义：中文/空格会被 WebView 规整，`#` 会被当成 fragment、`?` 会被当成
    // query 截断，导致读取到错误路径而扫描失败。统一用 shared 的逐段编码。
    const src = cap ? cap.convertFileSrc(encodeFilePathToUrl(abs)) : abs
    const res = await fetch(src)
    if (!res.ok) throw auroraError('runtime.error.fileReadFailed', { status: res.status })
    const blob = await res.blob()

    let metadata
    try {
      metadata = await mm.parseBlob(blob, { duration: true })
    } catch (err) {
      console.error('parseBlob failed for', filePath, err)
      return null
    }

    const title = metadata.common.title || fileName.replace(/\.[^.]+$/, '')
    // 无标签时的落库占位值保持中文原样：它参与 shared/coverMatch 的
    // PLACEHOLDER_ARTISTS 匹配（判定「歌手未知」以放宽封面匹配），翻译它等于改匹配规则
    const artist = metadata.common.artist || '未知艺术家' // i18n-exempt: 参与匹配的领域占位值
    const album = metadata.common.album || '未知专辑' // i18n-exempt: 参与匹配的领域占位值

    const trackId = crypto.randomUUID()
    let coverPath: string | undefined

    // 专辑级封面复用键：仅在专辑与艺术家标签都真实存在时才启用。
    // 否则所有无标签曲目都会落到「未知专辑|未知艺术家」同一个键上，
    // 导致彼此串用封面（显示成别人的封面）。
    const albumKey =
      metadata.common.album && metadata.common.artist
        ? `${metadata.common.album}|${metadata.common.artist}`
        : null

    const hadPicture = Boolean(metadata.common.picture && metadata.common.picture.length > 0)
    let coverPlan: ParsedFile['coverPlan'] = hadPicture ? 'none' : 'borrow'
    if (hadPicture) {
      const pic = metadata.common.picture![0]
      try {
        // 将 pic.data (Uint8Array) 转 base64 写入
        let bin = ''
        const buf = pic.data instanceof Uint8Array ? pic.data : new Uint8Array(pic.data)
        const coverDest = await getCoverCachePath(trackId, coverExtensionFor(buf, pic.format))
        const chunk = 0x8000
        for (let i = 0; i < buf.length; i += chunk) {
          bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk) as any)
        }
        const b64 = btoa(bin)
        await Filesystem.writeFile({
          path: coverDest,
          directory: Directory.Data,
          data: b64,
          recursive: true,
        })
        // 获取可直接在 WebView 中加载的 URL：
        // Filesystem.getUri 返回 file:///data/data/<pkg>/files/aurora-music/covers/xxx.jpg
        // Capacitor.convertFileSrc 把 file:// 转成 capacitor://localhost/... 或 https://localhost/_capacitor_file_/...
        // 直接存可访问 URL 到 coverPath，UI 层 getCoverSrc 原样返回即可
        const { uri } = await Filesystem.getUri({ path: coverDest, directory: Directory.Data })
        coverPath = Capacitor.convertFileSrc(uri)
        coverPlan = 'own'
      } catch (err) {
        // 落盘失败保持 coverPlan='none'：**不登记也不借用**，与旧实现的 if/else-if
        // 分支走向一致（旧代码在这里吞掉异常后 coverPath 保持 undefined，
        // 且不会落到 else-if 的借用分支）
        console.warn('保存封面失败:', err)
      }
    }

    const track: Track = {
      id: trackId,
      path: filePath,
      title,
      artist,
      album,
      year: metadata.common.year,
      genre: metadata.common.genre?.[0],
      duration: metadata.format.duration || 0,
      trackNumber: typeof metadata.common.track.no === 'number' ? metadata.common.track.no : undefined,
      coverPath,
      // 移动端拿 fileSize 需额外 stat，跳过避免重复 IO（与桌面端一致保留此字段，置为 undefined）
      fileSize: undefined,
      addedAt: Date.now(),
      playCount: 0,
      liked: false,
    }
    return { track, albumKey, coverPlan }
  } catch (err) {
    console.error('处理文件失败:', filePath, err)
    return null
  }
}

/**
 * 单次扫描的在飞解析上限。
 *
 * 与桌面端（PARSE_CONCURRENCY=8）、Web 端（4）同量级，取 4：手机端的瓶颈是
 * `fetch(convertFileSrc)` 走 WebView 流式读 + `parseBlob` 解析，
 * 4 路已足以盖住 IO 等待，再高在低端机上有把内存与文件描述符顶上去的风险。
 */
const SCAN_CONCURRENCY = 4

export async function scanFolder(
  rootPath: string,
  db: MobileDatabase,
  onTrack?: (track: Track) => void
): Promise<Track[]> {
  console.log('[Mobile] scanFolder starting:', rootPath)
  const files = await walkDir(rootPath)
  console.log('[Mobile] scanFolder found files:', files.length)

  // 清理数据库中存在但文件已不存在的记录（与桌面端一致）
  const removed = await db.deleteTracksWithMissingFiles(rootPath, new Set(files))
  if (removed > 0) console.log('[Mobile] scanFolder removed stale tracks:', removed)

  const tracks: Track[] = []
  /**
   * 专辑封面复用表：`albumKey → 本专辑已确定可用的封面地址`。
   *
   * 并发下它**只在提交阶段被读写**（提交严格按文件顺序串行），因此语义与
   * 逐文件串行的旧实现逐字一致：「无内嵌封面的曲目」借到的是**排在自己之前**的
   * 同专辑曲目已登记的封面。若放到并发解析阶段就地查表，后面的曲目可能比带封面那首
   * 先跑完而漏借（表现为同一张专辑部分曲目没有封面）。
   */
  const coverCache = new Map<string, string>()

  // ── 台账 ──
  // parsed[i]：第 i 个文件的解析结果（已入库的复用记录按「无专辑键」处理；null=解析失败）
  const parsed = new Array<ParsedFile | null>(files.length).fill(null)
  // existingTrack[i]：已入库时直接复用的原记录（这类曲目本就带 coverPath，不参与借用）
  const existingTrack = new Array<Track | null>(files.length).fill(null)
  // needsInsert[i]：只有新解析出来的才写库。已入库的曲目**不重新写库**
  // （旧实现里它们由 getTrackByPath 直接返回、从不 insert）：虽然 insertTrack 是
  // 「保留原 id 与用户数据」的 upsert，但为几百首没变的歌各发一次写，既白耗 IO，
  // 也平白多出一次「upsert 是否真的保住了播放统计」的信任成本。
  const needsInsert = new Array<boolean>(files.length).fill(false)
  /** 第 i 个文件是否已进入终态（解析完成 / 复用命中 / 解析失败） */
  const settled = new Array<boolean>(files.length).fill(false)

  /**
   * 提交闸门：只提交**从 commitCursor 开始连续就绪**的前缀，因此提交顺序恒等于文件顺序。
   *
   * 这是「渐进式刷新」与「并发」能同时成立的关键：先完成的文件不必等后面的文件
   * （此前三阶段实现里查重段与解析段各是一个屏障，首条通知要等全部查重结束才出现，
   * 已在库的大曲库上首条曲目会明显更晚才显示出来）。
   *
   * 提交（封面借用 + 写库 + onTrack）必须串行：Capacitor SQLite 的并发写行为没有
   * 本机可验证的保障（真机才跑得起来），不为一次扫描提速去赌它。串行化用一条
   * promise 链实现——解析 worker 完成时会调用本函数，可能同时有多个调用者，必须互斥。
   */
  let commitCursor = 0
  let commitChain: Promise<void> = Promise.resolve()

  const commitReady = async (): Promise<void> => {
    while (commitCursor < files.length && settled[commitCursor]) {
      const i = commitCursor
      const reused = existingTrack[i]
      const entry = parsed[i]

      if (reused) {
        // 已入库：原样复用（含原有 coverPath），不写库、不参与封面借用
        tracks.push(reused)
        // 先推进游标、再回调：onTrack 是外部注入的（生产路径是 store 更新），
        // 一旦它抛错，若游标还停在原地，下一次 commitReady 会把同一首**重复 push 并重复通知**
        // （实测可复现 [a,b,b,c]）。推进在前保证「提交一次且仅一次」。
        commitCursor++
        if (onTrack) onTrack(reused)
        continue
      }
      if (!entry) {
        // 解析失败：本文件整条丢弃（与旧实现一致），继续推进游标
        commitCursor++
        continue
      }

      const track = entry.track
      // ── 封面决策（严格按文件顺序，与串行版 if/else-if 分支走向一一对应） ──
      if (entry.coverPlan === 'own' && entry.albumKey && track.coverPath) {
        // 本曲自带封面且已落盘：登记供同专辑的**后续**曲目复用
        coverCache.set(entry.albumKey, track.coverPath)
      } else if (entry.coverPlan === 'borrow' && entry.albumKey) {
        // 本曲确认无内嵌封面：借同专辑「排在自己之前」的曲目已登记的封面
        const borrowed = coverCache.get(entry.albumKey)
        if (borrowed) track.coverPath = borrowed
      }
      // coverPlan === 'none'（有封面但落盘失败）：既不登记也不借用，
      // 与旧实现一致（见 ParsedFile.coverPlan 的说明）

      if (needsInsert[i]) {
        try {
          await db.insertTrack(track)
        } catch (err) {
          // 单条写入失败不中断整轮扫描（旧实现里这个错误会让该文件被整条丢弃）
          console.error('写入曲目失败:', track.path, err)
          commitCursor++
          continue
        }
      }
      tracks.push(track)
      // 同 reused 分支：先推进游标再通知，避免 onTrack 抛错导致重复提交
      commitCursor++
      // 立即通知 UI 追加显示（渐进式刷新），不等全部扫描完
      if (onTrack) onTrack(track)
    }
  }

  /** 串行化地触发一次提交；返回的 promise 在本次提交做完后 resolve */
  const flush = (): Promise<void> => {
    const next = commitChain.then(commitReady)
    // 不让链条因某次提交抛错而断掉：commitReady 内部已吞掉写库错误，
    // 这里的 catch 只兜「不该发生」的意外，保证后续 flush 仍能推进。
    commitChain = next.catch(() => {})
    return next
  }

  // ── 在飞解析数信号量（≤ SCAN_CONCURRENCY），避免一次把整个曲库读进内存 ──
  let inFlight = 0
  const slotsFree: Array<() => void> = []
  const acquire = async (): Promise<void> => {
    if (inFlight >= SCAN_CONCURRENCY) {
      await new Promise<void>((resolve) => slotsFree.push(resolve))
    }
    inFlight++
  }
  const release = (): void => {
    inFlight--
    slotsFree.shift()?.()
  }

  // ── 流水线：查重按文件顺序串行推进，解析投进并发池且不阻塞后续查重 ──
  //
  // 查重（getTrackByPath）保持**串行**：它也是数据库访问，和写库同理不并发。
  // 但它只占「每文件一次查询」的时间，解析才是耗时主体——把解析挪出主循环后，
  // 首条通知只需等「第一个文件查重完 + 它自己解析完」，不再等整轮查重。
  const parseJobs: Array<Promise<void>> = []
  for (let i = 0; i < files.length; i++) {
    // 查重抛错必须**只跳过该文件**，不能让整轮扫描 reject。
    //
    // 旧实现把这次查询放在 processFile 的 try/catch 内，读库出错时该文件被跳过、
    // 其余文件继续入库（实测旧版在同样输入下返回 [a,c]）。新流水线把查重提到了
    // 主循环，若放任异常冒泡就会 reject 整个 scanFolder —— 单条记录读不出来
    // 会让整张库扫不动，这是明确的退化。按旧语义降级为「该文件本次跳过」，
    // 并把 settled[i] 置位让提交游标能越过它。
    let existing: Track | null = null
    try {
      existing = await db.getTrackByPath(files[i])
    } catch (err) {
      console.warn('查重失败，本次跳过该文件:', files[i], err)
      settled[i] = true
      await flush()
      continue
    }
    if (existing) {
      existingTrack[i] = existing
      settled[i] = true
      await flush()
      continue
    }
    await acquire()
    parseJobs.push(
      (async () => {
        try {
          parsed[i] = await parseNewFile(files[i])
          needsInsert[i] = true
        } finally {
          settled[i] = true
          release()
          await flush()
        }
      })()
    )
  }

  await Promise.all(parseJobs)
  await flush()

  return tracks
}

/** 读取本地缓存的歌词文件，不存在返回 null */
export async function readLyricsFile(trackId: string): Promise<string | null> {
  try {
    const path = await getLyricsPath(trackId)
    const result = await Filesystem.readFile({ path, directory: Directory.Data })
    // data:application/octet-stream;base64,xxxx 或直接 base64
    const raw = result.data as string
    const b64 = raw.includes(',') ? raw.split(',')[1] : raw
    // atob 返回的是 Latin-1 二进制字符串，需反解 UTF-8，否则中文会乱码
    // (写入端用 btoa(unescape(encodeURIComponent(lyrics))) 做 UTF-8 编码，这里做对称解码)
    const lyrics = decodeURIComponent(escape(atob(b64)))
    // 命中即刷新最近使用时间：歌词很小，读一次就更新，常用歌词不会被当冷数据清掉
    await touchLyricsFile(trackId, new TextEncoder().encode(lyrics).length)
    return lyrics
  } catch {
    return null
  }
}

/** 保存歌词到本地，返回保存的路径 */
export async function saveLyricsFile(lyrics: string, trackId: string): Promise<string> {
  const path = await getLyricsPath(trackId)
  const b64 = btoa(unescape(encodeURIComponent(lyrics)))
  await Filesystem.writeFile({
    path,
    directory: Directory.Data,
    data: b64,
    recursive: true,
  })
  // 登记进媒体缓存索引（歌词池）：纳入「缓存占用」统计与容量驱逐
  await registerLyricsFile(trackId, new TextEncoder().encode(lyrics).length)
  return path
}
