/**
 * 音频容器嗅探（`sniffAudioContainer`）与「按真实容器嵌封面」的回归测试。
 *
 * 背景：下载在线歌曲时落盘文件的扩展名来自**源地址**推断
 * （`inferAudioExtFromUrl`，推断不出来直接回落 `.mp3`）。源直链经常没有扩展名，
 * 或扩展名与实际内容不符。拿错扩展名去嵌封面有两条后果，两条都在这里钉住：
 *   1. 封面静默丢失（用户侧表现就是「下载的歌在曲库里没封面」）；
 *   2. 更糟 —— 按错误容器写标签会破坏音频（给 FLAC 前面贴 ID3v2 头）。
 */
import { describe, expect, it } from 'vitest'
import { detectImageMime, embedCoverIntoAudio, sniffAudioContainer } from '../embedCover'

/** 最小可用 FLAC：'fLaC' + 唯一的 STREAMINFO 块（last 标记 + 34 字节全零） */
function minimalFlac(): Uint8Array {
  const out = new Uint8Array(4 + 4 + 34)
  out.set([0x66, 0x4c, 0x61, 0x43], 0) // 'fLaC'
  out[4] = 0x80 // last-metadata-block + type 0（STREAMINFO）
  out[5] = 0x00
  out[6] = 0x00
  out[7] = 34
  return out
}

/** 最小可解析 M4A/MP4：ftyp + 空 moov + mdat */
function minimalM4a(): Uint8Array {
  const ftyp = new Uint8Array(24)
  const view = new DataView(ftyp.buffer)
  view.setUint32(0, 24)
  ftyp.set([0x66, 0x74, 0x79, 0x70], 4) // 'ftyp'
  ftyp.set([0x4d, 0x34, 0x41, 0x20], 8) // 'M4A '
  ftyp.set([0x69, 0x73, 0x6f, 0x6d], 16) // 'isom'
  const moov = new Uint8Array([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76]) // size 8 + 'moov'
  const mdat = new Uint8Array([0, 0, 0, 12, 0x6d, 0x64, 0x61, 0x74, 0, 0, 0, 0]) // size 12 + 'mdat'
  const out = new Uint8Array(ftyp.length + moov.length + mdat.length)
  out.set(ftyp, 0)
  out.set(moov, ftyp.length)
  out.set(mdat, ftyp.length + moov.length)
  return out
}

/** 假 jpeg（魔数正确即可，嵌入不做图片解码） */
function fakeJpeg(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
}

/** 被贴了 ID3v2 头的 FLAC（非标准但真实存在：老式 Windows 抓轨器会这么写） */
function flacWithId3(): Uint8Array {
  const id3 = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) // ID3v2.3，标签体长度 0
  const flac = minimalFlac()
  const out = new Uint8Array(id3.length + flac.length)
  out.set(id3, 0)
  out.set(flac, id3.length)
  return out
}

describe('sniffAudioContainer', () => {
  it('按魔数识别 mp3 / flac / m4a', () => {
    expect(sniffAudioContainer(new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00]))).toBe('.mp3')
    // 无 ID3 的裸 MPEG 帧：0xFF 0xFB
    expect(sniffAudioContainer(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toBe('.mp3')
    expect(sniffAudioContainer(minimalFlac())).toBe('.flac')
    expect(sniffAudioContainer(minimalM4a())).toBe('.m4a')
  })

  it('带头 ID3 的 FLAC 仍识别为 flac（不能只看开头 3 字节）', () => {
    expect(sniffAudioContainer(flacWithId3())).toBe('.flac')
    // 这类文件不做嵌入（embedFlac 要求 'fLaC' 在 0 偏移）：安全跳过，绝不当 MP3 改
    expect(embedCoverIntoAudio(flacWithId3(), '.flac', {}, { data: fakeJpeg(), mime: 'image/jpeg' })).toBeNull()
  })

  it('ADTS(AAC) 裸流不当成 MP3：两者帧同步位相同，只有 layer 位能区分', () => {
    // ADTS MPEG-4 / MPEG-2 帧头：0xFF 0xF1 / 0xFF 0xF9 —— layer 位恒为 00
    expect(sniffAudioContainer(new Uint8Array([0xff, 0xf1, 0x50, 0x80]))).toBeNull()
    expect(sniffAudioContainer(new Uint8Array([0xff, 0xf9, 0x50, 0x80]))).toBeNull()
    // MPEG-2 Layer III（0xFF 0xF3）与 MPEG-1 Layer III（0xFF 0xFB）仍是 mp3
    expect(sniffAudioContainer(new Uint8Array([0xff, 0xf3, 0x90, 0x00]))).toBe('.mp3')
    expect(sniffAudioContainer(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toBe('.mp3')
    // 回归：以前这里会把 ADTS 判成 mp3 → 给 AAC 裸流前置 ID3v2 头把文件改坏
    expect(sniffAudioContainer(new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x00]))).not.toBe('.mp3')
  })

  it('不支持的容器返回 null（不要往上面硬写标签）', () => {
    expect(sniffAudioContainer(new TextEncoder().encode('OggS\x00\x02\x00\x00'))).toBeNull()
    expect(sniffAudioContainer(new TextEncoder().encode('RIFF\x24\x00\x00\x00WAVE'))).toBeNull()
    expect(sniffAudioContainer(new Uint8Array())).toBeNull()
    expect(sniffAudioContainer(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull()
  })
})

describe('按嗅探出的容器嵌入封面', () => {
  it('FLAC 内容 + 错误扩展名（.mp3）会写出 ID3 头 —— 这正是必须嗅探的原因', () => {
    const flac = minimalFlac()
    const wrong = embedCoverIntoAudio(flac, '.mp3', { title: 't' }, { data: fakeJpeg(), mime: 'image/jpeg' })
    expect(wrong).not.toBeNull()
    // 给 FLAC 贴 ID3v2 头：文件虽然"有标签了"，但容器头被顶掉，播放器/扫描器都可能读不了
    expect(Array.from(wrong!.subarray(0, 3))).toEqual([0x49, 0x44, 0x33])
  })

  it('用嗅探结果（.flac）嵌入后仍是 FLAC，且带上 PICTURE 块', () => {
    const flac = minimalFlac()
    const container = sniffAudioContainer(flac)
    expect(container).toBe('.flac')
    const out = embedCoverIntoAudio(flac, container!, { title: 't' }, { data: fakeJpeg(), mime: 'image/jpeg' })
    expect(out).not.toBeNull()
    // 容器头保持 'fLaC'，没有被 ID3 顶掉
    expect(Array.from(out!.subarray(0, 4))).toEqual([0x66, 0x4c, 0x61, 0x43])
    // 元数据块链里出现 PICTURE（type 6）：STREAMINFO 之后紧接的那块
    expect(out![4] & 0x7f).toBe(0) // STREAMINFO 仍在首位
    const pictureHeader = out![4 + 4 + 34]
    expect(pictureHeader & 0x80).toBe(0x80) // 新的最后一块
    expect(pictureHeader & 0x7f).toBe(6) // PICTURE
  })

  it('M4A 用嗅探结果嵌入后仍可解析出 covr', () => {
    const m4a = minimalM4a()
    const container = sniffAudioContainer(m4a)
    expect(container).toBe('.m4a')
    const out = embedCoverIntoAudio(m4a, container!, {}, { data: fakeJpeg(), mime: 'image/jpeg' })
    expect(out).not.toBeNull()
    // moov 里多出 udta → meta → ilst → covr
    const text = String.fromCharCode(...out!.subarray(0, Math.min(out!.length, 4096)))
    expect(text).toContain('moov')
    expect(text).toContain('udta')
    expect(text).toContain('ilst')
    expect(text).toContain('covr')
  })
})

describe('detectImageMime', () => {
  it('PNG 头识别为 png，其余按 jpeg（与嵌入时写进标签的 MIME 一致）', () => {
    expect(detectImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('image/png')
    expect(detectImageMime(fakeJpeg())).toBe('image/jpeg')
  })
})
