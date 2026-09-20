import {
  decodeFileUrlToPath,
  encodeFilePathToUrl,
  encodePathSegments,
} from '../fileUrl'

describe('encodeFilePathToUrl', () => {
  it('纯中文路径逐段编码', () => {
    expect(encodeFilePathToUrl('/home/李四/Music/歌曲.mp3')).toBe(
      'file:///home/%E6%9D%8E%E5%9B%9B/Music/%E6%AD%8C%E6%9B%B2.mp3'
    )
  })

  it('中文 + 空格编码为 %20', () => {
    expect(encodeFilePathToUrl('/home/Music/我的 歌.mp3')).toBe(
      'file:///home/Music/%E6%88%91%E7%9A%84%20%E6%AD%8C.mp3'
    )
  })

  it('含 # 时不会被 URL 当作 fragment 截断（核心缺陷回归）', () => {
    const url = encodeFilePathToUrl('/home/yibin/Music/歌曲 #1.mp3')
    expect(url).toBe('file:///home/yibin/Music/%E6%AD%8C%E6%9B%B2%20%231.mp3')
    expect(url).not.toContain('#')
    // 用 WHATWG URL 解析验证 pathname 完整
    expect(new URL(url).pathname).toBe('/home/yibin/Music/%E6%AD%8C%E6%9B%B2%20%231.mp3')
    expect(new URL(url).hash).toBe('')
    expect(new URL(url).search).toBe('')
  })

  it('含 ? 时不会被 URL 当作 query 起点', () => {
    const url = encodeFilePathToUrl('/home/Music/歌?.mp3')
    expect(url).toBe('file:///home/Music/%E6%AD%8C%3F.mp3')
    const parsed = new URL(url)
    expect(parsed.search).toBe('')
    expect(parsed.pathname).toBe('/home/Music/%E6%AD%8C%3F.mp3')
  })

  it('含 % 时按 UTF-8 转义为 %25，避免被误当成编码序列', () => {
    expect(encodeFilePathToUrl('/home/Music/100%.mp3')).toBe(
      'file:///home/Music/100%25.mp3'
    )
    expect(encodeFilePathToUrl('/home/Music/100%25.mp3')).toBe(
      'file:///home/Music/100%25.mp3'
    )
  })

  it('含 & 时转义为 %26', () => {
    expect(encodeFilePathToUrl('/home/Music/A & B.mp3')).toBe(
      'file:///home/Music/A%20%26%20B.mp3'
    )
  })

  it('含 emoji 时按 UTF-8 编码', () => {
    expect(encodeFilePathToUrl('/home/Music/🎵歌.mp3')).toBe(
      'file:///home/Music/%F0%9F%8E%B5%E6%AD%8C.mp3'
    )
  })

  it('Windows 盘符路径：反斜杠转正斜杠并补前导斜杠', () => {
    expect(encodeFilePathToUrl('C:\\Users\\张三\\Music\\歌.mp3')).toBe(
      'file:///C:/Users/%E5%BC%A0%E4%B8%89/Music/%E6%AD%8C.mp3'
    )
  })

  it('Windows 盘符路径：混合分隔符同样处理', () => {
    expect(encodeFilePathToUrl('D:/Music/歌 #2.flac')).toBe(
      'file:///D:/Music/%E6%AD%8C%20%232.flac'
    )
  })

  it('空串返回空串', () => {
    expect(encodeFilePathToUrl('')).toBe('')
  })

  it('根路径返回 file:/// 且不产生多余斜杠', () => {
    expect(encodeFilePathToUrl('/')).toBe('file:///')
    expect(encodeFilePathToUrl('//')).toBe('file:///')
  })

  it('重复分隔符不会产生 //（跳过空段）', () => {
    expect(encodeFilePathToUrl('/home//a///b.mp3')).toBe('file:///home/a/b.mp3')
  })

  it('已编码输入不二次编码（幂等）', () => {
    const encoded = 'file:///home/Music/%E6%AD%8C%E6%9B%B2%20%231.mp3'
    expect(encodeFilePathToUrl(encoded)).toBe(encoded)
    expect(encodeFilePathToUrl(encodeFilePathToUrl('/home/Music/歌曲 #1.mp3'))).toBe(
      encodeFilePathToUrl('/home/Music/歌曲 #1.mp3')
    )
  })

  it('孤立 % 不抛错，按字面量编码为 %25', () => {
    expect(() => encodeFilePathToUrl('/home/100%纯音乐.mp3')).not.toThrow()
    expect(encodeFilePathToUrl('/home/100%纯.mp3')).toBe(
      'file:///home/100%25%E7%BA%AF.mp3'
    )
  })

  it('保留 URL 安全字符与常见文件名符号', () => {
    expect(encodeFilePathToUrl("/home/Music/It's (Live) [Remix].mp3")).toBe(
      "file:///home/Music/It's%20(Live)%20%5BRemix%5D.mp3"
    )
  })
})

describe('decodeFileUrlToPath', () => {
  it('还原纯中文路径', () => {
    expect(decodeFileUrlToPath('file:///home/%E6%9D%8E%E5%9B%9B/Music/%E6%AD%8C%E6%9B%B2.mp3')).toBe(
      '/home/李四/Music/歌曲.mp3'
    )
  })

  it('还原含 # ? & 空格的路径', () => {
    expect(decodeFileUrlToPath('file:///home/Music/%E6%AD%8C%E6%9B%B2%20%231.mp3')).toBe(
      '/home/Music/歌曲 #1.mp3'
    )
    expect(decodeFileUrlToPath('file:///home/Music/%E6%AD%8C%3F.mp3')).toBe(
      '/home/Music/歌?.mp3'
    )
    expect(decodeFileUrlToPath('file:///home/Music/A%20%26%20B.mp3')).toBe(
      '/home/Music/A & B.mp3'
    )
  })

  it('还原 emoji', () => {
    expect(decodeFileUrlToPath('file:///home/Music/%F0%9F%8E%B5%E6%AD%8C.mp3')).toBe(
      '/home/Music/🎵歌.mp3'
    )
  })

  it('Windows 盘符：file:///C:/... 还原为 C:/...（不带前导斜杠）', () => {
    expect(decodeFileUrlToPath('file:///C:/Users/%E5%BC%A0%E4%B8%89/Music/%E6%AD%8C.mp3')).toBe(
      'C:/Users/张三/Music/歌.mp3'
    )
  })

  it('空串返回空串', () => {
    expect(decodeFileUrlToPath('')).toBe('')
  })

  it('根路径返回 /', () => {
    expect(decodeFileUrlToPath('file:///')).toBe('/')
  })

  it('兼容 file://host/share 形式（忽略 authority）', () => {
    expect(decodeFileUrlToPath('file://localhost/home/Music/%E6%AD%8C.mp3')).toBe(
      '/home/Music/歌.mp3'
    )
  })

  it('非 file:// 输入按普通路径处理', () => {
    expect(decodeFileUrlToPath('/home/Music/歌.mp3')).toBe('/home/Music/歌.mp3')
  })

  it('非法编码段原样保留，不抛错', () => {
    expect(() => decodeFileUrlToPath('file:///home/100%ZZ.mp3')).not.toThrow()
    expect(decodeFileUrlToPath('file:///home/100%ZZ.mp3')).toBe('/home/100%ZZ.mp3')
  })
})

describe('往返一致性', () => {
  const cases = [
    '/home/李四/Music/歌曲.mp3',
    '/home/Music/我的 歌.mp3',
    '/home/yibin/Music/歌曲 #1.mp3',
    '/home/Music/歌?.mp3',
    '/home/Music/100% 纯.mp3',
    '/home/Music/A & B.mp3',
    '/home/Music/🎵歌.mp3',
    '/home/Music/It\'s (Live) [Remix].mp3',
    '/home/Music/周杰伦 - 晴天.mp3',
  ]

  it.each(cases)('encode→decode 等于原值：%s', (path) => {
    expect(decodeFileUrlToPath(encodeFilePathToUrl(path))).toBe(path)
  })

  it('Windows 路径往返：反斜杠已归一为正斜杠', () => {
    const path = 'C:/Users/张三/Music/歌.mp3'
    expect(decodeFileUrlToPath(encodeFilePathToUrl(path))).toBe(path)
    expect(decodeFileUrlToPath(encodeFilePathToUrl('C:\\Users\\张三\\Music\\歌.mp3'))).toBe(path)
  })
})

describe('encodePathSegments', () => {
  it('逐段编码，不含 file:// 前缀', () => {
    expect(encodePathSegments('/home/李四/Music/歌曲 #1.mp3')).toBe(
      'home/%E6%9D%8E%E5%9B%9B/Music/%E6%AD%8C%E6%9B%B2%20%231.mp3'
    )
  })

  it('可直接拼接到 cover-local:// 自定义协议后', () => {
    expect(`cover-local://${encodePathSegments('/home/Music/封面 图.jpg')}`).toBe(
      'cover-local://home/Music/%E5%B0%81%E9%9D%A2%20%E5%9B%BE.jpg'
    )
  })

  it('供 Capacitor convertFileSrc 复用时，与手工拼接的根前缀组合无重复斜杠', () => {
    expect(`/storage/emulated/0/${encodePathSegments('/Music/我 的歌.mp3')}`).toBe(
      '/storage/emulated/0/Music/%E6%88%91%20%E7%9A%84%E6%AD%8C.mp3'
    )
  })

  it('相对路径同样逐段编码', () => {
    expect(encodePathSegments('Music/我的 歌.mp3')).toBe('Music/%E6%88%91%E7%9A%84%20%E6%AD%8C.mp3')
  })

  it('去重分隔符，不产生 //', () => {
    expect(encodePathSegments('/home//a///b.mp3')).toBe('home/a/b.mp3')
  })

  it('空串与纯分隔符返回空串', () => {
    expect(encodePathSegments('')).toBe('')
    expect(encodePathSegments('///')).toBe('')
  })

  it('已编码段落不二次编码（幂等）', () => {
    expect(encodePathSegments('home/Music/%E6%AD%8C%E6%9B%B2%20%231.mp3')).toBe(
      'home/Music/%E6%AD%8C%E6%9B%B2%20%231.mp3'
    )
  })

  it('孤立 % 不抛错', () => {
    expect(() => encodePathSegments('Music/100%纯.mp3')).not.toThrow()
    expect(encodePathSegments('Music/100%纯.mp3')).toBe('Music/100%25%E7%BA%AF.mp3')
  })

  it('与 encodeFilePathToUrl 的段落结果一致', () => {
    const path = '/home/Music/歌曲 #1.mp3'
    expect(encodeFilePathToUrl(path)).toBe(`file:///${encodePathSegments(path)}`)
  })
})
