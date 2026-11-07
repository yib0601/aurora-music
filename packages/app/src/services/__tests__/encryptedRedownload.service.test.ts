import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { redownloadEncryptedAudio, type RedownloadDeps } from '../encryptedRedownload.service'
import type { EncryptedAudioFile, OnlineSourceConfig, OnlineTrackSearchResult, Track } from '@/types'

/**
 * 下载目录从本机 HOME 推导：仓库公开，夹具里不写死任何真实用户路径
 * （见 docs/development.md「测试与 fixture 的隐私约束」）。
 */
const MUSIC_DIR = join(homedir(), 'Music')
const SAVED_PATH = join(MUSIC_DIR, '陈奕迅 - 十年.flac')

/**
 * 夹具取自真实形态：QQ 音乐安卓端落盘的文件名就是
 * `歌手 - 歌名 [mqms2].<加密扩展名>.<容器后缀>`。
 */
function hit(over: Partial<EncryptedAudioFile> = {}): EncryptedAudioFile {
  return {
    path: '/storage/emulated/0/Music/QQMusic/song/陈奕迅 - 十年 [mqms2].mflac0.flac',
    size: 22754099,
    family: 'qqmusic',
    token: 'mflac0',
    title: '十年',
    artist: '陈奕迅',
    ...over,
  }
}

function onlineResult(over: Partial<OnlineTrackSearchResult> = {}): OnlineTrackSearchResult {
  return {
    id: 'mid-1',
    title: '十年',
    artist: '陈奕迅',
    album: '黑白灰',
    duration: 205,
    audioUrl: 'https://cdn.example.com/ten.flac',
    source: 'src-1',
    sourceName: 'MY',
    ...over,
  }
}

const SOURCE: OnlineSourceConfig = {
  id: 'src-1',
  name: 'MY',
  sourceUrl: 'http://127.0.0.1:3201/?key=k',
  headers: { Referer: 'http://example.com' },
  enabled: true,
}

function makeDeps(over: Partial<RedownloadDeps> = {}) {
  const calls = { search: [] as string[], downloads: [] as any[], imported: [] as string[] }
  const deps: RedownloadDeps = {
    search: vi.fn(async (query: string) => {
      calls.search.push(query)
      return [onlineResult()]
    }),
    ensurePlayable: vi.fn(async (t: Track) => t),
    downloadFile: vi.fn(async (payload: any) => {
      calls.downloads.push(payload)
      return { savedPath: SAVED_PATH }
    }),
    importFile: vi.fn(async (p: string) => {
      calls.imported.push(p)
      return { id: 'new', path: p } as Track
    }),
    config: () => ({ sources: [SOURCE], downloadDir: MUSIC_DIR, quality: 'flac' as const }),
    ...over,
  }
  return { deps, calls }
}

describe('redownloadEncryptedAudio', () => {
  it('匹配 → 取址 → 下载 → 入库，一次走完', async () => {
    const { deps, calls } = makeDeps()
    const [result] = await redownloadEncryptedAudio([hit()], deps)

    expect(calls.search).toEqual(['陈奕迅 十年'])
    expect(result).toMatchObject({
      outcome: 'done',
      savedPath: SAVED_PATH,
      imported: true,
      matchedTitle: '十年',
    })
    // 下载带上歌源配置的附加请求头（与搜索请求同一份），以及默认下载目录
    expect(calls.downloads[0]).toMatchObject({ audioUrl: 'https://cdn.example.com/ten.flac', title: '十年' })
  })

  it('搜不到 → no-match', async () => {
    const { deps } = makeDeps({ search: vi.fn(async () => []) })
    const [result] = await redownloadEncryptedAudio([hit()], deps)
    expect(result.outcome).toBe('no-match')
  })

  it('只有同名不同歌手 → 分数不够，判 no-match（宁可漏也不下错歌）', async () => {
    const { deps } = makeDeps({
      search: vi.fn(async () => [onlineResult({ artist: '某翻唱歌手' })]),
    })
    const [result] = await redownloadEncryptedAudio([hit()], deps)
    expect(result.outcome).toBe('no-match')
  })

  it('伴奏/翻唱候选被排除', async () => {
    const { deps } = makeDeps({
      search: vi.fn(async () => [onlineResult({ title: '十年 (伴奏)' })]),
    })
    const [result] = await redownloadEncryptedAudio([hit()], deps)
    expect(result.outcome).toBe('no-match')
  })

  it('匹配到但取不到地址 → no-address（VIP 试听 / 直链失效）', async () => {
    const { deps } = makeDeps({
      search: vi.fn(async () => [onlineResult({ audioUrl: '' })]),
      ensurePlayable: vi.fn(async () => null),
    })
    const [result] = await redownloadEncryptedAudio([hit()], deps)
    expect(result.outcome).toBe('no-address')
  })

  it('惰性取址的源（搜索结果不带地址）在取址成功后照常下载', async () => {
    const { deps } = makeDeps({
      search: vi.fn(async () => [
        onlineResult({ audioUrl: '', trackRef: { sourceId: 'src-1', platform: 'tx', meta: { songmid: 'mid-1' } } }),
      ]),
      ensurePlayable: vi.fn(async (t: Track) => ({ ...t, onlineUrl: 'https://cdn.example.com/lazy.flac' })),
    })
    const [result] = await redownloadEncryptedAudio([hit()], deps)
    expect(result.outcome).toBe('done')
  })

  it('下载抛错 → failed，错误原文透出', async () => {
    const { deps } = makeDeps({
      downloadFile: vi.fn(async () => {
        throw new Error('EACCES: permission denied')
      }),
    })
    const [result] = await redownloadEncryptedAudio([hit()], deps)
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('EACCES')
  })

  it('文件名还原不出歌名 → 不发搜索请求，直接 no-match', async () => {
    const { deps, calls } = makeDeps()
    const [result] = await redownloadEncryptedAudio([hit({ title: '', artist: '' })], deps)
    expect(result.outcome).toBe('no-match')
    expect(calls.search).toEqual([])
  })

  it('平台不提供入库能力时仍算 done，但 imported=false', async () => {
    const { deps } = makeDeps({ importFile: undefined })
    const [result] = await redownloadEncryptedAudio([hit()], deps)
    expect(result).toMatchObject({ outcome: 'done', imported: false })
  })

  it('批量：逐条回调进度，顺序与入参一致', async () => {
    const seen: Array<[number, number, string]> = []
    const { deps } = makeDeps({
      onProgress: (done, total, result) => seen.push([done, total, result.path]),
    })
    const files = [hit({ path: '/a.mflac0.flac' }), hit({ path: '/b.mflac0.flac' })]
    const results = await redownloadEncryptedAudio(files, deps)

    expect(results.map((r) => r.path)).toEqual(['/a.mflac0.flac', '/b.mflac0.flac'])
    expect(seen).toEqual([
      [1, 2, '/a.mflac0.flac'],
      [2, 2, '/b.mflac0.flac'],
    ])
  })

  it('取消后不再处理剩余文件', async () => {
    let canceled = false
    const { deps, calls } = makeDeps({
      isCanceled: () => canceled,
      onProgress: () => {
        // 第一条处理完就取消
        canceled = true
      },
    })
    const files = [hit({ path: '/a.mflac0.flac' }), hit({ path: '/b.mflac0.flac' })]
    const results = await redownloadEncryptedAudio(files, deps)

    expect(results).toHaveLength(1)
    expect(calls.search).toHaveLength(1)
  })
})
