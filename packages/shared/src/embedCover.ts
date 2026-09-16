/**
 * 音频文件封面嵌入工具（桌面端主进程与移动端 WebView 共用，纯 Uint8Array 实现，无平台依赖）
 *
 * 背景：在线歌源直链的音频文件大多不带内嵌封面（实测酷源 MP3 仅有标题/艺术家/专辑文本标签），
 * 下载入库后无封面可提取。下载完成时把搜索结果里的 coverUrl 封面嵌入文件：
 * - MP3：重建 ID3v2.3 标签（TIT2/TPE1/TALB + APIC 封面），应用 unsynchronisation
 * - FLAC：解析元数据块链，替换/追加 METADATA_BLOCK_PICTURE（type 6）
 * - M4A/MP4：替换/追加 moov→udta→meta→ilst 的 covr atom，并在 moov 位于 mdat 之前时
 *   同步修正 stco/co64 chunk 绝对偏移（moov 尺寸变化会使 mdat 整体后移）
 *
 * 安全原则：任何解析异常都返回 null，调用方保留原始文件，绝不让嵌入失败损坏音频。
 */

export interface EmbedMeta {
  title?: string
  artist?: string
  album?: string
}

export interface EmbedCover {
  data: Uint8Array
  /** image/jpeg | image/png */
  mime: string
}

/** 按魔数识别图片 MIME（PNG 头 89 50 4E 47），默认 jpeg */
export function detectImageMime(data: Uint8Array): string {
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return 'image/png'
  }
  return 'image/jpeg'
}

// ---------- 基础字节操作 ----------

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f
  return out
}

function be32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

function be24(n: number): Uint8Array {
  return new Uint8Array([(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

/** ID3 syncsafe 整数（每字节 7 位） */
function syncsafe(n: number): Uint8Array {
  return new Uint8Array([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f])
}

function readSyncsafe(d: Uint8Array, off: number): number {
  return ((d[off] & 0x7f) << 21) | ((d[off + 1] & 0x7f) << 14) | ((d[off + 2] & 0x7f) << 7) | (d[off + 3] & 0x7f)
}

// ---------- MP3：ID3v2.3 标签 ----------

/** ID3v2.3 文本帧内容：编码 0x01（UTF-16 with BOM）+ UTF-16LE 字节 */
function textFramePayload(text: string): Uint8Array {
  const body = new Uint8Array(2 + text.length * 2)
  body[0] = 0xff // BOM（LE）
  body[1] = 0xfe
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i) // 代理对原样写入即为合法 UTF-16
    body[2 + i * 2] = code & 0xff
    body[3 + i * 2] = (code >>> 8) & 0xff
  }
  return concat(new Uint8Array([0x01]), body)
}

function frame(id: string, payload: Uint8Array): Uint8Array {
  return concat(ascii(id), be32(payload.length), new Uint8Array([0, 0]), payload)
}

/** APIC 帧内容：Latin-1 MIME + 0x00 + 图片类型 0x03（封面）+ 空描述 0x00 + 图片数据 */
function apicFramePayload(cover: EmbedCover): Uint8Array {
  return concat(
    new Uint8Array([0x00]),
    ascii(cover.mime),
    new Uint8Array([0x00, 0x03, 0x00]),
    cover.data
  )
}

/**
 * 为 MP3 重建 ID3v2.3 标签：剥离原有 ID3v2 头，写入文本帧 + 封面帧。
 * 下载文件的原始标签仅有标题/艺术家/专辑（与搜索结果一致），重建不会丢失有效信息。
 *
 * 不做 unsynchronisation：标签总长度在头部已界定，现代解析器不会到标签体内找帧同步；
 * 且 music-metadata（本应用扫描器）只支持 v2.4 帧级 unsync，不支持 v2.3 整标签 unsync，
 * 写了 0x80 标志反而会让它按错位字节解析。
 */
function embedMp3(fileData: Uint8Array, meta: EmbedMeta, cover: EmbedCover): Uint8Array | null {
  // 定位音频起始：跳过已有 ID3v2 标签（v2.4 带 footer 时额外 10 字节）
  let audioStart = 0
  if (
    fileData.length >= 10 &&
    fileData[0] === 0x49 && // 'I'
    fileData[1] === 0x44 && // 'D'
    fileData[2] === 0x33 && // '3'
    fileData[3] !== 0xff &&
    fileData[4] !== 0xff
  ) {
    const tagSize = readSyncsafe(fileData, 6)
    const hasFooter = (fileData[5] & 0x10) !== 0
    audioStart = 10 + tagSize + (hasFooter ? 10 : 0)
    if (audioStart > fileData.length) return null // 标签长度越界，异常文件
  }

  const frames: Uint8Array[] = []
  if (meta.title) frames.push(frame('TIT2', textFramePayload(meta.title)))
  if (meta.artist) frames.push(frame('TPE1', textFramePayload(meta.artist)))
  if (meta.album) frames.push(frame('TALB', textFramePayload(meta.album)))
  frames.push(frame('APIC', apicFramePayload(cover)))

  const framesBlob = concat(...frames)
  const header = concat(
    ascii('ID3'),
    new Uint8Array([0x03, 0x00, 0x00]), // v2.3，无 unsynchronisation
    syncsafe(framesBlob.length)
  )
  return concat(header, framesBlob, fileData.subarray(audioStart))
}

// ---------- FLAC：METADATA_BLOCK_PICTURE ----------

function embedFlac(fileData: Uint8Array, cover: EmbedCover): Uint8Array | null {
  // 'fLaC' 魔数
  if (
    fileData.length < 8 ||
    fileData[0] !== 0x66 || // 'f'
    fileData[1] !== 0x4c || // 'L'
    fileData[2] !== 0x61 || // 'a'
    fileData[3] !== 0x43 // 'C'
  ) {
    return null
  }

  // 遍历元数据块链：保留除 PICTURE(6) 外的块，并清除其 last 标志
  const kept: Uint8Array[] = []
  let off = 4
  let audioStart = -1
  for (let guard = 0; guard < 1024; guard++) {
    if (off + 4 > fileData.length) return null
    const headerByte = fileData[off]
    const isLast = (headerByte & 0x80) !== 0
    const type = headerByte & 0x7f
    if (type === 127) return null // 非法块类型
    const len = (fileData[off + 1] << 16) | (fileData[off + 2] << 8) | fileData[off + 3]
    const end = off + 4 + len
    if (end > fileData.length) return null
    if (type !== 6) {
      // 清除 last 标志后原样保留（新 PICTURE 块会成为最后的元数据块）
      kept.push(concat(new Uint8Array([type]), fileData.subarray(off + 1, end)))
    }
    off = end
    if (isLast) {
      audioStart = end
      break
    }
  }
  if (audioStart < 0) return null // 块链未正常结束

  // PICTURE 块体：类型(3=封面) + MIME + 描述(空) + 宽高/色深/色数(0=未知) + 数据
  const mime = ascii(cover.mime)
  const body = concat(
    be32(3),
    be32(mime.length),
    mime,
    be32(0),
    be32(0),
    be32(0),
    be32(0),
    be32(0),
    be32(cover.data.length),
    cover.data
  )
  if (body.length > 0xffffff) return null // 块长度 24 位上限（实际封面远达不到）
  const pictureBlock = concat(new Uint8Array([0x80 | 6]), be24(body.length), body)

  return concat(fileData.subarray(0, 4), ...kept, pictureBlock, fileData.subarray(audioStart))
}

// ---------- M4A/MP4：ilst covr ----------

/** 顶层 box 类型：含子 box 的容器（ftyp 等不在列，按叶子处理） */
const MP4_CONTAINER_TYPES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'mvex', 'moof', 'traf'])

interface Mp4Box {
  type: string
  /** box 头起始偏移 */
  start: number
  /** 子内容起始偏移（头之后） */
  contentStart: number
  /** 整个 box 结束偏移 */
  end: number
}

function boxType(d: Uint8Array, off: number): string {
  return String.fromCharCode(d[off + 4], d[off + 5], d[off + 6], d[off + 7])
}

/** 解析 [start, end) 内的一层 box；出现畸形（长度越界/零长度死循环）返回 null */
function parseBoxes(d: Uint8Array, start: number, end: number): Mp4Box[] | null {
  const boxes: Mp4Box[] = []
  let off = start
  while (off < end) {
    if (off + 8 > end) return null
    let size = (d[off] << 24) | (d[off + 1] << 16) | (d[off + 2] << 8) | d[off + 3]
    let contentStart = off + 8
    if (size === 1) {
      // 64 位 largesize；封面场景文件远小于 4GB，高 32 位必须为 0
      if (off + 16 > end) return null
      const hi = (d[off + 8] << 24) | (d[off + 9] << 16) | (d[off + 10] << 8) | d[off + 11]
      const lo = (d[off + 12] << 24) | (d[off + 13] << 16) | (d[off + 14] << 8) | d[off + 15]
      if (hi !== 0 || lo < 16) return null
      size = lo
      contentStart = off + 16
    } else if (size === 0) {
      // 0 = 延伸到文件尾，只允许作为最后一个 box
      size = end - off
    }
    const boxEnd = off + size
    if (size < 8 || boxEnd > end) return null
    boxes.push({ type: boxType(d, off), start: off, contentStart, end: boxEnd })
    off = boxEnd
  }
  return boxes
}

/** 深度优先找第一个指定类型的 box */
function findBox(d: Uint8Array, boxes: Mp4Box[], type: string): Mp4Box | null {
  for (const b of boxes) {
    if (b.type === type) return b
    if (MP4_CONTAINER_TYPES.has(b.type)) {
      const child = parseBoxes(d, b.contentStart, b.end)
      if (child) {
        const hit = findBox(d, child, type)
        if (hit) return hit
      }
    }
  }
  return null
}

/** 收集所有 stco/co64 box（位于 moov→trak→mdia→minf→stbl 下） */
function collectChunkOffsetBoxes(d: Uint8Array, boxes: Mp4Box[], out: Mp4Box[]): void {
  for (const b of boxes) {
    if (b.type === 'stco' || b.type === 'co64') {
      out.push(b)
      continue
    }
    if (MP4_CONTAINER_TYPES.has(b.type)) {
      const child = parseBoxes(d, b.contentStart, b.end)
      if (child) collectChunkOffsetBoxes(d, child, out)
    }
  }
}

/** 在 box 内容内原地把 stco/co64 的每个 chunk 偏移加上 delta */
function shiftChunkOffsets(d: Uint8Array, box: Mp4Box, delta: number): void {
  // 头：version(1) + flags(3) + entry_count(4)
  const count =
    (d[box.contentStart + 4] << 24) |
    (d[box.contentStart + 5] << 16) |
    (d[box.contentStart + 6] << 8) |
    d[box.contentStart + 7]
  let off = box.contentStart + 8
  if (box.type === 'stco') {
    for (let i = 0; i < count && off + 4 <= box.end; i++, off += 4) {
      const v = ((d[off] << 24) | (d[off + 1] << 16) | (d[off + 2] << 8) | d[off + 3]) >>> 0
      const nv = v + delta
      d[off] = (nv >>> 24) & 0xff
      d[off + 1] = (nv >>> 16) & 0xff
      d[off + 2] = (nv >>> 8) & 0xff
      d[off + 3] = nv & 0xff
    }
  } else {
    for (let i = 0; i < count && off + 8 <= box.end; i++, off += 8) {
      // 高 32 位原样保留（实际文件为 0），低 32 位加 delta
      const lo = ((d[off + 4] << 24) | (d[off + 5] << 16) | (d[off + 6] << 8) | d[off + 7]) >>> 0
      const nv = lo + delta
      d[off + 4] = (nv >>> 24) & 0xff
      d[off + 5] = (nv >>> 16) & 0xff
      d[off + 6] = (nv >>> 8) & 0xff
      d[off + 7] = nv & 0xff
    }
  }
}

function dataAtom(kind: number, payload: Uint8Array): Uint8Array {
  const size = 16 + payload.length
  return concat(be32(size), ascii('data'), be32(kind), be32(0), payload)
}

/** covr atom：head(8) + data atom（13=jpeg / 14=png） */
function covrAtom(cover: EmbedCover): Uint8Array {
  const kind = cover.mime === 'image/png' ? 14 : 13
  const body = dataAtom(kind, cover.data)
  return concat(be32(8 + body.length), ascii('covr'), body)
}

/** 重建 meta box：ilst 存在则替换其中 covr，否则在 meta 末尾追加 ilst */
function rebuildMetaWithCovr(fileData: Uint8Array, meta: Mp4Box, cover: EmbedCover): Uint8Array | null {
  // meta 是全版本 box：内容首 4 字节为 version+flags（规范写法），旧文件可能直接是 hdlr
  const versioned = meta.contentStart + 4 <= meta.end && fileData[meta.contentStart + 3] === 0
  const headLen = versioned ? 4 : 0
  const children = parseBoxes(fileData, meta.contentStart + headLen, meta.end)
  if (!children) return null

  const ilst = children.find((b) => b.type === 'ilst')
  const newCovr = covrAtom(cover)
  let newIlst: Uint8Array
  if (ilst) {
    const ilstChildren = parseBoxes(fileData, ilst.contentStart, ilst.end)
    if (!ilstChildren) return null
    const parts: Uint8Array[] = []
    for (const c of ilstChildren) {
      if (c.type !== 'covr') parts.push(fileData.subarray(c.start, c.end))
    }
    parts.push(newCovr)
    const body = concat(...parts)
    newIlst = concat(be32(8 + body.length), ascii('ilst'), body)
  } else {
    newIlst = concat(be32(8 + newCovr.length), ascii('ilst'), newCovr)
  }

  const metaParts: Uint8Array[] = []
  for (const c of children) {
    metaParts.push(c === ilst ? newIlst : fileData.subarray(c.start, c.end))
  }
  if (!ilst) metaParts.push(newIlst)
  const metaBody = concat(...metaParts)
  // 原样保留 meta 头（size+type）与 version+flags，只更新 size
  const versionBytes = fileData.subarray(meta.contentStart, meta.contentStart + headLen)
  return concat(be32(8 + headLen + metaBody.length), ascii('meta'), versionBytes, metaBody)
}

/** 新建 meta box：version+flags=0 + hdlr(mdir) + ilst(covr) */
function buildNewMeta(cover: EmbedCover): Uint8Array {
  const hdlr = concat(
    be32(33),
    ascii('hdlr'),
    be32(0), // version+flags
    be32(0), // pre_defined
    ascii('mdir'), // handler_type
    ascii('appl'), // reserved
    be32(0),
    be32(0),
    new Uint8Array([0]) // name（空字符串）
  )
  const newCovr = covrAtom(cover)
  const ilst = concat(be32(8 + newCovr.length), ascii('ilst'), newCovr)
  const body = concat(be32(0), hdlr, ilst)
  return concat(be32(8 + body.length), ascii('meta'), body)
}

/**
 * 为 M4A/MP4 嵌入封面：替换（或新建）moov→udta→meta→ilst 下的 covr atom。
 * 只动元数据 atom，文本标签不改动（源文件通常已带）。moov 尺寸变化且 moov
 * 位于 mdat 之前时，同步修正 stco/co64 的绝对 chunk 偏移，保证音频数据仍可定位。
 */
function embedM4a(fileData: Uint8Array, cover: EmbedCover): Uint8Array | null {
  const top = parseBoxes(fileData, 0, fileData.length)
  if (!top || !top.length) return null
  const moov = top.find((b) => b.type === 'moov')
  const mdat = top.find((b) => b.type === 'mdat')
  if (!moov || !mdat) return null

  const moovChildren = parseBoxes(fileData, moov.contentStart, moov.end)
  if (!moovChildren) return null
  const udta = moovChildren.find((b) => b.type === 'udta')

  // 计算新 meta 字节
  let newMeta: Uint8Array | null = null
  if (udta) {
    const udtaChildren = parseBoxes(fileData, udta.contentStart, udta.end)
    if (!udtaChildren) return null
    const meta = udtaChildren.find((b) => b.type === 'meta')
    newMeta = meta ? rebuildMetaWithCovr(fileData, meta, cover) : buildNewMeta(cover)
  } else {
    newMeta = buildNewMeta(cover)
  }
  if (!newMeta) return null

  // 重组 udta：替换 meta 或追加；无 udta 则新建
  let newUdta: Uint8Array
  if (udta) {
    const udtaChildren = parseBoxes(fileData, udta.contentStart, udta.end)!
    const meta = udtaChildren.find((b) => b.type === 'meta')
    const parts: Uint8Array[] = []
    for (const c of udtaChildren) {
      parts.push(c === meta ? newMeta : fileData.subarray(c.start, c.end))
    }
    if (!meta) parts.push(newMeta)
    const body = concat(...parts)
    newUdta = concat(be32(8 + body.length), ascii('udta'), body)
  } else {
    newUdta = concat(be32(8 + newMeta.length), ascii('udta'), newMeta)
  }

  // 重组 moov
  const moovParts: Uint8Array[] = []
  for (const c of moovChildren) {
    moovParts.push(c === udta ? newUdta : fileData.subarray(c.start, c.end))
  }
  if (!udta) moovParts.push(newUdta)
  const moovBody = concat(...moovParts)
  const newMoov = concat(be32(8 + moovBody.length), ascii('moov'), moovBody)

  const sizeDelta = newMoov.length - (moov.end - moov.start)
  const moovBeforeMdat = moov.start < mdat.start

  const out = concat(fileData.subarray(0, moov.start), newMoov, fileData.subarray(moov.end))

  // moov 在 mdat 之前且尺寸变化：mdat 整体后移 sizeDelta，修正所有 chunk 偏移
  if (moovBeforeMdat && sizeDelta !== 0) {
    const outTop = parseBoxes(out, 0, out.length)
    if (!outTop) return null
    const outMoov = outTop.find((b) => b.type === 'moov')
    if (!outMoov) return null
    const outMoovChildren = parseBoxes(out, outMoov.contentStart, outMoov.end)
    if (!outMoovChildren) return null
    const stcos: Mp4Box[] = []
    collectChunkOffsetBoxes(out, outMoovChildren, stcos)
    for (const s of stcos) shiftChunkOffsets(out, s, sizeDelta)
  }

  return out
}

// ---------- 入口 ----------

/**
 * 把封面（与基础文本标签）嵌入音频文件。
 * @param ext 音频扩展名（'.mp3' / '.flac' / '.m4a' 等），其它格式返回 null
 * @returns 嵌入后的新文件内容；不支持或解析异常返回 null（调用方保留原文件）
 */
export function embedCoverIntoAudio(
  fileData: Uint8Array,
  ext: string,
  meta: EmbedMeta,
  cover: EmbedCover
): Uint8Array | null {
  if (!fileData.length || !cover.data.length) return null
  try {
    switch (ext.toLowerCase()) {
      case '.mp3':
        return embedMp3(fileData, meta, cover)
      case '.flac':
        return embedFlac(fileData, cover)
      case '.m4a':
      case '.m4b':
      case '.mp4':
      case '.aac': // 仅 MP4 容器封装的 aac 有效，ADTS 裸流解析失败返回 null
        return embedM4a(fileData, cover)
      default:
        return null
    }
  } catch {
    return null
  }
}
