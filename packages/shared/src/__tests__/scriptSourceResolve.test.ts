/**
 * 跨源脚本取址单测（不打真实网络）
 *
 * 覆盖三件事：
 *   1) 候选筛选：哪些曲目可以交给脚本源（自带脚本令牌的跳过、没有源内 id 的跳过、
 *      停用 / 未声明平台 / 就是它自己 的源跳过）；
 *   2) 喂给脚本的元信息：通用 id 与展示字段都在，且每条候选拿到独立副本；
 *   3) 取址编排：按顺序尝试、失败记记忆（短时间内不重复白打）、命中即停。
 *
 * 这里刻意只测「策略」不测「怎么执行插件」：执行由调用方注入，两端各自不同，
 * 而策略必须同源 —— 那正是这层存在的理由。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearScriptSourceMemo,
  hasScriptSourceCandidate,
  inferPlatformFromUrl,
  resolveTrackAudioAcrossScriptSources,
  scriptSourcesForTrack,
  type ScriptSourcePick,
} from '../plugin/trackAudio'
import type { OnlineSourceConfig } from '../types'

/** 构造一条脚本源：`platform` 是它认领的平台 */
function scriptSource(over: Partial<OnlineSourceConfig> = {}): OnlineSourceConfig {
  return {
    id: 'src-script',
    name: '测试脚本源',
    sourceUrl: 'https://example.invalid/fish/latest.js',
    enabled: true,
    platform: 'tx',
    ...over,
  }
}

beforeEach(() => {
  clearScriptSourceMemo()
})

describe('scriptSourcesForTrack 候选筛选', () => {
  it('曲目已有脚本令牌（platform 非空）时不跨源', () => {
    const picks = scriptSourcesForTrack([scriptSource()], {
      trackRef: { sourceId: 'src-other', platform: 'tx', meta: { songmid: '123' } },
      onlineSource: 'src-other',
      onlineId: '123',
    })
    expect(picks).toEqual([])
  })

  it('没有源内 id 时不跨源（只有歌名歌手交出去没有意义）', () => {
    const picks = scriptSourcesForTrack([scriptSource()], {
      onlineSource: 'src-aurora',
      title: '起风了',
      artist: '买辣椒也用券',
    })
    expect(picks).toEqual([])
  })

  it('跳过停用源、未声明平台的源、以及曲目自己所属的源', () => {
    const picks = scriptSourcesForTrack(
      [
        scriptSource({ id: 'src-disabled', enabled: false }),
        scriptSource({ id: 'src-no-platform', platform: undefined }),
        scriptSource({ id: 'src-same', platform: 'tx' }),
        scriptSource({ id: 'src-ok' }),
      ],
      { onlineSource: 'src-same', onlineId: '91084746' }
    )
    expect(picks.map((p) => p.source.id)).toEqual(['src-ok'])
  })

  it('声明了多个平台时按配置顺序逐个给候选', () => {
    const picks = scriptSourcesForTrack(
      [scriptSource({ id: 'src-a', platform: 'kw' }), scriptSource({ id: 'src-b', platform: 'tx' })],
      { onlineSource: 'src-aurora', onlineId: '91084746' }
    )
    expect(picks.map((p) => `${p.source.id}:${p.ref.platform}`)).toEqual(['src-a:kw', 'src-b:tx'])
  })

  it('令牌 sourceId 指向脚本源自己，meta 带通用 id 与展示字段', () => {
    const [pick] = scriptSourcesForTrack([scriptSource()], {
      onlineSource: 'src-aurora',
      onlineId: '91084746',
      title: '起风了',
      artist: '买辣椒也用券',
      album: '起风了',
      duration: 325,
    })
    expect(pick.ref.sourceId).toBe('src-script')
    expect(pick.ref.platform).toBe('tx')
    expect(pick.ref.meta).toMatchObject({
      songmid: '91084746',
      id: '91084746',
      name: '起风了',
      singer: '买辣椒也用券',
      albumName: '起风了',
      interval: 325,
    })
  })

  it('曲目没有 onlineId 时从 trackRef.meta 里取 id（声明式插件的老令牌）', () => {
    const picks = scriptSourcesForTrack([scriptSource()], {
      onlineSource: 'src-aurora',
      trackRef: { sourceId: 'src-aurora', platform: '', meta: { id: 'abc' } },
      title: 'x',
    })
    expect(picks.map((p) => p.ref.meta.songmid)).toEqual(['abc'])
  })

  it('hasScriptSourceCandidate 与候选取址同源（同步判据不会与取址判定错位）', () => {
    const input = { onlineSource: 'src-aurora', onlineId: '1' }
    expect(hasScriptSourceCandidate([scriptSource()], input)).toBe(true)
    expect(hasScriptSourceCandidate([], input)).toBe(false)
  })
})

describe('平台归属按播放地址推断（脚本源不必认领平台）', () => {
  it('从媒体域名认出平台，认不出返回空串', () => {
    expect(inferPlatformFromUrl('https://isure6.stream.qqmusic.qq.com/C4000024jrso28p8VA.m4a')).toBe('tx')
    expect(inferPlatformFromUrl('http://sycdn.kuwo.cn/a/b.mp3?x=1')).toBe('kw')
    expect(inferPlatformFromUrl('https://webfs.tx.kugou.com/yy/index.php')).toBe('kg')
    expect(inferPlatformFromUrl('https://m801.music.126.net/2024/x.mp3')).toBe('wy')
    expect(inferPlatformFromUrl('https://freetyst.nf.migu.cn/x.mp3')).toBe('mg')
    expect(inferPlatformFromUrl('https://music.example.invalid/C4001.m4a')).toBe('')
    expect(inferPlatformFromUrl('not a url')).toBe('')
    expect(inferPlatformFromUrl(undefined)).toBe('')
  })

  it('脚本没认领平台，曲目地址认得出平台时照样是候选（平台取推断值）', () => {
    const picks = scriptSourcesForTrack(
      [scriptSource({ id: 'src-generic', platform: undefined })],
      {
        onlineSource: 'src-aurora',
        onlineId: '002qU5aY3Qu24y',
        onlineUrl: 'https://isure6.stream.qqmusic.qq.com/C400002qU5aY3Qu24y.m4a',
      }
    )
    expect(picks.map((p) => `${p.source.id}:${p.ref.platform}`)).toEqual(['src-generic:tx'])
    expect(hasScriptSourceCandidate([scriptSource({ id: 'src-generic', platform: undefined })], {
      onlineSource: 'src-aurora',
      onlineId: '1',
      onlineUrl: 'https://isure6.stream.qqmusic.qq.com/C4001.m4a',
    })).toBe(true)
  })

  it('认领了别的平台的脚本不拿这条曲目去试（错配的 id 只会白打一次）', () => {
    const picks = scriptSourcesForTrack(
      [scriptSource({ id: 'src-kw', platform: 'kw' }), scriptSource({ id: 'src-tx', platform: 'tx' })],
      {
        onlineSource: 'src-aurora',
        onlineId: '002qU5aY3Qu24y',
        onlineUrl: 'https://isure6.stream.qqmusic.qq.com/C400002qU5aY3Qu24y.m4a',
      }
    )
    expect(picks.map((p) => `${p.source.id}:${p.ref.platform}`)).toEqual(['src-tx:tx'])
  })

  it('推断不出平台时仍按认领平台行事（认领留空则不参与，避免瞎喂 id）', () => {
    const input = {
      onlineSource: 'src-aurora',
      onlineId: '1',
      onlineUrl: 'https://music.example.invalid/C4001.m4a',
    }
    expect(
      scriptSourcesForTrack([scriptSource({ id: 'src-claimed', platform: 'kw' })], input).map(
        (p) => `${p.source.id}:${p.ref.platform}`
      )
    ).toEqual(['src-claimed:kw'])
    expect(scriptSourcesForTrack([scriptSource({ id: 'src-none', platform: undefined })], input))
      .toEqual([])
  })
})

describe('resolveTrackAudioAcrossScriptSources 取址编排', () => {
  const input = { onlineSource: 'src-aurora', onlineId: '1', title: 't', artist: 'a' }

  it('第一个候选取不到时继续问下一个，命中即停', async () => {
    const sources = [
      scriptSource({ id: 'src-bad', platform: 'kw' }),
      scriptSource({ id: 'src-good', platform: 'tx' }),
      scriptSource({ id: 'src-late', platform: 'wy' }),
    ]
    const seen: string[] = []
    const hit = await resolveTrackAudioAcrossScriptSources(sources, input, async (pick) => {
      seen.push(pick.source.id)
      return pick.source.id === 'src-good' ? { url: 'https://cdn.example.invalid/a.mp3' } : null
    })
    expect(seen).toEqual(['src-bad', 'src-good'])
    expect(hit?.pick.source.id).toBe('src-good')
    expect(hit?.resolution.url).toBe('https://cdn.example.invalid/a.mp3')
  })

  it('非 http(s) 地址一律当作失败，继续下一个候选', async () => {
    const sources = [scriptSource({ id: 'src-a' }), scriptSource({ id: 'src-b' })]
    const hit = await resolveTrackAudioAcrossScriptSources(sources, input, async (pick) =>
      pick.source.id === 'src-a'
        ? { url: 'file:///tmp/x.mp3' }
        : { url: 'https://cdn.example.invalid/b.mp3' }
    )
    expect(hit?.pick.source.id).toBe('src-b')
  })

  it('注入的取址抛错不算失败上抛，而是回落下一个候选', async () => {
    const sources = [scriptSource({ id: 'src-throw' }), scriptSource({ id: 'src-ok' })]
    const hit = await resolveTrackAudioAcrossScriptSources(sources, input, async (pick) => {
      if (pick.source.id === 'src-throw') throw new Error('boom')
      return { url: 'https://cdn.example.invalid/ok.mp3' }
    })
    expect(hit?.pick.source.id).toBe('src-ok')
  })

  it('整轮失败后短时间内不再重复白打（失败记忆），清记忆后恢复', async () => {
    const sources = [scriptSource()]
    const resolve = vi.fn(async (_pick: ScriptSourcePick) => null)

    expect(await resolveTrackAudioAcrossScriptSources(sources, input, resolve)).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(1)

    // 同一条曲目立刻再播一次：命中失败记忆，直接回落，不再等一次失败
    expect(await resolveTrackAudioAcrossScriptSources(sources, input, resolve)).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(1)

    clearScriptSourceMemo()
    expect(await resolveTrackAudioAcrossScriptSources(sources, input, resolve)).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('改了源地址或平台后失败记忆自然失效（键里含地址与平台）', async () => {
    const resolve = vi.fn(async (_pick: ScriptSourcePick) => null)
    await resolveTrackAudioAcrossScriptSources([scriptSource({ id: 's' })], input, resolve)
    await resolveTrackAudioAcrossScriptSources(
      [scriptSource({ id: 's', platform: 'kw' })],
      input,
      resolve
    )
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('命中后清掉该候选的失败记忆（下次改回可用配置能立刻生效）', async () => {
    const sources = [scriptSource()]
    const resolve = vi
      .fn<(pick: ScriptSourcePick) => Promise<{ url: string } | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ url: 'https://cdn.example.invalid/a.mp3' })

    await resolveTrackAudioAcrossScriptSources(sources, input, resolve)
    clearScriptSourceMemo()
    const hit = await resolveTrackAudioAcrossScriptSources(sources, input, resolve)
    expect(hit?.resolution.url).toBe('https://cdn.example.invalid/a.mp3')
  })
})
