import type { OnlineTrackSearchResult } from './types'

/**
 * 在线封面候选挑选（纯函数，双端共用，可单测）。
 *
 * 只凭标题相似度挑封面会贴错图：歌源里同名结果大量是翻唱、live、remix 与
 * 蹭名条目（实测「杀死那个石家庄人」检索里带封面的前两条，标题写着
 * 「万能青年旅店《杀死那个石家庄人》」而歌手字段是「醉美谋女郎」），
 * 封面一旦落盘就被当成正式封面，比没有封面更糟。因此：
 *   1. 标题必须匹配——变体（主标题 / 括号内标题 / 去书名号标题）**相等**，
 *      或互为包含且时长接近（包含关系太弱，「那个石家庄人」也包含于
 *      「杀死那个石家庄人」，只用时长把它挡掉）；
 *   2. 本地歌手已知时，候选歌手必须能对上（归一化相等/互相包含/歌手串
 *      任一片段命中），对不上直接排除——这是拦住蹭名条目与翻唱的主力；
 *   3. 排除带版本标记（live / remix / 伴奏 / 翻唱 / 巡演…）的候选，
 *      它们的封面几乎都不是原专辑封面；
 *   4. 剩下按「歌手 +2 / 时长差 ≤3s +2 / ≤10s +1」打分，且只在
 *      「时长几乎一致」的那一档里取最优，封面对齐原版录音。
 * 全部不合格返回 null，由调用方回落到「无在线封面」。
 */

/** 搜索/标签占位值，参与匹配时视为「歌手未知」 */
const PLACEHOLDER_ARTISTS = new Set(['未知艺术家', '未知专辑', '未知歌曲', '合辑', '群星'])

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

/** 繁→简（仅映射表内高频字，其余原样保留） */
export function tradToSimp(s: string): string {
  return (s || '').replace(/[\u4e00-\u9fff]/g, (ch) => TRAD_TO_SIMP_MAP[ch] ?? ch)
}

/** 归一化标题/艺术家用于宽松匹配（繁→简、去大小写、空白与常见标点） */
export function normalizeForMatch(s?: string): string {
  return tradToSimp((s || '').toLowerCase()).replace(/[\s\-_·,，.。!！?？'"""''（）()【】\[\]@、]/g, '')
}

/**
 * 版本标记：这些词一出现就说明候选大概率不是原版条目，其封面多半不是原专辑
 * 封面。不把裸「版」与四位年份写进来——「2002年的第一场雪」这类歌名会被误伤。
 */
const VERSION_MARKER_RE =
  /(live|演唱会|音乐会|音乐节|巡演|现场|remix|bootleg|acoustic|unplugged|instrumental|karaoke|demo|伴奏|伴唱|纯音乐|器乐|演奏|翻唱|cover|翻版|女声|男声|童声|烟嗓|加速|减速|升调|降调|变调|清唱|口琴|合唱|对唱|串烧|联唱|重制版|混音版|改编版|dj版|dj)/i

/** 标题是否带版本标记；书名号同理——「歌手《歌名》」是搬运条目而非原版 */
export function hasVersionMarker(title: string): boolean {
  const raw = tradToSimp((title || '').toLowerCase())
  if (!raw) return false
  return VERSION_MARKER_RE.test(raw) || /[《》]/.test(raw)
}

/** 专辑名是否带版本标记（书名号不进这里：正常专辑名不会被书名号包起来） */
export function hasVersionMarkerStrict(album: string): boolean {
  const raw = tradToSimp((album || '').toLowerCase())
  return !!raw && VERSION_MARKER_RE.test(raw)
}

/**
 * 本地曲目的标题/专辑是否带版本标记（Live / Remix / DJ版 / 精选辑…）。
 *
 * 判据不是「带标记就排除」，而是**与候选的标记状态对齐**（见 pickCoverCandidate）：
 * 本地收藏了 Live，就必须匹配到同样标了 Live 的候选，两边都是 Live 才算同一版；
 * 一边有一边没有，说明是原版与版本之间的错配，封面张冠李戴，宁可不出图。
 *
 * 为什么要对齐而不是直接以歌手 + 时长过滤：本地「Shape of You」原版与
 * 「Shape of You (Remix)」在歌源里恰好同长，仅凭歌手与时长分不开；
 * 反过来本地真的是某个版本时（「输了你赢了世界又如何 (Live)」），
 * 同标记、同歌手、同长的候选就是同一录音，应当出图。
 */
export function targetHasVersionMarker(target: CoverMatchTarget): boolean {
  return hasVersionMarker(target.title) || hasVersionMarkerStrict(target.album || '')
}

/**
 * 候选是否可判定为「非原版条目」：标题或专辑带版本标记。
 * 「标题写成『万能青年旅店-杀死那个石家庄人 (中流砥同志 bootleg)』」这类搬运
 * 条目靠这个识别，其封面不是原专辑封面。
 *
 * 只看标题与专辑，不查歌手字段：合法歌手名里带 dj / cover 的很多
 * （DJ Snake、DJ Okawari、The Cover Band），按歌手排除会误伤整类曲目。
 */
export function isNonOriginalCandidate(c: {
  title?: string
  album?: string
  artist?: string
}): boolean {
  return hasVersionMarker(c.title || '') || hasVersionMarkerStrict(c.album || '')
}

/** 取第一艺术家：多人合唱标签（周杰倫、方文山）整个拿去比对会干扰判断 */
export function firstArtistOf(artist: string): string {
  return (artist || '').split(/[、,，/&;；]|\s*feat\.?\s*|\s*ft\.?\s*/i)[0].trim()
}

/** 艺术家串的全部片段（归一化去重），用于逐段比对 */
function artistSegments(raw: string): string[] {
  const out: string[] = []
  for (const part of (raw || '').split(/[、,，/&;；]|\s*feat\.?\s*|\s*ft\.?\s*/i)) {
    const n = normalizeForMatch(part)
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

/** 本地歌手是否可判定；占位值或空值视为未知，未知时不设歌手门禁 */
export function hasKnownArtist(artist?: string): boolean {
  const raw = (artist || '').trim()
  if (!raw || PLACEHOLDER_ARTISTS.has(raw)) return false
  return !!normalizeForMatch(firstArtistOf(raw))
}

/**
 * 清洗标题用于搜索与匹配：剔除打标工具追加的演唱者后缀。
 * - 全角「－后缀」基本是演唱者尾巴（反方向的鐘－周杰倫），直接剔除；
 * - 半角「- 后缀」仅当像艺术家名时剔除（与艺术家一致、或为 2-6 个汉字），
 *   避免误伤 "歌名 - Live" 这类正常标题。
 */
export function cleanTitleForQuery(title: string, artist?: string): string {
  let t = (title || '').trim()
  t = t.replace(/－[^－]{1,30}$/, '').trim()
  const m = t.match(/^(.+?)\s*-\s*([^-]{1,30})$/)
  if (m) {
    const stem = m[1].trim()
    const suffix = m[2].trim()
    const a = normalizeForMatch(artist)
    const s = normalizeForMatch(suffix)
    const artistPlaceholder = !a || PLACEHOLDER_ARTISTS.has(artist || '')
    const looksLikeArtist =
      (!artistPlaceholder && s && (a.includes(s) || s.includes(a))) ||
      (/^[\u4e00-\u9fff]{2,6}$/.test(suffix) && stem.length >= 2)
    if (looksLikeArtist) t = stem
  }
  return t || (title || '').trim()
}

/** 剔除标题里的括号补充（中文全角、英文半角、书名号、方头括号） */
function stripBracketed(title: string): string {
  return (title || '')
    .replace(/[（(][^（()）]*[)）]/g, ' ')
    .replace(/[《【][^《》【】]*[》】]/g, ' ')
    .trim()
}

/**
 * 标题变体：主标题、去书名号版本、括号内标题、去括号裸标题。
 *
 * - 歌源里大量条目标题被写成「歌手 (歌名)」「歌手《歌名》」，括号内变体覆盖这类；
 * - 括号补充也可能是**非版本**的发行标注（「不怪她 (Blame) (Explicit)」），
 *   裸标题变体让它们仍能与本地标题对齐，是否同一录音交给版本标记与时长判定。
 *
 * 括号内是版本词（Live / Remix…）时不取作变体：那样任意两首 Live 都会互相匹配，
 * 正确性反过来依赖版本标记对齐，徒增误判面。
 */
export function titleVariants(title: string, artist?: string): string[] {
  const out: string[] = []
  const push = (v: string) => {
    if (v && !out.includes(v)) out.push(v)
  }
  push(normalizeForMatch(cleanTitleForQuery(title, artist)))
  if (/[《》【】]/.test(title || '')) {
    push(normalizeForMatch(cleanTitleForQuery(title.replace(/[《》【】]/g, ' '), artist)))
  }
  const inner = /[（(《【]([^（()）《》【】]{1,40})[)）】》]/.exec(title || '')
  if (inner && !VERSION_MARKER_RE.test(tradToSimp(inner[1].toLowerCase()))) {
    push(normalizeForMatch(cleanTitleForQuery(inner[1], artist)))
  }
  const bare = stripBracketed(title)
  if (bare && bare !== title) push(normalizeForMatch(cleanTitleForQuery(bare, artist)))
  return out
}

/**
 * 标题是否匹配：任一变体**完全相等**才放行，不做包含判断。
 *
 * 包含关系在这里是危险证据：「龙卷风」包含于「龙卷风 live」、「那个石家庄人」
 * 包含于「杀死那个石家庄人」，一旦放行就会把版本词被剥离后的 Live 候选
 * 当成同一首。歌源条目里真正需要的宽松只在「歌手 (歌名)」「歌手《歌名》」
 * 这类搬运标题上，已由 titleVariants 的括号变体覆盖。
 */
export function titleMatches(want: string[], cand: string[]): boolean {
  for (const w of want) {
    if (!w) continue
    for (const c of cand) {
      if (c && c === w) return true
    }
  }
  return false
}

/**
 * 歌手是否对得上；本地歌手未知时放行（不因缺元数据就拒绝所有候选）。
 * 命中条件：归一化相等 / 互相包含 / 候选歌手串里任一片段命中。
 */
export function artistMatches(wantArtistRaw: string, candArtistRaw: string): boolean {
  const want = normalizeForMatch(firstArtistOf(wantArtistRaw))
  // 空值或占位歌手视为「未知」：一律放行，是否加分交给调用方的 hasKnownArtist 判断
  if (!want || PLACEHOLDER_ARTISTS.has((wantArtistRaw || '').trim())) return true
  const c = normalizeForMatch(candArtistRaw)
  if (c && (c === want || c.includes(want) || want.includes(c))) return true
  for (const seg of artistSegments(candArtistRaw)) {
    if (seg === want || seg.includes(want) || want.includes(seg)) return true
  }
  return false
}

/** 候选封面地址是否可用（必须是 http(s) 直链） */
function hasCoverUrl(c: OnlineTrackSearchResult): boolean {
  return !!c?.coverUrl && /^https?:\/\//i.test(c.coverUrl!)
}

/** 匹配目标：本地曲目的封面相关字段 */
export interface CoverMatchTarget {
  title: string
  artist: string
  duration: number
  /** 专辑（可选）：参与版本标记判定，用于识别本地条目本身是某版本的现场/精选辑 */
  album?: string
}

/** 包含关系（弱证据）成立所需的时长接近度：秒 */
const LOOSE_TITLE_MAX_DURATION_DIFF = 10
/** 「几乎同一录音」的时长容差：秒 */
const SAME_RECORDING_TOLERANCE = 3
/**
 * 本地时长与候选时长的最大容差：秒。
 * 超过这个差距就是**另一个录音**（电台剪辑、Live 抽段、串烧），封面不该借用。
 */
const MAX_DURATION_DIFF = 20

/**
 * 版本标记状态是否一致：一致（都是原版 / 都是版本）放行，不一致一律排除。
 *
 * 为什么不做「本地原版 + 候选 Live」的例外：实测本地原版曲目在歌源里几乎
 * 都能搜到对应的原版条目（江南 267s、退后 261s、龙卷风 250s、爱错 238s，
 * 歌手与时长都对得上），而「原版配 Live」只会让演唱会封面顶替录音室封面
 * （黑色幽默 283s 对 Live 291s、怎么说我不爱你 275s 对 Live 277s）。
 * 本地真的是版本条目时（输了你赢了世界又如何 (Live)），同标记的候选照样放行。
 */
function versionMarkerAligned(cand: { title?: string; album?: string }, target: CoverMatchTarget): boolean {
  return isNonOriginalCandidate(cand) === targetHasVersionMarker(target)
}

/**
 * 严格挑选封面候选，不合格返回 null（宁可无图也不贴错图）。
 *
 * 排除顺序：无封面地址 / 标题变体不相等 / 时长差过大（另一个录音）/
 * 歌手对不上 / 版本标记状态不一致；剩下按「歌手 +3、时长差 ≤3s +2、
 * ≤10s +1」打分，且只在「时长几乎一致」的那一档里取最优。
 *
 * 任一字段带版本标记时还要比对**完整标题**（含括号里的版本词）：本地
 * 「Plain Jane (Remix)」配候选「Plain Jane (Live)」两边都是版本、歌手也同，
 * 只有完整标题能识别出这不是同一版录音。
 */
export function pickCoverCandidate(
  candidates: OnlineTrackSearchResult[],
  target: CoverMatchTarget
): OnlineTrackSearchResult | null {
  const wantTitle = titleVariants(target.title, target.artist)
  if (!wantTitle.some(Boolean)) return null
  const wantTitleWithMarker = normalizeForMatch(cleanTitleForQuery(target.title, target.artist))
  const knownArtist = hasKnownArtist(target.artist)
  const targetIsVersion = targetHasVersionMarker(target)

  const scored: Array<{ c: OnlineTrackSearchResult; score: number }> = []
  for (const c of candidates || []) {
    if (!hasCoverUrl(c)) continue
    if (!titleMatches(wantTitle, titleVariants(c.title, c.artist))) continue
    // 时长差过大 = 另一个录音：即便标题与歌手都对也不借用其封面
    const bothDuration = target.duration > 0 && c.duration > 0
    const diff = bothDuration ? Math.abs(c.duration - target.duration) : 0
    if (bothDuration && diff > MAX_DURATION_DIFF) continue
    if (knownArtist && !artistMatches(target.artist, c.artist)) continue
    if (!versionMarkerAligned(c, target)) continue
    if ((targetIsVersion || isNonOriginalCandidate(c)) && wantTitleWithMarker) {
      // 完整标题用「归一化后相等」，同样不做包含判断：
      // 「龙卷风live」不会等于「龙卷风」
      if (normalizeForMatch(cleanTitleForQuery(c.title, c.artist)) !== wantTitleWithMarker) continue
    }
    let score = 1
    if (knownArtist && artistMatches(target.artist, c.artist)) score += 3
    if (bothDuration && diff <= SAME_RECORDING_TOLERANCE) score += 2
    else if (bothDuration && diff <= LOOSE_TITLE_MAX_DURATION_DIFF) score += 1
    scored.push({ c, score })
  }
  if (scored.length === 0) return null

  const exact = scored.filter(
    (s) =>
      target.duration > 0 &&
      s.c.duration > 0 &&
      Math.abs(s.c.duration - target.duration) <= SAME_RECORDING_TOLERANCE
  )
  const pool = exact.length > 0 ? exact : scored

  let best: OnlineTrackSearchResult | null = null
  let bestScore = -1
  for (const s of pool) {
    if (s.score > bestScore) {
      best = s.c
      bestScore = s.score
    }
  }
  return best
}