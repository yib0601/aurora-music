/**
 * 互斥状态机的**边界语义**补充测试（与 interlock.test.ts 不重复，单独一个文件）。
 *
 * interlock.test.ts 钉的是主路径（抢占 / 让位 / 续播 / 归还）。这里补三类最容易在
 * 现场炸、而不在主路径上的东西：
 *
 * 1. **控制通道失效**（Windows 的 stdin 泵坏掉、macOS 自动化授权被拒、播放器不支持
 *    Pause）：发过 Pause 却从没观察到 Paused 的播放器，不得触发让位，只能节流重试。
 *    原语义下这条会退化成「本应用一听到别人出声就把自己按停」。
 * 2. **让位与归还的交界**：让位会清空 pausedByUs，那先前被我们暂停的第三个播放器还记不记得？
 * 3. **`adoptPlayingNow`**（播放中打开开关）：开启时先于我们存在的播放器算抢占对象。
 *
 * 这里的用例守的是「让位 / 归还 / 重试」三者的交界处。
 */
import { describe, expect, it } from 'vitest'
import { AudioFocusInterlock } from '../interlock'
import type { ExternalPlayer } from '../types'

const player = (id: string, status: ExternalPlayer['status'] = 'Playing'): ExternalPlayer => ({
  id,
  label: id,
  status,
})

/** 假时钟 + 可注入的豁免窗口 / 重试节流，方便把「一拍之后又发生什么」摆在一起 */
function setup(options: { pauseGraceMs?: number; pauseRetryMs?: number } = {}) {
  let t = 0
  const interlock = new AudioFocusInterlock({
    now: () => t,
    pauseGraceMs: options.pauseGraceMs ?? 2000,
    pauseRetryMs: options.pauseRetryMs ?? 10_000,
  })
  return {
    interlock,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('控制通道失效：不因「对方还在 Playing」就让位', () => {
  it('豁免窗口内读到旧的 Playing：既不重试也不让位', () => {
    const { interlock } = setup()
    interlock.onSnapshot([player('a')])
    expect(interlock.onOursPlaying(true).pauseExternals).toEqual(['a'])

    // 还在 2s 豁免窗口内
    const eff = interlock.onSnapshot([player('a')])
    expect(eff.pauseOurs).toBe(false)
    expect(eff.pauseExternals).toEqual([])
  })

  it('窗口过后仍未停下：不让位，按 pauseRetryMs 节流重试 pause', () => {
    const { interlock, advance } = setup({ pauseGraceMs: 2000, pauseRetryMs: 10_000 })
    interlock.onSnapshot([player('a')])
    interlock.onOursPlaying(true)

    advance(2000)
    const retry = interlock.onSnapshot([player('a')])
    expect(retry.pauseOurs).toBe(false)
    expect(retry.pauseExternals).toEqual(['a'])

    // 重试本身也要过豁免窗口，且节流期内不再刷
    advance(1000)
    expect(interlock.onSnapshot([player('a')]).pauseExternals).toEqual([])
    advance(8000)
    expect(interlock.onSnapshot([player('a')]).pauseExternals).toEqual([])

    // 距上次重试满 10s → 再试一次
    advance(1000)
    expect(interlock.onSnapshot([player('a')]).pauseExternals).toEqual(['a'])
  })

  it('观察到真的 Paused 过、又被手动恢复 → 让位（这是「用户抢播放」）', () => {
    const { interlock, advance } = setup()
    interlock.onSnapshot([player('a')])
    interlock.onOursPlaying(true)

    // 下一拍确认停住了
    advance(1000)
    expect(interlock.onSnapshot([player('a', 'Paused')]).pauseExternals).toEqual([])

    // 用户之后手动恢复它
    advance(2000)
    expect(interlock.onSnapshot([player('a')]).pauseOurs).toBe(true)
  })

  it('从未被我们暂停过的新播放器出声 → 让位（这是「别人开始播放」）', () => {
    const { interlock } = setup()
    interlock.onSnapshot([])
    interlock.onOursPlaying(true)
    expect(interlock.onSnapshot([player('x')]).pauseOurs).toBe(true)
  })
})

describe('adoptPlayingNow：播放中打开开关', () => {
  it('认领窗口内：先于我们存在的播放器按抢占处理，不暂停自己', () => {
    const { interlock } = setup()
    // 开启瞬间没有任何快照：对齐播放态是空操作
    expect(interlock.onOursPlaying(true).pauseExternals).toEqual([])

    const eff = interlock.onSnapshot([player('a')], { adoptPlayingNow: true })
    expect(eff.pauseOurs).toBe(false)
    expect(eff.pauseExternals).toEqual(['a'])
    // 已经记成「我们暂停的对象」，后续轮询不会再把它当打断者
    expect(interlock.getState().pausedByUs).toEqual(['a'])
  })

  it('没有认领窗口时同样的快照会让位（对照）', () => {
    const { interlock } = setup()
    interlock.onOursPlaying(true)
    expect(interlock.onSnapshot([player('a')]).pauseOurs).toBe(true)
  })

  it('认领窗口过期后出现的播放器仍按打断处理', () => {
    const { interlock, advance } = setup()
    interlock.onOursPlaying(true)
    // 窗口在 service 侧判断（adoptUntil），状态机只看这一拍传进来的布尔值
    advance(6000)
    expect(interlock.onSnapshot([player('a')], { adoptPlayingNow: false }).pauseOurs).toBe(true)
  })
})

describe('让位与归还的交界', () => {
  it('让位对象安静时只请求一次续播（短轮询间隔不会一直重置定时器）', () => {
    const { interlock, advance } = setup()
    interlock.onSnapshot([player('a', 'Paused')])
    interlock.onOursPlaying(true)
    interlock.onSnapshot([player('a')])
    expect(interlock.getState().yieldedTo).toEqual(['a'])

    expect(interlock.onSnapshot([player('a', 'Paused')]).scheduleResumeOurs).toBe(true)
    advance(500)
    // 已排队期间不再重复请求：否则 win32 的 700ms 轮询会每拍重置 service 的 900ms 定时器，
    // 自动续播永远到不了点
    expect(interlock.onSnapshot([player('a', 'Paused')]).scheduleResumeOurs).toBe(false)

    // 对方又出声：排队意图取消，等它安静后重新请求
    expect(interlock.onSnapshot([player('a')]).scheduleResumeOurs).toBe(false)
    expect(interlock.getState().resumeOursPending).toBe(false)
    expect(interlock.onSnapshot([player('a', 'Paused')]).scheduleResumeOurs).toBe(true)
  })

  it('让位期间持续出声不会重复请求 pauseOurs', () => {
    const { interlock, advance } = setup()
    interlock.onSnapshot([])
    interlock.onOursPlaying(true)
    expect(interlock.onSnapshot([player('a')]).pauseOurs).toBe(true)
    for (let i = 0; i < 5; i += 1) {
      advance(1000)
      expect(interlock.onSnapshot([player('a')]).pauseOurs).toBe(false)
    }
  })

  /**
   * 缺陷 A（中等，三人以上场景）：
   * 让位时 `pausedByUs.clear()` 把「先前被我们暂停、现在仍停着」的其他播放器一起忘了。
   * 之后本应用重新起播、再停下时，这些播放器不再出现在归还名单里 —— 它们会一直停在暂停，
   * 只能用户自己去点播放。契约规则 4 说的是「本应用停止 → 归还被我们暂停的播放器」。
   *
   * 复现：a、b 都在播 → 我们起播，两个都被我们暂停 → 确认都停住后用户手动恢复 a
   * → 我们让位（a 是打断者）→ a 又安静 → 我们续播 → 用户暂停本应用。
   * 此时 b 应该被归还，但实现里早已被 clear 掉。
   */
  it('让位不应遗忘先前被我们暂停的第三个播放器（停止时仍要归还它）', () => {
    const { interlock, advance } = setup()
    interlock.onSnapshot([player('a'), player('b')])
    interlock.onOursPlaying(true)

    // 确认两个都真的停了
    advance(1000)
    interlock.onSnapshot([player('a', 'Paused'), player('b', 'Paused')])

    // 用户手动恢复 a → 让位
    advance(2000)
    expect(interlock.onSnapshot([player('a'), player('b', 'Paused')]).pauseOurs).toBe(true)

    // a 又安静 → 续播自己
    advance(1000)
    interlock.onSnapshot([player('a', 'Paused'), player('b', 'Paused')])
    expect(interlock.onResumeOursDue().resumeOurs).toBe(true)

    // 用户暂停本应用：b 仍是被我们暂停的，必须归还
    const eff = interlock.onOursPlaying(false)
    expect(eff.scheduleResumeExternals).toBe(true)
    expect(interlock.onResumeExternalsDue().resumeExternals).toContain('b')
  })

  /**
   * 缺陷 B（低概率，但逻辑上不一致）：
   * 归还路径（onResumeExternalsDue / release）用 `statusOf()` 判断「是否仍停在 Paused」，
   * 而 `statusOf()` 不看我们自己发出暂停的 2s 豁免窗口。于是「刚发完 Pause、轮询还没反映
   * （仍读作 Playing）、用户马上停掉本应用/关掉开关」时，这个播放器不会被归还；
   * 等它的 Pause 真正生效后，就永久停在暂停了。
   * 同一份快照，`playingIds()` 认为「它已被我们暂停」，`statusOf()` 却认为「它还在播」。
   */
  it('归还时也要认「我们刚发出暂停」的豁免窗口（不能漏归还）', () => {
    const { interlock, advance } = setup()
    interlock.onSnapshot([player('a')])
    interlock.onOursPlaying(true) // 发出 Pause，进入豁免窗口
    advance(500)
    // 轮询还没反映暂停，仍读到 Playing
    interlock.onSnapshot([player('a')])

    interlock.onOursPlaying(false) // 用户很快停了
    expect(interlock.onResumeExternalsDue().resumeExternals).toEqual(['a'])
  })

  it('release（关开关/退出）同样不能漏归还豁免窗口内的播放器', () => {
    const { interlock, advance } = setup()
    interlock.onSnapshot([player('a')])
    interlock.onOursPlaying(true)
    advance(500)
    interlock.onSnapshot([player('a')])

    expect(interlock.release().resumeExternals).toEqual(['a'])
  })
})
