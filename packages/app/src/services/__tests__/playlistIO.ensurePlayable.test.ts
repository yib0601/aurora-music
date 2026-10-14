/**
 * `ensurePlayableTrack` 的取址决策测试（本次加固的完整链路）。
 *
 * 这条链路上出过一次「元数据是原唱、播出来是别人的录音」的事故：榜单条目按
 * 「歌名 + 歌手」重搜取址，而同名不同版本（变速版 / 翻唱 / DJ 版）归一化后标题与
 * 目标完全相同，拿到与元数据同一档的分数 → 原唱《雨天》(274s) 被播成
 * 「雨天 (变速版)」(115s)，界面显示 4:34、播放条显示 1:55。
 *
 * 钉住两条路：
 *  1) 曲目带源内定位信息（onlineId / trackRef）时**先按 id 取址**，成功就不重搜；
 *  2) 回落按名搜索时必须过版本标记与时长判据；全部候选都不像同一版本时返回 null
 *     （上屏取址失败），而不是退回「取第一条结果」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '@/types'

const mocks = vi.hoisted(() => ({
  resolveTrackAudio: vi.fn(async (..._args: unknown[]) => null as Track | null),
  searchOnlineTracks: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  addImportedTracks: vi.fn(),
}))

vi.mock('@/services/platform', () => ({
  platform: {
    resolveTrackAudio: mocks.resolveTrackAudio,
    searchOnlineTracks: mocks.searchOnlineTracks,
  },
}))

vi.mock('@/stores/libraryStore', () => ({
  useLibraryStore: {
    getState: () => ({
      onlineSources: [
        {
          id: 'src-1',
          name: '我的音源',
          kind: 'aurora',
          sourceUrl: 'https://music.example.com?key=00000000-0000-0000-0000-000000000000',
          enabled: true,
        },
      ],
      downloadQuality: '128',
    }),
  },
}))

vi.mock('@/stores/playlistStore', () => ({
  usePlaylistStore: { getState: () => ({ addImportedTracks: mocks.addImportedTracks }) },
}))

/** 音乐馆榜单 / 歌单条目构造出的曲目：元数据是原唱、没有直链、带源内 id */
const hallTrack = (over: Partial<Track> = {}): Track =>
  ({
    id: 'hall-7798009869-33',
    path: '',
    title: '雨天',
    artist: '汪苏泷',
    album: '繁星四月 电视剧原声带',
    duration: 274,
    addedAt: 0,
    playCount: 0,
    liked: false,
    onlineSource: 'src-1',
    onlineSourceName: '我的音源',
    onlineId: '002A97IJ2D6KYA',
    ...over,
  }) as Track

/** 源端按名搜索返回的条目（形状与 /aurora 一致） */
const result = (over: Record<string, unknown> = {}) => ({
  id: 'src-1-003Yt1Id3vzsYq',
  title: '雨天 (变速版)',
  artist: '汪苏泷',
  album: '多讨厌的雨天 雨天 汪苏泷',
  duration: 115,
  audioUrl: 'http://cdn.example.com/M500003SOSss1ciu57.mp3',
  source: 'src-1',
  sourceName: '我的音源',
  ...over,
})

beforeEach(() => {
  mocks.resolveTrackAudio.mockReset()
  mocks.resolveTrackAudio.mockResolvedValue(null)
  mocks.searchOnlineTracks.mockReset()
  mocks.searchOnlineTracks.mockResolvedValue([])
  mocks.addImportedTracks.mockReset()
})

describe('ensurePlayableTrack：先按源内 id 取址', () => {
  it('按 id 取址成功时直接采用它的直链，不再按名重搜', async () => {
    mocks.resolveTrackAudio.mockResolvedValueOnce(
      hallTrack({ onlineUrl: 'http://cdn.example.com/M500002RXlW80X7JS7.mp3' })
    )
    const { ensurePlayableTrack } = await import('../playlistIO.service')

    const out = await ensurePlayableTrack(hallTrack())

    expect(out?.onlineUrl).toBe('http://cdn.example.com/M500002RXlW80X7JS7.mp3')
    expect(mocks.searchOnlineTracks).not.toHaveBeenCalled()
    expect(mocks.addImportedTracks).toHaveBeenCalledTimes(1)
  })

  it('按 id 取址失败（老服务端 / 无权益）时回落按名搜索', async () => {
    mocks.searchOnlineTracks.mockResolvedValueOnce([result({ title: '雨天', duration: 274 })])
    const { ensurePlayableTrack } = await import('../playlistIO.service')

    const out = await ensurePlayableTrack(hallTrack())

    expect(mocks.resolveTrackAudio).toHaveBeenCalledTimes(1)
    expect(out?.onlineUrl).toBe('http://cdn.example.com/M500003SOSss1ciu57.mp3')
  })

  it('本地曲目（有 path）与已有直链的曲目原样返回，不做任何取址', async () => {
    const { ensurePlayableTrack } = await import('../playlistIO.service')

    const local = hallTrack({ path: '/home/Music/雨天.flac', onlineId: undefined })
    expect(await ensurePlayableTrack(local)).toBe(local)
    const ready = hallTrack({ onlineUrl: 'http://cdn.example.com/x.mp3' })
    expect(await ensurePlayableTrack(ready)).toBe(ready)
    expect(mocks.resolveTrackAudio).not.toHaveBeenCalled()
    expect(mocks.searchOnlineTracks).not.toHaveBeenCalled()
  })
})

describe('ensurePlayableTrack：按名搜索的版本判据', () => {
  it('只有同名不同版本（变速版 / Live）时返回 null，而不是把别人的录音当原唱播', async () => {
    // 实测的原始搜索结果：原版不在其中，其余两条都是版本条目
    mocks.searchOnlineTracks.mockResolvedValueOnce([
      result({ id: 'r1', title: '像晴天像雨天 (Live)', duration: 243 }),
      result({ id: 'r2', title: '汪苏泷 (那个男孩)', artist: '语海小公主', duration: 223 }),
      result({ id: 'r3', title: '雨天 (变速版)', duration: 115 }),
    ])
    const { ensurePlayableTrack } = await import('../playlistIO.service')

    expect(await ensurePlayableTrack(hallTrack({ onlineId: undefined }))).toBeNull()
    expect(mocks.addImportedTracks).not.toHaveBeenCalled()
  })

  it('原版在结果里时取原版（时长与元数据一起来判）', async () => {
    mocks.searchOnlineTracks.mockResolvedValueOnce([
      result({ id: 'r3', title: '雨天 (变速版)', duration: 115 }),
      result({
        id: 'r0',
        title: '雨天',
        album: '繁星四月 电视剧原声带',
        duration: 274,
        audioUrl: 'http://cdn.example.com/M500002RXlW80X7JS7.mp3',
      }),
    ])
    const { ensurePlayableTrack } = await import('../playlistIO.service')

    const out = await ensurePlayableTrack(hallTrack({ onlineId: undefined }))

    expect(out?.onlineUrl).toBe('http://cdn.example.com/M500002RXlW80X7JS7.mp3')
    expect(out?.onlineId).toBe('r0')
  })

  it('目标自己就是某个版本时，同标记的候选仍然可匹配', async () => {
    mocks.searchOnlineTracks.mockResolvedValueOnce([result({ title: '雨天 (Live)', duration: 274 })])
    const { ensurePlayableTrack } = await import('../playlistIO.service')

    const out = await ensurePlayableTrack(
      hallTrack({ onlineId: undefined, title: '雨天 (Live)' })
    )

    expect(out?.onlineUrl).toBe('http://cdn.example.com/M500003SOSss1ciu57.mp3')
  })

  it('搜索结果为空时返回 null（没有可播的东西）', async () => {
    mocks.searchOnlineTracks.mockResolvedValueOnce([])
    const { ensurePlayableTrack } = await import('../playlistIO.service')

    expect(await ensurePlayableTrack(hallTrack({ onlineId: undefined }))).toBeNull()
  })
})
