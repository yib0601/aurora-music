/**
 * 歌词聚合的对冲调度回归。
 *
 * 改造前是 `for (const source of sources) await searchLyricsSource(...)`：耗时按源数累加，
 * 单源超时 8s（LYRICS_TIMEOUT_MS），用户配三个源 + 内置 LRCLIB 时最坏 32s 才出「无歌词」。
 * 对冲后必须钉住四件事：
 *   1. **优先级**：第一档在窗口内命中时，后面的源一个请求都不该发；
 *   2. **内置兜底的位置**：LRCLIB 永远排在用户源之后，因此「用户源先在窗口内命中」时
 *      内置源不该被打扰，但用户源全空时要轮到它；
 *   3. **命中即收场**：后面的源不必等；
 *   4. 全空时返回 null（而不是抛错）——调用方据此展示「无歌词」。
 *
 * 真实计时器：被验证的性质就是「谁在什么时刻被启动」，与 600ms 的对冲窗口之间
 * 拉开两个数量级（用例延时 10~30ms），判据稳定。
 */
import { searchLyrics, searchLyricsSource, BUILTIN_LYRICS_GET_SOURCE, BUILTIN_LYRICS_SOURCE } from '../lyricsSource'
import { setCustomFetch } from '../fetchWithTimeout'
import type { LyricsSourceConfig } from '../types'
import { expectCode, rejectionOf } from './i18nAssert'

/** 上游桩：按 URL 里的 tag 决定延时 / 响应；tag 为空视为内置源（LRCLIB） */
function installTimedUpstream(spec: Record<string, { ms?: number; body?: unknown; status?: number }>) {
  const started: string[] = []
  setCustomFetch(async (input) => {
    const url = String(input)
    const tag = /tag=([^&]*)/.exec(url)?.[1] || (url.includes('lrclib') ? 'builtin' : '')
    started.push(tag)
    const rule = spec[tag] || {}
    if (rule.ms) await new Promise((r) => setTimeout(r, rule.ms))
    return new Response(JSON.stringify(rule.body ?? []), {
      status: rule.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return started
}

const userSource = (tag: string): LyricsSourceConfig => ({
  id: tag,
  name: tag,
  sourceUrl: `https://api.example/lyrics?track={track}&artist={artist}&tag=${tag}`,
  enabled: true,
})

/** 一条带同步歌词的命中响应（toCandidate 认 syncedLyrics） */
const hitBody = (tag: string) => [
  { trackName: `歌-${tag}`, artistName: '手', syncedLyrics: `[00:01.00]词-${tag}`, duration: 200 },
]

describe('searchLyrics：对峙与兜底', () => {
  afterEach(() => setCustomFetch(null))

  it('空查询直接返回 null，不发任何请求', async () => {
    const started = installTimedUpstream({})
    expect(await searchLyrics('   ')).toBeNull()
    expect(started).toEqual([])
  })

  it('第一档在窗口内命中时，后面的用户源与内置源都不发请求', async () => {
    const started = installTimedUpstream({ a: { ms: 20, body: hitBody('a') } })
    const out = await searchLyrics('歌', '手', undefined, 200, {
      sources: [userSource('a'), userSource('b'), userSource('c')],
    })
    expect(out?.lrc).toBe('[00:01.00]词-a')
    expect(started).toEqual(['a'])
  })

  it('用户源全空时轮到内置 LRCLIB 兜底', async () => {
    const started = installTimedUpstream({
      a: { ms: 0, body: [] },
      b: { ms: 0, body: [] },
      builtin: { ms: 0, body: hitBody('builtin') },
    })
    const out = await searchLyrics('歌', '手', undefined, 200, { sources: [userSource('a'), userSource('b')] })
    expect(out?.lrc).toBe('[00:01.00]词-builtin')
    // 两个用户源落空后必然轮到内置源（顺序语义：兜底永远在最后）
    expect(started).toEqual(['a', 'b', 'builtin'])
  })

  it('用户源迟迟不定时并行启动下一档，先回来的胜出（等待不累加）', async () => {
    const started: string[] = []
    let releaseA: () => void = () => {}
    setCustomFetch(async (input) => {
      const tag = /tag=([^&]*)/.exec(String(input))?.[1] || ''
      started.push(tag)
      if (tag === 'a') await new Promise<void>((resolve) => (releaseA = resolve))
      else await new Promise((r) => setTimeout(r, 10))
      return new Response(JSON.stringify(hitBody(tag)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const t0 = Date.now()
    const out = await searchLyrics('歌', '手', undefined, 200, { sources: [userSource('a'), userSource('b')] })
    expect(out?.lrc).toBe('[00:01.00]词-b')
    // 600ms 对冲窗口 + 10ms：量级必须是「一个窗口」，不是 a 的整个超时窗口
    expect(Date.now() - t0).toBeLessThan(2500)
    expect(started).toEqual(['a', 'b'])
    releaseA()
  })

  it('单源抛错（HTTP 5xx）不中断，后续源照常命中', async () => {
    const started = installTimedUpstream({
      a: { ms: 0, status: 502 },
      b: { ms: 0, body: hitBody('b') },
    })
    const out = await searchLyrics('歌', '手', undefined, 200, { sources: [userSource('a'), userSource('b')] })
    expect(out?.lrc).toBe('[00:01.00]词-b')
    expect(started).toEqual(['a', 'b'])
  })

  it('全部无命中时返回 null（不抛错，调用方据此展示无歌词）', async () => {
    installTimedUpstream({ a: { ms: 0, body: [] }, b: { ms: 0, body: [] }, builtin: { ms: 0, body: [] } })
    const out = await searchLyrics('歌', '手', undefined, 200, { sources: [userSource('a'), userSource('b')] })
    expect(out).toBeNull()
  })

  it('未配置任何用户源时只打内置源，且候选里不会重复内置源', async () => {
    const started = installTimedUpstream({ builtin: { ms: 0, body: hitBody('builtin') } })
    const out = await searchLyrics('歌', '手', undefined, 200, {
      // 即便调用方把内置源也塞进 sources，也要被过滤掉、不出现两次
      sources: [{ ...BUILTIN_LYRICS_SOURCE, enabled: true }],
    })
    expect(out?.lrc).toBe('[00:01.00]词-builtin')
    expect(started).toEqual(['builtin'])
  })

  it('未启用的用户源被过滤，不参与调度', async () => {
    const started = installTimedUpstream({ builtin: { ms: 0, body: hitBody('builtin') } })
    await searchLyrics('歌', '手', undefined, 200, {
      sources: [{ ...userSource('off'), enabled: false }],
    })
    expect(started).toEqual(['builtin'])
  })
})

/**
 * 地址组装：空值占位符必须**整段剔除**。
 *
 * 这是另一处静默失效点：留成 `artist_name=` / `duration=` 不会报错，但上游把它当成
 * **错误**而不是「没这个条件」—— LRCLIB 实测 `artist_name=` 回 503 ServerOverloaded、
 * `duration=` 回 400 `cannot parse float from empty string`。本地曲目缺艺术家/专辑/
 * 时长是常态，所以空值必须是「不传这个参数」的语义。
 *
 * 全部走 setCustomFetch 打桩，零真实网络（第三方地址一律 example.test 这类假值）。
 */
describe('searchLyricsSource：空值占位符剔除', () => {
  afterEach(() => setCustomFetch(null))

  /** 打桩并记录每次请求的完整地址 */
  function recordCalls(handler: (url: string) => Response): string[] {
    const calls: string[] = []
    setCustomFetch(async (input) => {
      const url = String(input)
      calls.push(url)
      return handler(url)
    })
    return calls
  }

  const empty = (): Response =>
    new Response(JSON.stringify({ message: 'no lyrics' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  it('内置精确取词源：歌手/专辑/时长全缺时不留空参数，也不留尾随 ? 或 &', async () => {
    const calls = recordCalls(empty)
    await searchLyricsSource(BUILTIN_LYRICS_GET_SOURCE, '你听得到')
    await searchLyricsSource(BUILTIN_LYRICS_GET_SOURCE, '你听得到', '', '', 0)
    expect(calls).toEqual([
      'https://lrclib.net/api/get?track_name=%E4%BD%A0%E5%90%AC%E5%BE%97%E5%88%B0',
      'https://lrclib.net/api/get?track_name=%E4%BD%A0%E5%90%AC%E5%BE%97%E5%88%B0',
    ])
  })

  it('时长只在大于 0 时出现，负数与 0 都按「没有」处理', async () => {
    const calls = recordCalls(empty)
    await searchLyricsSource(BUILTIN_LYRICS_GET_SOURCE, 't', 'a', 'b', -3)
    await searchLyricsSource(BUILTIN_LYRICS_GET_SOURCE, 't', 'a', 'b', 245.6)
    expect(calls).toEqual([
      'https://lrclib.net/api/get?track_name=t&artist_name=a&album_name=b',
      'https://lrclib.net/api/get?track_name=t&artist_name=a&album_name=b&duration=246',
    ])
  })

  it('内置模糊检索源：空歌手不落地（回归 /api/search?artist_name= 导致 503 的根因）', async () => {
    const calls = recordCalls(empty)
    await searchLyricsSource(BUILTIN_LYRICS_SOURCE, 't', '', '')
    expect(calls).toEqual(['https://lrclib.net/api/search?track_name=t'])
  })

  it('{track} 与 {query} 走同一套剔除语义（第三方源常写 track_name={query}）', async () => {
    const calls = recordCalls(empty)
    await searchLyricsSource(
      {
        id: 'custom',
        name: '第三方源',
        sourceUrl: 'https://api.example.test/lyric?track_name={query}&artist={artist}&dur={duration}',
        enabled: true,
      },
      't',
      '',
      '',
      undefined
    )
    expect(calls).toEqual(['https://api.example.test/lyric?track_name=t'])
  })

  it('模板不含 {track}/{query} 时仍抛结构化错误（前置校验不被剔除逻辑吃掉）', async () => {
    recordCalls(empty)
    const err = await rejectionOf(
      searchLyricsSource(
        { id: 'bad', name: '坏源', sourceUrl: 'https://api.example.test/lyric?artist={artist}', enabled: true },
        't',
        'a'
      )
    )
    expectCode(err, 'core.error.lyricsUrlNoPlaceholder', {
      name: '坏源',
      track: '{track}',
      query: '{query}',
    })
  })

  it('多条候选仍优先带同步歌词者（不因时长更接近而选纯文本）', async () => {
    recordCalls(
      () =>
        new Response(
          JSON.stringify({
            results: [
              { trackName: 't', artistName: 'a', duration: 240, plainLyrics: 'plain' },
              { trackName: 't', artistName: 'a', duration: 200, syncedLyrics: '[00:01.00]synced' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    const picked = await searchLyricsSource(BUILTIN_LYRICS_SOURCE, 't', 'a', '', 239)
    expect(picked?.lrc).toBe('[00:01.00]synced')
  })

  it('503 抛带源名的结构化错误（空参数那条 503 的对外表现）', async () => {
    recordCalls(
      () =>
        new Response(JSON.stringify({ name: 'ServerOverloaded' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
    )
    const err = await rejectionOf(searchLyricsSource(BUILTIN_LYRICS_GET_SOURCE, 't', 'a'))
    expectCode(err, 'core.error.lyricsHttpStatus', { name: 'LRCLIB', status: 503 })
  })
})

/**
 * 内置源顺序：精确取词（/api/get）必须排在模糊检索（/api/search）之前。
 *
 * 顺序错了不报错，只是先等一轮 154KB / p50 3~7s 的模糊检索；命中时 /api/get 只有
 * 7.7KB / p50 1~2s。所以既钉「谁在前」，也钉「参数不匹配时的 404 会回落」。
 */
describe('内置源顺序：精确取词优先、模糊检索兜底', () => {
  afterEach(() => setCustomFetch(null))

  const GET_URL = 'https://lrclib.net/api/get?track_name=t&artist_name=a'
  const SEARCH_URL = 'https://lrclib.net/api/search?track_name=t&artist_name=a'

  it('精确取词命中时不再启动模糊检索（优先级不等于「都发一遍」）', async () => {
    const calls: string[] = []
    setCustomFetch(async (input) => {
      calls.push(String(input))
      return new Response(
        JSON.stringify({ trackName: 't', artistName: 'a', syncedLyrics: '[00:01.00]a' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
    const hit = await searchLyrics('t', 'a')
    expect(hit?.lrc).toBe('[00:01.00]a')
    expect(calls).toEqual([GET_URL])
  })

  it('精确取词 404（album 不匹配）后仍走模糊检索兜底', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls: string[] = []
    setCustomFetch(async (input) => {
      const url = String(input)
      calls.push(url)
      return url === GET_URL
        ? new Response(JSON.stringify({ message: 'Not Found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(
            JSON.stringify({ trackName: 't', artistName: 'a', syncedLyrics: '[00:01.00]a' }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
    })
    const hit = await searchLyrics('t', 'a')
    expect(hit?.lrc).toBe('[00:01.00]a')
    expect(calls.indexOf(GET_URL)).toBe(0)
    expect(calls.indexOf(SEARCH_URL)).toBeGreaterThan(0)
    warn.mockRestore()
  })

  it('全部落空时按「用户源 → 精确取词 → 模糊检索」顺序启动，两档内置都要轮到', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls: string[] = []
    setCustomFetch(async (input) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ message: 'no lyrics' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    await expect(
      searchLyrics('t', 'a', 'alb', 200, {
        sources: [
          { id: 'custom', name: '第三方源', sourceUrl: 'https://api.example.test/l?t={track}&tag=x', enabled: true },
        ],
      })
    ).resolves.toBeNull()
    // 落空会立刻推进下一档，与时序无关，因此顺序断言在这里是稳定的
    expect(calls).toEqual([
      'https://api.example.test/l?t=t&tag=x',
      'https://lrclib.net/api/get?track_name=t&artist_name=a&album_name=alb&duration=200',
      SEARCH_URL,
    ])
    warn.mockRestore()
  })

  it('用户配置里塞了两个内置源时被过滤，不放大请求数', async () => {
    const calls: string[] = []
    setCustomFetch(async (input) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ message: 'no lyrics' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    await searchLyrics('t', 'a', undefined, undefined, {
      sources: [BUILTIN_LYRICS_SOURCE, BUILTIN_LYRICS_GET_SOURCE],
    })
    expect(calls.filter((u) => u.startsWith('https://lrclib.net/api/get'))).toHaveLength(1)
    expect(calls.filter((u) => u.startsWith('https://lrclib.net/api/search'))).toHaveLength(1)
  })
})

/**
 * 纯空白歌词不得算命中。
 *
 * 上游会对部分曲目返回空壳记录（实测 LRCLIB 给 `{"syncedLyrics":"   \n  "}`）。
 * 判成命中的后果是三重放大：① 返回空白串 → 调用方解析出 0 行 → UI 落「暂无歌词」；
 * ② 聚合层认为已命中，不再回落 /api/search 兜底；③ 这份空白被写成本地 .lrc，
 * 此后永远走本地缓存命中 → 永久空态。
 *
 * 另一条红线：**判定用 trim，返回内容不 trim**。正常歌词的首尾空行与缩进都属于内容，
 * 自作主张 trim 会把它们吃掉。
 */
describe('纯空白歌词：不命中、不固化、不改写内容', () => {
  afterEach(() => setCustomFetch(null))

  function respondWith(body: unknown): string[] {
    const calls: string[] = []
    setCustomFetch(async (input) => {
      calls.push(String(input))
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    return calls
  }

  it('syncedLyrics 纯空白时单源返回 null，并按落空推进下一档源', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // /api/get 回空壳、/api/search 也没内容：能看到它确实推进到了 /api/search
    const calls = respondWith({ syncedLyrics: '   \n  ' })
    await expect(searchLyricsSource(BUILTIN_LYRICS_GET_SOURCE, 't', 'a')).resolves.toBeNull()
    await expect(searchLyrics('t', 'a')).resolves.toBeNull()
    expect(calls).toContain('https://lrclib.net/api/get?track_name=t&artist_name=a')
    expect(calls).toContain('https://lrclib.net/api/search?track_name=t&artist_name=a')
    warn.mockRestore()
  })

  it('空白 synced 不占 1000 分基础分：同一条候选里改用有内容的 plain', async () => {
    respondWith({ trackName: 't', artistName: 'a', syncedLyrics: '  \t ', plainLyrics: '真歌词' })
    const out = await searchLyricsSource(BUILTIN_LYRICS_SOURCE, 't', 'a')
    expect(out?.lrc).toBe('真歌词')
  })

  it('空白 synced 不与「正常 synced」抢位：正常 synced 胜出', async () => {
    respondWith({
      results: [
        // 第 1 条 synced 是空壳，若它仍拿 1000 分且排序在前，会把真歌词挤掉
        { trackName: 't', artistName: 'a', duration: 200, syncedLyrics: '   ' },
        { trackName: 't', artistName: 'a', duration: 240, syncedLyrics: '[00:01.00]真同步词' },
      ],
    })
    const out = await searchLyricsSource(BUILTIN_LYRICS_SOURCE, 't', 'a', '', 200)
    expect(out?.lrc).toBe('[00:01.00]真同步词')
  })

  it('空串、纯空白、字段缺失三种形态都返回 null', async () => {
    const cases: unknown[] = [
      { syncedLyrics: '' },
      { plainLyrics: '' },
      { syncedLyrics: '', plainLyrics: '' },
      { syncedLyrics: '\n\n\t ' },
      { trackName: 't', artistName: 'a', duration: 200 },
      { syncedLyrics: null, plainLyrics: null },
    ]
    for (const body of cases) {
      respondWith(body)
      await expect(searchLyricsSource(BUILTIN_LYRICS_SOURCE, 't', 'a')).resolves.toBeNull()
    }
  })

  it('字段名兜底链：空壳 syncedLyrics 时继续找 lrc，空壳 plainLyrics 时继续找 lyrics', async () => {
    respondWith({ syncedLyrics: '   ', lrc: '[00:01.00]来自 lrc', plainLyrics: '  ', lyrics: '来自 lyrics' })
    const out = await searchLyricsSource(BUILTIN_LYRICS_SOURCE, 't', 'a')
    expect(out?.lrc).toBe('[00:01.00]来自 lrc')
  })

  it('正常歌词逐字返回：首尾空行与缩进不得被 trim 掉', async () => {
    const raw = '\n  [00:01.00]第一行\n[00:02.00]第二行  \n\n'
    respondWith({ syncedLyrics: raw })
    const out = await searchLyricsSource(BUILTIN_LYRICS_SOURCE, 't', 'a')
    expect(out?.lrc).toBe(raw)
    // 反向断言：确实带首尾空行（若实现 trim 过，上面这行也过不了，双保险）
    expect(out?.lrc.startsWith('\n')).toBe(true)
    expect(out?.lrc.endsWith('\n\n')).toBe(true)
  })

  it('plain 只有空白、synced 正常时用 synced', async () => {
    respondWith({ syncedLyrics: '[00:01.00]真同步词', plainLyrics: '   \n ' })
    const out = await searchLyricsSource(BUILTIN_LYRICS_SOURCE, 't', 'a')
    expect(out?.lrc).toBe('[00:01.00]真同步词')
  })

  it('整批候选都是空壳时单源返回 null（不返回空白串）', async () => {
    respondWith({ results: [{ syncedLyrics: '   ' }, { plainLyrics: '\n' }, { syncedLyrics: '' }] })
    await expect(searchLyricsSource(BUILTIN_LYRICS_SOURCE, 't', 'a')).resolves.toBeNull()
  })
})