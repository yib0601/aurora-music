import { describe, expect, it } from 'vitest'
import { buildSourcePlugin } from '../source'
import { validatePluginManifest } from '../validate'
import { PLUGIN_MANIFEST_FORMAT, type PluginManifest } from '../types'
import type { OnlineSourceConfig } from '../../../types'
import type { PluginContext } from '../../types'

function manifestOf(source: unknown): PluginManifest {
  const result = validatePluginManifest({
    format: PLUGIN_MANIFEST_FORMAT,
    id: 'hall-demo',
    name: 'Hall Demo',
    version: '1.0.0',
    permissions: ['network'],
    hosts: ['api.example.com'],
    source,
  })
  if (!result.ok) throw new Error(`manifest invalid: ${JSON.stringify(result.issues)}`)
  return result.manifest
}

const config: OnlineSourceConfig = {
  id: 'src-1',
  name: 'Hall Source',
  sourceUrl: 'https://api.example.com',
  enabled: true,
}

function ctxReturning(payload: unknown, recorded?: string[]): PluginContext {
  return {
    fetch: (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      recorded?.push(url)
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof globalThis.fetch,
  }
}

describe('推荐歌单（声明式）', () => {
  const manifest = manifestOf({
    recommend: {
      url: 'https://api.example.com/recommend?cat={categoryId}&page={page}&limit={limit}',
      items: 'data.list',
      map: {
        id: 'dissid',
        name: 'dissname',
        coverUrl: 'imgurl',
        listenNum: 'listennum',
        creatorName: 'creator.name',
        createTime: 'createtime',
      },
    },
  })

  it('正常映射出推荐歌单', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const out = await plugin.recommendPlaylists!(
      config,
      { categoryId: '1', page: 2, limit: 10 },
      ctxReturning({
        data: {
          list: [
            {
              dissid: '9001',
              dissname: '华语流行',
              imgurl: 'https://img/a.jpg',
              listennum: 12345,
              creator: { name: '官方' },
              createtime: '2026-01-01',
            },
          ],
        },
      })
    )
    expect(out).toEqual([
      {
        id: '9001',
        name: '华语流行',
        coverUrl: 'https://img/a.jpg',
        listenNum: 12345,
        creatorName: '官方',
        createTime: '2026-01-01',
        source: 'src-1',
        sourceName: 'Hall Source',
      },
    ])
  })

  it('占位符按入参填充（分类 / 页 / 条数）', async () => {
    const recorded: string[] = []
    const plugin = buildSourcePlugin(manifest)!
    await plugin.recommendPlaylists!(
      config,
      { categoryId: '3', page: 4, limit: 20 },
      ctxReturning({ data: { list: [] } }, recorded)
    )
    expect(recorded[0]).toContain('cat=3')
    expect(recorded[0]).toContain('page=4')
    expect(recorded[0]).toContain('limit=20')
  })

  it('无 id 或无名的条目被丢弃（点不开 / 空白卡片）', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const out = await plugin.recommendPlaylists!(
      config,
      {},
      ctxReturning({
        data: {
          list: [
            { dissid: '1' }, // 无名
            { dissname: '有名无 id' }, // 无 id
            { dissid: '2', dissname: '正常' },
          ],
        },
      })
    )
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('2')
  })

  it('响应包裹在 list / playlists 时也能取到（items 未写时走容错链）', async () => {
    const loose = manifestOf({
      recommend: {
        url: 'https://api.example.com/r',
        map: { id: 'id', name: 'name' },
      },
    })
    const plugin = buildSourcePlugin(loose)!
    for (const payload of [
      { list: [{ id: 'a', name: 'A' }] },
      { playlists: [{ id: 'b', name: 'B' }] },
      [{ id: 'c', name: 'C' }],
    ]) {
      const out = await plugin.recommendPlaylists!(config, {}, ctxReturning(payload))
      expect(out).toHaveLength(1)
    }
  })

  it('该分类无内容 → 空数组（不是错误）', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const out = await plugin.recommendPlaylists!(config, {}, ctxReturning({ data: { list: [] } }))
    expect(out).toEqual([])
  })

  it('网络失败 → 抛错（由聚合层逐源捕获）', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const ctx: PluginContext = {
      fetch: (async () => new Response('x', { status: 500 })) as unknown as typeof globalThis.fetch,
    }
    await expect(plugin.recommendPlaylists!(config, {}, ctx)).rejects.toThrow()
  })
})

describe('榜单列表（声明式）', () => {
  const manifest = manifestOf({
    toplists: {
      url: 'https://api.example.com/toplists?preview={preview}',
      groups: 'data.groups',
      map: {
        groupName: 'groupName',
        toplists: 'toplists',
        item: {
          id: 'topId',
          name: 'name',
          updateTime: 'updateTime',
          listenNum: 'listenNum',
          songs: 'songs',
          song: { rank: 'rank', title: 'title', artist: 'singerName', coverUrl: 'cover' },
        },
      },
    },
  })

  it('分组 + 榜单 + 预览曲目全链路映射', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const out = await plugin.toplists!(
      config,
      { preview: 2 },
      ctxReturning({
        data: {
          groups: [
            {
              groupName: '巅峰榜',
              toplists: [
                {
                  topId: 4,
                  name: '飙升榜',
                  updateTime: '2026-10-31',
                  listenNum: 999,
                  songs: [
                    { rank: 1, title: 'A', singerName: 'X', cover: 'https://c/1.jpg' },
                    { rank: 2, title: 'B', singerName: 'Y' },
                  ],
                },
              ],
            },
          ],
        },
      })
    )
    expect(out).toHaveLength(1)
    expect(out[0].groupName).toBe('巅峰榜')
    expect(out[0].toplists).toHaveLength(1)
    const brief = out[0].toplists[0]
    expect(brief).toMatchObject({ id: 4, name: '飙升榜', updateTime: '2026-10-31', listenNum: 999 })
    expect(brief.songs).toEqual([
      { rank: 1, title: 'A', artist: 'X', coverUrl: 'https://c/1.jpg' },
      // 排名缺失按位置补（预览区要显示 1 2 3）
      { rank: 2, title: 'B', artist: 'Y', coverUrl: undefined },
    ])
  })

  it('预览曲目缺失 → 榜单保留且 songs 为空（预览是装饰不是必需）', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const out = await plugin.toplists!(
      config,
      {},
      ctxReturning({ data: { groups: [{ groupName: 'G', toplists: [{ topId: 1, name: 'A' }] }] } })
    )
    expect(out[0].toplists[0].songs).toEqual([])
  })

  it('裸数组响应视为单组（很多源只有一个"排行榜"分组）', async () => {
    const flat = manifestOf({
      toplists: {
        url: 'https://api.example.com/t',
        map: { item: { id: 'id', name: 'name' } },
      },
    })
    const plugin = buildSourcePlugin(flat)!
    const out = await plugin.toplists!(config, {}, ctxReturning([{ id: 't1', name: '热歌榜' }]))
    expect(out).toHaveLength(1)
    // ��组时组名留空（界面用通用标题兜底，数据层不烧文案）
    expect(out[0].groupName).toBe('')
    expect(out[0].toplists[0]).toMatchObject({ name: '热歌榜' })
  })

  it('非数字榜单 id（slug）转成稳定数字（详情请求要能对上）', async () => {
    const slug = manifestOf({
      toplists: {
        url: 'https://api.example.com/t',
        groups: 'groups',
        map: { toplists: 'items', item: { id: 'slug', name: 'name' } },
      },
    })
    const plugin = buildSourcePlugin(slug)!
    const payload = { groups: [{ items: [{ slug: 'hot-100', name: 'Hot 100' }] }] }
    const first = await plugin.toplists!(config, {}, ctxReturning(payload))
    const second = await plugin.toplists!(config, {}, ctxReturning(payload))
    expect(typeof first[0].toplists[0].id).toBe('number')
    // 稳定：两次取到的 id 必须相同（否则详情缓存永不命中）
    expect(first[0].toplists[0].id).toBe(second[0].toplists[0].id)
  })

  it('数字 id 原样保留（不被哈希掉）', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const out = await plugin.toplists!(
      config,
      {},
      ctxReturning({ data: { groups: [{ groupName: 'G', toplists: [{ topId: '19723756', name: 'A' }] }] } })
    )
    expect(out[0].toplists[0].id).toBe(19723756)
  })

  it('组内无有效榜单 → 该组丢弃（空组是一行空标题）', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const out = await plugin.toplists!(
      config,
      {},
      ctxReturning({ data: { groups: [{ groupName: '空组', toplists: [] }] } })
    )
    expect(out).toEqual([])
  })
})

describe('榜单详情（声明式）', () => {
  const manifest = manifestOf({
    toplistDetail: {
      url: 'https://api.example.com/toplist?id={id}&limit={limit}',
      items: 'data.songs',
      meta: { name: 'data.name', updateTime: 'data.updateTime', total: 'data.total' },
      map: {
        rank: 'rank',
        title: 'songname',
        artist: 'singer[0].name',
        album: 'albumname',
        duration: 'interval',
        coverUrl: 'cover',
        songmid: 'mid',
      },
    },
  })

  it('曲目 + 元信息正常映射', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const out = await plugin.toplistDetail!(
      config,
      { id: 4, limit: 100 },
      ctxReturning({
        data: {
          name: '飙升榜',
          updateTime: '2026-10-31',
          total: 100,
          songs: [
            { rank: 1, songname: 'A', singer: [{ name: 'X' }], albumname: 'Al', interval: 210, cover: 'c', mid: 'm1' },
          ],
        },
      })
    )
    expect(out).toMatchObject({ id: 4, name: '飙升榜', updateTime: '2026-10-31', total: 100 })
    expect(out.songs[0]).toEqual({
      rank: 1,
      title: 'A',
      artist: 'X',
      album: 'Al',
      duration: 210,
      coverUrl: 'c',
      songmid: 'm1',
    })
  })

  it('排名缺失按位置补（序号列不能全是 0）', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const out = await plugin.toplistDetail!(
      config,
      { id: 1 },
      ctxReturning({ data: { songs: [{ songname: 'A' }, { songname: 'B' }] } })
    )
    expect(out.songs.map((song) => song.rank)).toEqual([1, 2])
  })

  it('total 缺失时用曲目数（界面上"共 N 首"不能是 0）', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const out = await plugin.toplistDetail!(
      config,
      { id: 1 },
      ctxReturning({ data: { songs: [{ songname: 'A' }] } })
    )
    expect(out.total).toBe(1)
  })

  it('durationMs 声明时按 /1000 取整', async () => {
    const ms = manifestOf({
      toplistDetail: {
        url: 'https://api.example.com/t?id={id}',
        map: { title: 'n', artist: 'a', durationMs: 'ms' },
      },
    })
    const plugin = buildSourcePlugin(ms)!
    const out = await plugin.toplistDetail!(
      config,
      { id: 1 },
      ctxReturning({ songs: [{ n: 'A', a: 'B', ms: 298999 }] })
    )
    expect(out.songs[0].duration).toBe(299)
  })

  it('无标题的条目被跳过（空白行）', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const out = await plugin.toplistDetail!(
      config,
      { id: 1 },
      ctxReturning({ data: { songs: [{ singer: 'X' }, { songname: 'A' }] } })
    )
    expect(out.songs).toHaveLength(1)
    expect(out.songs[0].title).toBe('A')
  })

  it('占位符 {id} 被替换', async () => {
    const recorded: string[] = []
    const plugin = buildSourcePlugin(manifest)!
    await plugin.toplistDetail!(config, { id: 'top-9' }, ctxReturning({ data: { songs: [] } }, recorded))
    expect(recorded[0]).toContain('id=top-9')
  })

  it('名称为空不抛错（曲目列表才是用户要看的东西）', async () => {
    const plugin = buildSourcePlugin(manifest)!
    const out = await plugin.toplistDetail!(config, { id: 1 }, ctxReturning({ data: { songs: [] } }))
    expect(out.name).toBe('')
    expect(out.songs).toEqual([])
  })
})

describe('能力清单包含在线发现三项', () => {
  it('三个端点都声明时能力齐全', () => {
    const manifest = manifestOf({
      recommend: { url: 'https://api.example.com/r', map: { id: 'id', name: 'n' } },
      toplists: { url: 'https://api.example.com/t', map: { item: { id: 'id', name: 'n' } } },
      toplistDetail: { url: 'https://api.example.com/d', map: { title: 't', artist: 'a' } },
    })
    const plugin = buildSourcePlugin(manifest)!
    expect(plugin.capabilities.sort()).toEqual(['recommendPlaylists', 'toplistDetail', 'toplists'].sort())
    expect(typeof plugin.recommendPlaylists).toBe('function')
    expect(typeof plugin.toplists).toBe('function')
    expect(typeof plugin.toplistDetail).toBe('function')
  })

  it('只有在线发现能力的插件也能构造（不需要搜索）', () => {
    const manifest = manifestOf({
      recommend: { url: 'https://api.example.com/r', map: { id: 'id', name: 'n' } },
    })
    const plugin = buildSourcePlugin(manifest)!
    expect(plugin).not.toBeNull()
    expect(plugin.search).toBeUndefined()
  })
})
