import {
  buildAuthHeader,
  buildRemoteAudioUrl,
  isAudioFileName,
  isRemoteAudioUrl,
  joinUrl,
  normalizeHeadParsedDuration,
  parseMultiStatus,
  parseRemoteAudioUrl,
  shouldSkipDir,
  storagePathFor,
  storagePathPrefix,
} from '../webdav'

const BASE = 'https://nas.example.com:5006/dav'

/** 群晖/通用 WebDAV 的典型 207 响应 */
const MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/Music/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>Music</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/Music/Album%20One/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/Music/%E5%8F%8D%E6%96%B9%E5%90%91%E7%9A%84%E9%92%9F.mp3</D:href>
    <D:propstat>
      <D:prop>
        <D:getcontentlength>9437184</D:getcontentlength>
        <D:getlastmodified>Wed, 01 Jan 2025 12:00:00 GMT</D:getlastmodified>
        <D:resourcetype/>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/Music/cover.jpg</D:href>
    <D:propstat>
      <D:prop><D:getcontentlength>2048</D:getcontentlength><D:resourcetype/></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`

describe('parseMultiStatus', () => {
  const entries = parseMultiStatus(MULTISTATUS, BASE, 'Music', '')

  it('剔除发起请求的目录自身，保留其余条目', () => {
    expect(entries.map((e) => e.name)).toEqual(['Album One', '反方向的钟.mp3', 'cover.jpg'])
  })

  it('识别目录与文件', () => {
    expect(entries[0].isDirectory).toBe(true)
    expect(entries[1].isDirectory).toBe(false)
  })

  it('百分号编码的 href 还原为 UTF-8 路径', () => {
    expect(entries[1].path).toBe('反方向的钟.mp3')
    expect(entries[0].path).toBe('Album One')
  })

  it('解析 size 与 lastModified', () => {
    expect(entries[1].size).toBe(9437184)
    expect(entries[1].lastModified).toBe(Date.parse('Wed, 01 Jan 2025 12:00:00 GMT'))
    expect(entries[0].size).toBe(0)
  })

  it('无前缀命名空间（Nextcloud 风格）同样可解析', () => {
    const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/remote.php/dav/files/bob/Music/a.flac</d:href>
    <d:propstat>
      <d:prop><d:getcontentlength>100</d:getcontentlength><d:resourcetype/></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`
    const parsed = parseMultiStatus(xml, 'https://cloud.example.com/remote.php/dav/files/bob', 'Music', '')
    expect(parsed).toHaveLength(1)
    expect(parsed[0].path).toBe('a.flac')
    expect(parsed[0].size).toBe(100)
  })

  it('忽略 404 propstat，取 200 的那组属性', () => {
    const xml = `<D:multistatus xmlns:D="DAV:"><D:response>
      <D:href>/dav/Music/a.mp3</D:href>
      <D:propstat><D:prop><D:getcontentlength/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>
      <D:propstat><D:prop><D:getcontentlength>4096</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    </D:response></D:multistatus>`
    expect(parseMultiStatus(xml, BASE, 'Music', '')[0].size).toBe(4096)
  })

  it('空响应体返回空数组而不是抛错', () => {
    expect(parseMultiStatus('', BASE, '', '')).toEqual([])
  })
})

describe('URL 与鉴权辅助', () => {
  it('joinUrl 逐段编码，中文与空格不会破坏 URL', () => {
    expect(joinUrl(BASE, 'Music', 'Album One', '反方向的钟.mp3')).toBe(
      `${BASE}/Music/Album%20One/%E5%8F%8D%E6%96%B9%E5%90%91%E7%9A%84%E9%92%9F.mp3`
    )
  })

  it('joinUrl 容忍多余斜杠与空段', () => {
    expect(joinUrl(`${BASE}/`, '/Music/', '', 'a.mp3')).toBe(`${BASE}/Music/a.mp3`)
  })

  it('buildAuthHeader 对中文用户名做 UTF-8 编码', () => {
    const header = buildAuthHeader('张三', 'pwd')!
    expect(header.startsWith('Basic ')).toBe(true)
    // 逐字节还原 latin1 再按 UTF-8 解码（不用 Buffer，保持与实现同样的运行环境假设）
    const bin = atob(header.slice(6))
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    expect(new TextDecoder().decode(bytes)).toBe('张三:pwd')
  })

  it('无用户名口令时不产生鉴权头', () => {
    expect(buildAuthHeader(undefined, undefined)).toBeNull()
  })
})

describe('aurora-remote 播放地址', () => {
  it('构造与解析互为逆运算（含中文路径）', () => {
    const url = buildRemoteAudioUrl('lib-1', 'Music/Album One/反方向的钟.mp3')
    expect(url).toBe(
      'aurora-remote://lib-1/Music/Album%20One/%E5%8F%8D%E6%96%B9%E5%90%91%E7%9A%84%E9%92%9F.mp3'
    )
    expect(isRemoteAudioUrl(url)).toBe(true)
    expect(parseRemoteAudioUrl(url)).toEqual({ sourceId: 'lib-1', path: 'Music/Album One/反方向的钟.mp3' })
  })

  it('非本协议地址返回 null', () => {
    expect(parseRemoteAudioUrl('https://example.com/a.mp3')).toBeNull()
    expect(isRemoteAudioUrl('file:///tmp/a.mp3')).toBe(false)
  })

  it('存储坐标按来源隔离', () => {
    expect(storagePathFor('lib-1', 'Music/a.mp3')).toBe('webdav:lib-1/Music/a.mp3')
    expect(storagePathPrefix('lib-1')).toBe('webdav:lib-1/')
  })
})

describe('目录与文件过滤', () => {
  it('跳过群晖缩略图与隐藏目录', () => {
    expect(shouldSkipDir('@eaDir')).toBe(true)
    expect(shouldSkipDir('#recycle')).toBe(true)
    expect(shouldSkipDir('.git')).toBe(true)
    expect(shouldSkipDir('Music')).toBe(false)
  })

  it('识别音频扩展名（大小写不敏感）', () => {
    expect(isAudioFileName('a.MP3')).toBe(true)
    expect(isAudioFileName('a.flac')).toBe(true)
    expect(isAudioFileName('cover.jpg')).toBe(false)
    expect(isAudioFileName('noext')).toBe(false)
  })
})

/**
 * 时长修正的判定表。
 * 第 1 条用的是 music-metadata 10.9.1 的实测值（1000 帧 CBR MP3，只喂前 100 帧）：
 * 完整解析 26.122448979591837s，截断解析 2.6122448979591835s，恰好 1/10。
 */
describe('normalizeHeadParsedDuration', () => {
  const HEAD = 41700
  const TOTAL = 417000

  it('MPEG/CBR：按真实/已读长度等比还原', () => {
    const measured = 2.6122448979591835
    const fixed = normalizeHeadParsedDuration(
      { container: 'MPEG', codecProfile: 'CBR', numberOfSamples: 115200, duration: measured },
      HEAD,
      TOTAL
    )
    expect(fixed).toBeCloseTo(26.122448979591837, 9)
  })

  it('MPEG + Xing/LAME 头：时长来自文件头，必须原样保留（numberOfSamples 未设置）', () => {
    expect(
      normalizeHeadParsedDuration(
        { container: 'MPEG', codecProfile: 'VBR', numberOfSamples: undefined, duration: 271.5 },
        HEAD,
        TOTAL
      )
    ).toBe(271.5)
  })

  it('MPEG 无 Xing 的 VBR：时长按截断长度数帧得来，置 0 而不是留错误值', () => {
    expect(
      normalizeHeadParsedDuration(
        { container: 'MPEG', codecProfile: undefined, numberOfSamples: 115200, duration: 2.6 },
        HEAD,
        TOTAL
      )
    ).toBe(0)
  })

  it('未截断（整首都在文件头内）：直接采信解析结果', () => {
    expect(
      normalizeHeadParsedDuration({ container: 'MPEG', codecProfile: 'CBR', duration: 12.5 }, TOTAL, TOTAL)
    ).toBe(12.5)
  })

  it('非 MPEG 格式（FLAC 等）：时长来自格式头，与读取长度无关', () => {
    expect(
      normalizeHeadParsedDuration({ container: 'FLAC', duration: 300 }, HEAD, TOTAL)
    ).toBe(300)
  })

  it('服务器未报大小时（total 未知）不下手修正', () => {
    expect(
      normalizeHeadParsedDuration({ container: 'MPEG', codecProfile: 'CBR', duration: 2.6 }, HEAD, 0)
    ).toBe(2.6)
  })

  it('无时长时返回 0', () => {
    expect(normalizeHeadParsedDuration({ container: 'MPEG', codecProfile: 'CBR' }, HEAD, TOTAL)).toBe(0)
  })
})
