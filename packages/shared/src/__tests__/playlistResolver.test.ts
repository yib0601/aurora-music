import {
  extractShareUrl,
  parsePlaylistLink,
  resolvePlaylistUrl,
} from '../playlistResolver'
import { playlistEndpointOf } from '../auroraPreset'
import { setCustomFetch } from '../fetchWithTimeout'
import { expectCode, rejectionOf } from './i18nAssert'
import type { OnlineSourceConfig } from '../types'

const SHARE_URL = 'https://y.qq.com/n/ryqq/playlist/7344515327'

/** 造一条音源（默认无音源地址，只有歌单解析能力） */
function makeSource(partial: Partial<OnlineSourceConfig>): OnlineSourceConfig {
  return { id: 'src-1', name: '我的音源', sourceUrl: '', enabled: true, ...partial }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

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

describe('playlistEndpointOf（执行时解析）', () => {
  it('接口模板形态：取手填的歌单解析地址', () => {
    const s = makeSource({
      sourceUrl: 'https://api.example/search?q={query}',
      playlistUrl: 'https://api.example/playlist?url={url}',
    })
    expect(playlistEndpointOf(s)).toBe('https://api.example/playlist?url={url}')
  })

  it('只有搜索接口的音源不具备歌单解析能力', () => {
    expect(playlistEndpointOf(makeSource({ sourceUrl: 'https://api.example/search?q={query}' }))).toBe('')
  })

  it('服务地址形态：歌单端点由协议派生，不必手填', () => {
    const s = makeSource({ sourceUrl: 'https://music.example.com?key=K1' })
    expect(playlistEndpointOf(s)).toBe(
      'https://music.example.com/aurora/playlist?url={url}&key=K1'
    )
  })

  it('服务端自描述的端点模板优先于默认约定', () => {
    const s = makeSource({
      sourceUrl: 'https://music.example.com',
      endpoints: { playlist: '/v2/playlist?u={url}' },
    })
    expect(playlistEndpointOf(s)).toBe('https://music.example.com/v2/playlist?u={url}')
  })

  it('只做歌单解析的音源：音源地址留空，取手填地址', () => {
    const s = makeSource({ sourceUrl: '', playlistUrl: 'https://api.example/resolve?url={url}' })
    expect(playlistEndpointOf(s)).toBe('https://api.example/resolve?url={url}')
  })

  it('playlistUrl 不含 {url} 时不当作有效解析地址', () => {
    expect(playlistEndpointOf(makeSource({ playlistUrl: 'https://api.example/playlist' }))).toBe('')
  })

  it('未配置任何源时安全返回空串', () => {
    expect(playlistEndpointOf(null)).toBe('')
    expect(playlistEndpointOf(undefined)).toBe('')
  })
})

describe('parsePlaylistLink（音源合并后）', () => {
  afterEach(() => setCustomFetch(null))

  it('同一条音源的搜索与歌单解析接口各司其职：解析走 playlistUrl', async () => {
    const seen: string[] = []
    setCustomFetch(async (input) => {
      seen.push(String(input))
      return jsonResponse({ name: '华语精选', songs: [{ title: '七里香', artist: '周杰伦' }] })
    })
    const source = makeSource({
      sourceUrl: 'https://api.example/search?q={query}',
      playlistUrl: 'https://api.example/playlist?url={url}',
    })
    const out = await parsePlaylistLink([source], SHARE_URL)
    expect(seen).toEqual(['https://api.example/playlist?url=' + encodeURIComponent(SHARE_URL)])
    expect(out).toEqual({ name: '华语精选', songs: [{ title: '七里香', artist: '周杰伦' }] })
  })

  it('服务地址形态：解析直接打到派生的歌单端点', async () => {
    let called = ''
    setCustomFetch(async (input) => {
      called = String(input)
      return jsonResponse({ songs: [{ title: '七里香', artist: '周杰伦' }] })
    })
    await parsePlaylistLink([makeSource({ sourceUrl: 'https://music.example.com?key=K1' })], SHARE_URL)
    expect(called).toBe(
      `https://music.example.com/aurora/playlist?url=${encodeURIComponent(SHARE_URL)}&key=K1`
    )
  })

  it('解析接口地址里的 {url} 会被 URL 编码后的分享链接替换', async () => {
    let called = ''
    setCustomFetch(async (input) => {
      called = String(input)
      return jsonResponse([{ title: '晴天', artist: ['周杰伦', '其他'] }])
    })
    const out = await resolvePlaylistUrl(
      makeSource({ playlistUrl: 'https://api.example/resolve?url={url}&key=abc' }),
      SHARE_URL
    )
    expect(called).toBe(`https://api.example/resolve?url=${encodeURIComponent(SHARE_URL)}&key=abc`)
    expect(out.name).toBe('')
    // 数组形式的 artist 用 / 连接（与响应宽松解析一致）
    expect(out.songs[0]).toEqual({ title: '晴天', artist: '周杰伦/其他' })
  })

  it('只有搜索接口的音源不参与解析，给出可读提示', async () => {
    const err = await rejectionOf(
      parsePlaylistLink([makeSource({ sourceUrl: 'https://api.example/search?q={query}' })], SHARE_URL)
    )
    expectCode(err, 'core.error.playlistNoSource')
  })

  it('未启用的音源被跳过', async () => {
    const err = await rejectionOf(
      parsePlaylistLink(
        [makeSource({ enabled: false, playlistUrl: 'https://api.example/playlist?url={url}' })],
        SHARE_URL
      )
    )
    expectCode(err, 'core.error.playlistNoSource')
  })

  it('只做歌单解析的音源（音源地址留空）仍可解析', async () => {
    const onlyPlaylist = makeSource({
      sourceUrl: '',
      playlistUrl: 'https://old.example/resolve?url={url}',
    })
    setCustomFetch(async () =>
      jsonResponse({ data: { name: '旧歌单', songs: [{ name: '夜曲', singer: '周杰伦' }] } })
    )
    const out = await parsePlaylistLink([onlyPlaylist], SHARE_URL)
    expect(out.name).toBe('旧歌单')
    expect(out.songs[0]).toEqual({ title: '夜曲', artist: '周杰伦' })
  })

  it('首个源失败时按顺序尝试下一个源', async () => {
    let n = 0
    setCustomFetch(async () => {
      n += 1
      if (n === 1) return jsonResponse({ error: '解析失败' }, 502)
      return jsonResponse([{ title: '稻香', artist: '周杰伦' }])
    })
    const out = await parsePlaylistLink(
      [
        makeSource({ id: 'a', name: '源A', playlistUrl: 'https://a.example/playlist?url={url}' }),
        makeSource({ id: 'b', name: '源B', playlistUrl: 'https://b.example/playlist?url={url}' }),
      ],
      SHARE_URL
    )
    expect(n).toBe(2)
    expect(out.songs[0].title).toBe('稻香')
  })

  it('响应里没有歌曲条目时抛错', async () => {
    setCustomFetch(async () => jsonResponse({ songs: [] }))
    const err = await rejectionOf(
      parsePlaylistLink([makeSource({ playlistUrl: 'https://a.example/playlist?url={url}' })], SHARE_URL)
    )
    expectCode(err, 'core.error.playlistEmpty', { name: '我的音源' })
  })

  it('HTTP 非 2xx 时抛出带状态码的错误', async () => {
    setCustomFetch(async () => jsonResponse({ error: 'nope' }, 500))
    const err = await rejectionOf(
      parsePlaylistLink([makeSource({ playlistUrl: 'https://a.example/playlist?url={url}' })], SHARE_URL)
    )
    expectCode(err, 'core.error.playlistHttpStatus', { name: '我的音源', status: 500 })
  })

  // ── 扩展字段（专辑 / 时长 / 封面 / songmid）：歌单详情页的时长与序号靠它们 ──
  // 回归背景：协议最初只归一 title/artist，音源服务补齐 album/duration/coverUrl/songmid 后，
  // 歌单详情页仍只显示歌名 + 歌手（榜单页一直是全字段）。
  it('新版音源服务给的扩展字段原样带出', async () => {
    setCustomFetch(async () =>
      jsonResponse({
        name: '甜度爆表 | 旋律说唱狙击少女心',
        songs: [
          {
            title: '你的',
            artist: 'DouDou/Viva宋佩豫',
            album: '你的',
            duration: 163,
            coverUrl: 'https://y.gtimg.cn/music/photo_new/T002R300x300M0000023VbHy1oT80v_3.jpg',
            songmid: '002xTzGb2UBQRk',
          },
        ],
      })
    )
    const out = await parsePlaylistLink(
      [makeSource({ playlistUrl: 'https://api.example/playlist?url={url}' })],
      SHARE_URL
    )
    expect(out.songs[0]).toEqual({
      title: '你的',
      artist: 'DouDou/Viva宋佩豫',
      album: '你的',
      duration: 163,
      coverUrl: 'https://y.gtimg.cn/music/photo_new/T002R300x300M0000023VbHy1oT80v_3.jpg',
      songmid: '002xTzGb2UBQRk',
    })
  })

  it('老音源只回最小集时字段直接缺席，不补空串 / 0', async () => {
    setCustomFetch(async () => jsonResponse([{ title: '晴天', artist: '周杰伦' }]))
    const out = await parsePlaylistLink(
      [makeSource({ playlistUrl: 'https://api.example/playlist?url={url}' })],
      SHARE_URL
    )
    expect(out.songs[0]).toEqual({ title: '晴天', artist: '周杰伦' })
    // 「源没给」必须与「源给了空值」可区分：歌单页据此隐藏时长列
    expect('duration' in out.songs[0]).toBe(false)
    expect('album' in out.songs[0]).toBe(false)
  })

  it('专辑三种形状（字符串 / album.name / albumname）与封面两个位置都认', async () => {
    setCustomFetch(async () =>
      jsonResponse({
        songs: [
          // 酷我：album 是字符串、duration 是秒
          { title: '夜曲', artist: '周杰伦', album: '十一月的萧邦', duration: 227, pic: 'https://img4.kuwo.cn/c/1.jpg' },
          // QQ：album 是对象、时长在 interval、曲目 id 在 mid
          { title: '你的', artist: 'DouDou', album: { name: '你的' }, interval: 163, mid: '002xTzGb2UBQRk' },
          // 网易云：封面在 album.picUrl、曲目 id 在 id
          { title: '起风了', artist: '买辣椒也用券', album: { name: '起风了', picUrl: 'https://p1.music.126.net/1.jpg' }, duration: 325, id: 1001 },
          // 老式字段名 + 时长为 0（视为源没给）
          { title: '旧曲', artist: '旧歌手', albumname: '旧专辑', duration: 0 },
        ],
      })
    )
    const out = await parsePlaylistLink(
      [makeSource({ playlistUrl: 'https://api.example/playlist?url={url}' })],
      SHARE_URL
    )
    expect(out.songs[0]).toMatchObject({ album: '十一月的萧邦', duration: 227, coverUrl: 'https://img4.kuwo.cn/c/1.jpg' })
    expect(out.songs[1]).toMatchObject({ album: '你的', duration: 163, songmid: '002xTzGb2UBQRk' })
    expect(out.songs[2]).toMatchObject({ album: '起风了', duration: 325, coverUrl: 'https://p1.music.126.net/1.jpg', songmid: '1001' })
    expect(out.songs[3].album).toBe('旧专辑')
    expect(out.songs[3].duration).toBeUndefined()
  })
})
