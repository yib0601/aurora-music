import { afterEach, describe, expect, it } from 'vitest'
import {
  clearTrackEndpointCache,
  isTrackEndpointKnownMissing,
  resolveAuroraTrack,
  resolveAuroraTrackUrl,
  sourceSongIdOf,
} from '../trackResolver'
import { setCustomFetch } from '../fetchWithTimeout'
import { expectCode, infoOf } from './i18nAssert'
import type { OnlineSourceConfig } from '../types'

const KEY = '00000000-0000-0000-0000-000000000000'

/** 造一条自有服务协议（kind='aurora'，服务地址形态）的音源 */
function makeSource(partial: Partial<OnlineSourceConfig> = {}): OnlineSourceConfig {
  return {
    id: 'src-1',
    name: '我的音源',
    sourceUrl: `https://music.example.com?key=${KEY}`,
    enabled: true,
    ...partial,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 注入 fetch 并记录每次请求的地址（返回的数组即调用记录） */
function stubFetch(handler: (url: string, call: number) => Response | Promise<Response>): string[] {
  const calls: string[] = []
  setCustomFetch(async (input) => {
    const url = String(input)
    calls.push(url)
    return handler(url, calls.length)
  })
  return calls
}

/** 取失败原因；实际成功时抛错（用例写法更直白） */
function reasonOf(out: Awaited<ReturnType<typeof resolveAuroraTrack>>): string {
  if (out.audioUrl !== null) throw new Error(`期望取址失败，实际成功：${out.audioUrl}`)
  return out.reason
}

/** 源端按 id 取址的正常响应（形状与 /aurora 的条目一致） */
const HIT = {
  songmid: '002A97IJ2D6KYA',
  found: true,
  reason: null,
  track: { songmid: '002A97IJ2D6KYA', title: '雨天', artist: '汪苏泷', duration: 274 },
  results: [
    {
      audioUrl: 'http://cdn.example.com/M500002RXlW80X7JS7.mp3?vkey=fake',
      id: '002A97IJ2D6KYA',
      songmid: '002A97IJ2D6KYA',
      media_mid: '002RXlW80X7JS7',
      title: '雨天',
      artist: '汪苏泷',
      album: '繁星四月 电视剧原声带',
      duration: 274,
      coverUrl: 'https://y.qq.com/music/photo_new/T002R300x300M000001rvLZC39uADA.jpg',
      quality: '128',
      qualityUrls: { '128': 'http://cdn.example.com/M500002RXlW80X7JS7.mp3?vkey=fake' },
    },
  ],
}

afterEach(() => {
  setCustomFetch(null)
  clearTrackEndpointCache()
})

describe('sourceSongIdOf（曲目上的 onlineId → 源内 id）', () => {
  it('剥掉历史形态的来源前缀', () => {
    // 搜索条目曾经把来源拼进 id；最近播放里的快照就是这一形态，不认它会取不到址
    expect(sourceSongIdOf('src-1', 'src-1-002A97IJ2D6KYA')).toBe('002A97IJ2D6KYA')
  })

  it('纯源内 id 原样返回（音乐馆榜单 / 歌单条目存的形态）', () => {
    expect(sourceSongIdOf('src-1', '002A97IJ2D6KYA')).toBe('002A97IJ2D6KYA')
  })

  it('别的源 id 前缀不误剥，空值安全返回空串', () => {
    expect(sourceSongIdOf('src-1', 'src-2-abc')).toBe('src-2-abc')
    expect(sourceSongIdOf('src-1', '')).toBe('')
    expect(sourceSongIdOf(undefined, undefined)).toBe('')
  })
})

describe('resolveAuroraTrack（按源内 id 取址）', () => {
  it('模板填好 id / quality 与密钥，取回直链与**实际**档位', async () => {
    const calls = stubFetch(() => jsonResponse(HIT))
    const out = await resolveAuroraTrack({
      source: makeSource(),
      songId: '002A97IJ2D6KYA',
      quality: '320',
    })

    expect(calls).toEqual([
      `https://music.example.com/aurora/track?id=002A97IJ2D6KYA&quality=320&key=${KEY}`,
    ])
    expect(out).toEqual({
      audioUrl: 'http://cdn.example.com/M500002RXlW80X7JS7.mp3?vkey=fake',
      quality: '128',
      qualityUrls: { '128': 'http://cdn.example.com/M500002RXlW80X7JS7.mp3?vkey=fake' },
      coverUrl: 'https://y.qq.com/music/photo_new/T002R300x300M000001rvLZC39uADA.jpg',
      duration: 274,
      title: '雨天',
      artist: '汪苏泷',
    })
  })

  it('不传 quality 时该参数整段删掉（老服务端不会收到字面量占位）', async () => {
    const calls = stubFetch(() => jsonResponse(HIT))
    await resolveAuroraTrack({ source: makeSource(), songId: '002A97IJ2D6KYA' })

    expect(calls[0]).toBe(`https://music.example.com/aurora/track?id=002A97IJ2D6KYA&key=${KEY}`)
  })

  it('id 里的特殊字符做 URL 编码（源端按原值回查）', async () => {
    const calls = stubFetch(() => jsonResponse(HIT))
    await resolveAuroraTrack({ source: makeSource(), songId: 'a b&c' })

    expect(calls[0]).toContain('id=a%20b%26c')
  })

  it('源端回填的 songmid / media_mid 不影响取址（只取直链与档位）', async () => {
    const calls = stubFetch(() => jsonResponse(HIT))
    const out = await resolveAuroraTrack({ source: makeSource(), songId: 'mid-1' })

    // 同一条响应里 songmid/media_mid 与请求的 id 不一致也照用：按 id 取址的权威在源端
    expect(out.audioUrl).toContain('M500002RXlW80X7JS7.mp3')
    expect(calls).toHaveLength(1)
  })

  it('缺少源内 id：给结构化错误，不发请求', async () => {
    const calls = stubFetch(() => jsonResponse(HIT))
    const out = await resolveAuroraTrack({ source: makeSource(), songId: '  ' })

    expectCode(reasonOf(out), 'core.error.trackIdMissing')
    expect(calls).toEqual([])
  })

  it('源没有取址端点（接口模板形态 / 脚本源）：给结构化错误，不发请求', async () => {
    const calls = stubFetch(() => jsonResponse(HIT))
    const noEndpoint = makeSource({ sourceUrl: 'https://api.example.com/search?q={query}' })
    expectCode(
      reasonOf(await resolveAuroraTrack({ source: noEndpoint, songId: 'mid-1' })),
      'core.error.trackEndpointMissing',
      { name: '我的音源', id: '{id}' }
    )
    const lxSource = makeSource({ kind: 'lx', sourceUrl: 'https://example.com/lx.js' })
    expectCode(
      reasonOf(await resolveAuroraTrack({ source: lxSource, songId: 'mid-1' })),
      'core.error.trackEndpointMissing',
      { name: '我的音源', id: '{id}' }
    )
    expect(calls).toEqual([])
  })

  it('老服务端 404：记成「无该端点」，后续取址不再白打一次', async () => {
    const calls = stubFetch(() => jsonResponse({ error: 'not found' }, 404))
    const source = makeSource()

    expectCode(reasonOf(await resolveAuroraTrack({ source, songId: 'mid-1' })), 'core.error.trackEndpointMissing')
    expect(isTrackEndpointKnownMissing(source)).toBe(true)
    expectCode(reasonOf(await resolveAuroraTrack({ source, songId: 'mid-2' })), 'core.error.trackEndpointMissing')
    expect(calls).toHaveLength(1)

    // 音源配置变动时会清掉这份记忆（服务端升级后立刻恢复取址）
    clearTrackEndpointCache()
    expect(isTrackEndpointKnownMissing(source)).toBe(false)
  })

  it('传输层失败映射成结构化错误：HTTP 状态 / 非 JSON / 超时', async () => {
    stubFetch(() => jsonResponse({ error: 'boom' }, 500))
    expectCode(
      reasonOf(await resolveAuroraTrack({ source: makeSource(), songId: 'mid-1' })),
      'core.error.sourceHttpStatus',
      { name: '我的音源', status: 500 }
    )

    setCustomFetch(async () => new Response('<html>nope</html>', { status: 200 }))
    expectCode(
      reasonOf(await resolveAuroraTrack({ source: makeSource(), songId: 'mid-1' })),
      'core.error.sourceNotJson',
      { name: '我的音源' }
    )

    setCustomFetch(() =>
      Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    )
    expectCode(
      reasonOf(await resolveAuroraTrack({ source: makeSource(), songId: 'mid-1' })),
      'core.error.sourceTimeout',
      { name: '我的音源', ms: 10000 }
    )
  })

  it('源端有这条曲目但没给直链：trackNoAudio，机器原因进 detail 而不是句子', async () => {
    stubFetch(() =>
      jsonResponse({
        songmid: 'mid-1',
        found: true,
        reason: 'no-rights',
        track: { songmid: 'mid-1', title: '雨天', duration: 274 },
        results: [],
      })
    )
    const reason = reasonOf(await resolveAuroraTrack({ source: makeSource(), songId: 'mid-1' }))

    expectCode(reason, 'core.error.trackNoAudio', { name: '我的音源' })
    expect(infoOf(reason)?.detail).toContain('no-rights')
  })

  it('条目存在但 audioUrl 是空串：同样算取不到，不把空地址交给播放器', async () => {
    stubFetch(() => jsonResponse({ songmid: 'mid-1', found: true, results: [{ audioUrl: '' }] }))
    const reason = reasonOf(await resolveAuroraTrack({ source: makeSource(), songId: 'mid-1' }))

    expectCode(reason, 'core.error.trackNoAudio', { name: '我的音源' })
    expect(infoOf(reason)?.detail).toContain('empty audioUrl')
  })

  it('便捷封装：成功给 {url, quality}，失败给 null（调用方判空回落按名搜索）', async () => {
    stubFetch(() => jsonResponse(HIT))
    expect(await resolveAuroraTrackUrl({ source: makeSource(), songId: 'mid-1' })).toEqual({
      url: 'http://cdn.example.com/M500002RXlW80X7JS7.mp3?vkey=fake',
      quality: '128',
    })

    stubFetch(() => jsonResponse({ found: false, reason: 'not-found', results: [] }))
    expect(await resolveAuroraTrackUrl({ source: makeSource(), songId: 'mid-2' })).toBeNull()
  })
})
