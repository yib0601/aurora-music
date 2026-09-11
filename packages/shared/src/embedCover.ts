/**
 * 音频文件封面嵌入工具（桌面端主进程与移动端 WebView 共用，纯 Uint8Array 实现，无平台依赖）
 *
 * 背景：在线歌源直链的音频文件大多不带内嵌封面（实测酷源 MP3 仅有标题/艺术家/专辑文本标签），
 * 下载入库后无封面可提取。下载完成时把搜索结果里的 coverUrl 封面嵌入文件：
 * - MP3：重建 ID3v2.3 标签（TIT2/TPE1/TALB + APIC 封面），应用 unsynchronisation
 * - FLAC：解析元数据块链，替换/追加 METADATA_BLOCK_PICTURE（type 6）
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

// ---------- 入口 ----------

/**
 * 把封面（与基础文本标签）嵌入音频文件。
 * @param ext 音频扩展名（'.mp3' / '.flac'），其它格式返回 null
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
      default:
        return null
    }
  } catch {
    return null
  }
}
