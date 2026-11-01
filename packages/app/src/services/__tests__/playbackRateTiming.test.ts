/**
 * 变速的**时序**正确性：Howler 的 `_state` / `_playLock` 闸门。
 *
 * ## 为什么需要单独一份（既有的 `playbackRateApplication.test.ts` 不够）
 *
 * 那份用例的 fake Howl 没有 `_state` / `_playLock`，`rate()` 立刻记下调用——
 * 于是「调用发生过」这个断言永远成立。但**调用发生 ≠ 速率生效**：Howler 在
 * `_state !== 'loaded'` 或 `_playLock` 为真时会把动作推进 `_queue` 而不改元素速率，
 * 而 `_loadQueue()` 只在 `_state` 由非 loaded 变 loaded 的那一次被调用、且只清队首
 * 一条任务。起播瞬间的两个条件恰恰都成立（`play()` 先置 `_playLock = true`
 * 再置 `_state = 'loading'`），于是：
 *
 *   写入 → 入队 → 没人再跑 → **变速静默失效**（进度条照走 1×，控制台无输出）。
 *
 * 这是实测抓到的真缺陷：`store.playbackRate` 显示 2，音频仍 1×。
 * 所以这份用例的 fake Howl**如实模拟那两个闸门**，断言的是
 * 「闸门打开之后速率最终落到了元素上」，而不是「函数被调过」。
 *
 * 同时钉住第二件事：重试必须读**当前** rate，不能吃调用点的快照值 ——
 * 否则用户连点两档时，早一次的重试到点会把中间值写回去。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  instances: [] as any[],
}))

/**
 * 假 Howl：如实模拟 Howler 的两个闸门。
 *
 * - `_state`：初始 `'loading'`（`play()` 之后就是这样），测试手动置 `'loaded'`
 * - `_playLock`：初始 true，测试手动放开
 * - 闸门关着时 `rate()` **不入元素**（记进 rejected 便于断言"确实被挡过"）
 */
vi.mock('howler', () => {
  /**
   * 假 Howl：如实模拟 Howler 的两个闸门。
   *
   * - `_state`：初始 `'loading'`（`play()` 之后就是这样），测试手动放开
   * - `_playLock`：初始 true，测试手动放开
   * - 闸门关着时 `rate()` **不入元素**（记进 rejected 便于断言"确实被挡过"）
   *
   * 回调按 Howler 的真实事件名存放（`onload` 而不是 `load`）——写成 `fire('load')`
   * 会静默什么都不做，测试就会假绿（这个坑本轮实测踩过）。
   */
  class FakeHowl {
    _state: string
    _playLock: boolean
    appliedRates: number[]
    rejected: number
    opts: Record<string, any>

    constructor(opts: Record<string, any>) {
      this.opts = opts || {}
      this.appliedRates = []
      this.rejected = 0
      this._state = 'loading'
      this._playLock = true
      h.instances.push(this)
    }

    rate(value?: number) {
      if (typeof value !== 'number') {
        return this.appliedRates.length ? this.appliedRates[this.appliedRates.length - 1] : 1
      }
      if (this._state !== 'loaded' || this._playLock) {
        this.rejected += 1
        return this
      }
      this.appliedRates.push(value)
      return this
    }

    volume() { return this }
    play() { return 1 }
    pause() {}
    stop() {}
    seek() { return 0 }
    duration() { return 200 }
    fade() { return this }
    once() { return this }
    on() { return this }
    off() { return this }
    unload() {}
    playing() { return false }
    state() { return this._state }

    /** 模拟 canplay 完成：Howler 的顺序是 state=loaded → emit load → 释放 playLock */
    becomeWritable() {
      this._state = 'loaded'
      this._playLock = false
    }

    /** 只放开 state、仍保留 playLock（复现"onload 已触发但仍不可写"那一帧） */
    loadWithoutUnlocking() {
      this._state = 'loaded'
      this._playLock = true
    }

    /** 按 Howler 的真实事件名触发构造参数里的回调（`onload` / `onplay` …） */
    fire(event: 'onload' | 'onplay' | 'onpause' | 'onstop' | 'onend') {
      const fn = this.opts[event]
      if (typeof fn === 'function') fn.call(this)
    }
  }
  return { Howl: FakeHowl, Howler: { _html5AudioPool: [] } }
})

vi.mock('@/services/audioCache.service', () => ({
  resolveCachedAudioSrc: async () => null,
  configureAudioCache: () => {},
}))

const { playTrack, setPlaybackRate, getPlaybackRate, stopPlayback } = await import(
  '@/services/audio.service'
)

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

/** 让 applyRate 的重试定时器（40ms 间隔）跑起来 */
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms))

describe('变速：Howler 闸门关闭时必须等它打开，而不是静默丢弃', () => {
  beforeEach(() => {
    h.instances.length = 0
    setPlaybackRate(1)
    stopPlayback()
  })

  it('起播瞬间设速率：闸门关着不生效，闸门打开后速率落到元素上', async () => {
    setPlaybackRate(2)

    playTrack(track('a'))
    const howl = h.instances.at(-1)!

    // 此刻闸门仍关着（模拟起播瞬间）：不该有速率落到元素上
    expect(howl.appliedRates).toEqual([])

    // 模拟 canplay：闸门打开 + onload 触发
    howl.becomeWritable()
    howl.fire('onload')
    await tick()

    // 关键断言：速率**最终**落到了元素上（不是"函数被调过"）
    expect(howl.appliedRates.at(-1)).toBe(2)
  })

  it('元素已可写时立即生效（不引入无谓延迟）', () => {
    playTrack(track('b'))
    const howl = h.instances.at(-1)!
    howl.becomeWritable()

    setPlaybackRate(1.5)

    // 同步生效：不必等重试定时器
    expect(howl.appliedRates.at(-1)).toBe(1.5)
  })

  /**
   * 连点两档：早一次的重试到点时**不能**把中间值写回去。
   *
   * 这钉住的是「重试读当前 rate」而不是「吃调用点传进来的快照」。
   */
  it('连续改两次：最终值以最后一次为准，中间值不会被重试写回', async () => {
    playTrack(track('c'))
    const howl = h.instances.at(-1)!

    // 闸门关着时连续设两次（真实场景：用户快速点两档）
    setPlaybackRate(2)
    setPlaybackRate(0.75)

    howl.becomeWritable()
    await tick(200)

    expect(howl.appliedRates.at(-1)).toBe(0.75)
    expect(howl.appliedRates).not.toContain(2)
  })

  it('切歌后新曲目继承用户设定的速率（不是回到 1×）', async () => {
    setPlaybackRate(1.25)

    playTrack(track('d'))
    const first = h.instances.at(-1)!
    first.becomeWritable()
    first.fire('onload')
    await tick()
    expect(first.appliedRates.at(-1)).toBe(1.25)

    // 切歌：新 Howl 不继承旧实例的 rate，必须重新应用
    playTrack(track('e'))
    const second = h.instances.at(-1)!
    expect(second).not.toBe(first)
    second.becomeWritable()
    second.fire('onload')
    await tick()

    expect(second.appliedRates.at(-1)).toBe(1.25)
  })

  it('stopPlayback 之后旧实例待执行的重试被取消（不会串到下一首）', async () => {
    setPlaybackRate(2)
    playTrack(track('f'))
    const old = h.instances.at(-1)!

    stopPlayback()
    const appliedBefore = old.appliedRates.length

    // 即便此刻放开闸门，已取消的重试也不该再写入
    old.becomeWritable()
    await tick(200)

    expect(old.appliedRates.length).toBe(appliedBefore)
  })

  /**
   * 真实 Howler 里最常见的一帧：`_emit('load')` 已经发生，但 `_playLock` 还没释放。
   * 这一帧里写速率必须**等到锁释放**再写，不能直接丢弃。
   */
  it('onload 已触发但 playLock 仍为真：等锁释放后再写入', async () => {
    setPlaybackRate(1.5)
    playTrack(track('g'))
    const howl = h.instances.at(-1)!

    // 复现那一帧：state 已 loaded，但锁还在
    howl.loadWithoutUnlocking()
    howl.fire('onload')

    // 此刻不该写入（锁挡着）
    expect(howl.appliedRates).toEqual([])

    // 锁释放
    howl._playLock = false
    await tick(200)

    expect(howl.appliedRates.at(-1)).toBe(1.5)
  })

  it('setPlaybackRate 在没有 Howl 时只记状态，不抛错', () => {
    stopPlayback()
    expect(() => setPlaybackRate(0.75)).not.toThrow()
    expect(getPlaybackRate()).toBe(0.75)
  })
})
