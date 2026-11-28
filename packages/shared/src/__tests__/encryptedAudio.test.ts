import { describe, expect, it } from 'vitest'
import {
  detectEncryptedAudioName,
  encryptedAudioSearchQuery,
  ENCRYPTED_SETTLE_MS,
  isEncryptedAudioName,
  isInProgressDownloadName,
  isStillDownloading,
  parseEncryptedAudioName,
} from '../encryptedAudio'

/**
 * 夹具全部取自真实形态：QQ 音乐安卓端下载落盘的文件名就是
 * `歌手 - 歌名 [mqms2].<加密扩展名>.<容器后缀>` 这三段拼起来的。
 */
describe('detectEncryptedAudioName', () => {
  it('认 QQ 音乐新格式（带追加的容器后缀）', () => {
    expect(detectEncryptedAudioName('陈奕迅 - 十年 [mqms2].mflac0.flac')).toEqual({
      family: 'qqmusic',
      token: 'mflac0',
    })
    expect(detectEncryptedAudioName('陈奕迅 - 不如不见 [mqms2].mgg2.flac')).toEqual({
      family: 'qqmusic',
      token: 'mgg2',
    })
  })

  it('认老 QMC 系列', () => {
    expect(detectEncryptedAudioName('周杰伦 - 晴天.qmcflac')).toEqual({ family: 'qqmusic', token: 'qmcflac' })
    expect(detectEncryptedAudioName('周杰伦 - 晴天.qmc0')).toEqual({ family: 'qqmusic', token: 'qmc0' })
  })

  it('加密扩展名被改掉、只剩平台标记时仍认得出', () => {
    expect(detectEncryptedAudioName('暗杠&寅子 - 说书人 [mqms2].flac')).toEqual({
      family: 'qqmusic',
      token: 'mqms2',
    })
  })

  it('大小写不敏感', () => {
    expect(detectEncryptedAudioName('A - B.MFLAC0.FLAC')).toEqual({ family: 'qqmusic', token: 'mflac0' })
  })

  it('认其它平台：网易云 / 酷狗 / 酷我 / 虾米', () => {
    expect(detectEncryptedAudioName('A - B.ncm')?.family).toBe('netease')
    expect(detectEncryptedAudioName('A - B.kgm')?.family).toBe('kugou')
    expect(detectEncryptedAudioName('A - B.kwm')?.family).toBe('kuwo')
    expect(detectEncryptedAudioName('A - B.xm')?.family).toBe('xiami')
  })

  it('普通音频文件不算加密', () => {
    expect(detectEncryptedAudioName('陈奕迅 - 十年.flac')).toBeNull()
    expect(detectEncryptedAudioName('A - B.mp3')).toBeNull()
    expect(isEncryptedAudioName('周杰伦 - 晴天.flac')).toBe(false)
    expect(isEncryptedAudioName('周杰伦 - 晴天 [mqms2].mflac0.flac')).toBe(true)
  })

  it('Windows 反斜杠路径同样能取到 basename', () => {
    expect(detectEncryptedAudioName('D:\\Music\\QQMusic\\song\\陈奕迅 - 十年 [mqms2].mflac0.flac')).toEqual({
      family: 'qqmusic',
      token: 'mflac0',
    })
  })
})

describe('parseEncryptedAudioName', () => {
  it('还原歌手与歌名', () => {
    const hit = parseEncryptedAudioName('陈奕迅 - 十年 [mqms2].mflac0.flac')
    expect(hit).toMatchObject({ family: 'qqmusic', title: '十年', artist: '陈奕迅' })
  })

  it('歌名里有句点不被截断', () => {
    const hit = parseEncryptedAudioName('Mr.Children - 花.mflac')
    expect(hit).toMatchObject({ title: '花', artist: 'Mr.Children' })
  })

  it('多个歌手并列时整段保留（不替用户挑第一歌手）', () => {
    const hit = parseEncryptedAudioName('暗杠&寅子 - 说书人 [mqms2].flac')
    expect(hit).toMatchObject({ title: '说书人', artist: '暗杠&寅子' })
  })

  it('没有 `歌手 - 歌名` 结构时整段当歌名、歌手留空', () => {
    const hit = parseEncryptedAudioName('说书人 [mqms2].mflac0.flac')
    expect(hit).toMatchObject({ title: '说书人', artist: '' })
  })

  it('非加密文件返回 null', () => {
    expect(parseEncryptedAudioName('陈奕迅 - 十年.flac')).toBeNull()
  })
})

describe('encryptedAudioSearchQuery', () => {
  it('歌手 + 歌名，跳过空项', () => {
    expect(encryptedAudioSearchQuery({ title: '十年', artist: '陈奕迅' })).toBe('陈奕迅 十年')
    expect(encryptedAudioSearchQuery({ title: '十年', artist: '' })).toBe('十年')
    expect(encryptedAudioSearchQuery({ title: '', artist: '' })).toBe('')
  })
})

/**
 * 「仍在下载」判据：**这组错了会让用户的平台下载报废**。
 *
 * 场景很具体：QQ 音乐正在往扫描目录里写一首 `.mflac0.flac`，文件名里的加密标记
 * 齐全（那正是识别加密文件的唯一线索）。若照常上报成「待处理」，用户点「替换」
 * 就会把正在写的文件移进回收站 —— 平台下载直接报废，且半截文件不可恢复。
 */
describe('isInProgressDownloadName', () => {
  it('认常见的下载器中间文件后缀（大小写不敏感）', () => {
    // 应用自己的下载走 .part（见 desktop/ipc/downloadTarget.ts）
    expect(isInProgressDownloadName('陈奕迅 - 十年 [mqms2].mflac0.flac.part')).toBe(true)
    expect(isInProgressDownloadName('陈奕迅 - 十年.mflac.PART')).toBe(true)
    // 各家下载器 / 浏览器的中间名
    expect(isInProgressDownloadName('a.flac.crdownload')).toBe(true) // Chrome
    expect(isInProgressDownloadName('a.flac.opdownload')).toBe(true) // Opera
    expect(isInProgressDownloadName('a.flac.!qb')).toBe(true) // qBittorrent
    expect(isInProgressDownloadName('a.flac.bc!')).toBe(true) // BitComet
    expect(isInProgressDownloadName('a.flac.aria2')).toBe(true)
    expect(isInProgressDownloadName('a.flac.partial')).toBe(true)
    expect(isInProgressDownloadName('a.flac.tmp')).toBe(true)
  })

  it('已完成的文件名不算进行中', () => {
    expect(isInProgressDownloadName('陈奕迅 - 十年 [mqms2].mflac0.flac')).toBe(false)
    expect(isInProgressDownloadName('/m/a.mp3')).toBe(false)
    // 只写了一半的名字结尾（不是后缀）不该误判
    expect(isInProgressDownloadName('part.flac')).toBe(false)
    expect(isInProgressDownloadName('tmp.mp3')).toBe(false)
  })

  it('完整路径同样能判（取 basename）', () => {
    expect(isInProgressDownloadName('/m/QQMusic/song/十年.mflac0.flac.part')).toBe(true)
    expect(isInProgressDownloadName('D:\\\\Music\\\\十年.mflac0.flac.part')).toBe(true)
  })
})

describe('isStillDownloading', () => {
  it('名字带中间态后缀 → 无论 mtime 多新多旧都算在下载', () => {
    const old = Date.now() - 3600_000
    expect(isStillDownloading('a.mflac0.flac.part', old)).toBe(true)
    expect(isStillDownloading('a.mflac0.flac.part', undefined)).toBe(true)
  })

  it('mtime 在静默期内 → 视为仍在写（直接写最终名的下载器只能靠这条挡住）', () => {
    expect(isStillDownloading('a.mflac0.flac', Date.now())).toBe(true)
    expect(isStillDownloading('a.mflac0.flac', Date.now() - ENCRYPTED_SETTLE_MS + 1000)).toBe(true)
  })

  it('mtime 过了静默期 → 认作已落盘', () => {
    expect(isStillDownloading('a.mflac0.flac', Date.now() - ENCRYPTED_SETTLE_MS - 1000)).toBe(false)
  })

  it('拿不到 mtime 时只按名字判（宁可上报也不要让真加密文件永久隐身）', () => {
    expect(isStillDownloading('a.mflac0.flac', undefined)).toBe(false)
    expect(isStillDownloading('a.mflac0.flac', Number.NaN)).toBe(false)
  })

  it('静默期是秒级的，不会长到让刚下完的文件拖到下次启动才提示', () => {
    // 上限取 30 秒：这条断言是给「有人把常量调成 10 分钟」时用的保险
    expect(ENCRYPTED_SETTLE_MS).toBeGreaterThanOrEqual(1000)
    expect(ENCRYPTED_SETTLE_MS).toBeLessThanOrEqual(30_000)
  })
})
