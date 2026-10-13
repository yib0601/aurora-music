/**
 * 歌词加载的去重、缓存与落地取舍单测。
 *
 * 为什么打桩平台层：这三个行为（同曲并发只打一次上游、空结果不缓存、已有歌词不降级
 * 为空态）都在真机上是概率事件——上游 LRCLIB 的 /api/search 响应体 150KB+、p90 >20s，
 * 8s 预算下偶发超时才会露出「暂无歌词」这一屏。打桩后这些分支可确定性重放，
 * 真机只用于确认「重复进出播放页不再清空歌词」这条主干。
 *
 * 平台层与曲库 store 都必须打桩：真实 import 会牵进 Capacitor / 主进程桥，
 * 且 libraryStore 的 zustand persist 在 node 环境下没有 localStorage。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    /** 打到上游（platform.searchLyrics）的调用次数 */
    upstreamCalls: 0,
  }
  return {
    state,
    platformMock: {
      readLyrics: vi.fn(async (_trackId: string): Promise<string | null> => null),
      saveLyrics: vi.fn(async (_lyrics: string, _trackId: string): Promise<string> => 'lyrics.lrc'),
      searchLyrics: vi.fn(
        async (
          _query: string,
          _artist?: string,
          _album?: string,
          _duration?: number
        ): Promise<{ lrc: string; name: string; artist: string } | null> => {
          state.upstreamCalls += 1
          return { lrc: '[00:01.00]上游歌词', name: _query, artist: _artist ?? '' }
        }
      ),
    },
    libraryMock: {
      useLibraryStore: {
        getState: () => ({ onlineSources: [] as unknown[] }),
      },
    },
  }
})

vi.mock('@/services/platform', () => ({ platform: mocks.platformMock }))
vi.mock('@/stores/libraryStore', () => mocks.libraryMock)

import {
  loadLyricsForTrack,
  clearLyricsCache,
  lyricsLoadKey,
  nextLyricsText,
} from '../lyrics.service'

const { platformMock, state } = mocks

function track(id: string) {
  return { id, title: `曲目-${id}`, artist: '歌手', album: '专辑', duration: 200 }
}

/** 上游返回空结果（未命中）：searchLyrics 成功但 lrc 为空 */
function upstreamReturnsEmpty(): void {
  platformMock.searchLyrics.mockImplementation(async () => {
    state.upstreamCalls += 1
    return null
  })
}

function upstreamReturns(lrc: string): void {
  platformMock.searchLyrics.mockImplementation(async () => {
    state.upstreamCalls += 1
    return { lrc, name: '曲目', artist: '歌手' }
  })
}

beforeEach(() => {
  clearLyricsCache()
  state.upstreamCalls = 0
  platformMock.readLyrics.mockReset()
  platformMock.readLyrics.mockImplementation(async () => null)
  platformMock.saveLyrics.mockReset()
  platformMock.saveLyrics.mockImplementation(async () => 'lyrics.lrc')
  platformMock.searchLyrics.mockReset()
  upstreamReturns('[00:01.00]上游歌词')
})

describe('loadLyricsForTrack：同曲去重与结果缓存', () => {
  it('同一 trackId 先失败后成功：第二次调用命中缓存，上游只被打过一次', async () => {
    upstreamReturns('[00:01.00]一次就好')
    expect(await loadLyricsForTrack(track('t1'))).toBe('[00:01.00]一次就好')
    expect(await loadLyricsForTrack(track('t1'))).toBe('[00:01.00]一次就好')
    expect(platformMock.searchLyrics).toHaveBeenCalledTimes(1)
    // 命中结果缓存是零 I/O：连本地缓存都不再读，避免每次切歌都过一遍文件系统
    expect(platformMock.readLyrics).toHaveBeenCalledTimes(1)
  })

  it('并发同一 trackId：上游只调用一次，且两次调用解引用同一个 promise', async () => {
    const first = loadLyricsForTrack(track('t1'))
    const second = loadLyricsForTrack(track('t1'))
    // 同一首歌词的两个消费者（全屏页与详情页）拿到的是同一次请求
    expect(first).toBe(second)
    expect(await first).toBe('[00:01.00]上游歌词')
    expect(platformMock.searchLyrics).toHaveBeenCalledTimes(1)
  })

  it('空结果不缓存：第二次调用仍会重新打上游（网络恢复后可重试）', async () => {
    upstreamReturnsEmpty()
    expect(await loadLyricsForTrack(track('t1'))).toBeNull()
    expect(await loadLyricsForTrack(track('t1'))).toBeNull()
    expect(platformMock.searchLyrics).toHaveBeenCalledTimes(2)
  })

  it('空结果之后的成功结果会进缓存', async () => {
    upstreamReturnsEmpty()
    expect(await loadLyricsForTrack(track('t1'))).toBeNull()
    upstreamReturns('[00:09.00]恢复了')
    expect(await loadLyricsForTrack(track('t1'))).toBe('[00:09.00]恢复了')
    expect(await loadLyricsForTrack(track('t1'))).toBe('[00:09.00]恢复了')
    expect(platformMock.searchLyrics).toHaveBeenCalledTimes(2)
  })

  it('切到另一首：两首歌各自独立请求，互不复用', async () => {
    const a = loadLyricsForTrack(track('t1'))
    const b = loadLyricsForTrack(track('t2'))
    expect(a).not.toBe(b)
    await Promise.all([a, b])
    expect(platformMock.searchLyrics).toHaveBeenCalledTimes(2)
  })

  it('一次失败的空结果不会永久卡住该曲：inFlight 在 settle 后清理', async () => {
    // 修复后 `loadLyricsForTrack` 基本不会再 reject：上游异常已被 searchOnlineLyrics
    // 吞成 null，本地缓存两端也降级为尽力而为。因此「失败」在这里表现为空结果，
    // 关键在于它 settle 之后必须能重新发起，而不是永远落回那个已完成的 promise。
    platformMock.searchLyrics.mockRejectedValueOnce(new Error('上游连接被重置'))
    expect(await loadLyricsForTrack(track('t1'))).toBeNull()
    expect(await loadLyricsForTrack(track('t1'))).toBe('[00:01.00]上游歌词')
    expect(platformMock.searchLyrics).toHaveBeenCalledTimes(2)
  })

  it('clearLyricsCache() 后重新请求上游', async () => {
    await loadLyricsForTrack(track('t1'))
    expect(platformMock.searchLyrics).toHaveBeenCalledTimes(1)
    clearLyricsCache()
    await loadLyricsForTrack(track('t1'))
    expect(platformMock.searchLyrics).toHaveBeenCalledTimes(2)
  })

  it('本地缓存命中时完全不打上游', async () => {
    platformMock.readLyrics.mockResolvedValue('[00:02.00]本地歌词')
    expect(await loadLyricsForTrack(track('t1'))).toBe('[00:02.00]本地歌词')
    expect(platformMock.searchLyrics).not.toHaveBeenCalled()
    expect(platformMock.saveLyrics).not.toHaveBeenCalled()
  })

  it('上游命中后写回本地缓存，下次由本地缓存兜底', async () => {
    expect(await loadLyricsForTrack(track('t1'))).toBe('[00:01.00]上游歌词')
    expect(platformMock.saveLyrics).toHaveBeenCalledWith('[00:01.00]上游歌词', 't1')
    // 清掉内存缓存，模拟重启：这次应命中刚写回的本地缓存
    clearLyricsCache()
    platformMock.readLyrics.mockResolvedValue('[00:01.00]上游歌词')
    expect(await loadLyricsForTrack(track('t1'))).toBe('[00:01.00]上游歌词')
    expect(platformMock.searchLyrics).toHaveBeenCalledTimes(1)
  })

  it('缓存有界：超过上限时淘汰最久未用的那首', async () => {
    upstreamReturns('[00:01.00]X')
    for (let i = 0; i < 51; i += 1) {
      await loadLyricsForTrack(track(`t${i}`))
    }
    expect(platformMock.searchLyrics).toHaveBeenCalledTimes(51)
    // t0 已被淘汰 → 重新请求；t50（最新写入）仍在缓存里
    await loadLyricsForTrack(track('t0'))
    expect(platformMock.searchLyrics).toHaveBeenCalledTimes(52)
    await loadLyricsForTrack(track('t50'))
    expect(platformMock.searchLyrics).toHaveBeenCalledTimes(52)
  })
})

describe('lyricsLoadKey：加载触发的等价性', () => {
  it('同 id 不同对象引用得到同一个键', () => {
    const key = lyricsLoadKey(track('t1'))
    // 播放中 currentTrack 会被封面补齐 / 取址回填 / persist rehydrate 换成新对象，
    // 字段没变时不得触发重新加载
    expect(lyricsLoadKey({ ...track('t1') })).toBe(key)
  })

  it('切歌（id 变化）得到不同的键', () => {
    expect(lyricsLoadKey(track('t2'))).not.toBe(lyricsLoadKey(track('t1')))
  })

  it('同 id 不同对象引用：依赖项按 Object.is 比较结果不变，effect 不重跑', () => {
    // React 用 Object.is 逐项比较依赖数组；这里直接复现该语义。
    // 触发场景：CoverImage 的 syncPlayerStoreCover 封面补齐回写、playerStore 取址回填、
    // persist rehydrate —— 字段没变但 currentTrack 换了引用
    const depsA = [lyricsLoadKey({ ...track('t1') }, undefined)]
    const depsB = [lyricsLoadKey({ ...track('t1') }, undefined)]
    expect(depsA.every((dep, i) => Object.is(dep, depsB[i]))).toBe(true)
  })

  it('切歌：依赖项按 Object.is 比较结果变化，effect 重跑', () => {
    const depsA = [lyricsLoadKey(track('t1'))]
    const depsB = [lyricsLoadKey(track('t2'))]
    expect(depsA.some((dep, i) => !Object.is(dep, depsB[i]))).toBe(true)
  })

  it('无曲目与外部歌词也参与键：无曲目的键不与其他曲目相同', () => {
    expect(lyricsLoadKey(null)).toBe(lyricsLoadKey(undefined))
    expect(lyricsLoadKey(null)).not.toBe(lyricsLoadKey(track('t1')))
    expect(lyricsLoadKey(track('t1'), '外部歌词')).not.toBe(lyricsLoadKey(track('t1')))
    expect(lyricsLoadKey(track('t1'), '外部歌词')).toBe(lyricsLoadKey({ id: 't1' }, '外部歌词'))
  })
})

describe('loadLyricsForTrack：本地缓存 I/O 失败不得丢弃已取到的歌词', () => {
  it('saveLyrics 抛错：仍 resolve 并返回取到的歌词', async () => {
    platformMock.saveLyrics.mockRejectedValue(new Error('磁盘已满'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 核心断言：本地缓存是加速手段、不是正确性前提，写失败只该降级为「下次没缓存」
      expect(await loadLyricsForTrack(track('t1'))).toBe('[00:01.00]上游歌词')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('saveLyrics 抛错后同一首仍能靠内存缓存零网络命中', async () => {
    platformMock.saveLyrics.mockRejectedValue(new Error('权限不足'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await loadLyricsForTrack(track('t1'))).toBe('[00:01.00]上游歌词')
      expect(await loadLyricsForTrack(track('t1'))).toBe('[00:01.00]上游歌词')
      expect(platformMock.searchLyrics).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('readLyrics 抛错：降级为「本地没命中」，继续走在线搜索并返回歌词', async () => {
    platformMock.readLyrics.mockRejectedValue(new Error('缓存文件损坏'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await loadLyricsForTrack(track('t1'))).toBe('[00:01.00]上游歌词')
      expect(platformMock.searchLyrics).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('saveLyrics 未定义时行为不变：照常返回歌词', async () => {
    const saved = platformMock.saveLyrics
    // @ts-expect-error 模拟平台适配器不提供写缓存能力
    delete platformMock.saveLyrics
    try {
      expect(await loadLyricsForTrack(track('t1'))).toBe('[00:01.00]上游歌词')
    } finally {
      platformMock.saveLyrics = saved
    }
  })

  it('本地缓存与在线都失败（saveLyrics 抛错 + 上游空结果）→ 返回 null 而非 reject', async () => {
    upstreamReturnsEmpty()
    platformMock.saveLyrics.mockRejectedValue(new Error('磁盘已满'))
    expect(await loadLyricsForTrack(track('t1'))).toBeNull()
  })

  it('本地缓存 I/O 抛错时不会把 trackId 永久卡在 in-flight', async () => {
    platformMock.readLyrics.mockRejectedValue(new Error('本地缓存读取失败'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 读失败降级为「本地没命中」，因此这次仍会走到在线并成功
      expect(await loadLyricsForTrack(track('t1'))).toBe('[00:01.00]上游歌词')
      expect(platformMock.searchLyrics).toHaveBeenCalledTimes(1)
      // 第二次调用不得落回那个已 settle 的旧 promise（也不得重打上游：命中内存缓存）
      expect(await loadLyricsForTrack(track('t1'))).toBe('[00:01.00]上游歌词')
      expect(platformMock.searchLyrics).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('nextLyricsText：结果落地不降级', () => {
  it('非空结果覆盖当前文本', () => {
    expect(nextLyricsText('旧歌词', '[00:01.00]新歌词')).toBe('[00:01.00]新歌词')
  })

  it('空结果或 null 不得把已有歌词清成空态', () => {
    expect(nextLyricsText('[00:01.00]已有歌词', '')).toBe('[00:01.00]已有歌词')
    expect(nextLyricsText('[00:01.00]已有歌词', null)).toBe('[00:01.00]已有歌词')
    expect(nextLyricsText('[00:01.00]已有歌词', undefined)).toBe('[00:01.00]已有歌词')
  })

  it('原本就没有歌词时，空结果仍保持空', () => {
    expect(nextLyricsText('', null)).toBe('')
  })
})

/**
 * 盘上已固化的坏 .lrc 必须视为未命中。
 *
 * 背景：shared 侧已让上游的纯空白歌词不再**新写入** .lrc，但存量用户盘上那份坏文件
 * 还在，而「本地读到就 return」会短路在线搜索 —— 表现为永久空态：每次进播放页都拿到
 * 同一份渲染不出东西的文本，且它还会经「命中即返回」长期驻留。
 *
 * 判据用 parseLRC 而不是只看 trim：UI 唯一渲染路径就是 `setLyrics(parseLRC(text))`，
 * 「解析出 0 行」＝ 用户必然看到「暂无歌词」。只看 trim 会漏掉「只有时间标签没有文字」
 * 这类同样渲染不出来的坏文件。
 *
 * 反向保护同样重要：**纯文本歌词（无时间标签）合法** —— parseLRC 对它按行生成
 * 5 秒间隔的时间轴，误判为不可用等于把正常歌词当坏文件丢掉。
 */
describe('本地/在线歌词的可用性判定（存量坏 .lrc 不得短路在线搜索）', () => {
  /** 抑制可用性降级路径的告警输出 */
  function silenceWarn() {
    return vi.spyOn(console, 'warn').mockImplementation(() => {})
  }

  it('本地缓存是纯空白：视为未命中，继续走在线并返回在线歌词', async () => {
    platformMock.readLyrics.mockResolvedValue('   \n  ')
    const warn = silenceWarn()
    try {
      expect(await loadLyricsForTrack(track('t1'))).toBe('[00:01.00]上游歌词')
      expect(platformMock.searchLyrics).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('本地缓存只有时间标签、没有任何文字：同样视为未命中并走在线', async () => {
    platformMock.readLyrics.mockResolvedValue('[00:00.00]\n[00:01.00]')
    const warn = silenceWarn()
    try {
      expect(await loadLyricsForTrack(track('t1'))).toBe('[00:01.00]上游歌词')
      expect(platformMock.searchLyrics).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('本地缓存只有空白行：视为未命中并走在线', async () => {
    platformMock.readLyrics.mockResolvedValue('\n\n   \n\t\n')
    const warn = silenceWarn()
    try {
      expect(await loadLyricsForTrack(track('t1'))).toBe('[00:01.00]上游歌词')
      expect(platformMock.searchLyrics).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('本地缓存是正常 LRC：仍由本地命中，不打在线（既有语义不许退化）', async () => {
    platformMock.readLyrics.mockResolvedValue('[00:02.00]本地歌词')
    expect(await loadLyricsForTrack(track('t1'))).toBe('[00:02.00]本地歌词')
    expect(platformMock.searchLyrics).not.toHaveBeenCalled()
    expect(platformMock.saveLyrics).not.toHaveBeenCalled()
  })

  it('本地缓存是纯文本歌词（无时间标签）：必须判为可用，不得误判为坏文件', async () => {
    const plain = '第一行歌词\n第二行歌词\n第三行歌词'
    platformMock.readLyrics.mockResolvedValue(plain)
    expect(await loadLyricsForTrack(track('t1'))).toBe(plain)
    expect(platformMock.searchLyrics).not.toHaveBeenCalled()
  })

  it('在线返回纯空白：不写本地缓存、也不返回（避免把坏文本固化进 .lrc）', async () => {
    upstreamReturns('   \n  ')
    expect(await loadLyricsForTrack(track('t1'))).toBeNull()
    expect(platformMock.saveLyrics).not.toHaveBeenCalled()
  })

  it('在线返回只有时间标签：不写本地缓存且返回 null', async () => {
    upstreamReturns('[00:00.00]\n[00:01.00]')
    expect(await loadLyricsForTrack(track('t1'))).toBeNull()
    expect(platformMock.saveLyrics).not.toHaveBeenCalled()
  })

  it('在线返回不可用时不留内存缓存：下次调用仍会重新打上游', async () => {
    upstreamReturns('   ')
    expect(await loadLyricsForTrack(track('t1'))).toBeNull()
    expect(await loadLyricsForTrack(track('t1'))).toBeNull()
    expect(platformMock.searchLyrics).toHaveBeenCalledTimes(2)
  })

  it('在线返回可用歌词：仍照常写回本地缓存（写回语义未退化）', async () => {
    upstreamReturns('[00:01.00]上游歌词')
    expect(await loadLyricsForTrack(track('t1'))).toBe('[00:01.00]上游歌词')
    expect(platformMock.saveLyrics).toHaveBeenCalledWith('[00:01.00]上游歌词', 't1')
  })

  it('在线返回纯文本歌词：可用，照常写回本地缓存', async () => {
    const plain = '只有文字的歌词\n第二行'
    upstreamReturns(plain)
    expect(await loadLyricsForTrack(track('t1'))).toBe(plain)
    expect(platformMock.saveLyrics).toHaveBeenCalledWith(plain, 't1')
  })
})