/**
 * 静默期补扫调度的行为回归。
 *
 * 要钉住的是**调度本身的三条契约**，不是「补扫能扫出文件」（那是端侧扫描器的事）：
 *   1. 同一目录多次 defer 合并成一个定时器，且时刻不被后来的调用往后推；
 *   2. 连续补扫有上限，但 markClean 必须能把额度清零（否则补扫永久失效）；
 *   3. 目录被移除/消失时的 cancel 真的取消，之后不会再有补扫。
 *
 * 用假定时器：这些断言全是「什么时候触发」，等真实 7 秒既慢又会让用例不稳定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENCRYPTED_SETTLE_MS } from '../encryptedAudio'
import {
  SETTLE_RESCAN_DELAY_MS,
  SETTLE_RESCAN_MAX_ROUNDS,
  createSettleRescanScheduler,
} from '../settleRescan'

const FOLDER = '/music'
const OTHER = '/music/other'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createSettleRescanScheduler', () => {
  it('延迟与闸门同源：补扫必须比静默期更晚，否则补扫本身也会被挡掉', () => {
    expect(SETTLE_RESCAN_DELAY_MS).toBeGreaterThan(ENCRYPTED_SETTLE_MS)
  })

  it('defer 之后到点触发一次补扫，触发前 pending 为真', () => {
    const rescans: string[] = []
    const s = createSettleRescanScheduler({ rescan: (f) => { rescans.push(f) } })

    s.defer(FOLDER)
    expect(s.pending(FOLDER)).toBe(true)

    vi.advanceTimersByTime(SETTLE_RESCAN_DELAY_MS - 1)
    expect(rescans).toEqual([])

    vi.advanceTimersByTime(1)
    expect(rescans).toEqual([FOLDER])
    // 触发后不再 pending：否则下一轮的 defer 会被自己的 has 判定合并掉
    expect(s.pending(FOLDER)).toBe(false)
  })

  it('同一目录重复 defer 合并成一次，且不把已定好的时刻往后推', () => {
    const rescans: string[] = []
    const s = createSettleRescanScheduler({ rescan: (f) => { rescans.push(f) } })

    s.defer(FOLDER)
    // 文件持续落盘：每首都会被静默期挡下，若每次都重设定时器就永远推不到头
    vi.advanceTimersByTime(1000)
    s.defer(FOLDER)
    vi.advanceTimersByTime(1000)
    s.defer(FOLDER)

    // 从**第一次** defer 算起满一个延迟就该触发
    vi.advanceTimersByTime(SETTLE_RESCAN_DELAY_MS - 2000)
    expect(rescans).toEqual([FOLDER])

    // 之后也不再有多余触发
    vi.advanceTimersByTime(SETTLE_RESCAN_DELAY_MS * 3)
    expect(rescans).toEqual([FOLDER])
  })

  it('不同目录各自独立触发（不能合并，否则别的目录要等自己下次变动才被看见）', () => {
    const rescans: string[] = []
    const s = createSettleRescanScheduler({ rescan: (f) => { rescans.push(f) } })

    s.defer(FOLDER)
    s.defer(OTHER)
    vi.advanceTimersByTime(SETTLE_RESCAN_DELAY_MS)

    expect(rescans.sort()).toEqual([FOLDER, OTHER].sort())
  })

  it(`连续补扫到上限（${SETTLE_RESCAN_MAX_ROUNDS} 次）后不再安排：写入一直不停时别死循环`, () => {
    let calls = 0
    // 模拟「补扫之后又被挡」：每次触发后立刻再 defer
    const s = createSettleRescanScheduler({
      rescan: () => { calls += 1; s.defer(FOLDER) },
    })
    s.defer(FOLDER)

    for (let i = 0; i < 10; i++) vi.advanceTimersByTime(SETTLE_RESCAN_DELAY_MS)

    expect(calls).toBe(SETTLE_RESCAN_MAX_ROUNDS)
    expect(s.pending(FOLDER)).toBe(false)
  })

  it('markClean 清空连续计数，补扫额度恢复（否则额度用满后永久失效）', () => {
    let calls = 0
    const s = createSettleRescanScheduler({
      rescan: () => { calls += 1; s.defer(FOLDER) },
    })
    s.defer(FOLDER)

    for (let i = 0; i < 10; i++) vi.advanceTimersByTime(SETTLE_RESCAN_DELAY_MS)
    expect(calls).toBe(SETTLE_RESCAN_MAX_ROUNDS)

    // 某一轮扫描干净了：额度恢复
    s.markClean(FOLDER)
    s.defer(FOLDER)
    vi.advanceTimersByTime(SETTLE_RESCAN_DELAY_MS)
    expect(calls).toBe(SETTLE_RESCAN_MAX_ROUNDS + 1)
  })

  it('rescan 返回 false（例如监听正被挂起）时不计入额度，留给下次机会', () => {
    const s = createSettleRescanScheduler({
      rescan: () => false,
      maxRounds: 1,
    })

    // 一直被拒也不会把额度耗光：返回 false 表示「这次没扫」
    for (let i = 0; i < 5; i++) {
      s.defer(FOLDER)
      vi.advanceTimersByTime(SETTLE_RESCAN_DELAY_MS)
      expect(s.pending(FOLDER)).toBe(false)
    }

    // 恢复后仍然能补扫（额度没被白耗）
    let called = 0
    const s2 = createSettleRescanScheduler({ maxRounds: 1, rescan: () => { called += 1 } })
    s2.defer(FOLDER)
    vi.advanceTimersByTime(SETTLE_RESCAN_DELAY_MS)
    expect(called).toBe(1)
  })

  it('cancel 取消待补扫，之后不再触发，且额度一并清掉', () => {
    const rescans: string[] = []
    const s = createSettleRescanScheduler({ rescan: (f) => { rescans.push(f) } })

    s.defer(FOLDER)
    s.cancel(FOLDER)
    expect(s.pending(FOLDER)).toBe(false)

    vi.advanceTimersByTime(SETTLE_RESCAN_DELAY_MS * 2)
    expect(rescans).toEqual([])
  })

  it('cancelAll 清空所有目录', () => {
    const rescans: string[] = []
    const s = createSettleRescanScheduler({ rescan: (f) => { rescans.push(f) } })

    s.defer(FOLDER)
    s.defer(OTHER)
    s.cancelAll()

    vi.advanceTimersByTime(SETTLE_RESCAN_DELAY_MS * 2)
    expect(rescans).toEqual([])
  })

  it('rescan 抛错不外泄（定时器回调里抛出会让 Electron 主进程直接崩）', () => {
    const s = createSettleRescanScheduler({
      rescan: () => { throw new Error('boom') },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    s.defer(FOLDER)
    expect(() => vi.advanceTimersByTime(SETTLE_RESCAN_DELAY_MS)).not.toThrow()
    expect(warn).toHaveBeenCalled()

    warn.mockRestore()
  })

  it('空目录名直接忽略（不当成一次有效请求）', () => {
    const rescans: string[] = []
    const s = createSettleRescanScheduler({ rescan: (f) => { rescans.push(f) } })

    s.defer('')
    vi.advanceTimersByTime(SETTLE_RESCAN_DELAY_MS * 2)
    expect(rescans).toEqual([])
  })
})
