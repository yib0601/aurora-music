import { describe, it, expect, vi } from 'vitest'
import { runOnlineDownload, type OnlineDownloadDeps } from '../onlineDownload.service'
import type { Track, OnlineSourceConfig } from '@/types'

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

const SOURCE: OnlineSourceConfig = {
  id: 'src-1',
  name: 'MY',
  sourceUrl: 'http://127.0.0.1:3201/?key=k',
  headers: { Referer: 'http://example.com' },
  enabled: true,
}

function makeDeps(over: Partial<OnlineDownloadDeps> = {}) {
  const calls: { notify: [string, any][]; downloadDir: string[]; files: any[] } = {
    notify: [],
    downloadDir: [],
    files: [],
  }
  const deps: OnlineDownloadDeps = {
    resolveTrack: vi.fn(async () => null),
    downloadFile: vi.fn(async (payload: any) => {
      calls.files.push(payload)
      return { savedPath: '/home/yibin/Music/执迷不悟.mp3' }
    }),
    config: () => ({ sources: [SOURCE], downloadDir: '/home/yibin/Music', quality: '320' as const }),
    isDesktop: true,
    notify: (message, options) => calls.notify.push([message, options]),
    setDownloadDir: (dir) => calls.downloadDir.push(dir),
    ...over,
  }
  return { deps, calls }
}

describe('runOnlineDownload', () => {
  it('最近播放快照没有播放地址：先按需取址再用新地址下载', async () => {
    // 真实形态：持久化剥离了 onlineUrl，只剩来源与条目 id
    const snapshot = track({ onlineSource: 'src-1', onlineSourceName: 'MY', onlineId: 'x-1' })
    const resolved = track({ ...snapshot, onlineUrl: 'https://cdn/x.mp3', onlineQualityUrls: { '320': 'u320', flac: 'uflac' } })
    const { deps, calls } = makeDeps({ resolveTrack: vi.fn(async () => resolved) })

    expect(await runOnlineDownload(snapshot, deps)).toBe('saved')
    expect(calls.files).toHaveLength(1)
    // 音质设置 320 命中多音质地址，而不是源默认地址
    expect(calls.files[0].audioUrl).toBe('u320')
    expect(calls.files[0].title).toBe('执迷不悟')
    expect(calls.notify[0][0]).toContain('下载完成')
  })

  it('取址无结果（未配置歌源 / 搜不到）：如实报错且不发起下载', async () => {
    const { deps, calls } = makeDeps({ resolveTrack: vi.fn(async () => null) })
    expect(await runOnlineDownload(track({ onlineSource: 'src-1' }), deps)).toBe('no-source')
    expect(calls.files).toHaveLength(0)
    expect(calls.notify[0][0]).toContain('无法下载')
    expect(calls.notify[0][1].type).toBe('error')
  })

  it('取址过程抛错但曲目本身有地址：回退到现有地址照常下载', async () => {
    const withUrl = track({ onlineUrl: 'https://cdn/old.mp3', onlineSource: 'src-1' })
    const { deps, calls } = makeDeps({
      resolveTrack: vi.fn(async () => {
        throw new Error('网络请求失败')
      }),
    })
    expect(await runOnlineDownload(withUrl, deps)).toBe('saved')
    expect(calls.files[0].audioUrl).toBe('https://cdn/old.mp3')
  })

  it('取址命中别的音源：完成提示里标注实际音源', async () => {
    const snapshot = track({ onlineSource: 'src-1', onlineSourceName: 'MY' })
    const other = track({ onlineUrl: 'https://cdn/x.mp3', onlineSource: 'src-9', onlineSourceName: 'OTHER' })
    const { deps, calls } = makeDeps({ resolveTrack: vi.fn(async () => other) })
    await runOnlineDownload(snapshot, deps)
    expect(calls.notify[0][0]).toContain('音源：OTHER')
  })

  it('歌源配置的附加请求头随下载下发（与搜索请求一致）', async () => {
    const withUrl = track({ onlineUrl: 'https://cdn/x.mp3', onlineSource: 'src-1' })
    const seen: any[] = []
    const { deps } = makeDeps({
      downloadFile: vi.fn(async (_p, headers) => {
        seen.push(headers)
        return { savedPath: '/home/yibin/Music/a.mp3' }
      }),
    })
    await runOnlineDownload(withUrl, deps)
    expect(seen[0]).toEqual({ Referer: 'http://example.com' })
  })

  it('桌面端无默认目录：给「设为默认下载目录」入口，点击后落盘该目录', async () => {
    const withUrl = track({ onlineUrl: 'https://cdn/x.mp3', onlineSource: 'src-1' })
    const { deps, calls } = makeDeps({
      config: () => ({ sources: [SOURCE], downloadDir: null, quality: 'flac' as const }),
      downloadFile: vi.fn(async () => ({ savedPath: '/home/yibin/Music/new/a.mp3' })),
    })
    await runOnlineDownload(withUrl, deps)
    const action = calls.notify[0][1]?.action
    expect(action?.label).toBe('设为默认下载目录')
    action.onClick()
    expect(calls.downloadDir).toEqual(['/home/yibin/Music/new'])
  })

  it('移动端即使无默认目录也不给该入口（相对路径反推会存成绝对路径）', async () => {
    const withUrl = track({ onlineUrl: 'https://cdn/x.mp3', onlineSource: 'src-1' })
    const { deps, calls } = makeDeps({
      isDesktop: false,
      config: () => ({ sources: [SOURCE], downloadDir: null, quality: '320' as const }),
    })
    await runOnlineDownload(withUrl, deps)
    expect(calls.notify[0][1]?.action).toBeUndefined()
  })

  it('用户在保存对话框取消：不算失败，不报错', async () => {
    const withUrl = track({ onlineUrl: 'https://cdn/x.mp3', onlineSource: 'src-1' })
    const { deps, calls } = makeDeps({
      downloadFile: vi.fn(async () => {
        throw new Error('已取消保存')
      }),
    })
    expect(await runOnlineDownload(withUrl, deps)).toBe('cancelled')
    expect(calls.notify).toHaveLength(0)
  })

  it('下载失败：透出主进程的错误原因', async () => {
    const withUrl = track({ onlineUrl: 'https://cdn/x.mp3', onlineSource: 'src-1' })
    const { deps, calls } = makeDeps({
      downloadFile: vi.fn(async () => {
        throw new Error('HTTP 403')
      }),
    })
    expect(await runOnlineDownload(withUrl, deps)).toBe('failed')
    expect(calls.notify[0][0]).toBe('HTTP 403')
    expect(calls.notify[0][1].type).toBe('error')
  })
})