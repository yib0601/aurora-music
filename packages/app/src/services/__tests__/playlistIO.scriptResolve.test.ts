/**
 * `ensurePlayableTrack` 的「跨源脚本取址」决策测试
 *
 * 背景：洛雪自定义脚本绝大多数只实现 `musicUrl`。用户在设置页给脚本源指定平台后，
 * 别的音源搜到的该平台曲目在播放/下载时应**先**交给脚本取直链。这条链最容易被写错的
 * 地方是**顺序**：搜索返回的条目本身就带 `audioUrl`，如果「已有地址就早退」的分支排在
 * 前面，脚本偏好会永远执行不到（且没有任何报错，只有日志能看出来）。
 *
 * 因此这里钉两件事：
 *   1) 脚本取到地址时用它，且不再走自带凭据取址 / 按名搜索；
 *   2) 脚本取不到（null / 地址非法 / 抛错）时，行为与引入这条链之前**完全一致**。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '@/types'

const mocks = vi.hoisted(() => ({
  resolveScriptTrackAudio: vi.fn(async (..._args: unknown[]) => null as Track | null),
  resolveTrackAudio: vi.fn(async (..._args: unknown[]) => null as Track | null),
  searchOnlineTracks: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  addImportedTracks: vi.fn(),
}))

vi.mock('@/services/platform', () => ({
  platform: {
    get resolveScriptTrackAudio() {
      return mocks.resolveScriptTrackAudio
    },
    resolveTrackAudio: mocks.resolveTrackAudio,
    searchOnlineTracks: mocks.searchOnlineTracks,
  },
}))

vi.mock('@/stores/libraryStore', () => ({
  useLibraryStore: {
    getState: () => ({
      onlineSources: [
        {
          id: 'src-aurora',
          name: 'Aurora 音源',
          kind: 'aurora',
          sourceUrl: 'https://music.example.com?key=00000000-0000-0000-0000-000000000000',
          enabled: true,
        },
        {
          id: 'src-script',
          name: '洛雪脚本',
          sourceUrl: 'https://example.invalid/fish/latest.js',
          enabled: true,
          platform: 'tx',
        },
      ],
      downloadQuality: '128',
    }),
  },
}))

vi.mock('@/stores/playlistStore', () => ({
  usePlaylistStore: { getState: () => ({ addImportedTracks: mocks.addImportedTracks }) },
}))

/** 搜索返回的条目转成的曲目：自带直链（这正是「早退」诱因） */
const readyTrack = (over: Partial<Track> = {}): Track =>
  ({
    id: 'online-1',
    path: '',
    title: '起风了',
    artist: '买辣椒也用券',
    album: '起风了',
    duration: 325,
    addedAt: 0,
    playCount: 0,
    liked: false,
    onlineSource: 'src-aurora',
    onlineSourceName: 'Aurora 音源',
    onlineId: '003AkvB00CnBkb',
    onlineUrl: 'https://isure6.stream.qqmusic.qq.com/C400003AkvB00CnBkb.m4a',
    ...over,
  }) as Track

beforeEach(() => {
  mocks.resolveScriptTrackAudio.mockReset()
  mocks.resolveScriptTrackAudio.mockResolvedValue(null)
  mocks.resolveTrackAudio.mockReset()
  mocks.resolveTrackAudio.mockResolvedValue(null)
  mocks.searchOnlineTracks.mockReset()
  mocks.searchOnlineTracks.mockResolvedValue([])
  mocks.addImportedTracks.mockReset()
})

describe('脚本源优先取址', () => {
  it('脚本取到直链时采用它，覆盖搜索条目自带的地址', async () => {
    mocks.resolveScriptTrackAudio.mockResolvedValueOnce(
      readyTrack({ onlineUrl: 'https://cdn.example.invalid/script.flac', onlineQuality: 'flac' })
    )
    const { ensurePlayableTrack } = await import('../playlistIO.service')

    const out = await ensurePlayableTrack(readyTrack())

    expect(out?.onlineUrl).toBe('https://cdn.example.invalid/script.flac')
    // 走到脚本就停：不再用曲目自带凭据取址，也不按名重搜
    expect(mocks.resolveTrackAudio).not.toHaveBeenCalled()
    expect(mocks.searchOnlineTracks).not.toHaveBeenCalled()
    // 取到的新地址要回填队列（否则播放条显示的还是旧地址）
    expect(mocks.addImportedTracks).toHaveBeenCalledTimes(1)
  })

  it('脚本取不到时，已有直链的曲目原样返回（与引入这条链之前一致）', async () => {
    const { ensurePlayableTrack } = await import('../playlistIO.service')
    const track = readyTrack()

    expect(await ensurePlayableTrack(track)).toBe(track)
    expect(mocks.resolveScriptTrackAudio).toHaveBeenCalledTimes(1)
    expect(mocks.resolveTrackAudio).not.toHaveBeenCalled()
    expect(mocks.searchOnlineTracks).not.toHaveBeenCalled()
  })

  it('脚本抛错按「取不到」处理，不影响播放', async () => {
    mocks.resolveScriptTrackAudio.mockRejectedValueOnce(new Error('script host not ready'))
    const { ensurePlayableTrack } = await import('../playlistIO.service')
    const track = readyTrack()

    expect(await ensurePlayableTrack(track)).toBe(track)
  })

  it('脚本返回空地址时不算命中，仍回落原地址', async () => {
    mocks.resolveScriptTrackAudio.mockResolvedValueOnce(readyTrack({ onlineUrl: '' }))
    const { ensurePlayableTrack } = await import('../playlistIO.service')
    const track = readyTrack()

    expect(await ensurePlayableTrack(track)).toBe(track)
  })

  it('没有直链的曲目：脚本取不到时继续走自带凭据取址（不改变旧链路）', async () => {
    mocks.resolveTrackAudio.mockResolvedValueOnce(
      readyTrack({ onlineUrl: 'https://cdn.example.invalid/source.mp3' })
    )
    const { ensurePlayableTrack } = await import('../playlistIO.service')

    const out = await ensurePlayableTrack(readyTrack({ onlineUrl: undefined }))

    expect(out?.onlineUrl).toBe('https://cdn.example.invalid/source.mp3')
    expect(mocks.resolveTrackAudio).toHaveBeenCalledTimes(1)
  })
})
