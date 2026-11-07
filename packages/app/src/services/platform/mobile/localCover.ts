/**
 * 移动端「我的音乐」封面补齐：内嵌图按需提取 + 在线歌源兜底。
 *
 * 这两件事在桌面端由主进程的 `covers:ensure` / `covers:fetchOnline` 承担
 * （`packages/desktop/src/ipc/scanner.ts`）。移动端没有第二层进程，所以直接跑在
 * 渲染进程里：解析、落盘走 `coverFile.saveCoverImage`，结果写回曲库记录 ——
 * 只更新 store 不写库，等于每次冷启动都要把这批文件重新解析/重新搜一遍。
 *
 * 为什么必须有兜底（历史缺陷）：移动端原先**只在扫描那一刻**读一次内嵌封面
 * （见 `scanner.ts` 的 `parseNewFile`），下载时"把源封面嵌进文件"又是 best-effort，
 * 任何一步静默失败（源没给 coverUrl、封面 403、容器不支持、写回失败）都会让这首
 * 歌永久没有封面：`ensureCover` 对本地曲目直接返回 null，扫描对已入库记录又原样复用。
 * 桌面端同一个文件不会这样，因为它有下面这两条兜底。
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import * as mm from 'music-metadata-browser'
import {
  PLACEHOLDER_ARTISTS,
  auroraError,
  cleanTitleForQuery,
  encodeFilePathToUrl,
  firstArtistOf,
  pickCoverCandidate,
  tradToSimp,
} from '@aurora/shared'
import { base64ToUint8Array } from './base64'
import { saveCoverImage } from './coverFile'
import { searchOnlineTracks } from './online'
import type { MobileDatabase } from './database'
import type { OnlineSearchOptions, Track } from '@/types'

/** 在线封面下载超时：封面是可选增强，等太久不如让 UI 下次挂载重试（与桌面端同档） */
const COVER_TIMEOUT_MS = 15000
/** 小于这个体积的响应不可能是一张图（半截下载 / 占位空文件），与桌面端同口径 */
const COVER_MIN_BYTES = 100
/** 封面站普遍按 UA 决定是否给图（缺 UA 时多为 403） */
const COVER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * 读取本机音频文件的 Blob。
 *
 * 路径是相对 `Directory.ExternalStorage` 的存储坐标（与扫描入库时一致），
 * 绝对地址一律由原生侧解析：多用户/工作资料是 /storage/emulated/10，
 * 外置 SD 卡的挂载点又不同，硬编码 /storage/emulated/0 会读到不存在的路径。
 */
async function readLocalAudioBlob(path: string): Promise<Blob> {
  const { uri } = await Filesystem.getUri({ path, directory: Directory.ExternalStorage })
  // 逐段 encode：文件名含中文/空格/`#` 时，裸路径拼进 convertFileSrc 生成的 URL
  // 会被 WebView 当成 fragment 截断，fetch 到错误路径
  const res = await fetch(Capacitor.convertFileSrc(encodeFilePathToUrl(uri)))
  if (!res.ok) throw auroraError('runtime.error.fileReadFailed', { status: res.status })
  // 拿 Blob 而不是字节数组：music-metadata-browser 按 Blob.slice 随机读，
  // 整段 arrayBuffer 会把几十 MB 的整曲复制进堆（扫描器在 40MB flac 上踩过 OOM）
  return res.blob()
}

/**
 * 按需提取本地曲目的内嵌封面并落盘（对齐桌面端 `covers:ensure`）。
 *
 * - 返回可直接上屏的封面地址；
 * - 确认无内嵌封面返回 null（由调用方接着走在线兜底）；
 * - 读文件 / 解析失败**抛错**：由 `CoverImage` 退避重试，不能把「文件暂时读不到」
 *   记成「这首没有封面」，否则一次权限抖动就把它钉死成空封面。
 *
 * ⚠️ 刻意**不**因 `track.coverPath` 有值就早退：那条路径可能已经悬空（缓存被清、
 * URL 形态变更、文件被删）。早退会把一个不存在的文件当成功结果返回，而
 * `<CoverImage>` 的 onError 又只清 store、不写库 —— 两边互相踢皮球，<img> 每次都
 * 失败、每次重新要走一遍提取，是**无上界**的重试循环（桌面端 `covers:ensure`
 * 有同样的注释，且会顺手把悬空值从库里清掉）。这里直接重新提取：有图就覆盖，
 * 没图就返回 null 交给在线兜底，两条路都能自愈。
 *
 * 已知成本：`CoverImage` 的会话缓存只在本进程有效，"确认无内嵌封面"这件事**没有落库**，
 * 所以每次冷启动后、用户第一次滚到某首无封面曲目时，还会再读一遍文件。
 * 这与桌面端 `covers:ensure` 的口径一致（那边也是每次冷启动重解析一次），
 * 且只发生在可见行上（列表是虚拟化的）；要压掉这段成本得先加一个"已确认无封面"
 * 的持久哨兵，属于独立改造，不塞进本次修复。
 */
export async function ensureEmbeddedCoverForTrack(
  track: Track,
  db: MobileDatabase
): Promise<string | null> {
  const blob = await readLocalAudioBlob(track.path)

  let picture: { data: Uint8Array | ArrayBuffer; format?: string } | undefined
  try {
    const metadata = await mm.parseBlob(blob, { duration: false })
    picture = metadata.common.picture?.[0]
  } catch (err) {
    // 解析失败原样抛出：CoverImage 只对"确认无内嵌封面"记终态，异常要留给它退避重试
    console.warn('[Mobile] 内嵌封面解析失败:', track.path, err)
    throw err
  }
  if (!picture) {
    // 旧记录里的悬空封面值顺手清掉：留着它只会让每次挂载都先失败一次
    if (track.coverPath) await db.updateTrack(track.id, { coverPath: undefined })
    return null
  }

  const data = picture.data instanceof Uint8Array ? picture.data : new Uint8Array(picture.data)
  const coverPath = await saveCoverImage(track.id, data, picture.format)
  // 写库：扫描对已入库记录是"原样复用"，不落库的话本次会话一过又要重新解析一遍
  await db.updateTrack(track.id, { coverPath })
  return coverPath
}

/**
 * 在线歌源兜底：按「标题 + 艺术家」搜歌，取版本/时长都对得上的候选封面下载缓存。
 *
 * 语义与桌面端 `fetchOnlineCover` 逐条一致：无匹配返回 null（UI 记成"确认没有"，
 * 本次会话不再刷歌源）；网络/下载失败抛错（UI 不缓存，下次挂载重试）。
 */
export async function ensureOnlineCoverForTrack(
  track: Track,
  options: OnlineSearchOptions | undefined,
  db: MobileDatabase
): Promise<string | null> {
  // 已经有远端封面地址：`<CoverImage>` 的 remoteSrc 会直接用它显示，不必再搜一遍。
  // 而且在线曲目的快照（最近播放 / 队列）**永远不入库**，搜回来的封面会以 trackId
  // 落进艺术家目录、没有任何记录能引用它 —— 每会话一次搜索+下载，换来的是一堆孤儿文件。
  if (typeof track.coverUrl === 'string' && /^https?:\/\//i.test(track.coverUrl)) return null

  // 占位值当歌手/歌名去搜只会搜回别人的封面：先清空（与桌面端同一套判据）
  const rawArtist = PLACEHOLDER_ARTISTS.has(track.artist) ? '' : track.artist
  const rawTitle = PLACEHOLDER_ARTISTS.has(track.title) ? '' : track.title
  // 查询词清洗：第一艺术家 + 去演唱者后缀的标题，并统一转简体（歌源多以简体索引）
  const artist = firstArtistOf(rawArtist)
  const title = cleanTitleForQuery(rawTitle, rawArtist)
  const query = tradToSimp(`${artist} ${title}`).trim()
  if (!query) return null

  const candidates = await searchOnlineTracks(query, options)
  const best = pickCoverCandidate(candidates, {
    title: rawTitle,
    artist: rawArtist,
    duration: track.duration,
    album: track.album,
  })
  if (!best?.coverUrl) return null

  const data = await downloadCoverBytes(best.coverUrl)
  const coverPath = await saveCoverImage(track.id, data)
  await db.updateTrack(track.id, { coverPath })
  return coverPath
}

/**
 * 下载封面字节。走 `CapacitorHttp` 而不是 `fetch`：封面站几乎都不带 CORS 头，
 * WebView 的 fetch 会被同源策略拦掉；同时必须是原生二进制通道
 * （`responseType: 'blob'` 回 base64，文本通道会把二进制当字符串解坏）。
 *
 * 超时只用 `Promise.race` 兜住调用方，底层原生请求仍在跑 —— Capacitor 没有取消入口，
 * 这与 `nativeFetch.ts` 里记录的已知限制同源。
 */
async function downloadCoverBytes(url: string): Promise<Uint8Array> {
  const resp = await withCoverTimeout(
    CapacitorHttp.get({
      url,
      headers: { 'User-Agent': COVER_USER_AGENT },
      responseType: 'blob',
    })
  )
  if (resp.status < 200 || resp.status >= 300) {
    throw auroraError('runtime.error.coverHttpStatus', { status: resp.status })
  }
  // 非字符串 = 原生侧按 JSON 解析了响应（错误页 / 接口文档），不可能是图片
  if (typeof resp.data !== 'string') throw auroraError('runtime.error.coverInvalid')
  const data = base64ToUint8Array(resp.data)
  if (data.length < COVER_MIN_BYTES || !looksLikeCoverImage(data)) {
    // CDN 的 200 错误页 / 验证页也会回内容，只按体积判会把 HTML 当封面存下来，
    // 而存下来的坏封面又会让列表里的 <img> 永远加载失败（见 ensureEmbeddedCoverForTrack 的注释）
    throw auroraError('runtime.error.coverInvalid')
  }
  return data
}

/** 图片魔数判定（与 `coverFile.coverExtensionFor` 同一组格式，任一命中即可） */
function looksLikeCoverImage(data: Uint8Array): boolean {
  if (data.length < 12) return false
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return true // jpeg
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return true // png
  if (
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) {
    return true // webp
  }
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return true // gif
  if (data[0] === 0x42 && data[1] === 0x4d) return true // bmp
  return false
}

/**
 * 给原生请求套一层超时：Capacitor 没有取消入口，这里只能保证**调用方**按时拿到异常，
 * 底层请求仍会跑完（与 `nativeFetch.ts` 记录的已知限制同源）。
 */
async function withCoverTimeout<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(auroraError('runtime.error.coverTimeout', { ms: COVER_TIMEOUT_MS })),
          COVER_TIMEOUT_MS
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
