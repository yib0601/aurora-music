import fs from 'fs'
import path from 'path'
import { parseFile } from 'music-metadata'
import iconv from 'iconv-lite'
import { v4 as uuidv4 } from 'uuid'
import type { Track } from '../types'
import { insertTracks, getTracksByPaths, deleteTracksWithMissingFiles, countTracksByFolder, updateTrack } from './database'
import { searchOnlineTracks, fetchWithTimeout } from '@aurora/shared'
import type { OnlineSearchOptions, OnlineTrackSearchResult } from '@aurora/shared'

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav', '.wma', '.opus'])

async function walkDir(dir: string, files: string[] = []): Promise<string[]> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (err) {
    // 单个目录不可读（权限/损坏）不应中断整个扫描，跳过即可
    console.warn('walkDir: 无法读取目录，已跳过:', dir, err)
    return files
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      await walkDir(fullPath, files)
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (AUDIO_EXTENSIONS.has(ext)) {
        files.push(fullPath)
      }
    }
  }
  return files
}

function decodeGbk(buffer: Buffer): string {
  try {
    return iconv.decode(buffer, 'gbk')
  } catch {
    return buffer.toString('utf8')
  }
}

/**
 * 判断封面扩展名：以**真实字节**为准，声明类型仅作兜底。
 * 不能只信 pic.format——部分打标工具会在 FLAC/MP3 里把 PNG 封面声明成
 * image/jpeg（实测曲库中确有此类文件），按声明存成 .jpg 会让 cover-local
 * 协议以错误的 Content-Type 提供图片。
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

function getCoverCachePath(userData: string, trackId: string, ext = '.jpg'): string {
  const dir = path.join(userData, 'aurora-music', 'covers')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return path.join(dir, `${trackId}${ext}`)
}

/**
 * 解析单个音频文件。
 * 性能关键点：skipCovers=true 跳过嵌入图片读取（封面改为按需提取），
 * 这是扫描提速的最大来源。
 */
async function processFile(
  filePath: string,
  stat: fs.Stats,
  userData: string,
  existingByPath: Map<string, Track>
): Promise<Track | null> {
  try {
    const existing = existingByPath.get(filePath)
    if (existing) {
      // 文件未变化（大小一致）直接复用，保留播放统计/收藏等用户数据；
      // 文件被修改（重新打标签/替换）则继续往下重新解析
      if (existing.fileSize === stat.size) {
        // 老版本未按「艺术家 - 歌名」拆分文件名留下的占位记录，
        // 重扫时补一次重解析修正元数据（幂等，修正后即不再触发）
        const legacyUntagged = existing.artist === '未知艺术家' && existing.title.includes('-')
        if (!legacyUntagged) return existing
      }
    }

    let metadata
    try {
      metadata = await parseFile(filePath, { duration: true, skipCovers: true })
    } catch (err) {
      console.error('parseFile failed for', filePath, err)
      return null
    }

    const stem = path.basename(filePath, path.extname(filePath))
    let title = metadata.common.title || stem
    let artist = metadata.common.artist || ''
    if (!artist) {
      // 无艺术家标签时按「艺术家 - 歌名」文件名惯例拆分（音乐平台下载的常见命名）；
      // 否则 artist=未知艺术家 会让在线封面/歌词的匹配查询完全失效
      const m = stem.match(/^(.{1,50}?)\s*-\s*(.{1,100})$/)
      if (m) {
        artist = m[1].trim()
        if (!metadata.common.title) title = m[2].trim()
      }
    }
    if (!artist) artist = '未知艺术家'
    const album = metadata.common.album || '未知专辑'

    if (metadata.common.title && /[\u0000-\u001f]/.test(metadata.common.title)) {
      // GBK 兜底：标签在文件头部，只读前 64KB，避免把整个大文件读进内存
      const fd = await fs.promises.open(filePath, 'r')
      try {
        const headBuf = Buffer.alloc(64 * 1024)
        const { bytesRead } = await fd.read(headBuf, 0, headBuf.length, 0)
        const asStr = decodeGbk(headBuf.subarray(0, bytesRead))
        const titleMatch = asStr.match(/TIT2[\s\S]{0,200}/)
        if (titleMatch) {
          title = titleMatch[0].replace(/^TIT2[\s\S]{0,10}/, '').trim()
        }
      } finally {
        await fd.close()
      }
    }

    // 重新解析时保留原记录 id，保证封面文件名与播放统计延续
    const trackId = existing?.id ?? uuidv4()

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
      // 封面延迟到按需提取（getTrackById 时补齐），扫描阶段不读图片数据
      coverPath: existing?.coverPath,
      fileSize: stat.size,
      // 重新解析时保留原有的入库时间、播放统计与收藏状态
      addedAt: existing?.addedAt ?? Date.now(),
      lastPlayedAt: existing?.lastPlayedAt,
      playCount: existing?.playCount ?? 0,
      liked: existing?.liked ?? false,
    }

    return track
  } catch (err) {
    console.error('Error processing file:', filePath, err)
    return null
  }
}

/** 并发上限：受限于磁盘 IO 与 music-metadata 的 CPU 开销，8 是经验值 */
const PARSE_CONCURRENCY = 8

/**
 * 扫描指定目录，返回本次扫描到的全部曲目。
 * @param onTrack 可选回调：每解析完一首立即触发，用于渐进式刷新 UI
 *   （注意：并发批次内回调顺序非顺序，但 UI 端 addTracks 是去重追加，乱序无影响）
 */
export async function scanFolder(
  rootPath: string,
  userData: string,
  onTrack?: (track: Track) => void
): Promise<Track[]> {
  console.log('scanFolder starting:', rootPath)
  const files = await walkDir(rootPath)
  console.log('scanFolder found files:', files.length)

  // 一个文件都没扫到，但库里本来有该目录的记录 → 几乎不可能是「用户清空了音乐」，
  // 更常见的是网络共享（SMB/NFS）未挂载、外置盘掉线或根目录权限临时异常：
  // 挂载点丢失后目录往往仍然存在（只是空），isReadableDir 判不出来，walkDir 会
  // 返回空列表。若照常执行缺失清理，一次挂载故障就会把整个曲库清空。
  // 因此这里保守跳过清理并告警，用户仍可通过设置页移除该目录来主动清库。
  if (files.length === 0) {
    const known = countTracksByFolder(rootPath)
    if (known > 0) {
      console.warn(
        `scanFolder: 未发现任何音频文件但库中有 ${known} 条记录，已跳过缺失清理（疑似共享未挂载或权限异常）:`,
        rootPath
      )
      return []
    }
  }

  // 清理数据库中存在但文件已不存在的记录（歌曲被删除/移动后同步移除）
  const removed = deleteTracksWithMissingFiles(rootPath, new Set(files))
  if (removed > 0) console.log('scanFolder removed stale tracks:', removed)

  // 批量预取已有记录（一次 SQL），替代逐文件查询
  const existingByPath = getTracksByPaths(files)

  const tracks: Track[] = []
  const toInsert: Track[] = []

  // 并发解析：未变化的文件直接复用，只有新增/修改的文件才真正解析元数据
  for (let i = 0; i < files.length; i += PARSE_CONCURRENCY) {
    const batch = files.slice(i, i + PARSE_CONCURRENCY)
    const stats = await Promise.all(
      batch.map((f) => fs.promises.stat(f).catch(() => null))
    )
    const results = await Promise.all(
      batch.map((file, j) => {
        const stat = stats[j]
        if (!stat) return null
        return processFile(file, stat, userData, existingByPath)
      })
    )
    for (let j = 0; j < results.length; j++) {
      const track = results[j]
      const stat = stats[j]
      if (!track || !stat) continue
      tracks.push(track)
      // 立即通知 UI 追加显示（渐进式刷新），不等全部扫描完
      if (onTrack) onTrack(track)
      // 只有新解析的（不在已有记录里、或大小变化重新解析的）才需要写库
      const existing = existingByPath.get(batch[j])
      if (!existing || existing.fileSize !== stat.size) {
        toInsert.push(track)
      }
    }
  }

  // 批量事务插入，替代逐条 INSERT
  if (toInsert.length > 0) {
    insertTracks(toInsert)
  }

  return tracks
}

/**
 * 按需补齐封面：扫描阶段为提速跳过了嵌入图片读取，
 * 当 UI 需要某曲目的封面而记录中无 coverPath 时，单独提取并缓存。
 */
export async function ensureCover(track: Track, userData: string): Promise<string | null> {
  if (track.coverPath) return track.coverPath
  try {
    const metadata = await parseFile(track.path, { duration: false })
    const pic = metadata.common.picture?.[0]
    if (!pic) return null
    const data = pic.data instanceof Uint8Array ? pic.data : new Uint8Array(pic.data)
    const coverDest = getCoverCachePath(userData, track.id, coverExtensionFor(data, pic.format))
    await fs.promises.writeFile(coverDest, data)
    updateTrack(track.id, { coverPath: coverDest })
    return coverDest
  } catch (err) {
    // 抛错而非返回 null：渲染层只对"确认无内嵌封面"缓存结果，
    // 失败（文件暂不可读/解析异常）不缓存，会退避重试
    console.warn('封面提取失败:', track.path, err)
    throw err
  }
}

/** 归一化标题/艺术家用于宽松匹配（繁→简、去大小写、空白与常见标点） */
function normalizeForMatch(s?: string): string {
  return tradToSimp((s || '').toLowerCase()).replace(/[\s\-_·,，.。!！?？'"""''（）()【】\[\]@、]/g, '')
}

/**
 * 华语歌名高频繁→简映射：老标签多为繁体（反方向的鐘/刀馬旦/愛在西元前），
 * 而在线歌源以简体索引，不做转换会导致标题匹配失败。覆盖高频字而非全表。
 */
const TRAD_TO_SIMP_MAP: Record<string, string> = Object.fromEntries(
  Object.entries({
    愛: '爱', 馬: '马', 鐘: '钟', 鍾: '钟', 門: '门', 們: '们', 倫: '伦', 傑: '杰', 說: '说', 話: '话',
    語: '语', 請: '请', 謝: '谢', 詩: '诗', 詞: '词', 記: '记', 憶: '忆', 該: '该', 讓: '让', 見: '见',
    親: '亲', 寶: '宝', 貝: '贝', 兒: '儿', 學: '学', 長: '长', 遠: '远', 這: '这', 還: '还', 過: '过',
    時: '时', 後: '后', 點: '点', 開: '开', 關: '关', 問: '问', 間: '间', 雲: '云', 風: '风', 飛: '飞',
    鳥: '鸟', 魚: '鱼', 龍: '龙', 葉: '叶', 樹: '树', 線: '线', 綫: '线', 紅: '红', 綠: '绿', 藍: '蓝',
    黃: '黄', 雙: '双', 單: '单', 獨: '独', 對: '对', 錯: '错', 選: '选', 擇: '择', 決: '决', 約: '约',
    會: '会', 讀: '读', 寫: '写', 書: '书', 畫: '画', 戀: '恋', 煙: '烟', 車: '车', 橋: '桥', 樓: '楼',
    國: '国', 華: '华', 萬: '万', 歲: '岁', 歷: '历', 麗: '丽', 陽: '阳', 陰: '阴', 圓: '圆', 滿: '满',
    燈: '灯', 聲: '声', 聽: '听', 樂: '乐', 夢: '梦', 靈: '灵', 淚: '泪', 傷: '伤', 無: '无', 與: '与',
    為: '为', 於: '于', 麼: '么', 體: '体', 臉: '脸', 頭: '头', 髮: '发', 發: '发', 難: '难', 離: '离',
    別: '别', 剛: '刚', 劉: '刘', 陳: '陈', 張: '张', 孫: '孙', 楊: '杨', 吳: '吴', 趙: '赵', 鄭: '郑',
    蘇: '苏', 鄧: '邓', 蕭: '萧', 羅: '罗', 蘭: '兰', 韓: '韩', 許: '许', 幾: '几', 處: '处', 願: '愿',
    靜: '静', 顏: '颜', 須: '须', 裏: '里', 裡: '里', 麵: '面', 錶: '表', 錄: '录', 鋼: '钢', 鐵: '铁',
    銀: '银', 鏡: '镜', 閃: '闪', 電: '电', 韻: '韵', 飄: '飘', 飯: '饭', 館: '馆', 驕: '骄', 騎: '骑',
    鳳: '凤', 鴿: '鸽', 嘗: '尝', 夠: '够', 屆: '届', 島: '岛', 嶺: '岭', 帥: '帅', 廣: '广', 場: '场',
    塊: '块', 壞: '坏', 壓: '压', 奪: '夺', 奮: '奋', 媽: '妈', 寧: '宁', 將: '将', 專: '专', 屬: '属',
    帶: '带', 幫: '帮', 庫: '库', 彈: '弹', 強: '强', 復: '复', 懷: '怀', 戰: '战', 戲: '戏', 擁: '拥',
    據: '据', 斷: '断', 曉: '晓', 東: '东', 條: '条', 來: '来', 楓: '枫', 標: '标', 機: '机', 歡: '欢',
    殺: '杀', 毀: '毁', 沒: '没', 涼: '凉', 淺: '浅', 溫: '温', 滄: '沧', 滅: '灭', 漢: '汉', 潛: '潜',
    濃: '浓', 濕: '湿', 燒: '烧', 熱: '热', 爺: '爷', 牽: '牵', 獻: '献', 環: '环', 產: '产', 異: '异',
    瘋: '疯', 療: '疗', 盜: '盗', 盡: '尽', 確: '确', 禮: '礼', 稱: '称', 窮: '穷', 競: '竞', 筆: '笔',
    節: '节', 簡: '简', 籠: '笼', 粵: '粤', 終: '终', 給: '给', 經: '经', 緊: '紧', 總: '总', 繼: '继',
    續: '续', 聖: '圣', 聞: '闻', 聰: '聪', 腸: '肠', 臺: '台', 舊: '旧', 艷: '艳', 藝: '艺', 號: '号',
    雖: '虽', 蝸: '蜗', 蟻: '蚁', 衝: '冲', 裝: '装', 複: '复', 覺: '觉', 觸: '触', 訂: '订', 評: '评',
    譯: '译', 護: '护', 變: '变', 費: '费', 賴: '赖', 趕: '赶', 跡: '迹', 蹤: '踪', 輕: '轻', 輝: '辉',
    輸: '输', 轉: '转', 轟: '轰', 迴: '回', 連: '连', 進: '进', 遊: '游', 運: '运', 達: '达', 遙: '遥',
    適: '适', 遷: '迁', 遺: '遗', 鄰: '邻', 醫: '医', 釋: '释', 鈴: '铃', 錦: '锦', 鍵: '键', 鑽: '钻',
    閉: '闭', 陣: '阵', 類: '类', 餘: '余', 騰: '腾', 驚: '惊', 髒: '脏', 鬥: '斗', 魯: '鲁', 鴨: '鸭',
    鴻: '鸿', 麥: '麦', 齊: '齐', 齒: '齿', 龜: '龟', 妳: '你', 洩: '泄', 掛: '挂', 芃: '芃',
  })
)

function tradToSimp(s: string): string {
  return s.replace(/[\u4e00-\u9fff]/g, (ch) => TRAD_TO_SIMP_MAP[ch] ?? ch)
}

/**
 * 清洗标题用于搜索与匹配：剔除打标工具追加的演唱者后缀。
 * - 全角「－后缀」基本是演唱者尾巴（反方向的鐘－周杰倫），直接剔除；
 * - 半角「- 后缀」仅当像艺术家名时剔除（与艺术家一致、或为 2-6 个汉字），
 *   避免误伤 "歌名 - Live" 这类正常标题。
 */
function cleanTitleForQuery(title: string, artist?: string): string {
  let t = title.trim()
  t = t.replace(/－[^－]{1,30}$/, '').trim()
  const m = t.match(/^(.+?)\s*-\s*([^-]{1,30})$/)
  if (m) {
    const stem = m[1].trim()
    const suffix = m[2].trim()
    const a = normalizeForMatch(artist)
    const s = normalizeForMatch(suffix)
    const artistPlaceholder = !a || META_PLACEHOLDERS.has(artist || '')
    const looksLikeArtist =
      (!artistPlaceholder && s && (a.includes(s) || s.includes(a))) ||
      (/^[\u4e00-\u9fff]{2,6}$/.test(suffix) && stem.length >= 2)
    if (looksLikeArtist) t = stem
  }
  return t || title.trim()
}

/** 取第一艺术家：多人合唱标签（周杰倫、方文山）整个塞进查询词会干扰搜索 */
function firstArtistOf(artist: string): string {
  return artist.split(/[、,，/&]| feat\.? | ft\.? /i)[0].trim()
}

/**
 * 在线封面候选挑选：标题必须匹配（归一化后相等或互相包含），
 * 艺术家匹配 +1、时长差 ≤3s +2，取总分最高且带封面 URL 者。
 * 标题不匹配的一律排除，宁可无图也不贴错封面。
 */
function pickOnlineCoverCandidate(
  candidates: OnlineTrackSearchResult[],
  track: Track
): OnlineTrackSearchResult | null {
  // 本地标题先做演唱者后缀剔除 + 繁简归一（老标签：反方向的鐘－周杰倫 → 反方向的钟）
  const wantTitle = normalizeForMatch(cleanTitleForQuery(track.title, track.artist))
  const wantArtist = normalizeForMatch(track.artist)
  let best: OnlineTrackSearchResult | null = null
  let bestScore = 0
  for (const c of candidates) {
    if (!c.coverUrl || !/^https?:\/\//i.test(c.coverUrl)) continue
    // 候选标题同样剔除后缀再归一（歌源条目也常带 "- 歌手" 尾巴）
    const ct = normalizeForMatch(cleanTitleForQuery(c.title, c.artist))
    if (!wantTitle || !ct) continue
    if (ct !== wantTitle && !ct.includes(wantTitle) && !wantTitle.includes(ct)) continue
    let score = 2
    const ca = normalizeForMatch(c.artist)
    if (wantArtist && ca && (ca === wantArtist || ca.includes(wantArtist) || wantArtist.includes(ca))) score += 1
    if (track.duration > 0 && c.duration > 0 && Math.abs(c.duration - track.duration) <= 3) score += 2
    if (score > bestScore) {
      best = c
      bestScore = score
    }
  }
  return best
}

/** 扫描/标签里的占位值，搜索时剔除避免污染关键词 */
const META_PLACEHOLDERS = new Set(['未知艺术家', '未知专辑', '未知歌曲'])

/**
 * 在线补齐封面：文件无内嵌封面时的兜底。
 * 用「艺术家 + 标题」搜索用户配置的在线歌源，取标题匹配（艺术家/时长加分）
 * 的候选封面下载并落盘缓存。无匹配返回 null；网络/下载失败抛错
 * （渲染层按"失败可重试"处理，不会当作无封面缓存）。
 */
export async function fetchOnlineCover(
  track: Track,
  userData: string,
  options?: OnlineSearchOptions
): Promise<string | null> {
  if (track.coverPath) return track.coverPath
  const rawArtist = META_PLACEHOLDERS.has(track.artist) ? '' : track.artist
  const rawTitle = META_PLACEHOLDERS.has(track.title) ? '' : track.title
  // 查询词清洗：第一艺术家 + 去演唱者后缀的标题，并统一转简体（歌源多以简体索引）
  const artist = firstArtistOf(rawArtist)
  const title = cleanTitleForQuery(rawTitle, rawArtist)
  const query = tradToSimp(`${artist} ${title}`).trim()
  if (!query) return null

  const candidates = await searchOnlineTracks(query, options)
  const best = pickOnlineCoverCandidate(candidates, track)
  if (!best?.coverUrl) return null

  const resp = await fetchWithTimeout(
    best.coverUrl,
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    },
    15000
  )
  if (!resp.ok) throw new Error(`封面下载失败：HTTP ${resp.status}`)
  const buf = new Uint8Array(await resp.arrayBuffer())
  if (buf.length < 100) throw new Error('封面下载失败：内容不是有效图片')

  const coverDest = getCoverCachePath(userData, track.id, coverExtensionFor(buf))
  await fs.promises.writeFile(coverDest, buf)
  updateTrack(track.id, { coverPath: coverDest })
  return coverDest
}
