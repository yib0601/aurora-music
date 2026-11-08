/**
 * `needsScriptResolve` 单测：播放器同步闸门的判据
 *
 * 这个函数只有两件事要保证，且两件都会直接变成用户可见的 bug：
 *   1) **不误报**：本地文件 / 没有候选脚本源的曲目不能被它拖进异步取址闸门
 *      （误报的代价是「点了立刻能播的歌要等一下」，以及连点时顺序错乱）；
 *   2) **不遗漏**：有脚本源认领该平台、曲目带源内 id 时必须报 true
 *      （遗漏的代价是脚本偏好静默失效，也就是这次要修的问题本身）。
 *
 * 音源配置从 store 同步读取，这里桩掉 store；候选策略（哪些源算数）在
 * `@aurora/shared` 侧已有单测，不在本文件重复断言。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state: { onlineSources: Array<Record<string, unknown>> } = { onlineSources: [] }

vi.mock('@/stores/libraryStore', () => ({
  useLibraryStore: { getState: () => state },
}))

async function load() {
  const mod = await import('../scriptSourceResolve')
  return mod.needsScriptResolve
}

const scriptSource = (over: Record<string, unknown> = {}) => ({
  id: 'src-script',
  name: '洛雪',
  sourceUrl: 'https://example.invalid/fish/latest.js',
  enabled: true,
  platform: 'tx',
  ...over,
})

const onlineTrack = (over: Record<string, unknown> = {}) => ({
  id: 'track-1',
  title: '起风了',
  artist: '买辣椒也用券',
  album: '',
  duration: 325,
  onlineSource: 'src-aurora',
  onlineId: '91084746',
  ...over,
})

beforeEach(() => {
  state.onlineSources = []
  vi.resetModules()
})

describe('needsScriptResolve', () => {
  it('本地曲目（有 path）永不进闸门', async () => {
    const needsScriptResolve = await load()
    state.onlineSources = [scriptSource()]
    expect(needsScriptResolve(onlineTrack({ path: '/music/a.flac' }) as never)).toBe(false)
  })

  it('没有候选脚本源时为 false（默认配置下零行为变化）', async () => {
    const needsScriptResolve = await load()
    expect(needsScriptResolve(onlineTrack() as never)).toBe(false)
  })

  it('停用源 / 未声明平台的源都不算候选', async () => {
    const needsScriptResolve = await load()
    state.onlineSources = [scriptSource({ enabled: false }), scriptSource({ id: 'src-b', platform: '' })]
    expect(needsScriptResolve(onlineTrack() as never)).toBe(false)
  })

  it('有启用且声明了平台的脚本源时为 true（即使曲目本来就有地址）', async () => {
    const needsScriptResolve = await load()
    state.onlineSources = [scriptSource()]
    expect(
      needsScriptResolve(
        onlineTrack({ onlineUrl: 'https://isure6.stream.qqmusic.qq.com/C400xxx.m4a' }) as never
      )
    ).toBe(true)
  })

  it('曲目已带脚本令牌（platform 非空）时为 false：不再跨源重取', async () => {
    const needsScriptResolve = await load()
    state.onlineSources = [scriptSource()]
    expect(
      needsScriptResolve(
        onlineTrack({ trackRef: { sourceId: 'src-script', platform: 'tx', meta: { songmid: '1' } } }) as never
      )
    ).toBe(false)
  })

  it('没有源内 id 时为 false（脚本拿不到 id 也无从取址）', async () => {
    const needsScriptResolve = await load()
    state.onlineSources = [scriptSource()]
    expect(needsScriptResolve(onlineTrack({ onlineId: undefined }) as never)).toBe(false)
  })

  it('store 读取出错时按「无候选」处理，不抛给播放链路', async () => {
    const needsScriptResolve = await load()
    const original = state.onlineSources
    Object.defineProperty(state, 'onlineSources', {
      configurable: true,
      get() {
        throw new Error('store not ready')
      },
    })
    expect(needsScriptResolve(onlineTrack() as never)).toBe(false)
    Object.defineProperty(state, 'onlineSources', { configurable: true, writable: true, value: original })
  })
})
