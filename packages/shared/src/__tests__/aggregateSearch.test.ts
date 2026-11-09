/**
 * 内置「聚合搜索」插件的单测（不打真实网络）
 *
 * 钉住三件在实现里最容易悄悄坏掉的事：
 *   1) **进 meta 而不是 platform**：平台标识必须写在 `trackRef.meta.platform`，
 *      `trackRef.platform` 必须留空 —— 后者非空会让跨源脚本取址直接放弃资格；
 *   2) **只给元信息**：`audioUrl` 恒为空串（惰性取址），别在这里猜直链；
 *   3) **单平台失败不拖垮整体**：五个端点互相独立，一家改版不该让兜底整体失效。
 */
import { describe, expect, it } from 'vitest'
import { aggregateSearchPlugin, AGGREGATE_SEARCH_PLUGIN_ID, AGGREGATE_SEARCH_SOURCE_ID } from '../plugin/aggregateSearch'
import type { OnlineSourceConfig } from '../types'

const config: OnlineSourceConfig = {
  id: AGGREGATE_SEARCH_SOURCE_ID,
  name: '聚合搜索',
  pluginId: AGGREGATE_SEARCH_PLUGIN_ID,
  sourceUrl: '',
  enabled: true,
}

/** 五个平台各一条命中（字段形状照抄实测响应，见 plugins/aggregateSearch/platforms.ts） */
const PAYLOADS: Record<string, unknown> = {
  'u.y.qq.com': {
    'music.search.SearchCgiService': {
      code: 0,
      data: {
        body: {
          song: {
            list: [
              {
                mid: 'tx-mid-1',
                id: 1001,
                title: '晴天',
                interval: 269,
                file: { media_mid: 'tx-mid-1', size_flac: 30_000_000, size_128mp3: 4_000_000 },
                album: { mid: 'alb-tx', name: '叶惠美' },
                singer: [{ name: '周杰伦', mid: 'singer-1' }],
              },
              // 缺 media_mid：脚本取不了址，必须被丢掉
              { mid: 'tx-mid-2', id: 1002, title: '没有媒体 id', file: {} },
            ],
          },
        },
      },
    },
  },
  'search.kuwo.cn': {
    abslist: [
      {
        MUSICRID: 'MUSIC_2001',
        SONGNAME: '晴天&nbsp;<em>live</em>',
        ARTIST: '周杰伦&方文山',
        ALBUM: '叶惠美',
        DURATION: '269',
        ALBUMID: 'alb-kw',
        N_MINFO: 'level:flac,bitrate:2000,format:flac,size:30.5M;',
      },
    ],
  },
  'music.163.com': {
    result: {
      songs: [
        {
          id: 3001,
          name: '晴天',
          dt: 269_000,
          ar: [{ name: '周杰伦' }],
          al: { id: 9, name: '叶惠美', picUrl: 'https://p1.music.126.net/x.jpg' },
          sq: { size: 30_000_000 },
        },
      ],
    },
  },
  'songsearch.kugou.com': {
    data: {
      lists: [
        {
          Audioid: 'kg-1',
          FileHash: 'kg-hash-1',
          SongName: '晴天',
          Singers: [{ name: '周杰伦' }],
          AlbumName: '叶惠美',
          AlbumID: 'alb-kg',
          MixSongID: 'kg-mix-1',
          Duration: 269,
          SQFileSize: 30_000_000,
          FileSize: 4_000_000,
        },
      ],
    },
  },
  'jadeite.migu.cn': {
    code: '000000',
    songResultData: {
      resultList: [
        [
          {
            songId: 'mg-1',
            copyrightId: 'mg-cr-1',
            name: '晴天',
            singerList: [{ name: '周杰伦' }],
            album: '叶惠美',
            albumId: 'alb-mg',
            duration: 269,
            audioFormats: [{ formatType: 'SQ' }],
            img3: '/music/cover/mg.jpg',
          },
        ],
      ],
    },
  },
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** 假 ctx：按主机名回对应平台的响应；`fail` 里的主机抛错 */
function makeCtx(fail: string[] = []) {
  const calls: string[] = []
  const logs: string[] = []
  const ctx = {
    fetch: (async (input: unknown) => {
      const url = String(input)
      calls.push(url)
      const host = hostOf(url)
      if (fail.includes(host)) throw new Error(`stub 网络错误: ${host}`)
      const payload = PAYLOADS[host]
      if (payload === undefined) throw new Error(`stub 未覆盖的端点: ${url}`)
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof globalThis.fetch,
    log: (message: string) => logs.push(message),
  }
  return { ctx, calls, logs }
}

describe('聚合搜索插件', () => {
  it('五个平台各出一条，按平台顺序交错', async () => {
    const { ctx } = makeCtx()
    const results = await aggregateSearchPlugin.search!(config, '晴天', undefined, ctx as never)
    expect(results.map((r) => r.sourceName)).toEqual([
      'QQ 音乐',
      '酷我音乐',
      '网易云音乐',
      '酷狗音乐',
      '咪咕音乐',
    ])
  })

  it('只给元信息：audioUrl 为空串，平台写在 meta 里而不是 platform 字段', async () => {
    const { ctx } = makeCtx()
    const [first] = await aggregateSearchPlugin.search!(config, '晴天', undefined, ctx as never)
    expect(first.audioUrl).toBe('')
    expect(first.source).toBe(AGGREGATE_SEARCH_SOURCE_ID)
    expect(first.trackRef?.sourceId).toBe(AGGREGATE_SEARCH_SOURCE_ID)
    // 关键：platform 留空，平台标识进 meta —— 否则跨源脚本取址会直接放弃
    expect(first.trackRef?.platform).toBe('')
    expect(first.trackRef?.meta).toMatchObject({ platform: 'tx', songmid: 'tx-mid-1' })
    // 平台原始定位字段要带出来（脚本按自己的字段名取）
    expect(first.trackRef?.meta).toMatchObject({ mediaMid: 'tx-mid-1', albumMid: 'alb-tx' })
  })

  it('id 带平台前缀，避免五家 id 撞号', async () => {
    const { ctx } = makeCtx()
    const results = await aggregateSearchPlugin.search!(config, '晴天', undefined, ctx as never)
    expect(results.every((r) => /^(tx|kw|wy|kg|mg):/.test(r.id))).toBe(true)
    expect(results.map((r) => r.id)).toContain('kw:2001')
  })

  it('上游富文本痕迹被清掉，歌手按顿号合并', async () => {
    const { ctx } = makeCtx()
    const results = await aggregateSearchPlugin.search!(config, '晴天', undefined, ctx as never)
    const kuwo = results.find((r) => r.sourceName === '酷我音乐')
    expect(kuwo?.title).toBe('晴天 live')
    expect(kuwo?.artist).toBe('周杰伦、方文山')
    expect(kuwo?.coverUrl).toBeUndefined()
  })

  it('QQ 音乐缺 media_mid 的条目被丢弃（脚本取不了址）', async () => {
    const { ctx } = makeCtx()
    const results = await aggregateSearchPlugin.search!(config, '晴天', undefined, ctx as never)
    const tx = results.filter((r) => r.trackRef?.meta?.platform === 'tx')
    expect(tx).toHaveLength(1)
    expect(tx[0].songmid).toBe('tx-mid-1')
    expect(tx[0].coverUrl).toBe('https://y.gtimg.cn/music/photo_new/T002R500x500M000alb-tx.jpg')
  })

  it('单平台失败只记日志，其余平台照常返回', async () => {
    const { ctx, logs } = makeCtx(['search.kuwo.cn'])
    const results = await aggregateSearchPlugin.search!(config, '晴天', undefined, ctx as never)
    expect(results).toHaveLength(4)
    expect(results.some((r) => r.sourceName === '酷我音乐')).toBe(false)
    expect(logs.join('\n')).toContain('酷我音乐')
  })

  it('空关键词不发请求', async () => {
    const { ctx, calls } = makeCtx()
    const results = await aggregateSearchPlugin.search!(config, '   ', undefined, ctx as never)
    expect(results).toEqual([])
    expect(calls).toEqual([])
  })

  it('插件元信息：只有 search 能力，且标记为自带内置源', () => {
    expect(aggregateSearchPlugin.capabilities).toEqual(['search'])
    expect(aggregateSearchPlugin.builtinSource).toBe(true)
    // 不实现 probe：内置兜底源没有「探测」这回事（用户看不到它）
    expect(aggregateSearchPlugin.probe).toBeUndefined()
  })
})
