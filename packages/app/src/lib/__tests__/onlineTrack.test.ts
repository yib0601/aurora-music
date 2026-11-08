import { describe, it, expect } from 'vitest'
import { isDownloadableOnlineTrack, pickDownloadCandidate, pickDownloadUrl } from '../onlineTrack'
import type { Track } from '@/types'

/** 构造曲目：字段按需覆盖，避免每条都写满必填项 */
function track(partial: Partial<Track>): Track {
  return {
    id: 't1',
    path: '',
    title: '执迷不悟',
    artist: '王贰浪',
    album: '执迷不悟',
    duration: 234,
    addedAt: 0,
    playCount: 0,
    liked: false,
    ...partial,
  }
}

describe('isDownloadableOnlineTrack', () => {
  it('搜索结果的在线曲目：有播放地址 → 给下载入口', () => {
    expect(isDownloadableOnlineTrack(track({ onlineUrl: 'https://a/x.mp3', onlineSource: 'src-1' }))).toBe(true)
  })

  it('重启后从最近播放进入：快照只剩 onlineSource/onlineId（无 URL）→ 仍要给下载入口', () => {
    // 真实持久化数据形态（桌面端 Local Storage 实测）
    const snapshot = track({
      id: 'src-1788364494685-u5z3bi-000x4jVm2XQWgY',
      onlineSource: 'src-1788364494685-u5z3bi',
      onlineSourceName: 'MY',
      onlineId: 'src-1788364494685-u5z3bi-000x4jVm2XQWgY',
      coverUrl: 'https://y.qq.com/music/photo_new/T002R300x300M000000ushgb0eYhKe.jpg',
    })
    expect(snapshot.onlineUrl).toBeUndefined()
    expect(isDownloadableOnlineTrack(snapshot)).toBe(true)
  })

  it('只有 onlineQualityUrls（默认地址被剥离）→ 给下载入口', () => {
    expect(isDownloadableOnlineTrack(track({ onlineQualityUrls: { flac: 'https://a/x.flac' } }))).toBe(true)
  })

  it('本地曲目（有磁盘路径、无在线字段）→ 不给下载入口', () => {
    expect(isDownloadableOnlineTrack(track({ path: '/home/yibin/Music/a.flac' }))).toBe(false)
  })

  it('网络存储（WebDAV）曲目 → 不给下载入口', () => {
    expect(
      isDownloadableOnlineTrack(track({ path: 'webdav:lib-1/a.flac', sourceId: 'lib-1', remoteUrl: 'aurora-remote://lib-1/a.flac' }))
    ).toBe(false)
  })

  it('远端曲目（有 remoteUrl、无在线字段）→ 不给下载入口：下载管线不接远端存储直链', () => {
    expect(isDownloadableOnlineTrack(track({ remoteUrl: 'aurora-remote://lib-1/a.flac' }))).toBe(false)
  })
})

describe('pickDownloadUrl', () => {
  const withUrls = track({ onlineUrl: 'https://a/default.mp3', onlineQualityUrls: { '128': 'u128', flac: 'uflac' } })

  it('首选档位可用时直接用首选', () => {
    expect(pickDownloadUrl(withUrls, '128')).toBe('u128')
    expect(pickDownloadUrl(withUrls, 'flac')).toBe('uflac')
  })

  it('首选档位缺失时按回退链挑选，而不是回落到源默认地址', () => {
    expect(pickDownloadUrl(withUrls, '320')).toBe('uflac')
  })

  it('源未提供多音质地址时用默认地址', () => {
    expect(pickDownloadUrl(track({ onlineUrl: 'https://a/default.mp3' }), 'flac')).toBe('https://a/default.mp3')
  })
})
describe('pickDownloadCandidate 档位优先级（回归：不能只看 qualityUrls）', () => {
  it('audioUrl 是无损、qualityUrls 只有 128 → 选 audioUrl 的无损地址（旧实现会下 128）', () => {
    const t = track({
      onlineUrl: 'https://cdn/x.flac',
      onlineQualityUrls: { '128': 'https://cdn/x-128.m4a' },
    })
    expect(pickDownloadCandidate(t, 'flac')).toEqual({ url: 'https://cdn/x.flac', tier: 'flac' })
    // pickDownloadUrl 是薄包装，行为必须一致
    expect(pickDownloadUrl(t, 'flac')).toBe('https://cdn/x.flac')
  })

  it('请求 flac 但只有 320 的有损兜底地址 → 档位判为 320（供上层判降级并提示）', () => {
    const t = track({
      onlineUrl: 'https://cdn/C400.m4a',
      onlineQuality: '320',
      onlineQualityUrls: { '128': 'https://cdn/x-128.m4a' },
    })
    // 320 在 flac 回退链上排在 128 前面
    expect(pickDownloadCandidate(t, 'flac')).toEqual({ url: 'https://cdn/C400.m4a', tier: '320' })
  })

  it('audioUrl 判不出档位（m4a 且无声明）→ lossy，排在 qualityUrls 各档之后', () => {
    const t = track({
      onlineUrl: 'https://cdn/C400.m4a',
      onlineQualityUrls: { '128': 'https://cdn/x-128.m4a' },
    })
    expect(pickDownloadCandidate(t, 'flac')).toEqual({ url: 'https://cdn/x-128.m4a', tier: '128' })
  })

  it('audioUrl 在链外（lossy）时一律最后：qualityUrls 有 128 也不选兜底地址', () => {
    const t = track({
      onlineUrl: 'https://cdn/M500.mp3',
      onlineQualityUrls: { '128': 'https://cdn/x-128.m4a' },
    })
    expect(pickDownloadCandidate(t, '320').tier).toBe('128')
  })

  it('多音质地址里的无损优先于有损的 audioUrl', () => {
    const t = track({ onlineUrl: 'https://cdn/M500.mp3', onlineQualityUrls: { flac: 'https://cdn/x.flac' } })
    expect(pickDownloadCandidate(t, 'flac')).toEqual({ url: 'https://cdn/x.flac', tier: 'flac' })
  })

  it('同一档位内 qualityUrls 优先于 audioUrl（源按档位分的地址更可信）', () => {
    const t = track({ onlineUrl: 'https://cdn/default.flac', onlineQualityUrls: { flac: 'https://cdn/x.flac' } })
    expect(pickDownloadCandidate(t, 'flac').url).toBe('https://cdn/x.flac')
  })

  it('请求 128 时直接选 128（即便同时有无损），遵循用户所选档位', () => {
    const t = track({ onlineUrl: 'https://cdn/default.mp3', onlineQualityUrls: { '128': 'u128', flac: 'uflac' } })
    expect(pickDownloadCandidate(t, '128')).toEqual({ url: 'u128', tier: '128' })
    expect(pickDownloadCandidate(t, '320')).toEqual({ url: 'uflac', tier: 'flac' })
  })

  it('只有 audioUrl 时按扩展名判档位', () => {
    expect(pickDownloadCandidate(track({ onlineUrl: 'https://cdn/x.flac' }), 'flac').tier).toBe('flac')
    expect(pickDownloadCandidate(track({ onlineUrl: 'https://cdn/x.mp3' }), 'flac').tier).toBe('lossy')
  })

  it('完全没有可用地址时返回空地址 + unknown（不抛错）', () => {
    expect(pickDownloadCandidate(track({}), 'flac')).toEqual({ url: '', tier: 'unknown' })
  })
})
