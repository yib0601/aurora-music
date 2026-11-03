import { describe, it, expect } from 'vitest'
import { AudioFocusInterlock } from '../interlock'
import type { ExternalPlayer } from '../types'

const player = (id: string, status: ExternalPlayer['status'] = 'Playing'): ExternalPlayer => ({
  id,
  label: id,
  status,
})

/**
 * 互斥仲裁的时序测试。
 *
 * 这里全部用假时钟：真实场景里的 bug（起播一拍后把自己按停、切歌时把别人的播放器来回按）
 * 都是「两次轮询之间发生了另一件事」造成的，只有把时间攥在手里才复现得稳。
 */
function setup(pauseGraceMs = 2000) {
  let t = 0
  const interlock = new AudioFocusInterlock({ now: () => t, pauseGraceMs })
  return {
    interlock,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('AudioFocusInterlock', () => {
  it('起播时暂停正在出声的外部播放器，暂停只做一次', () => {
    const { interlock } = setup()
    expect(interlock.onSnapshot([player('a'), player('b', 'Paused'), player('c')])).toEqual({
      pauseExternals: [],
      resumeExternals: [],
      pauseOurs: false,
      resumeOurs: false,
      scheduleResumeExternals: false,
      scheduleResumeOurs: false,
    })

    const first = interlock.onOursPlaying(true)
    expect(first.pauseExternals).toEqual(['a', 'c'])
    // 重复上报同一状态必须无副作用
    expect(interlock.onOursPlaying(true).pauseExternals).toEqual([])
  })

  it('暂停没生效时不把自己按停，而是节流重试（控制通道坏掉也不自激）', () => {
    const { interlock, advance } = setup(2000)
    interlock.onSnapshot([player('a')])
    interlock.onOursPlaying(true)

    // 豁免窗口内：D-Bus 还没反映暂停，视为已暂停，既不让位也不重试
    expect(interlock.onSnapshot([player('a')])).toMatchObject({
      pauseOurs: false,
      pauseExternals: [],
    })

    // 窗口过后仍是 Playing，但从没确认停过 → 不让位（否则控制通道一坏就随机自暂停），
    // 改为重试一次暂停
    advance(3000)
    expect(interlock.onSnapshot([player('a')])).toMatchObject({
      pauseOurs: false,
      pauseExternals: ['a'],
    })
    expect(interlock.getState().oursPlaying).toBe(true)

    // 重试节流：紧接着的下一拍不重复发
    advance(1000)
    expect(interlock.onSnapshot([player('a')]).pauseExternals).toEqual([])
  })

  it('我们暂停过、确认停过，之后被用户恢复 → 让位', () => {
    const { interlock, advance } = setup()
    interlock.onSnapshot([player('a')])
    interlock.onOursPlaying(true)

    // 对方真的停了（确认暂停生效）
    advance(3000)
    expect(interlock.onSnapshot([player('a', 'Paused')]).pauseOurs).toBe(false)

    // 用户手动恢复：这次才是「打断我们」，让位
    expect(interlock.onSnapshot([player('a')]).pauseOurs).toBe(true)
  })

  it('播放中打开开关（认领窗口）：抢占正在出声的人，而不是让位', () => {
    // 开启首拍就拿到快照：开启后对齐播放态，直接抢占
    const { interlock } = setup()
    interlock.onSnapshot([player('a')])
    expect(interlock.onOursPlaying(true).pauseExternals).toEqual(['a'])

    // 开启首拍拿不到人（Windows PowerShell 预热），第二拍才看到 a：
    // 认领窗口内按「先于我们存在」抢占
    const { interlock: i2 } = setup()
    i2.onOursPlaying(true)
    expect(i2.onSnapshot([player('a')], { adoptPlayingNow: true })).toMatchObject({
      pauseExternals: ['a'],
      pauseOurs: false,
    })
    // 认领窗口之外看到新人 → 按「打断我们」让位
    expect(i2.onSnapshot([player('b')]).pauseOurs).toBe(true)
  })

  it('有人打断时让位，对方安静后自动续播', () => {
    const { interlock } = setup()
    interlock.onSnapshot([player('a', 'Paused')])
    interlock.onOursPlaying(true)

    // 用户手动开了播放器 a
    expect(interlock.onSnapshot([player('a')]).pauseOurs).toBe(true)
    expect(interlock.getState().yieldedTo).toEqual(['a'])

    // 对方暂停 → 安排续播 → 到点续播
    expect(interlock.onSnapshot([player('a', 'Paused')]).scheduleResumeOurs).toBe(true)
    const due = interlock.onResumeOursDue()
    expect(due.resumeOurs).toBe(true)
    expect(interlock.getState().yieldedTo).toEqual([])
    expect(interlock.getState().oursPlaying).toBe(true)
  })

  it('对方只是切歌（短暂暂停又播）时不抢着续播', () => {
    const { interlock } = setup()
    interlock.onSnapshot([player('a', 'Paused')])
    interlock.onOursPlaying(true)
    interlock.onSnapshot([player('a')])

    expect(interlock.onSnapshot([player('a', 'Paused')]).scheduleResumeOurs).toBe(true)
    // 到点前对方又开始播了（切歌间隙结束）
    expect(interlock.onSnapshot([player('a')]).scheduleResumeOurs).toBe(false)
    expect(interlock.onResumeOursDue().resumeOurs).toBe(false)
    expect(interlock.getState().oursPlaying).toBe(false)
  })

  it('让位对象退出（从列表消失）也算安静，要能续播', () => {
    const { interlock } = setup()
    interlock.onSnapshot([player('a', 'Paused')])
    interlock.onOursPlaying(true)
    interlock.onSnapshot([player('a')])

    expect(interlock.onSnapshot([]).scheduleResumeOurs).toBe(true)
    expect(interlock.onResumeOursDue().resumeOurs).toBe(true)
  })

  it('本应用停止后安排归还，且只归还仍然停在暂停的播放器', () => {
    const { interlock } = setup()
    interlock.onSnapshot([player('a'), player('b')])
    interlock.onOursPlaying(true)

    expect(interlock.onOursPlaying(false).scheduleResumeExternals).toBe(true)
    expect(interlock.onResumeExternalsDue()).toMatchObject({ resumeExternals: ['a', 'b'] })

    // b 被用户手动停掉（Stopped）时不该替他按播放
    const { interlock: i2 } = setup()
    i2.onSnapshot([player('a'), player('b')])
    i2.onOursPlaying(true)
    i2.onOursPlaying(false)
    i2.onSnapshot([player('a', 'Paused'), player('b', 'Stopped')])
    expect(i2.onResumeExternalsDue().resumeExternals).toEqual(['a'])
  })

  it('归还在到点前又被起播打断则作废', () => {
    const { interlock } = setup()
    interlock.onSnapshot([player('a')])
    interlock.onOursPlaying(true)
    interlock.onOursPlaying(false)
    interlock.onSnapshot([player('a', 'Paused')])

    // 用户在延迟窗口内又点了播放
    interlock.onOursPlaying(true)
    expect(interlock.onResumeExternalsDue().resumeExternals).toEqual([])
  })

  it('让位期间不归还被我们暂停的其他播放器', () => {
    const { interlock, advance } = setup()
    interlock.onSnapshot([player('a'), player('b')])
    interlock.onOursPlaying(true)
    // 两者都确认停过，随后 a 被用户恢复 → 让位
    advance(3000)
    interlock.onSnapshot([player('a', 'Paused'), player('b', 'Paused')])
    expect(interlock.onSnapshot([player('a'), player('b', 'Paused')]).pauseOurs).toBe(true)
    expect(interlock.onOursPlaying(false).scheduleResumeExternals).toBe(false)
    expect(interlock.onResumeExternalsDue().resumeExternals).toEqual([])
  })

  it('用户手动播放覆盖让位状态', () => {
    const { interlock, advance } = setup()
    interlock.onSnapshot([player('a', 'Paused')])
    interlock.onOursPlaying(true)
    interlock.onSnapshot([player('a')])
    expect(interlock.getState().yieldedTo).toEqual(['a'])

    // 用户点了播放：抢回主动权，并把正在出声的 a 暂停
    advance(3000)
    const eff = interlock.onOursPlaying(true)
    expect(eff.pauseExternals).toEqual(['a'])
    expect(interlock.getState().yieldedTo).toEqual([])
  })

  it('关闭功能时归还所有仍被暂停的播放器', () => {
    const { interlock } = setup()
    interlock.onSnapshot([player('a'), player('b')])
    interlock.onOursPlaying(true)
    interlock.onSnapshot([player('a', 'Paused'), player('b', 'Paused')])

    expect(interlock.release().resumeExternals).toEqual(['a', 'b'])
    expect(interlock.getState()).toMatchObject({
      oursPlaying: false,
      pausedByUs: [],
      yieldedTo: [],
      resumeExternalsPending: false,
      resumeOursPending: false,
    })
  })

  it('快照顺序不影响裁定', () => {
    const { interlock } = setup()
    interlock.onSnapshot([player('a'), player('b')])
    expect(interlock.onOursPlaying(true).pauseExternals).toEqual(['a', 'b'])

    const { interlock: i2 } = setup()
    i2.onSnapshot([player('b'), player('a')])
    expect(i2.onOursPlaying(true).pauseExternals).toEqual(['b', 'a'])
  })
})
