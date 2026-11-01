/**
 * 桌面端播放速率的落点：Howler。
 *
 * 这条路径的关键事实（Howler 2.2.4 源码核对过，见 `Howl.prototype.rate`）：
 *   - rate 是**每个 Howl 实例独立的**：`new Howl()` 不会继承上一个实例的速率；
 *   - 未加载完成时调用 `rate()` 会被推进实例自己的 `_queue`，在 `load` 之后补做。
 *
 * 所以「新曲开始要把 rate 重新应用一遍」不是可选的优化，而是**正确性要求**：
 * 漏掉这一步的表现是「切歌后悄悄变回 1×」——没有任何报错，只能靠断言钉住。
 *
 * 本文件用 howler 的整体 mock 断言调用次数与最后一次的参数，不依赖真实音频栈。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** 每个被创建出来的假 Howl 实例都会记进这里 */
const h = vi.hoisted(() => ({
  instances: [] as any[],
}))

vi.mock('howler', () => {
  class FakeHowl {
    /** 本实例收到的每一次 rate() 调用参数 */
    rateCalls: number[] = []
    volumeCalls: number[] = []
    private handlers: Record<string, (...args: any[]) => void> = {}
    private unloaded = false

    constructor(opts: Record<string, any>) {
      // 把构造参数里的回调存起来，测试里手动触发 onload
      for (const [k, v] of Object.entries(opts)) {
        if (typeof v === 'function') this.handlers[k] = v
      }
      h.instances.push(this)
    }

    rate(value?: number) {
      if (typeof value === 'number') {
        this.rateCalls.push(value)
        return this
      }
      return 1
    }

    volume(value?: number) {
      if (typeof value === 'number') {
        this.volumeCalls.push(value)
        return this
      }
      return 1
    }

    play() {
      return 1
    }
    pause() {}
    stop() {}
    seek() {
      return 0
    }
    duration() {
      return 0
    }
    fade() {
      return this
    }
    once() {
      return this
    }
    on() {
      return this
    }
    off() {
      return this
    }
    unload() {
      this.unloaded = true
    }
    playing() {
      return false
    }

    /** 测试专用：触发构造时注册的回调 */
    fire(event: string, ...args: any[]) {
      this.handlers[event]?.(...args)
    }
  }
  return { Howl: FakeHowl, Howler: { _html5AudioPool: [] } }
})

vi.mock('@/services/audioCache.service', () => ({
  resolveCachedAudioSrc: async () => null,
  configureAudioCache: () => {},
}))

const { playTrack, setPlaybackRate, getPlaybackRate } = await import('@/services/audio.service')

function track(id: string, duration = 200) {
  return {
    id,
    path: `/music/${id}.mp3`,
    title: id,
    artist: '歌手',
    album: '',
    duration,
    addedAt: 0,
    playCount: 0,
    liked: false,
  } as any
}

const last = () => h.instances.at(-1)!

beforeEach(() => {
  h.instances.length = 0
  // 每个用例从原速开始：模块级 mirror 是跨用例共享的
  setPlaybackRate(1)
  h.instances.length = 0
})

describe('桌面端播放速率：Howler 落点', () => {
  it('默认速率是 1', () => {
    expect(getPlaybackRate()).toBe(1)
  })

  it('setPlaybackRate 立即应用到当前 Howl', () => {
    playTrack(track('a'), 0.7, false, false)
    const howl = last()
    howl.rateCalls.length = 0

    setPlaybackRate(1.5)
    expect(howl.rateCalls).toEqual([1.5])
    expect(getPlaybackRate()).toBe(1.5)
  })

  it('新曲的新 Howl 会重新应用一遍速率（rate 是按实例存的）', () => {
    setPlaybackRate(1.25)

    playTrack(track('a'), 0.7, false, false)
    const first = last()
    // 加载完成时同步再落一次，不依赖 Howler 队列时序
    first.fire('onload')
    expect(first.rateCalls).toEqual([1.25])

    playTrack(track('b'), 0.7, false, false)
    const second = last()
    expect(second).not.toBe(first)
    // 新实例初始没收到过任何 rate 调用
    expect(second.rateCalls).toEqual([])

    // 其 onload 必须把当前速率重新应用上去 —— 这就是「切歌后不会悄悄变回 1×」的保证
    second.fire('onload')
    expect(second.rateCalls).toEqual([1.25])
  })

  it('速率 1 时不改变行为（与无变速功能的旧版本逐字节等价）', () => {
    setPlaybackRate(1)
    playTrack(track('a'), 0.7, false, false)
    const howl = last()
    howl.fire('onload')
    // 仍然会调一次 rate(1)：Howler 对未改动的速率是幂等赋值，无副作用，
    // 但保证「上一个实例留下的状态」不会以任何方式影响到新实例
    expect(howl.rateCalls).toEqual([1])
  })

  it('归一化脏值：NaN/0/负数回落 1，越界夹到边界', () => {
    setPlaybackRate(Number.NaN)
    expect(getPlaybackRate()).toBe(1)
    setPlaybackRate(0)
    expect(getPlaybackRate()).toBe(1)
    setPlaybackRate(-3)
    expect(getPlaybackRate()).toBe(1)
    setPlaybackRate(99)
    expect(getPlaybackRate()).toBe(2)
    setPlaybackRate(0.1)
    expect(getPlaybackRate()).toBe(0.5)
  })

  it('Howler 抛错（越界速率在部分内核上抛 InvalidStateError）不影响播放继续', () => {
    playTrack(track('a'), 0.7, false, true)
    const howl = last()
    howl.rate = () => {
      throw new Error('InvalidStateError')
    }
    // 不抛出：变速是附加能力，不能因此中断播放
    expect(() => setPlaybackRate(1.5)).not.toThrow()
    expect(getPlaybackRate()).toBe(1.5)
  })
})
