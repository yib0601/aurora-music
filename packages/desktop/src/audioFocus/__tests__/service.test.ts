/**
 * 音频焦点 service 的装配与时序单测（Electron 用最小 mock 顶掉）。
 *
 * ## 为什么值得单独测这一层
 *
 * interlock 是纯函数，provider 各自有自己的单测；真正没人守的是**装配**：
 *   - ipcMain 通道注册了几次、参数类型有没有被挡；
 *   - 开关关掉后 setInterval 是否真的停了（不是「收到快照后什么都不做」）；
 *   - 定时器与状态机豁免窗口（2s）之间的相对关系；
 *   - 退出时到底有没有把暂停别人的播放器还回去。
 *
 * 这些错误在单测里不会让任何纯函数变红，现场却表现为「功能时灵时不灵」「关掉开关反而更糟」。
 *
 * ## 怎么让它可测
 *
 * service.ts 在模块级持有单例，provider 由 `createAudioFocusProvider()` 就地构造，
 * 所以这里：
 *   1. `vi.mock('electron')` 把 ipcMain 换成记录器（并模拟「同一通道注册两次就抛错」）；
 *   2. `vi.mock('../providers')` 让 provider 从 `h.provider` 取，用例自行注入假实现；
 *   3. 每个用例 `vi.resetModules()` + 动态 import，拿到干净的单例；
 *   4. 全程假时钟：轮询间隔、900ms/1200ms 延迟、2s 豁免窗口都由 `advanceTimersByTimeAsync` 驱动。
 *
 * 曾经用 `it.fails` 钉住的四条缺陷（退出不归还 / pausedOursByUs 残留 / 短轮询下续播永不到点 /
 * dispose 后重新 init 抛 second handler）已修复，用例保留为回归测试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { AUDIO_FOCUS_CHANNELS } from '../types'
import type { AudioFocusProvider, ExternalPlayer } from '../types'

/* eslint-disable @typescript-eslint/no-explicit-any */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  listeners: new Map<string, (...args: any[]) => void>(),
  provider: null as any,
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: any[]) => any) => {
      if (h.handlers.has(channel)) {
        // 与 Electron 真实行为一致：同一通道注册第二个 handler 会抛错
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      h.handlers.set(channel, fn)
    },
    on: (channel: string, fn: (...args: any[]) => void) => {
      h.listeners.set(channel, fn)
    },
    removeHandler: (channel: string) => {
      h.handlers.delete(channel)
    },
    removeAllListeners: (channel: string) => {
      h.listeners.delete(channel)
    },
  },
}))

vi.mock('../providers', () => ({
  createAudioFocusProvider: () => h.provider,
}))

interface FakeProvider {
  provider: AudioFocusProvider
  snapshot: ExternalPlayer[]
  setSnapshot: (players: ExternalPlayer[]) => void
  list: Mock
  pause: Mock
  play: Mock
  dispose: Mock
}

/** 造一个假 provider：list 读内存快照，pause/play/dispose 只记录 */
function makeFakeProvider(pollingIntervalMs = 1000): FakeProvider {
  const snapshot: ExternalPlayer[] = []
  const list = vi.fn(async () => snapshot.map((p) => ({ ...p })))
  const pause = vi.fn(async (_id: string) => {})
  const play = vi.fn(async (_id: string) => {})
  const dispose = vi.fn(async () => {})
  return {
    provider: {
      kind: 'linux',
      pollingIntervalMs,
      list,
      pause,
      play,
      dispose,
    } as AudioFocusProvider,
    snapshot,
    setSnapshot: (players) => {
      snapshot.splice(0, snapshot.length, ...players)
    },
    list,
    pause,
    play,
    dispose,
  }
}

function makeWindow() {
  const send = vi.fn()
  const webContents = { id: 1, send }
  const win = { isDestroyed: () => false, webContents }
  return { win, send, webContents }
}

const player = (
  id: string,
  status: ExternalPlayer['status'] = 'Playing',
): ExternalPlayer => ({ id, label: id, status })

/**
 * 起一个干净的单例 service，并把两个 IPC 入口包成可直接调用的函数。
 *
 * 事件对象只需要 `sender`：service 用它判断「是不是本窗口」。
 */
async function boot(pollingIntervalMs = 1000) {
  const fake = makeFakeProvider(pollingIntervalMs)
  h.provider = fake.provider
  vi.resetModules()
  const service = await import('../service')
  const { win, send, webContents } = makeWindow()
  service.initAudioFocus(win as any)

  const enable = (value: unknown) =>
    h.handlers.get(AUDIO_FOCUS_CHANNELS.enable)!({ sender: webContents }, value) as boolean
  const reportOurs = (value: unknown) =>
    h.listeners.get(AUDIO_FOCUS_CHANNELS.ours)!({ sender: webContents }, value)

  /** 主进程下发给渲染层的播放控制（'pause' / 'resume'） */
  const controls = () =>
    send.mock.calls.filter(([channel]) => channel === 'media-control').map(([, action]) => action)

  return { service, fake, win, webContents, send, enable, reportOurs, controls }
}

/** 推进假时钟并额外冲刷微任务（provider.list 是 async） */
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  h.handlers.clear()
  h.listeners.clear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('生命周期：开关与轮询', () => {
  it('未开启时完全不轮询（不空转：Linux 上一拍就是一串 D-Bus 调用）', async () => {
    const { fake } = await boot()
    await tick(10_000)
    expect(fake.list).not.toHaveBeenCalled()
  })

  it('开启后按 provider 的轮询间隔走，关闭后立刻停表', async () => {
    const { fake, enable } = await boot(1000)
    expect(enable(true)).toBe(true)
    // startPolling 会立刻补一拍，不等第一个 interval
    await tick(0)
    expect(fake.list).toHaveBeenCalledTimes(1)

    await tick(3000)
    expect(fake.list).toHaveBeenCalledTimes(4)

    enable(false)
    const callsAtDisable = fake.list.mock.calls.length
    await tick(10_000)
    expect(fake.list).toHaveBeenCalledTimes(callsAtDisable)
  })

  it('反复开关不泄漏定时器，也不重复注册 ipcMain', async () => {
    const { fake, enable } = await boot(1000)
    for (let i = 0; i < 5; i += 1) {
      enable(true)
      await tick(0)
      enable(false)
    }
    // enable 走 invoke（handle），ours 走 send（on）；反复开关不得重复注册
    // （重复 handle 在 Electron 里会直接抛错，这个 mock 也照抛）
    expect([...h.handlers.keys()]).toEqual([AUDIO_FOCUS_CHANNELS.enable])
    expect([...h.listeners.keys()]).toEqual([AUDIO_FOCUS_CHANNELS.ours])

    fake.list.mockClear()
    enable(true)
    await tick(0)
    await tick(3000)
    // 干净的一轮：立即一拍 + 3 个 interval。有泄漏时这里会明显偏大
    expect(fake.list.mock.calls.length).toBe(4)
  })

  it('initAudioFocus 重复调用是幂等的（不会抛 second handler）', async () => {
    const { service } = await boot()
    expect(() => service.initAudioFocus(makeWindow().win as any)).not.toThrow()
    expect(h.handlers.size).toBe(1)
    expect(h.listeners.size).toBe(1)
  })

  it('dispose 幂等：停表、provider 只释放一次、之后开关不再生效', async () => {
    const { service, fake, enable } = await boot(1000)
    enable(true)
    await tick(2000)
    const callsBeforeDispose = fake.list.mock.calls.length

    service.disposeAudioFocus()
    service.disposeAudioFocus()

    expect(fake.dispose).toHaveBeenCalledTimes(1)
    await tick(10_000)
    expect(fake.list).toHaveBeenCalledTimes(callsBeforeDispose)
    // dispose 现在会注销 IPC：两个通道都不再挂在 ipcMain 上
    // （不注销的话，将来任何「销毁后再 init」都会抛 second handler）
    expect(h.handlers.size).toBe(0)
    expect(h.listeners.size).toBe(0)
  })
})

describe('IPC 面：参数与来源约束', () => {
  it('非布尔参数一律拒绝（渲染层不能借此表达别的语义）', async () => {
    const { fake, enable, reportOurs, send } = await boot()
    fake.setSnapshot([player('a')])

    expect(enable('true')).toBe(false)
    expect(enable(1)).toBe(false)
    expect(enable({ enabled: true })).toBe(false)

    reportOurs('true')
    reportOurs(1)
    await tick(3000)
    // 开关没被打开 → 一轮都没轮询
    expect(fake.list).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('非本窗口（第三方页面/插件页）来的消息被丢弃', async () => {
    const { fake, send } = await boot()
    const foreignSender = { id: 99 }

    expect(h.handlers.get(AUDIO_FOCUS_CHANNELS.enable)!({ sender: foreignSender }, true)).toBe(false)
    h.listeners.get(AUDIO_FOCUS_CHANNELS.ours)!({ sender: foreignSender }, true)
    await tick(5000)

    expect(fake.list).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  /**
   * 「播放中打开开关」的回归：开启那一刻还没有任何外部快照，若照常按「对方在播 + 我方在播」
   * 裁定，第一拍就会让位——用户开着歌点开关，看到的是本应用把自己暂停。
   * service 用 adoptUntil（5s 认领窗口）把这几拍里正在出声的人定性为「先于我们存在」，
   * 按抢占处理。这条用例钉住「先抢占、不暂停自己」。
   */
  it('播放中打开开关：抢占外部播放器，而不是把自己暂停', async () => {
    const { fake, enable, reportOurs, controls } = await boot(1000)
    fake.setSnapshot([player('a')])

    // 关闭状态下也记录播放态（重新打开开关要能立刻对齐）
    reportOurs(true)
    expect(enable(true)).toBe(true)
    await tick(1000)

    expect(fake.pause).toHaveBeenCalledWith('a')
    expect(controls()).not.toContain('pause')
  })
})

describe('时序：抢占 / 让位 / 续播', () => {
  it('本应用起播时暂停正在出声的外部播放器', async () => {
    const { fake, enable, reportOurs } = await boot(1000)
    fake.setSnapshot([player('a'), player('b', 'Paused')])
    enable(true)
    await tick(0)

    reportOurs(true)
    expect(fake.pause).toHaveBeenCalledWith('a')
    // 已暂停的 b 不该被再按一次
    expect(fake.pause).not.toHaveBeenCalledWith('b')
  })

  /**
   * 控制通道失效（说话没人听）时的行为：**不让位**，改为 10s 节流重试暂停。
   *
   * 语义修正后的规则（interlock.ts「第三类不让位」）：我们发过 Pause、但从没观察到
   * 对方真的 Paused 的播放器，不按「它打断了我」处理 —— 否则 Windows 的 stdin 泵坏掉、
   * macOS 的自动化授权被拒时，本应用会变成「一有别人出声就把自己按停」。
   * 这里在 service 层验证它确实没下发 media-control:pause，且重试是节流的。
   */
  it('发过 Pause 但对方始终没停下：不让位，按 10s 节流重试（不刷屏）', async () => {
    const { fake, enable, reportOurs, controls } = await boot(1000)
    fake.setSnapshot([player('a')])
    enable(true)
    await tick(0)
    reportOurs(true)
    expect(fake.pause).toHaveBeenCalledTimes(1)

    // 豁免窗口（2s）内：不重试、不让位
    await tick(1000)
    expect(fake.pause).toHaveBeenCalledTimes(1)
    expect(controls()).not.toContain('pause')

    // 窗口过后仍 Playing：认定为「通道没生效」→ 立即重试一次，但**不**让位
    await tick(1000)
    expect(fake.pause).toHaveBeenCalledTimes(2)
    expect(controls()).not.toContain('pause')

    // 接着 9 秒内不再重试（10s 节流）
    await tick(9000)
    expect(fake.pause).toHaveBeenCalledTimes(2)

    // 节流窗口到了 → 再试一次
    await tick(1000)
    expect(fake.pause).toHaveBeenCalledTimes(3)
  })

  it('确认停下过、又被用户手动恢复 → 让位', async () => {
    const { fake, enable, reportOurs, controls } = await boot(1000)
    fake.setSnapshot([player('a')])
    enable(true)
    await tick(0)
    reportOurs(true)
    expect(fake.pause).toHaveBeenCalledWith('a')

    // 下一拍观察到对方真的 Paused → 记为「确认停过」
    fake.setSnapshot([player('a', 'Paused')])
    await tick(1000)

    // 用户手动恢复它：这才是「别人抢了播放」，让位
    fake.setSnapshot([player('a')])
    await tick(1000)
    expect(controls()).toContain('pause')
  })

  it('让位后对方安静 → 900ms 后续播自己（Linux：1s 轮询 > 900ms 延迟，能正常触发）', async () => {
    const { fake, enable, reportOurs, controls } = await boot(1000)
    fake.setSnapshot([])
    enable(true)
    await tick(0)
    reportOurs(true)

    // 别人开始出声 → 让位
    fake.setSnapshot([player('a')])
    await tick(1000)
    expect(controls().filter((action) => action === 'pause')).toHaveLength(1)

    // 渲染层如实上报「我已暂停」
    reportOurs(false)
    // 对方安静 → 安排续播
    fake.setSnapshot([player('a', 'Paused')])
    await tick(1000)
    expect(controls()).not.toContain('resume')

    await tick(900)
    expect(controls().filter((action) => action === 'resume')).toHaveLength(1)
    // 持续安静后再多拍轮询：不应再反复下发控制（没有自激）
    await tick(5000)
    expect(controls().filter((action) => action === 'pause')).toHaveLength(1)
    expect(controls().filter((action) => action === 'resume')).toHaveLength(1)
  })

  it('让位期间对方持续出声：只下发一次暂停，不会每拍都按一次', async () => {
    const { fake, enable, reportOurs, controls } = await boot(1000)
    fake.setSnapshot([])
    enable(true)
    await tick(0)
    reportOurs(true)
    fake.setSnapshot([player('a')])
    await tick(1000)
    reportOurs(false)

    for (let i = 0; i < 5; i += 1) {
      await tick(1000)
    }
    expect(controls().filter((action) => action === 'pause')).toHaveLength(1)
    expect(controls()).not.toContain('resume')
  })

  it('provider.list 抛错不会把轮询循环打死（契约：不抛给上层）', async () => {
    const { fake, enable } = await boot(1000)
    fake.list.mockRejectedValueOnce(new Error('dbus exploded'))
    enable(true)
    await tick(0)
    await tick(2000)
    expect(fake.list.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('归还：关开关 vs 退出', () => {
  it('关闭开关时把被我们暂停的外部播放器还回去', async () => {
    const { fake, enable, reportOurs } = await boot(1000)
    fake.setSnapshot([player('a')])
    enable(true)
    await tick(0)
    reportOurs(true)
    expect(fake.pause).toHaveBeenCalledWith('a')

    enable(false)
    expect(fake.play).toHaveBeenCalledWith('a')
  })

  /**
   * 缺陷 1（必须修）：`dispose()` 先把 `this.disposed = true`，随后 `apply(release())`
   * 在 apply 的第一行就被 `if (this.disposed) return` 挡掉 —— 也就是**退出时根本不归还**。
   * 表现：退出 Aurora 后，用户此前被我们暂停的浏览器/播放器一直停在暂停，只能手动点播放。
   */
  it('退出（dispose）时也必须归还被暂停的外部播放器', async () => {
    const { service, fake, enable, reportOurs } = await boot(1000)
    fake.setSnapshot([player('a')])
    enable(true)
    await tick(0)
    reportOurs(true)
    expect(fake.pause).toHaveBeenCalledWith('a')

    service.disposeAudioFocus()
    expect(fake.play).toHaveBeenCalledWith('a')
  })

  /**
   * 缺陷 2（必须修）：`pausedOursByUs` 只在我们自己下发 resume 时清除，
   * 渲染层手动播放/暂停不会清它。于是「让位过 → 用户自己点播放 → 用户又暂停 →
   * 关掉音频焦点开关」会下发一次 `media-control: resume`，把用户刚停掉的播放重新拉起来。
   * 契约是「关闭功能要归还」，不是「关闭功能要开始播放」。
   */
  it('关闭开关不能把用户已暂停的本应用重新拉起来（pausedOursByUs 残留）', async () => {
    const { fake, enable, reportOurs, controls } = await boot(1000)
    fake.setSnapshot([])
    enable(true)
    await tick(0)
    reportOurs(true)

    // 别人出声 → 我们让位（本应用被暂停）
    fake.setSnapshot([player('a')])
    await tick(1000)
    expect(controls()).toContain('pause')

    // 用户手动点播放（抢回主动权），随后又手动暂停
    reportOurs(true)
    reportOurs(false)
    fake.setSnapshot([player('a', 'Paused')])
    await tick(2000)

    const before = controls().length
    enable(false)
    const after = controls().slice(before)
    expect(after).not.toContain('resume')
  })
})

describe('已知时序缺陷：轮询间隔 < 续播延迟', () => {
  /**
   * 缺陷 3（必须修，Windows 上是常态）：
   *
   * interlock 在「让位对象已安静」时**每一拍快照都会**返回 `scheduleResumeOurs`，
   * 而 service 的 `scheduleResumeOurs()` 会先 `clearResumeTimers()` 再重新设 900ms。
   * 只要轮询间隔 < 900ms，定时器每拍都被重置，`onResumeOursDue` 永远到不了点。
   *
   * win32 provider 的 `pollingIntervalMs = 700`（子进程 700ms 推一行快照），
   * 因此在 Windows 上「对方安静后自动续播」永远不触发 —— 用户看到的是：
   * 别人一出声我就永久暂停，直到手动点播放。Linux（1000ms）与 macOS（1500ms）
   * 只是恰好间隔更大，属于侥幸安全（Linux 只剩 100ms 余量）。
   */
  it('轮询 700ms（win32 provider 的实际值）时，对方安静后仍能自动续播', async () => {
    const { fake, enable, reportOurs, controls } = await boot(700)
    fake.setSnapshot([])
    enable(true)
    await tick(0)
    reportOurs(true)

    fake.setSnapshot([player('a')])
    await tick(700)
    expect(controls()).toContain('pause')

    reportOurs(false)
    fake.setSnapshot([player('a', 'Paused')])
    // 走 7 秒（10 拍轮询），足够覆盖 900ms 的续播延迟
    for (let i = 0; i < 10; i += 1) {
      await tick(700)
    }
    expect(controls()).toContain('resume')
  })
})

describe('已知潜在缺陷：dispose 后重新初始化', () => {
  /**
   * 缺陷 4（次要，当前 main.ts 不会走到）：
   * `dispose()` 没有 `ipcMain.removeHandler`，而 `disposeAudioFocus()` 把单例置空。
   * 一旦将来出现「销毁后再 init」（例如 macOS 关窗后重新 activate 又挂一次服务，
   * 或测试里重置单例），`ipcMain.handle` 会抛
   * `Attempted to register a second handler for 'audio-focus:enable'`。
   * main.ts 现在的 `app.on('activate')` 只重建窗口、不重新 init，所以暂不会触发。
   */
  it('dispose 之后重新 init 不应抛 second handler', async () => {
    const { service } = await boot()
    service.disposeAudioFocus()
    expect(() => service.initAudioFocus(makeWindow().win as any)).not.toThrow()
  })
})
