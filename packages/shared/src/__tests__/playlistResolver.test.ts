import { extractShareUrl } from '../playlistResolver'

describe('extractShareUrl', () => {
  it('从纯链接文本提取', () => {
    expect(extractShareUrl('https://music.163.com/playlist?id=123')).toBe(
      'https://music.163.com/playlist?id=123'
    )
  })
  it('从分享文案中提取第一个链接', () => {
    const text = '分享周杰伦创建的歌单「七里香」：https://music.163.com/playlist?id=123 (来自网易云音乐)'
    expect(extractShareUrl(text)).toBe('https://music.163.com/playlist?id=123')
  })
  it('无链接返回 null', () => {
    expect(extractShareUrl('七里香 - 周杰伦')).toBeNull()
  })
})
