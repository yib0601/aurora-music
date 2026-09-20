import { MAX_FILENAME_BYTES, inferAudioExtFromUrl, sanitizeFileName } from '../downloadUtils'

/** 按 UTF-8 计算字节数 */
const bytesOf = (text: string): number => new TextEncoder().encode(text).length

describe('sanitizeFileName 中文与常规字符', () => {
  it('中文歌名原样保留，不被破坏', () => {
    expect(sanitizeFileName('周杰伦 - 晴天')).toBe('周杰伦 - 晴天')
  })

  it('中英文混排与括号、空格保留', () => {
    expect(sanitizeFileName('周杰伦 - 晴天 (Live 版)')).toBe('周杰伦 - 晴天 (Live 版)')
  })

  it('日文与 emoji 保留（emoji 本身是可落盘字符）', () => {
    expect(sanitizeFileName('米津玄師 - 🎵Lemon')).toBe('米津玄師 - 🎵Lemon')
  })

  it('全角逗号、句号等非非法字符保留原样', () => {
    expect(sanitizeFileName('歌手：周杰伦，专辑《叶惠美》')).toBe(
      '歌手_周杰伦，专辑《叶惠美》'
    )
  })
})

describe('sanitizeFileName 全角非法字符处理', () => {
  it('全角冒号归一为半角后替换为下划线', () => {
    expect(sanitizeFileName('周杰伦：晴天')).toBe('周杰伦_晴天')
  })

  it('全角问号替换为下划线', () => {
    expect(sanitizeFileName('歌名？')).toBe('歌名_')
  })

  it('全角引号、星号、竖线、斜杠一并处理', () => {
    expect(sanitizeFileName('ＡＢ＂＊｜／＼')).toBe('ＡＢ_____')
  })

  it('全角与半角混合时结果一致', () => {
    expect(sanitizeFileName('周杰伦：晴天')).toBe(sanitizeFileName('周杰伦:晴天'))
    expect(sanitizeFileName('歌名？')).toBe(sanitizeFileName('歌名?'))
  })
})

describe('sanitizeFileName 路径分隔符与控制字符', () => {
  it('正反斜杠被替换，防止路径穿越', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('.._.._etc_passwd')
    expect(sanitizeFileName('..\\..\\Windows\\system32')).toBe('.._.._Windows_system32')
  })

  it('U+0000-U+001F 控制字符全部替换为下划线', () => {
    expect(sanitizeFileName('a\u0000b\u0001c\u001fd')).toBe('a_b_c_d')
    expect(sanitizeFileName('歌\t名\n.mp3')).toBe('歌_名_.mp3')
  })

  it('Windows 非法字符 * ? " < > | 全部替换', () => {
    expect(sanitizeFileName('a*b?c"d<e>f|g')).toBe('a_b_c_d_e_f_g')
  })

  it('替换后不会残留路径分隔符', () => {
    const result = sanitizeFileName('a/b\\c:d')
    expect(result).not.toContain('/')
    expect(result).not.toContain('\\')
  })
})

describe('sanitizeFileName Windows 保留设备名', () => {
  it.each(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9'])(
    '保留名 %s 被加前缀规避',
    (name) => {
      const result = sanitizeFileName(name)
      expect(result).not.toBe(name)
      expect(result.toUpperCase()).not.toBe(name)
      expect(result.endsWith(name)).toBe(true)
    }
  )

  it('带扩展名的保留名同样规避：CON.mp3', () => {
    const result = sanitizeFileName('CON.mp3')
    expect(result.split('.')[0].toUpperCase()).not.toBe('CON')
    expect(result).toContain('CON.mp3')
  })

  it('保留名不区分大小写：con.mp3 / CoM1', () => {
    expect(sanitizeFileName('con.mp3').split('.')[0].toUpperCase()).not.toBe('CON')
    expect(sanitizeFileName('CoM1').toUpperCase().includes('COM1')).toBe(true)
    expect(sanitizeFileName('CoM1')).not.toBe('CoM1')
  })

  it('含保留名但非保留名的正常文件名不受影响', () => {
    expect(sanitizeFileName('CONCERT - 演唱会')).toBe('CONCERT - 演唱会')
    expect(sanitizeFileName('COM10 - 歌')).toBe('COM10 - 歌')
    expect(sanitizeFileName('My CON')).toBe('My CON')
  })

  it('规避后的名字再处理保持稳定（幂等）', () => {
    const once = sanitizeFileName('CON.mp3')
    expect(sanitizeFileName(once)).toBe(once)
  })
})

describe('sanitizeFileName 结尾点与空格', () => {
  it('去掉结尾的点', () => {
    expect(sanitizeFileName('歌名.')).toBe('歌名')
    expect(sanitizeFileName('歌名...')).toBe('歌名')
  })

  it('去掉结尾的空格', () => {
    expect(sanitizeFileName('歌名   ')).toBe('歌名')
  })

  it('去掉结尾的点与空格混合', () => {
    expect(sanitizeFileName('歌名 . . ')).toBe('歌名')
  })

  it('去掉首尾空白', () => {
    expect(sanitizeFileName('  歌名  ')).toBe('歌名')
  })

  it('中间的点与空格保留', () => {
    expect(sanitizeFileName('周杰伦 - 晴天.mp3')).toBe('周杰伦 - 晴天.mp3')
  })
})

describe('sanitizeFileName 长度限制', () => {
  it('超长中文名按 UTF-8 字节截断到上限内', () => {
    const long = '歌'.repeat(300)
    const result = sanitizeFileName(long)
    expect(bytesOf(result)).toBeLessThanOrEqual(MAX_FILENAME_BYTES)
  })

  it('截断不产生半个字符（无 U+FFFD，且字符可逆）', () => {
    const long = '歌'.repeat(300)
    const result = sanitizeFileName(long)
    expect(result).not.toContain('\uFFFD')
    // 每个字符都是完整的 3 字节中文
    expect(result.length * 3).toBe(bytesOf(result))
    expect(result).toBe('歌'.repeat(result.length))
  })

  it('截断点落在多字节字符中间时整体舍弃该字符', () => {
    // 60 个 ASCII 字符 + 中文，上限 180 字节：ASCII 占 60，剩余 120 字节 = 40 个中文
    const input = 'a'.repeat(60) + '歌'.repeat(40) + 'bbbb'
    const result = sanitizeFileName(input)
    expect(bytesOf(result)).toBeLessThanOrEqual(MAX_FILENAME_BYTES)
    expect(result).not.toContain('\uFFFD')
    expect(result).toBe('a'.repeat(60) + '歌'.repeat(40))
  })

  it('emoji（4 字节）截断后不残缺', () => {
    // 176 个 ASCII（176 字节）+ 2 个 emoji：恰好装下 1 个 emoji，第 2 个整体舍弃
    const input = 'a'.repeat(176) + '🎵🎵'
    const result = sanitizeFileName(input)
    expect(bytesOf(result)).toBeLessThanOrEqual(MAX_FILENAME_BYTES)
    expect(result).not.toContain('\uFFFD')
    expect(result).toBe('a'.repeat(176) + '🎵')
    expect(Array.from(result).pop()).toBe('🎵')
  })

  it('未超长的名字不截断', () => {
    expect(sanitizeFileName('周杰伦 - 晴天.mp3')).toBe('周杰伦 - 晴天.mp3')
    expect(bytesOf(sanitizeFileName('歌'.repeat(60)))).toBe(180)
  })

  it('截断后若产生结尾点/空格会被清除', () => {
    const input = 'a'.repeat(MAX_FILENAME_BYTES - 1) + ' . ' + 'b'.repeat(20)
    const result = sanitizeFileName(input)
    expect(result.endsWith('.')).toBe(false)
    expect(result.endsWith(' ')).toBe(false)
    expect(bytesOf(result)).toBeLessThanOrEqual(MAX_FILENAME_BYTES)
  })
})

describe('sanitizeFileName Unicode 归一化', () => {
  it('NFD 输入归一化为 NFC', () => {
    const nfd = 'Cafe\u0301 - 歌' // e + U+0301 组合重音
    const result = sanitizeFileName(nfd)
    expect(result).toBe('Café - 歌')
    expect(result).toBe(result.normalize('NFC'))
    expect(result).not.toBe(nfd)
  })

  it('NFC 输入保持不变', () => {
    const nfc = 'Café - 歌'
    expect(sanitizeFileName(nfc)).toBe(nfc)
  })

  it('NFD 与 NFC 输入得到完全相同的结果（扫描匹配一致）', () => {
    expect(sanitizeFileName('Cafe\u0301 晴天')).toBe(sanitizeFileName('Café 晴天'))
  })

  it('拉丁组合音标（NFD）归一化为单码位预组合字符', () => {
    // U+0301 组合尖音符不可单点组合，但 U+0301 可组合到 a/e/o/u 上
    expect(sanitizeFileName('Cafe\u0301 - 歌')).toBe('Café - 歌')
  })
})

describe('sanitizeFileName 兜底', () => {
  it('空串回退为未知歌曲', () => {
    expect(sanitizeFileName('')).toBe('未知歌曲')
  })

  it('纯空白回退为未知歌曲', () => {
    expect(sanitizeFileName('   ')).toBe('未知歌曲')
  })

  it('纯非法字符被逐个替换为下划线，保留可落盘结果', () => {
    expect(sanitizeFileName('///')).toBe('___')
    expect(sanitizeFileName('a/b')).toBe('a_b')
  })

  it('仅由结尾点与空格组成时回退为未知歌曲', () => {
    expect(sanitizeFileName(' . ')).toBe('未知歌曲')
    expect(sanitizeFileName('.')).toBe('未知歌曲')
  })

  it('纯控制字符被替换后保留', () => {
    expect(sanitizeFileName('\u0000\u0001')).toBe('__')
  })

  it('是纯函数：多次调用结果一致且不修改语义', () => {
    const input = '周杰伦：晴天. '
    const first = sanitizeFileName(input)
    const second = sanitizeFileName(input)
    expect(first).toBe(second)
    expect(input).toBe('周杰伦：晴天. ')
  })
})

describe('inferAudioExtFromUrl 回归', () => {
  it('识别常见音频扩展名', () => {
    expect(inferAudioExtFromUrl('https://a.com/b/c.flac?x=1')).toBe('.flac')
    expect(inferAudioExtFromUrl('https://a.com/b/c.MP3')).toBe('.mp3')
  })

  it('未知扩展名回退 .mp3', () => {
    expect(inferAudioExtFromUrl('https://a.com/b/c.txt')).toBe('.mp3')
    expect(inferAudioExtFromUrl('not a url')).toBe('.mp3')
  })
})
