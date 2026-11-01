import { describe, expect, it } from 'vitest'
import { buildLyricsRunner, fillLyricsUrl, lyricsConfigOf } from '../lyrics'
import { validatePluginManifest } from '../validate'
import { PLUGIN_MANIFEST_FORMAT, type PluginManifest } from '../types'

function lyricsManifest(lyrics: Record<string, unknown>): PluginManifest {
  const result = validatePluginManifest({
    format: PLUGIN_MANIFEST_FORMAT,
    id: 'demo-lyrics',
    name: 'Demo Lyrics',
    version: '1.0.0',
    permissions: ['network'],
    hosts: ['lyrics.example.com'],
    lyrics,
  })
  if (!result.ok) throw new Error(`invalid: ${JSON.stringify(result.issues)}`)
  return result.manifest
}

/** 记录请求 URL 并返回给定 body 的假 fetch */
function fakeFetch(body: string, init: { status?: number; json?: boolean } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const impl = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, headers: (options?.headers || {}) as Record<string, string> })
    return new Response(body, {
      status: init.status ?? 200,
      headers: { 'Content-Type': init.json === false ? 'text/plain' : 'application/json' },
    })
  }) as typeof globalThis.fetch
  return { impl, calls }
}

describe('fillLyricsUrl：占位符填充与空参数剔除', () => {
  it('正常填充并按 URL 编码', () => {
    expect(fillLyricsUrl('https://x/l?t={track}&a={artist}', { track: 'A B', artist: 'C&D' })).toBe(
      'https://x/l?t=A%20B&a=C%26D'
    )
  })

  it('{track} 与 {query} 是同一个值的两个别名', () => {
    const url = fillLyricsUrl('https://x/l?t={track}&q={query}', { track: 'A', query: 'A' })
    expect(url).toBe('https://x/l?t=A&q=A')
  })

  it('空值占位符整段剔除（留成 artist= 会让上游当错误：LRCLIB 实测 503）', () => {
    expect(fillLyricsUrl('https://x/l?t={track}&a={artist}', { track: 'A', artist: '' })).toBe(
      'https://x/l?t=A'
    )
  })

  it('末尾空参数剔除后不留尾随 ? / &', () => {
    expect(fillLyricsUrl('https://x/l?t={track}&d={duration}', { track: 'A', duration: '' })).toBe(
      'https://x/l?t=A'
    )
  })

  it('同时多个空参数不留下连续的 &&', () => {
    expect(
      fillLyricsUrl('https://x/l?t={track}&a={artist}&b={album}', { track: 'A', artist: '', album: '' })
    ).toBe('https://x/l?t=A')
  })

  it('调用方没传的占位符同样剔除（不会把 {duration} 字面量发给上游）', () => {
    expect(fillLyricsUrl('https://x/l?t={track}&d={duration}', { track: 'A' })).toBe('https://x/l?t=A')
  })
})

describe('buildLyricsRunner：JSON 形态', () => {
  const manifest = lyricsManifest({ url: 'https://lyrics.example.com/search?t={track}&a={artist}' })

  it('优先取带时间标签的那一条', async () => {
    const { impl } = fakeFetch(
      JSON.stringify({
        results: [
          { syncedLyrics: null, plainLyrics: '纯文本歌词', trackName: 'A', artistName: 'B', duration: 200 },
          { syncedLyrics: '[00:01.00]同步歌词', plainLyrics: null, trackName: 'A', artistName: 'B', duration: 200 },
        ],
      })
    )
    const run = buildLyricsRunner(manifest, impl)!
    const hit = await run('A', 'B')
    expect(hit?.lrc).toBe('[00:01.00]同步歌词')
  })

  it('全部没有同步词时回落纯文本', async () => {
    const { impl } = fakeFetch(
      JSON.stringify({ results: [{ plainLyrics: '纯文本歌词', trackName: 'A', artistName: 'B' }] })
    )
    const run = buildLyricsRunner(manifest, impl)!
    expect((await run('A', 'B'))?.lrc).toBe('纯文本歌词')
  })

  it('同名候选按时长最接近的选（避免翻唱版挤掉原唱）', async () => {
    const { impl } = fakeFetch(
      JSON.stringify({
        results: [
          { syncedLyrics: '[00:01.00]翻唱', duration: 120 },
          { syncedLyrics: '[00:01.00]原唱', duration: 240 },
        ],
      })
    )
    const run = buildLyricsRunner(manifest, impl)!
    const hit = await run('A', 'B', undefined, 241)
    expect(hit?.lrc).toBe('[00:01.00]原唱')
  })

  it('空壳候选（只有空白 synced）不算命中（否则会永久空态）', async () => {
    const { impl } = fakeFetch(JSON.stringify({ results: [{ syncedLyrics: '   \n  ' }] }))
    const run = buildLyricsRunner(manifest, impl)!
    expect(await run('A')).toBeNull()
  })

  it('响应是单对象也认（/get 形态）', async () => {
    const { impl } = fakeFetch(JSON.stringify({ syncedLyrics: '[00:02.00]X', trackName: 'A' }))
    const run = buildLyricsRunner(manifest, impl)!
    expect((await run('A'))?.lrc).toBe('[00:02.00]X')
  })

  it.each(['syncedLyrics', 'lrc', 'lyric'])('字段 %s 都能取到同步词', async (field) => {
    const { impl } = fakeFetch(JSON.stringify({ results: [{ [field]: '[00:03.00]Y' }] }))
    const run = buildLyricsRunner(manifest, impl)!
    expect((await run('A'))?.lrc).toBe('[00:03.00]Y')
  })

  it.each(['plainLyrics', 'lyrics'])('字段 %s 都能取到纯文本', async (field) => {
    const { impl } = fakeFetch(JSON.stringify({ results: [{ [field]: 'PLAIN' }] }))
    const run = buildLyricsRunner(manifest, impl)!
    expect((await run('A'))?.lrc).toBe('PLAIN')
  })

  it('空查询直接 null，不发请求', async () => {
    const { impl, calls } = fakeFetch('{}')
    const run = buildLyricsRunner(manifest, impl)!
    expect(await run('   ')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('非 JSON 响应 → null（不抛错，聚合层继续推进下一档）', async () => {
    const { impl } = fakeFetch('<html>', { json: false })
    const run = buildLyricsRunner(manifest, impl)!
    expect(await run('A')).toBeNull()
  })

  it('HTTP 失败 → null', async () => {
    const { impl } = fakeFetch('nope', { status: 503 })
    const run = buildLyricsRunner(manifest, impl)!
    expect(await run('A')).toBeNull()
  })

  it('网络异常 → null', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof globalThis.fetch
    const run = buildLyricsRunner(manifest, impl)!
    expect(await run('A')).toBeNull()
  })
})

describe('buildLyricsRunner：裸 LRC 形态', () => {
  const manifest = lyricsManifest({ url: 'https://lyrics.example.com/raw?t={track}', format: 'lrc' })

  it('响应体本身就是歌词', async () => {
    const { impl } = fakeFetch('[00:01.00]第一行\n[00:02.00]第二行', { json: false })
    const run = buildLyricsRunner(manifest, impl)!
    const hit = await run('A', 'B')
    expect(hit?.lrc).toContain('[00:01.00]第一行')
    // 名称回落查询词（裸文本里没有元信息）
    expect(hit?.name).toBe('A')
  })

  it('空白 LRC 按落空返回 null（不留坏文本进缓存）', async () => {
    const { impl } = fakeFetch('   \n  ', { json: false })
    const run = buildLyricsRunner(manifest, impl)!
    expect(await run('A')).toBeNull()
  })
})

describe('buildLyricsRunner：请求头', () => {
  it('清单里声明的头出现在请求里', async () => {
    const manifest = lyricsManifest({
      url: 'https://lyrics.example.com/l?t={track}',
      headers: { 'X-Token': 'abc' },
    })
    const { impl, calls } = fakeFetch('{"syncedLyrics":"[00:01.00]X"}')
    const run = buildLyricsRunner(manifest, impl)!
    await run('A')
    expect(calls[0].headers['X-Token']).toBe('abc')
    expect(calls[0].headers['User-Agent']).toContain('Aurora-Music')
  })
})

describe('lyricsConfigOf：供既有聚合层消费的形状', () => {
  it('id 带 plugin: 前缀（保证永不与内置源 id 相撞）', () => {
    const manifest = lyricsManifest({ url: 'https://lyrics.example.com/l?t={track}' })
    const config = lyricsConfigOf(manifest)!
    expect(config.id).toBe('plugin:demo-lyrics')
    expect(config.sourceUrl).toBe('https://lyrics.example.com/l?t={track}')
    expect(config.enabled).toBe(true)
  })

  it('格式随配置交下去：format 缺省 json，声明 lrc 时原样带出', () => {
    // 防回归：「清单写了 format: 'lrc'，却永远取不到词」。
    // 聚合链实际执行的是 `lyricsSource.searchLyricsSource`，它只认
    // `LyricsSourceConfig.format`。不映射这一项，清单声明就形同虚设 ——
    // 插件构造得出来、进得了候选，每次都在 resp.json() 处落空。
    expect(lyricsConfigOf(lyricsManifest({ url: 'https://x/l?t={track}' }))!.format).toBe('json')
    expect(
      lyricsConfigOf(lyricsManifest({ url: 'https://x/l?t={track}', format: 'lrc' }))!.format
    ).toBe('lrc')
  })

  it('没有歌词声明的清单返回 null', () => {
    const result = validatePluginManifest({
      format: PLUGIN_MANIFEST_FORMAT,
      id: 'demo-source',
      name: 'Demo',
      version: '1.0.0',
      permissions: ['network'],
      hosts: ['api.example.com'],
      source: { search: { url: 'https://api.example.com/s?q={query}', map: { title: 't', audioUrl: 'u' } } },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(lyricsConfigOf(result.manifest)).toBeNull()
  })
})
