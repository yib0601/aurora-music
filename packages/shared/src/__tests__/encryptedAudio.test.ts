import { describe, expect, it } from 'vitest'
import {
  detectEncryptedAudioName,
  encryptedAudioSearchQuery,
  isEncryptedAudioName,
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
