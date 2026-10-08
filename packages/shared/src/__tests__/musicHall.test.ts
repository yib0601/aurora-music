import { fetchRecommendPlaylists, fetchToplistGroups, fetchToplistSongs, musicHallSourceOf } from '../musicHall'
import { setCustomFetch } from '../fetchWithTimeout'
import { expectCode, rejectionOf } from './i18nAssert'
import type { MusicHallSource } from '../types'

/** 固定音源：服务地址形态（在线音乐端点由协议派生） */
const SOURCE: MusicHallSource = {
  id: 'src-1',
  name: '我的音源',
  sourceUrl: 'https://music.example.com',
}

/** 造一个响应：记录请求地址，返回给定 JSON */
function stubJson(payload: unknown, seen?: string[]) {
  setCustomFetch(async (input) => {
    seen?.push(String(input))
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

afterEach(() => {
  setCustomFetch(null as never)
})

describe('fetchRecommendPlaylists', () => {
  it('解析服务端 list[]，并映射为带来源信息的条目', async () => {
    const seen: string[] = []
    stubJson(
      {
        list: [
          {
            id: '7707261125',
            name: '甜度爆表',
            coverUrl: 'http://qpic.y.qq.com/a.jpg',
            listenNum: 8552380,
            creatorName: '我想要两颗西柚',
            createTime: '2020-09-06',
          },
        ],
        total: 11618,
      },
      seen
    )
    const out = await fetchRecommendPlaylists(SOURCE, { page: 2, limit: 5 })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      id: '7707261125',
      name: '甜度爆表',
      listenNum: 8552380,
      creatorName: '我想要两颗西柚',
      source: 'src-1',
      sourceName: '我的音源',
    })
    // 分页参数进了请求地址
    expect(seen[0]).toContain('limit=5')
    expect(seen[0]).toContain('page=2')
  })

  it('容错上游字段命名（dissid / dissname / imgurl / listennum）', async () => {
    stubJson({
      data: {
        list: [{ dissid: '123', dissname: '歌单名', imgurl: 'http://x/y.jpg', listennum: 42 }],
      },
    })
    const out = await fetchRecommendPlaylists(SOURCE)
    expect(out[0]).toMatchObject({ id: '123', name: '歌单名', coverUrl: 'http://x/y.jpg', listenNum: 42 })
  })

  it('无 id 或无名的条目丢弃，结构缺失返回空数组', async () => {
    stubJson({ list: [{ name: '没有 id' }, { id: '9' }, null, 42] })
    expect(await fetchRecommendPlaylists(SOURCE)).toEqual([])

    stubJson({ unexpected: true })
    expect(await fetchRecommendPlaylists(SOURCE)).toEqual([])
  })

  it('接口模板形态的音源没有在线音乐能力，不发起请求', async () => {
    let called = false
    setCustomFetch(async () => {
      called = true
      return new Response('{}')
    })
    const out = await fetchRecommendPlaylists({
      id: 'x',
      name: '模板源',
      sourceUrl: 'https://x.com/api?query={query}',
    })
    expect(out).toEqual([])
    expect(called).toBe(false)
  })
})

describe('fetchToplistGroups', () => {
  const groupsPayload = {
    groups: [
      {
        groupId: 0,
        groupName: '巅峰榜',
        toplists: [
          {
            id: 62,
            name: '飙升榜',
            updateTime: '2026-10-05',
            coverUrl: 'https://y.gtimg.cn/a.jpg',
            songs: [{ rank: 1, title: 'Sold Out', artist: 'Hawk Nelson', coverUrl: 'https://y.gtimg.cn/b.jpg' }],
          },
        ],
      },
    ],
  }

  it('解析分组与榜单，保留预览曲目', async () => {
    stubJson(groupsPayload)
    const out = await fetchToplistGroups(SOURCE, { preview: 3 })
    expect(out).toHaveLength(1)
    expect(out[0].groupName).toBe('巅峰榜')
    expect(out[0].toplists[0]).toMatchObject({ id: 62, name: '飙升榜', updateTime: '2026-10-05' })
    expect(out[0].toplists[0].songs[0]).toMatchObject({ rank: 1, title: 'Sold Out', artist: 'Hawk Nelson' })
  })

  it('兼容 QQ 上游原始形状（data.group[].toplist[].frontPicUrl/singerName）', async () => {
    stubJson({
      data: {
        group: [
          {
            groupName: '地区榜',
            toplist: [
              {
                topId: 5,
                title: '内地榜',
                frontPicUrl: 'https://y.gtimg.cn/c.jpg',
                song: [{ rank: 2, title: '某曲', singerName: '某歌手' }],
              },
            ],
          },
        ],
      },
    })
    const out = await fetchToplistGroups(SOURCE)
    expect(out[0].groupName).toBe('地区榜')
    expect(out[0].toplists[0]).toMatchObject({ id: 5, name: '内地榜' })
    // 原始形状里榜单数组是 toplist、预览曲目是 song，协议形状才是 toplists/songs —— 两者都要兜住
    expect(out[0].toplists[0].songs[0]).toMatchObject({ rank: 2, title: '某曲', artist: '某歌手' })
  })

  it('结构缺失或全无有效榜单时返回空数组', async () => {
    stubJson({ groups: [] })
    expect(await fetchToplistGroups(SOURCE)).toEqual([])

    stubJson({ foo: 'bar' })
    expect(await fetchToplistGroups(SOURCE)).toEqual([])

    stubJson({ groups: [{ groupName: '空组', toplists: [{ title: '缺 id' }] }] })
    expect(await fetchToplistGroups(SOURCE)).toEqual([])
  })

  it('HTTP 非 2xx 抛带源名与状态码的错误', async () => {
    setCustomFetch(async () => new Response('boom', { status: 502 }))
    const err = await rejectionOf(fetchToplistGroups(SOURCE))
    expectCode(err, 'core.error.hallHttpStatus', { name: '我的音源', status: 502 })
  })

  it('响应不是 JSON 时抛错', async () => {
    setCustomFetch(async () => new Response('<html>502</html>', { status: 200 }))
    const err = await rejectionOf(fetchToplistGroups(SOURCE))
    expectCode(err, 'core.error.hallNotJson', { name: '我的音源' })
  })

  it('上游超过 10s 超时：抛带源名的超时错误，不是英文 AbortError', async () => {
    // 复现用户侧现象：音源服务慢于 HALL_TIMEOUT_MS，底层抛 AbortError
    // 本用例真等满 10s 超时预算，故单独放宽 vitest 默认 5s 上限
    setCustomFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          )
        })
    )
    const err = await fetchToplistGroups(SOURCE).catch((e) => e as Error)
    expectCode(err, 'core.error.hallTimeout', { name: '我的音源', ms: 10000 })
    // 底层 AbortError 的英文原文一个字都不许漏进载荷（改成结构化后同样成立）
    expect(err.message).not.toMatch(/aborted/i)
  }, 20000)
})

describe('fetchToplistSongs', () => {
  it('解析协议形状的曲目（平铺字段）', async () => {
    stubJson({
      id: 26,
      name: '热歌榜',
      updateTime: '2026-10-05',
      total: 100,
      songs: [
        { rank: 1, title: 'A', artist: 'AA', album: 'AL', duration: 245, coverUrl: 'https://c/1.jpg', songmid: 'mid1' },
      ],
    })
    const out = await fetchToplistSongs(SOURCE, { id: 26, limit: 10 })
    expect(out.name).toBe('热歌榜')
    expect(out.total).toBe(100)
    expect(out.songs[0]).toMatchObject({ rank: 1, title: 'A', artist: 'AA', duration: 245, songmid: 'mid1' })
  })

  it('兼容 QQ 原始形状（songlist[].data + singer[] + albummid 拼封面）', async () => {
    stubJson({
      topinfo: { ListName: '飙升榜', update_time: '2026-10-05' },
      total_song_num: 100,
      songlist: [
        {
          rank: 3,
          data: {
            songmid: '0039MnYb0qxYhV',
            songname: '晴天',
            interval: 269,
            albummid: '004Z8Ihr0JIu5s',
            albumname: '叶惠美',
            singer: [{ name: '周杰伦' }, { name: '袁咏琳' }],
          },
        },
      ],
    })
    const out = await fetchToplistSongs(SOURCE, { id: 62 })
    expect(out.name).toBe('飙升榜')
    expect(out.total).toBe(100)
    expect(out.songs[0]).toMatchObject({
      rank: 3,
      title: '晴天',
      artist: '周杰伦 / 袁咏琳',
      album: '叶惠美',
      duration: 269,
      songmid: '0039MnYb0qxYhV',
    })
    expect(out.songs[0].coverUrl).toBe(
      'https://y.gtimg.cn/music/photo_new/T002R300x300M000004Z8Ihr0JIu5s_3.jpg'
    )
  })

  it('缺 rank 时按「页码偏移 + 序号」补位；缺 id 直接返回空结果且不发请求', async () => {
    stubJson({ songs: [{ title: '无 rank 曲' }] })
    const out = await fetchToplistSongs(SOURCE, { id: 4, page: 2, limit: 50 })
    expect(out.songs[0].rank).toBe(51)

    let called = false
    setCustomFetch(async () => {
      called = true
      return new Response('{}')
    })
    const empty = await fetchToplistSongs(SOURCE, {})
    expect(empty.songs).toEqual([])
    expect(called).toBe(false)
  })

  it('无标题的条目丢弃', async () => {
    stubJson({ songs: [{ rank: 1 }, { rank: 2, title: '' }, { rank: 3, title: '有效' }] })
    const out = await fetchToplistSongs(SOURCE, { id: 26 })
    expect(out.songs.map((s) => s.title)).toEqual(['有效'])
  })
})

describe('musicHallSourceOf', () => {
  it('取第一个已启用且有在线音乐能力的音源', () => {
    expect(musicHallSourceOf([SOURCE])).toBe(SOURCE)
    expect(
      musicHallSourceOf([{ ...SOURCE, id: 'off', enabled: false }, SOURCE])
    ).toBe(SOURCE)
  })

  it('无音源或都不具备该能力时返回 null', () => {
    expect(musicHallSourceOf([])).toBeNull()
    expect(
      musicHallSourceOf([{ id: 't', name: '模板源', sourceUrl: 'https://x.com/api?query={query}' }])
    ).toBeNull()
  })
})