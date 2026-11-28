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
      // 并发档必须锁成 1 才测得出「取消拦住了后续」：档位 > 1 时所有条目在第一个
      // 完成前就已经启动，取消只能拦住**还没启动**的那些（见下方 canceled 用例）
      concurrency: 1,
      isCanceled: () => canceled,
      onProgress: () => {
        // 第一条处理完就取消
        canceled = true
      },
    })
    const files = [hit({ path: '/a.mflac0.flac' }), hit({ path: '/b.mflac0.flac' })]
    const results = await redownloadEncryptedAudio(files, deps)

    // 结果仍按入参一一对应（未启动的那条是 canceled），但只搜过一条
    expect(results.map((r) => r.outcome)).toEqual(['done', 'canceled'])
    expect(calls.search).toHaveLength(1)
  })
})

/**
 * 批量替换（多选 + 有界并发 + 可选清理原件）新增的三条不变量。
 *
 * 这一组用例存在的理由是：这三条一旦被改坏，用户看到的现象都是「一切正常」——
 * 取消没有报错、并发没有报错、清理也没有报错，只有文件真的没了或者数字对不上时
 * 才发现。所以每条都要能从返回值上验证，而不是靠读代码。
 */
describe('redownloadEncryptedAudio：批量替换', () => {
  it('并发档真的并行：同时在途不超过 concurrency，且比串行快', async () => {
    let live = 0
    let peak = 0
    const { deps } = makeDeps({
      ensurePlayable: vi.fn(async (t: Track) => {
        live += 1
        peak = Math.max(peak, live)
        await new Promise((r) => setTimeout(r, 10))
        live -= 1
        return t
      }),
      concurrency: 3,
    })
    const files = Array.from({ length: 9 }, (_, i) => hit({ path: `/p${i}.mflac0.flac` }))
    const results = await redownloadEncryptedAudio(files, deps)

    expect(results).toHaveLength(9)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('结果顺序恒等于入参顺序（并发完成次序打乱也不影响）', async () => {
    // 第 i 条的耗时反过来：最后一条最快，第一条最慢
    const { deps } = makeDeps({
      search: vi.fn(async (query: string) => {
        await new Promise((r) => setTimeout(r, 5))
        return [onlineResult({ title: query })]
      }),
      concurrency: 3,
    })
    const files = [
      hit({ path: '/slow.mflac0.flac', artist: 'A', title: 'slow' }),
      hit({ path: '/mid.mflac0.flac', artist: 'B', title: 'mid' }),
      hit({ path: '/fast.mflac0.flac', artist: 'C', title: 'fast' }),
    ]
    const results = await redownloadEncryptedAudio(files, deps)
    expect(results.map((r) => r.path)).toEqual([
      '/slow.mflac0.flac',
      '/mid.mflac0.flac',
      '/fast.mflac0.flac',
    ])
  })

  it('并发档被夹到上限：传 999 不会真的打出 999 条在途请求', async () => {
    const { deps } = makeDeps({
      ensurePlayable: vi.fn(async (t: Track) => {
        await new Promise((r) => setTimeout(r, 2))
        return t
      }),
      concurrency: 999,
    })
    const files = Array.from({ length: 12 }, (_, i) => hit({ path: `/c${i}.mflac0.flac` }))
    const results = await redownloadEncryptedAudio(files, deps)
    expect(results.every((r) => r.outcome === 'canceled' || r.outcome === 'done')).toBe(true)
  })

  it('取消时未启动的条目返回 canceled（而不是从数组里消失）', async () => {
    let started = 0
    const { deps } = makeDeps({
      concurrency: 1,
      search: vi.fn(async (q: string) => {
        started += 1
        return [onlineResult({ title: q })]
      }),
      isCanceled: () => started >= 1,
    })
    const files = [hit({ path: '/a.mflac0.flac' }), hit({ path: '/b.mflac0.flac' })]
    const results = await redownloadEncryptedAudio(files, deps)

    expect(results.map((r) => r.outcome)).toEqual(['done', 'canceled'])
  })

  it('replaceSource 开启且入库成功 → 清理原件', async () => {
    const removed: string[] = []
    const { deps } = makeDeps({
      replaceSource: true,
      removeSourceFile: vi.fn(async (p: string) => {
        removed.push(p)
      }),
    })
    const [result] = await redownloadEncryptedAudio([hit()], deps)

    expect(removed).toEqual([hit().path])
    expect(result).toMatchObject({ outcome: 'done', sourceRemoved: true })
  })

  it('**没入库就绝不清理原件**（否则用户两头空）', async () => {
    const removed: string[] = []
    const { deps } = makeDeps({
      replaceSource: true,
      importFile: vi.fn(async () => null),
      removeSourceFile: vi.fn(async (p: string) => {
        removed.push(p)
      }),
    })
    const [result] = await redownloadEncryptedAudio([hit()], deps)

    expect(removed).toEqual([])
    expect(result).toMatchObject({ outcome: 'done', imported: false })
    expect(result.sourceRemoved).toBeUndefined()
  })

  it('未开启 replaceSource → 不调用清理，sourceRemoved 保持未定义', async () => {
    const removeSourceFile = vi.fn(async () => {})
    const { deps } = makeDeps({ removeSourceFile })
    const [result] = await redownloadEncryptedAudio([hit()], deps)

    expect(removeSourceFile).not.toHaveBeenCalled()
    expect(result.sourceRemoved).toBeUndefined()
  })

  it('清理失败不翻转 outcome，但如实带出原因', async () => {
    const { deps } = makeDeps({
      replaceSource: true,
      removeSourceFile: vi.fn(async () => {
        throw new Error('gio: no trash support')
      }),
    })
    const [result] = await redownloadEncryptedAudio([hit()], deps)

    expect(result.outcome).toBe('done')
    expect(result.sourceRemoved).toBe(false)
    expect(result.cleanupError).toContain('trash')
  })

  it('未匹配/取不到址的条目不会被清理（没有可替换的对象）', async () => {
    const removeSourceFile = vi.fn(async () => {})
    const { deps } = makeDeps({
      replaceSource: true,
      removeSourceFile,
      search: vi.fn(async () => []),
    })
    const [result] = await redownloadEncryptedAudio([hit()], deps)

    expect(removeSourceFile).not.toHaveBeenCalled()
    expect(result).toMatchObject({ outcome: 'no-match' })
  })

  it('落盘路径与原件相同（极端情形）时不清理：删掉的会是刚下好的新文件', async () => {
    const removeSourceFile = vi.fn(async () => {})
    const { deps } = makeDeps({
      replaceSource: true,
      removeSourceFile,
      // 下载器把新文件写回原路径（同名覆盖）
      downloadFile: vi.fn(async () => ({ savedPath: hit().path })),
    })
    const [result] = await redownloadEncryptedAudio([hit()], deps)

    expect(removeSourceFile).not.toHaveBeenCalled()
    expect(result.outcome).toBe('done')
  })
})

describe('redownloadEncryptedAudio：「扫描进行中」相关的三个契约', () => {
  /**
   * 这三条都来自同一个真实场景：**用户在批次进行中，扫描正在跑**。
   * 加密文件识别与待处理列表由扫描产生，替换动作又会往同一个目录里写新文件，
   * 两条链路在时间上必然重叠。
   */

  it('整批期间挂起自动重扫，结束后（正常完成）恢复', async () => {
    const events: string[] = []
    const { deps } = makeDeps({
      onBatchStart: () => void events.push('start'),
      onBatchEnd: () => void events.push('end'),
    })
    await redownloadEncryptedAudio([hit(), hit({ path: '/m/b.mflac0.flac' })], deps)

    // 必须是「先挂起、后恢复」且各一次：多次挂起会让恢复次数对不上，
    // 而恢复漏掉会让 watcher 永久挂着（之后新增的歌要等下次启动才进库）
    expect(events).toEqual(['start', 'end'])
  })

  it('整批抛错也必须恢复自动重扫（否则 watcher 永久挂起）', async () => {
    const events: string[] = []
    const { deps } = makeDeps({
      onBatchStart: () => void events.push('start'),
      onBatchEnd: () => void events.push('end'),
      // search 抛错会被 redownloadOne 吞成 outcome=failed，所以让 onBatchStart 之后
      // 由 progress 回调抛出，模拟渲染层在批次中途炸掉
      onProgress: () => {
        throw new Error('renderer exploded')
      },
    })
    await expect(redownloadEncryptedAudio([hit()], deps)).rejects.toThrow('renderer exploded')

    expect(events).toEqual(['start', 'end'])
  })

  it('恢复失败不影响已经完成的结果（新文件已在库里，不该因收尾失败而报错）', async () => {
    const { deps } = makeDeps({
      onBatchStart: () => {},
      onBatchEnd: () => {
        throw new Error('ipc gone')
      },
    })
    const [result] = await redownloadEncryptedAudio([hit()], deps)

    expect(result.outcome).toBe('done')
    expect(result.imported).toBe(true)
  })

  it('入库成功后把曲目回流给曲库（否则列表一直是旧的）', async () => {
    const imported: Track[] = []
    const { deps } = makeDeps({ onTrackImported: (t) => imported.push(t) })
    await redownloadEncryptedAudio([hit()], deps)

    expect(imported).toHaveLength(1)
    expect(imported[0].path).toBe(SAVED_PATH)
  })

  it('入库失败时不回流（列表里不该出现一条库里没有的记录）', async () => {
    const imported: Track[] = []
    const { deps } = makeDeps({
      onTrackImported: (t) => imported.push(t),
      importFile: vi.fn(async () => null),
    })
    const [result] = await redownloadEncryptedAudio([hit()], deps)

    expect(imported).toEqual([])
    expect(result).toMatchObject({ outcome: 'done', imported: false })
  })

  it('取消后剩余条目不再启动，但批次仍正常收尾（恢复自动重扫）', async () => {
    const events: string[] = []
    let canceled = false
    const { deps, calls } = makeDeps({
      concurrency: 1,
      onBatchStart: () => void events.push('start'),
      onBatchEnd: () => void events.push('end'),
      isCanceled: () => canceled,
      onProgress: (done) => {
        // 第一首结算后立刻取消
        if (done === 1) canceled = true
      },
    })
    const results = await redownloadEncryptedAudio([hit(), hit({ path: '/m/b.mflac0.flac' })], deps)

    expect(calls.downloads).toHaveLength(1)
    expect(results.map((r) => r.outcome)).toEqual(['done', 'canceled'])
    expect(events).toEqual(['start', 'end'])
  })
})
