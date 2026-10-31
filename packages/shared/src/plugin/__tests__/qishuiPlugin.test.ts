import { describe, it, expect } from 'vitest'
import { extractSessionId, qishuiCoverUrl, qishuiPlugin } from '../qishuiPlugin'
import type { PluginContext } from '../types'

/**
 * 汽水插件的纯函数与取址判定。
 *
 * 所有 fixture 都是**假值**（仓库公开）：真实的接口响应结构来自实测观察，
 * 但域名 / id / cookie 值一律用一眼可辨的假数据。
 */

describe('汽水：sessionid 提取', () => {
  it('从完整 Cookie 串里取出 sessionid', () => {
    const cookie =
      'ttwid=00000000-0000-0000-0000-000000000000; sessionid=local-dev-session-value; sid_guard=abc'
    expect(extractSessionId(cookie)).toBe('local-dev-session-value')
  })

  it('只有裸值时整串当作 sessionid', () => {
    expect(extractSessionId('local-dev-bare-session-value')).toBe('local-dev-bare-session-value')
  })

  it('空输入与明显不是凭证的短串返回 null', () => {
    expect(extractSessionId('')).toBeNull()
    expect(extractSessionId('   ')).toBeNull()
    // 太短，不像 sessionid；不能把用户输入的任意文字当凭证存下去
    expect(extractSessionId('hello')).toBeNull()
  })

  it('不被相似键名误导（sessionid_ss 不是 sessionid）', () => {
    // 上游会同时下发 sessionid_ss，正则必须锚在键名的完整边界上
    expect(extractSessionId('sessionid_ss=wrong-value-here-0000')).toBeNull()
  })
})

describe('汽水：封面地址拼接', () => {
  it('按 urls[0] + uri + ~template-15.webp 拼接（裸 uri 会 400）', () => {
    const url = qishuiCoverUrl({
      uri: 'fake-object-key',
      urls: ['https://img.example.test/img/'],
      template_prefix: 'fake-prefix',
    })
    expect(url).toBe('https://img.example.test/img/fake-object-key~fake-prefix-15.webp')
  })

  it('缺 template_prefix 时退化为不加模板后缀', () => {
    const url = qishuiCoverUrl({ uri: 'fake-key', urls: ['https://img.example.test/img/'] })
    expect(url).toBe('https://img.example.test/img/fake-key')
  })

  it('缺 uri 或 urls 时返回 undefined（不产出一个必然 400 的地址）', () => {
    expect(qishuiCoverUrl(undefined)).toBeUndefined()
    expect(qishuiCoverUrl({ uri: 'only-key' })).toBeUndefined()
    expect(qishuiCoverUrl({ urls: ['https://img.example.test/'] })).toBeUndefined()
  })
})

/** 构造一个只回固定 JSON 的假 fetch，记录收到的 URL 与 headers */
function makeCtx(payload: unknown, calls: Array<{ url: string; headers: Record<string, string> }> = []): PluginContext {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: (init?.headers || {}) as Record<string, string>,
      })
      return {
        ok: true,
        status: 200,
        json: async () => payload,
      } as unknown as Response
    }) as typeof globalThis.fetch,
  }
}

const CONFIG = { id: 'qishui', name: 'Soda', sourceUrl: '', enabled: true }

describe('汽水：歌单曲目解析', () => {
  it('解析曲目字段，duration 从毫秒换算成秒，并带上惰性取址令牌', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const ctx = makeCtx(
      {
        media_resources: [
          {
            id: '111',
            type: 'track',
            entity: {
              track_wrapper: {
                track: {
                  id: '111',
                  name: 'Fake Song',
                  duration: 218133,
                  artists: [{ name: 'Fake Artist' }],
                  album: { name: 'Fake Album' },
                },
              },
            },
          },
        ],
        has_more: false,
      },
      calls
    )

    const tracks = await qishuiPlugin.getPlaylistTracks!(CONFIG, '999', ctx)
    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({
      id: '111',
      songmid: '111',
      title: 'Fake Song',
      artist: 'Fake Artist',
      album: 'Fake Album',
      // 毫秒 → 秒
      duration: 218,
      // 空串表示由插件惰性取址
      audioUrl: '',
    })
    expect(tracks[0].trackRef?.meta).toMatchObject({ trackId: '111', durationMs: 218133 })
    // 请求里不能带 Origin（上游对带 Origin 的请求返回 403，实测）
    expect(calls[0].url).toContain('playlist_id=999')
    expect(calls[0].headers.Origin).toBeUndefined()
  })

  it('分页按 has_more / next_cursor 推进，并对重复曲目去重', async () => {
    let page = 0
    const ctx: PluginContext = {
      fetch: (async () => {
        page++
        const body =
          page === 1
            ? {
                media_resources: [
                  { entity: { track_wrapper: { track: { id: 'a', name: 'A', duration: 1000 } } } },
                ],
                has_more: true,
                next_cursor: '2',
              }
            : {
                // 第二页故意重复 a，验证去重
                media_resources: [
                  { entity: { track_wrapper: { track: { id: 'a', name: 'A', duration: 1000 } } } },
                  { entity: { track_wrapper: { track: { id: 'b', name: 'B', duration: 2000 } } } },
                ],
                has_more: false,
              }
        return { ok: true, status: 200, json: async () => body } as unknown as Response
      }) as typeof globalThis.fetch,
    }

    const tracks = await qishuiPlugin.getPlaylistTracks!(CONFIG, '999', ctx)
    expect(tracks.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('游标不前进时立即停止（防上游异常导致死循环）', async () => {
    let calls = 0
    const ctx: PluginContext = {
      fetch: (async () => {
        calls++
        return {
          ok: true,
          status: 200,
          json: async () => ({
            media_resources: [],
            has_more: true,
            // 永远返回同一个游标
            next_cursor: '1',
          }),
        } as unknown as Response
      }) as typeof globalThis.fetch,
    }
    await qishuiPlugin.getPlaylistTracks!(CONFIG, '999', ctx)
    // 第一次 cursor='0'，返回 '1' 后进入第二页；'1' === '1' 时跳出
    expect(calls).toBeLessThanOrEqual(3)
  })
})

describe('汽水：取址与试听判定', () => {
  function resolveCtx(videoModel: unknown): PluginContext {
    return makeCtx({
      seo_track: { track: { duration: 218133, name: 'Fake' } },
      track_player: { expire_at: 1800000000, video_model: videoModel },
    })
  }

  const ref = { sourceId: 'qishui', platform: 'qishui', meta: { trackId: '111' } }

  it('video_model 是 JSON 字符串时需要二次解析', async () => {
    const vm = JSON.stringify({
      video_duration: 218.134,
      video_list: [
        {
          main_url: 'https://audio.example.test/a.m4a',
          video_meta: { bitrate: 320000, quality: 'highest', vtype: 'm4a' },
        },
      ],
    })
    const out = await qishuiPlugin.resolveTrack!(CONFIG, ref, undefined, resolveCtx(vm))
    expect(out?.url).toBe('https://audio.example.test/a.m4a')
    expect(out?.quality).toBe('highest')
    // 时长吻合 → 不是试听
    expect(out?.isPreview).toBeUndefined()
    // expire_at 是秒，转成毫秒
    expect(out?.expireAt).toBe(1800000000000)
  })

  it('VIP 曲目只有片段时标记 isPreview 并给出片段时长（不能伪装成完整曲目）', async () => {
    const vm = JSON.stringify({
      // 29 秒片段 vs 218 秒完整曲目
      video_duration: 29.002,
      video_list: [{ main_url: 'https://audio.example.test/preview.m4a', video_meta: { bitrate: 128000 } }],
    })
    const out = await qishuiPlugin.resolveTrack!(CONFIG, ref, undefined, resolveCtx(vm))
    expect(out?.isPreview).toBe(true)
    expect(out?.previewDurationMs).toBe(29002)
    expect(out?.fullDurationMs).toBe(218133)
  })

  it('多档音质里选码率最高的一档', async () => {
    const vm = JSON.stringify({
      video_duration: 218.134,
      video_list: [
        { main_url: 'https://audio.example.test/low.m4a', video_meta: { bitrate: 128000, quality: 'medium' } },
        { main_url: 'https://audio.example.test/high.m4a', video_meta: { bitrate: 320000, quality: 'highest' } },
      ],
    })
    const out = await qishuiPlugin.resolveTrack!(CONFIG, ref, undefined, resolveCtx(vm))
    expect(out?.url).toBe('https://audio.example.test/high.m4a')
  })

  it('没有可用地址时返回 null（让上层回落，而不是抛错打断播放）', async () => {
    const out = await qishuiPlugin.resolveTrack!(
      CONFIG,
      ref,
      undefined,
      resolveCtx(JSON.stringify({ video_list: [] }))
    )
    expect(out).toBeNull()
  })
})

describe('汽水：能力边界', () => {
  it('不声明 search 能力（该平台搜索被签名门控，纯 HTTP 不可用）', () => {
    expect(qishuiPlugin.capabilities).not.toContain('search')
    // 契约上 search 就不存在，上层按能力探测会自动跳过
    expect(qishuiPlugin.search).toBeUndefined()
  })

  it('歌单曲目与登录是声明能力；未登录也能拉歌单曲目', () => {
    expect(qishuiPlugin.capabilities).toContain('playlistTracks')
    expect(qishuiPlugin.capabilities).toContain('auth')
    expect(typeof qishuiPlugin.getPlaylistTracks).toBe('function')
  })
})
