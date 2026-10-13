import {
  extractShareUrl,
  parsePlaylistLink,
  resolvePlaylistUrl,
} from '../playlistResolver'
import { playlistEndpointOf } from '../auroraPreset'
import { setCustomFetch } from '../fetchWithTimeout'
import { expectCode, rejectionOf } from './i18nAssert'
import type { OnlineSourceConfig } from '../types'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
      'https://music.example.com/aurora/playlist?url={url}&limit={limit}&key=K1'
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

  // ── 首屏 limit 与 truncated（服务端 ?limit= 协议） ──
  // 背景：大歌单（实测 647 首）上游一次要吐 ~1.1MB，服务端因此提供 ?limit= 让客户端
  // 先取一页渲染首屏；`truncated` 是「要不要再补一次全量」的判据。
  it('limit 填进端点模板的 {limit} 占位符', async () => {
    let called = ''
    setCustomFetch(async (input) => {
      called = String(input)
      return jsonResponse({ songs: [{ title: '七里香', artist: '周杰伦' }] })
    })
    await parsePlaylistLink(
      [
        makeSource({
          sourceUrl: 'https://music.example.com',
          endpoints: { playlist: '/aurora/playlist?url={url}&limit={limit}' },
        }),
      ],
      SHARE_URL,
      { limit: 200 }
    )
    expect(called).toBe(
      `https://music.example.com/aurora/playlist?url=${encodeURIComponent(SHARE_URL)}&limit=200`
    )
  })

  it('不传 limit 时把 {limit} 占位参数整段剔除，不把字面量发给服务端', async () => {
    let called = ''
    setCustomFetch(async (input) => {
      called = String(input)
      return jsonResponse([{ title: '晴天', artist: '周杰伦' }])
    })
    await parsePlaylistLink(
      [
        makeSource({
          sourceUrl: 'https://music.example.com',
          endpoints: { playlist: '/aurora/playlist?url={url}&limit={limit}' },
        }),
      ],
      SHARE_URL
    )
    expect(called).toBe(
      `https://music.example.com/aurora/playlist?url=${encodeURIComponent(SHARE_URL)}`
    )
    expect(called).not.toContain('{limit}')
  })

  it('limit 非法（0 / 负数 / 非数字）视同不传', async () => {
    const seen: string[] = []
    setCustomFetch(async (input) => {
      seen.push(String(input))
      return jsonResponse([{ title: '晴天', artist: '周杰伦' }])
    })
    const source = makeSource({
      sourceUrl: 'https://music.example.com',
      endpoints: { playlist: '/aurora/playlist?url={url}&limit={limit}' },
    })
    for (const limit of [0, -5, Number.NaN]) {
      await parsePlaylistLink([source], SHARE_URL, { limit })
    }
    expect(seen).toHaveLength(3)
    for (const url of seen) {
      expect(url).not.toContain('limit')
      expect(url).not.toContain('{limit}')
    }
  })

  it('源回了 truncated 才带出该字段（老源不给 → 缺省视为全量）', async () => {
    setCustomFetch(async () =>
      jsonResponse({
        name: '甜度爆表 | 旋律说唱狙击少女心',
        songs: [{ title: '你的', artist: 'DouDou' }],
        total: 647,
        truncated: true,
      })
    )
    const cut = await parsePlaylistLink(
      [makeSource({ playlistUrl: 'https://api.example/playlist?url={url}' })],
      SHARE_URL,
      { limit: 200 }
    )
    expect(cut.truncated).toBe(true)

    setCustomFetch(async () => jsonResponse({ songs: [{ title: '你的', artist: 'DouDou' }] }))
    const plain = await parsePlaylistLink(
      [makeSource({ playlistUrl: 'https://api.example/playlist?url={url}' })],
      SHARE_URL
    )
    expect('truncated' in plain).toBe(false)
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

/**
 * 对冲调度（延迟对冲取代了旧的逐源串行）的语义回归。
 *
 * 改造前是 `for (const source of enabled) await resolvePlaylistUrl(...)`：失败耗时按源数
 * 累加，单源超时 15s、三个源全挂最坏 45s。改成对冲后必须钉住三件事：优先级没丢、
 * 累计等待确实消失、全部失败时抛的仍是「最后试过的那一个」的错误。
 *
 * 这里用**真实的计时**（上游桩里 sleep 一段）而不是假计时器：被验证的性质就是
 * 「谁先被启动、什么时刻被启动」，假计时器要手工推进到恰好 tick 才不 flaky。
 * 每档的延时都在 10~60ms 量级，与 1000ms 的对冲窗口拉开两个数量级，判据稳定。
 */
describe('parsePlaylistLink：对冲调度', () => {
  afterEach(() => {
    setCustomFetch(null)
    vi.restoreAllMocks()
  })

  /** 上游桩：按 URL 里的 tag 决定延时与响应，并记录每次请求的时刻 */
  function installTimedUpstream(spec: Record<string, { ms: number; body?: unknown; status?: number }>) {
    const t0 = Date.now()
    const started: Array<{ tag: string; at: number }> = []
    setCustomFetch(async (input) => {
      const url = String(input)
      const tag = /tag=([^&]*)/.exec(url)?.[1] || ''
      started.push({ tag, at: Date.now() - t0 })
      const rule = spec[tag] || { ms: 0 }
      if (rule.ms) await new Promise((r) => setTimeout(r, rule.ms))
      return jsonResponse(rule.body ?? { songs: [{ title: `歌-${tag}`, artist: '手' }] }, rule.status ?? 200)
    })
    return started
  }

  const tagSource = (tag: string) =>
    makeSource({ id: tag, name: tag, playlistUrl: `https://api.example/playlist?url={url}&tag=${tag}` })

  it('首源在窗口内成功时，后续源根本不发请求（优先级不被网络快慢颠倒）', async () => {
    const started = installTimedUpstream({ a: { ms: 20 } })
    const out = await parsePlaylistLink([tagSource('a'), tagSource('b'), tagSource('c')], SHARE_URL)
    expect(out.songs[0].title).toBe('歌-a')
    expect(started.map((s) => s.tag)).toEqual(['a'])
  })

  it('首源迟迟不定时并行启动下一源，先回来的胜出（等待不再累加）', async () => {
    // a 永不返回（可控 deferred），b 20ms 就回 —— 若仍是串行，本用例会一直等到 a 的超时
    const started: string[] = []
    let releaseA: () => void = () => {}
    setCustomFetch(async (input) => {
      const tag = /tag=([^&]*)/.exec(String(input))?.[1] || ''
      started.push(tag)
      if (tag === 'a') await new Promise<void>((resolve) => (releaseA = resolve))
      else await new Promise((r) => setTimeout(r, 20))
      return jsonResponse({ songs: [{ title: `歌-${tag}`, artist: '手' }] })
    })
    const t0 = Date.now()
    const out = await parsePlaylistLink([tagSource('a'), tagSource('b')], SHARE_URL)
    const elapsed = Date.now() - t0
    expect(out.songs[0].title).toBe('歌-b')
    // 对冲窗口 1000ms + b 的 20ms：耗时必须是「一个窗口」量级，而不是 a 的整个超时窗口
    expect(elapsed).toBeLessThan(3000)
    expect(started).toEqual(['a', 'b'])
    releaseA()
  })

  it('首源失败立刻推进下一源，不白等一个对冲窗口', async () => {
    const started = installTimedUpstream({
      a: { ms: 0, status: 500 },
      b: { ms: 0, body: { songs: [{ title: '歌-b', artist: '手' }] } },
    })
    const t0 = Date.now()
    const out = await parsePlaylistLink([tagSource('a'), tagSource('b')], SHARE_URL)
    expect(out.songs[0].title).toBe('歌-b')
    expect(started.map((s) => s.tag)).toEqual(['a', 'b'])
    // 落空后是同一次微任务链上推进的，第二个请求必须在毫秒级出现
    expect(started[1].at).toBeLessThan(500)
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('全部失败时抛最后试过的那一个源的错误（与旧串行版口径一致）', async () => {
    // a 返回 500 -> 抛 playlistHttpStatus(name=a)；b 返回空歌单 -> 抛 playlistEmpty(name=b)
    installTimedUpstream({
      a: { ms: 0, status: 500 },
      b: { ms: 0, body: { songs: [] } },
    })
    const err = await rejectionOf(parsePlaylistLink([tagSource('a'), tagSource('b')], SHARE_URL))
    expectCode(err, 'core.error.playlistEmpty', { name: 'b' })
  })

  it('失败原因按**配置顺序**取，不随完成顺序漂移（并发下的确定性）', async () => {
    // 关键构造：让 a **慢到超过对冲窗口**（1500ms > 1000ms）。于是 b 在 1000ms 被对冲启动、
    // 立刻失败；a 要到 1500ms 才失败 —— 完成顺序 b → a，与配置顺序 a → b 恰好相反。
    //
    // 这个构造是必须的：若 a 只慢 300ms（未超过窗口），b 会在 a 失败**之后**才被启动，
    // 完成顺序就退化成与配置顺序一致，两种实现（按下标记位 / 按完成顺序 push）结果相同，
    // 用例便没有区分力。此处的时刻差已实测确认（改前实测会抛 a 的 playlistHttpStatus）。
    const started = installTimedUpstream({
      a: { ms: 1500, status: 500 },
      b: { ms: 0, body: { songs: [] } },
    })
    const err = await rejectionOf(parsePlaylistLink([tagSource('a'), tagSource('b')], SHARE_URL))
    // 按配置顺序取「最后尝试过的源」= b；按完成顺序取末项会得到 a
    expectCode(err, 'core.error.playlistEmpty', { name: 'b' })
    expect(started.map((s) => s.tag)).toEqual(['a', 'b'])
  })

  it('三个源全失败时抛的是配置顺序上的第三个（而非最快失败的那个）', async () => {
    // 失败耗时与配置顺序**完全相反**：越靠前的源越慢才失败
    installTimedUpstream({
      a: { ms: 60, status: 503 },
      b: { ms: 20, status: 502 },
      c: { ms: 0, status: 500 },
    })
    const err = await rejectionOf(
      parsePlaylistLink([tagSource('a'), tagSource('b'), tagSource('c')], SHARE_URL)
    )
    expectCode(err, 'core.error.playlistHttpStatus', { name: 'c', status: 500 })
  })

  it('同时在途的源不超过上限 3（第 4 个源要等前一个落空）', async () => {
    // 四个源都「永不返回」：前 3 个被启动后，第 4 个必须等某个在途档让位才有机会。
    // 用可控 deferred 而非定时器，测完由用例显式放行，不留悬挂的异步任务。
    const started: string[] = []
    const gates: Array<() => void> = []
    setCustomFetch(async (input) => {
      const tag = /tag=([^&]*)/.exec(String(input))?.[1] || ''
      started.push(tag)
      await new Promise<void>((resolve) => gates.push(resolve))
      return jsonResponse({ songs: [{ title: `歌-${tag}`, artist: '手' }] })
    })

    const task = parsePlaylistLink(
      [tagSource('a'), tagSource('b'), tagSource('c'), tagSource('d')],
      SHARE_URL
    )
    // 等过两轮对冲窗口（1000ms × 2）：a/b/c 应已在途，第 4 档被 maxInFlight 挡住
    await new Promise((r) => setTimeout(r, 2400))
    expect(started).toEqual(['a', 'b', 'c'])

    // 放行 a → 它成功返回，整体收场；此时第 4 档仍不该被启动
    gates[0]()
    const out = await task
    expect(out.songs[0].title).toBe('歌-a')
    await new Promise((r) => setTimeout(r, 50))
    expect(started).toEqual(['a', 'b', 'c'])
    // 清掉仍在挂的 b / c，避免它们的请求跨用例存活
    gates.slice(1).forEach((open) => open())
  })
})
