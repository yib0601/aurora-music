/**
 * 加密音频**识别**（只认，不解）。
 *
 * 背景：QQ 音乐等平台把「下载到本机」的歌加密落盘，文件名带平台标记与双重扩展名
 * （`陈奕迅 - 十年 [mqms2].mflac0.flac`）。这类文件的扩展名是合法的 `.flac`，
 * 内容却不是 FLAC 容器 —— 扫描时 music-metadata / music-metadata-browser 解析必失败，
 * 旧行为是 `return null` 静默丢弃，用户只看到「扫了但一首都没进来」，无从判断原因。
 *
 * 本模块只做两件事：**认出这是平台的加密文件**，以及**从文件名还原歌手/歌名**，
 * 供上层发起「按名重新下载一份明文副本」。
 *
 * 刻意**不含任何解密逻辑**：本项目公开分发，携带平台密钥的解锁实现会在分发环节出问题
 * （QQ 音乐曾对 unlock-music 及其整条 fork 网络提交 DMCA，497 个仓库被处理）；
 * 而按名重下走的是用户自己配置的音源，与手动搜索下载完全同一条路径。
 */

/** 加密文件的来源平台 */
export type EncryptedAudioFamily = 'qqmusic' | 'netease' | 'kugou' | 'kuwo' | 'xiami'

/**
 * 一个被识别出来的加密音频文件。
 *
 * 字段全部是「识别结果」而非「解密结果」：`token` 只用于诊断与展示，
 * `title`/`artist` 只用于拼搜索词，允许为空（文件名里没有 `歌手 - 歌名` 结构时）。
 */
export interface EncryptedAudioFile {
  /** 绝对路径（桌面端）或存储内路径（移动端） */
  path: string
  /** 文件大小（字节）；调用方拿不到 stat 时省略 */
  size?: number
  family: EncryptedAudioFamily
  /** 命中的加密标记段（`mflac0` / `mgg2` / `qmcflac` / `mqms` …），仅供诊断 */
  token: string
  /** 从文件名还原的歌名；还原不出为空串 */
  title: string
  /** 从文件名还原的歌手；还原不出为空串 */
  artist: string
}

/**
 * 音频容器扩展名。QQ 音乐会在加密扩展名之后再追加一个「看得懂」的容器后缀，
 * 于是同一个文件既有 `.mflac0` 又有 `.flac` —— 剥名字时必须两级都跳过。
 */
const AUDIO_EXT_SEGMENTS = new Set([
  'mp3', 'flac', 'ogg', 'oga', 'wav', 'm4a', 'm4b', 'aac', 'opus', 'wma', 'mp4', 'aiff', 'aif', 'ape', 'wv',
])

/** 加密标记段 → 平台。键一律小写，匹配前会先 lowercase 文件名 */
const TOKEN_FAMILY = new Map<string, EncryptedAudioFamily>()

function registerTokens(family: EncryptedAudioFamily, tokens: readonly string[]): void {
  for (const token of tokens) TOKEN_FAMILY.set(token, family)
}

// QQ 音乐：老 QMC 系列（qmc*）+ 新格式（mflac/mgg/mmp4）+ 海外版 JOOX（ofl_en）。
// 新格式的序号后缀不是固定值：平台每换一次加密方案就加一档，所以按 0~9 全展开，
// 而不是只列当前已知的那一个（漏一档就表现为「这一批文件认不出来」）。
const QQ_MUSIC_TOKENS: string[] = [
  'qmc0', 'qmc2', 'qmc3', 'qmc4', 'qmcflac', 'qmcogg', 'tkm', 'ofl_en', 'mflac', 'mgg', 'mggl', 'mmp4',
]
for (let i = 0; i <= 9; i++) {
  QQ_MUSIC_TOKENS.push(`mflac${i}`, `mgg${i}`)
}
registerTokens('qqmusic', QQ_MUSIC_TOKENS)
registerTokens('netease', ['ncm'])
registerTokens('kugou', ['kgm', 'kgma', 'vpr'])
registerTokens('kuwo', ['kwm'])
registerTokens('xiami', ['xm'])

/** 取 basename：两端都有可能是 `/` 或 `\` 分隔，不能只认 `path.sep`（渲染层没有 node:path） */
function baseNameOf(fileName: string): string {
  const cut = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'))
  return cut >= 0 ? fileName.slice(cut + 1) : fileName
}

/**
 * 按文件名判断是不是平台的加密音频。
 *
 * 判据是**文件名标记**而不是文件头：加密文件的头部是密文，嗅探不出容器类型，
 * 反过来「嗅探失败」又会把损坏文件、冷门编码一并算进来（误报）。文件名标记是
 * 平台自己写上去的，准确且零 IO。
 */
export function detectEncryptedAudioName(
  fileName: string
): { family: EncryptedAudioFamily; token: string } | null {
  const base = baseNameOf(fileName).toLowerCase()
  if (!base) return null
  const segments = base.split('.').filter(Boolean)

  // 从后往前跳过容器后缀（最多两级），第一个非容器段就是可疑的加密标记段
  let idx = segments.length - 1
  let skipped = 0
  while (idx >= 0 && skipped < 2 && (AUDIO_EXT_SEGMENTS.has(segments[idx]) || segments[idx] === '')) {
    idx--
    skipped++
  }
  if (idx >= 0) {
    const token = segments[idx]
    const family = TOKEN_FAMILY.get(token)
    if (family) return { family, token }
  }

  // 退一步认平台标记：QQ 音乐下载的文件名里恒带 `[mqms]` / `[mqms2]`。
  // 覆盖「加密扩展名被工具改掉、只剩平台标记」的形态（用户手动重命名很常见）。
  const tag = base.match(/\[(mqms\d*)\]/i)
  if (tag) return { family: 'qqmusic', token: tag[1] }

  return null
}

/** 是否平台的加密音频（供扫描器在解析失败处快速判定） */
export function isEncryptedAudioName(fileName: string): boolean {
  return detectEncryptedAudioName(fileName) !== null
}

/**
 * 把文件名还原成「歌名 + 歌手」。
 *
 * 处理链：去掉加密标记段与追加的容器后缀 → 去掉 `[...]` 平台标签 →
 * 按 `歌手 - 歌名` 拆分（与扫描器无标签时的文件名惯例完全一致，
 * 见 desktop/ipc/scanner.ts 的 artist 兜底逻辑）。
 *
 * 返回 null 表示不是加密文件。`title`/`artist` 可能为空串（文件名没有可拆的结构），
 * 调用方据此判断「这条没法按名重下」。
 */
export function parseEncryptedAudioName(fileName: string): {
  family: EncryptedAudioFamily
  token: string
  title: string
  artist: string
} | null {
  const detected = detectEncryptedAudioName(fileName)
  if (!detected) return null

  const base = baseNameOf(fileName)
  const segments = base.split('.')
  // 从第一个「加密标记 / 容器后缀」段开始截断，前面的部分才是内容名。
  // 用 join('.') 还原而不是硬切字符串：歌名里本来就可能有句点（`Mr.Children - 花`）。
  let cutAt = segments.length
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i].toLowerCase()
    if (TOKEN_FAMILY.has(seg) || AUDIO_EXT_SEGMENTS.has(seg)) {
      cutAt = i
      break
    }
  }
  let stem = segments.slice(0, cutAt).join('.')
  // 平台标签：`[mqms2]` / `[mqms]`，以及个别平台的 `【…】`
  stem = stem.replace(/\[[^\]]{0,20}\]/g, ' ').replace(/【[^】]{0,20}】/g, ' ')
  stem = stem.replace(/\s+/g, ' ').trim()

  const match = stem.match(/^(.{1,50}?)\s*-\s*(.{1,100})$/)
  const artist = match ? match[1].trim() : ''
  const title = (match ? match[2] : stem).trim()
  return { family: detected.family, token: detected.token, title, artist }
}

/**
 * 拼「按名重下」用的搜索词。
 *
 * 只拼得出歌手与歌名，不做任何跨平台改写（繁简、别名、版本后缀一律原样带进去）：
 * 改写规则一旦猜错，搜到的是另一首歌，而用户看到的是「下载成功」——
 * 那比「未匹配」糟得多。搜不到就如实报未匹配，让用户自己去搜。
 */
export function encryptedAudioSearchQuery(hit: Pick<EncryptedAudioFile, 'title' | 'artist'>): string {
  return [hit.artist, hit.title].map((s) => s.trim()).filter(Boolean).join(' ')
}
