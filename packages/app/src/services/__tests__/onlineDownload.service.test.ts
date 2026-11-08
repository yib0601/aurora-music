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
// ─── 音质：优先满足所选档位 + 降级提示 ────────────────────────────
// 线上实测形态：请求 flac 时 audioUrl 常是 C400 的 m4a（服务端声明 quality:"320"），
// qualityUrls 只有 128 或为空。用户设了 flac 却下到 m4a，且界面完全没有提示。

describe('runOnlineDownload 音质档位', () => {
  /** 兜底源给的低档地址：声明 320，但只有 m4a 文件 */
  const lossyNow = (partial: Partial<Track> = {}) =>
    track({
      onlineSource: 'src-1',
      onlineSourceName: 'MY',
      onlineUrl: 'https://cdn/C400.m4a',
      onlineQuality: '320',
      ...partial,
    })

  it('audioUrl 是 flac、qualityUrls 只有 128 → 直接下 flac，不做降级提示', async () => {
    const resolved = track({
      onlineSource: 'src-1',
      onlineSourceName: 'MY',
      onlineUrl: 'https://cdn/x.flac',
      onlineQualityUrls: { '128': 'https://cdn/x-128.m4a' },
    })
    const attempt = vi.fn(async () => null)
    const { deps, calls } = makeDeps({
      resolveTrack: vi.fn(async () => resolved),
      config: () => ({ sources: [SOURCE], downloadDir: '/home/yibin/Music', quality: 'flac' as const }),
      attemptRequestedQuality: attempt,
    })

    expect(await runOnlineDownload(track({ onlineSource: 'src-1' }), deps)).toBe('saved')
    expect(calls.files[0].audioUrl).toBe('https://cdn/x.flac')
    // 已满足所选档位：不必再取址，也不能提示降级
    expect(attempt).not.toHaveBeenCalled()
    expect(calls.notify[0][0]).not.toContain('音质未达所选档位')
  })

  it('再取址成功升档 → 用更高档的地址下载，且不提示降级', async () => {
    const upgraded = track({
      onlineSource: 'src-1',
      onlineSourceName: 'MY',
      onlineUrl: 'https://cdn/x.flac',
      onlineQuality: 'flac',
    })
    const { deps, calls } = makeDeps({
      resolveTrack: vi.fn(async () => lossyNow()),
      config: () => ({ sources: [SOURCE], downloadDir: '/home/yibin/Music', quality: 'flac' as const }),
      attemptRequestedQuality: vi.fn(async () => upgraded),
    })

    expect(await runOnlineDownload(track({ onlineSource: 'src-1' }), deps)).toBe('saved')
    expect(calls.files[0].audioUrl).toBe('https://cdn/x.flac')
    expect(calls.notify[0][0]).toContain('下载完成')
    expect(calls.notify[0][0]).not.toContain('音质未达所选档位')
  })

  it('再取址失败仍降级 → 照原候选下载，成功提示里追加降级说明（类型仍是 success）', async () => {
    const { deps, calls } = makeDeps({
      resolveTrack: vi.fn(async () => lossyNow()),
      config: () => ({ sources: [SOURCE], downloadDir: '/home/yibin/Music', quality: 'flac' as const }),
      attemptRequestedQuality: vi.fn(async () => null),
    })

    expect(await runOnlineDownload(track({ onlineSource: 'src-1' }), deps)).toBe('saved')
    expect(calls.files[0].audioUrl).toBe('https://cdn/C400.m4a')
    const [message, options] = calls.notify[0]
    expect(message).toContain('下载完成')
    expect(message).toContain('音质未达所选档位')
    // {requested} / {actual} 都渲染成了档位展示名（不是占位符原文）
    expect(message).toContain('无损 FLAC')
    expect(message).toContain('高品质 320k')
    expect(message).not.toContain('{requested}')
    expect(message).not.toContain('{actual}')
    expect(options?.type ?? 'success').toBe('success')
  })

  it('再取址返回更差的档位 → 不替换，仍用原候选并提示降级', async () => {
    const worse = track({
      onlineSource: 'src-1',
      onlineSourceName: 'MY',
      onlineUrl: 'https://cdn/x-128.m4a',
      onlineQualityUrls: { '128': 'https://cdn/x-128.m4a' },
    })
    const { deps, calls } = makeDeps({
      // 原始候选已是 320：再取址拿回 128 属于「更差」，必须丢弃
      resolveTrack: vi.fn(async () => lossyNow()),
      config: () => ({ sources: [SOURCE], downloadDir: '/home/yibin/Music', quality: 'flac' as const }),
      attemptRequestedQuality: vi.fn(async () => worse),
    })

    await runOnlineDownload(track({ onlineSource: 'src-1' }), deps)
    expect(calls.files[0].audioUrl).toBe('https://cdn/C400.m4a')
    expect(calls.notify[0][0]).toContain('音质未达所选档位')
  })

  it('再取址抛错 → 不影响下载，按原候选下载并提示降级', async () => {
    const { deps, calls } = makeDeps({
      resolveTrack: vi.fn(async () => lossyNow()),
      config: () => ({ sources: [SOURCE], downloadDir: '/home/yibin/Music', quality: 'flac' as const }),
      attemptRequestedQuality: vi.fn(async () => {
        throw new Error('网络请求失败')
      }),
    })

    expect(await runOnlineDownload(track({ onlineSource: 'src-1' }), deps)).toBe('saved')
    expect(calls.files[0].audioUrl).toBe('https://cdn/C400.m4a')
    expect(calls.notify[0][0]).toContain('音质未达所选档位')
  })

  it('请求 320 只有 128 → 判降级并提示；请求 128 下载 128 → 不提示', async () => {
    const only128 = track({
      onlineSource: 'src-1',
      onlineSourceName: 'MY',
      onlineUrl: 'https://cdn/x-128.m4a',
      onlineQualityUrls: { '128': 'https://cdn/x-128.m4a' },
    })
    const ask320 = makeDeps({
      resolveTrack: vi.fn(async () => only128),
      config: () => ({ sources: [SOURCE], downloadDir: '/home/yibin/Music', quality: '320' as const }),
    })
    await runOnlineDownload(track({ onlineSource: 'src-1' }), ask320.deps)
    expect(ask320.calls.files[0].audioUrl).toBe('https://cdn/x-128.m4a')
    expect(ask320.calls.notify[0][0]).toContain('音质未达所选档位')

    const ask128 = makeDeps({
      resolveTrack: vi.fn(async () => only128),
      config: () => ({ sources: [SOURCE], downloadDir: '/home/yibin/Music', quality: '128' as const }),
    })
    await runOnlineDownload(track({ onlineSource: 'src-1' }), ask128.deps)
    expect(ask128.calls.files[0].audioUrl).toBe('https://cdn/x-128.m4a')
    expect(ask128.calls.notify[0][0]).not.toContain('音质未达所选档位')
  })

  it('源切换文案与降级说明共存：两句都在（不互相吞掉）', async () => {
    const other = track({
      onlineSource: 'src-9',
      onlineSourceName: 'OTHER',
      onlineUrl: 'https://cdn/C400.m4a',
      onlineQuality: '320',
    })
    const { deps, calls } = makeDeps({
      resolveTrack: vi.fn(async () => other),
      config: () => ({ sources: [SOURCE], downloadDir: '/home/yibin/Music', quality: 'flac' as const }),
      attemptRequestedQuality: vi.fn(async () => null),
    })

    await runOnlineDownload(track({ onlineSource: 'src-1', onlineSourceName: 'MY' }), deps)
    expect(calls.notify[0][0]).toContain('音源：OTHER')
    expect(calls.notify[0][0]).toContain('音质未达所选档位')
  })
})

describe('runOnlineDownload 部分提升（128 → 320）', () => {
  it('再取址只升到 320 也替换：不追求满分升档，但拿到更高就用，并如实提示仍降级', async () => {
    const only128 = track({
      onlineSource: 'src-1',
      onlineSourceName: 'MY',
      onlineUrl: 'https://cdn/x-128.m4a',
      onlineQualityUrls: { '128': 'https://cdn/x-128.m4a' },
    })
    const partial320 = track({
      onlineSource: 'src-1',
      onlineSourceName: 'MY',
      onlineUrl: 'https://cdn/C400.m4a',
      onlineQuality: '320',
    })
    const { deps, calls } = makeDeps({
      resolveTrack: vi.fn(async () => only128),
      config: () => ({ sources: [SOURCE], downloadDir: '/home/yibin/Music', quality: 'flac' as const }),
      attemptRequestedQuality: vi.fn(async () => partial320),
    })

    await runOnlineDownload(track({ onlineSource: 'src-1' }), deps)

    // 320 > 128：tierRank 更高就替换（不必等到 flac）
    expect(calls.files[0].audioUrl).toBe('https://cdn/C400.m4a')
    // 相对所选档位仍偏低，提示照旧
    expect(calls.notify[0][0]).toContain('音质未达所选档位')
    expect(calls.notify[0][0]).toContain('高品质 320k')
  })

  it('再取址返回同档（320 → 320 的另一条）不替换：避免把稳定的原候选换成未知来源', async () => {
    const already320 = track({
      onlineSource: 'src-1',
      onlineSourceName: 'MY',
      onlineUrl: 'https://cdn/orig.mp3',
      onlineQuality: '320',
    })
    const sameTier = track({
      onlineSource: 'src-1',
      onlineSourceName: 'MY',
      onlineUrl: 'https://cdn/other.mp3',
      onlineQuality: '320',
    })
    const { deps, calls } = makeDeps({
      resolveTrack: vi.fn(async () => already320),
      config: () => ({ sources: [SOURCE], downloadDir: '/home/yibin/Music', quality: 'flac' as const }),
      attemptRequestedQuality: vi.fn(async () => sameTier),
    })

    await runOnlineDownload(track({ onlineSource: 'src-1' }), deps)
    expect(calls.files[0].audioUrl).toBe('https://cdn/orig.mp3')
  })
})
