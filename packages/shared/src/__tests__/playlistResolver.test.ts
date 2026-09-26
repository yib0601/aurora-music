import {
  extractShareUrl,
  parsePlaylistLink,
  resolvePlaylistUrl,
} from '../playlistResolver'
import { playlistEndpointOf } from '../auroraPreset'
import { setCustomFetch } from '../fetchWithTimeout'
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
    await expect(
      parsePlaylistLink([makeSource({ sourceUrl: 'https://api.example/search?q={query}' })], SHARE_URL)
    ).rejects.toThrow(/尚未配置可解析歌单的音源/)
  })

  it('未启用的音源被跳过', async () => {
    await expect(
      parsePlaylistLink(
        [makeSource({ enabled: false, playlistUrl: 'https://api.example/playlist?url={url}' })],
        SHARE_URL
      )
    ).rejects.toThrow(/尚未配置可解析歌单的音源/)
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
    await expect(
      parsePlaylistLink([makeSource({ playlistUrl: 'https://a.example/playlist?url={url}' })], SHARE_URL)
    ).rejects.toThrow(/未返回任何歌曲/)
  })

  it('HTTP 非 2xx 时抛出带状态码的错误', async () => {
    setCustomFetch(async () => jsonResponse({ error: 'nope' }, 500))
    await expect(
      parsePlaylistLink([makeSource({ playlistUrl: 'https://a.example/playlist?url={url}' })], SHARE_URL)
    ).rejects.toThrow(/HTTP 500/)
  })
})
