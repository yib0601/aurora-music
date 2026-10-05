import { describe, it, expect } from 'vitest'
import { isDownloadableOnlineTrack, pickDownloadUrl } from '../onlineTrack'
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