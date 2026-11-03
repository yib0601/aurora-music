import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NO_PROVIDER_KIND,
  createAudioFocusProvider,
  createProviderForPlatform,
} from '../providers'

/**
 * 平台选择器 + 两个「本机跑不了」平台的打桩测试。
 *
 * 本机是 Linux，Windows / macOS 的真实通道无法在这里验证，但**装配层**的错照样会漏出去：
 * 子进程参数、-EncodedCommand 的编码、stdout 分行的缓冲、退出后的限频重启、
 * osascript 的调用与结果解析——这些都不依赖真实平台，用打桩把子进程换成假的就能测。
 * 真机才成立的部分（SMTC 受限能力是否放行、各播放器 AppleScript 字典、TCC 授权）
 * 明确留作「未验证点」。
 */

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
}))

/** 让假的子进程/流把数据吐完（PassThrough 的 data 事件是异步派发的） */
const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))
const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface FakeChild extends EventEmitter {
  stdout: PassThrough
  stdin: PassThrough
  kill: ReturnType<typeof vi.fn>
  /** 写进 stdin 的内容（按数据块收集，断言时拼起来） */
  written: string[]
}

/** 造一条假 powershell 子进程：stdout/stdin 都是内存流，退出由用例手动 emit('exit') */
function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new PassThrough()
  child.stdin = new PassThrough()
  child.written = []
  child.stdin.on('data', (chunk: Buffer | string) => child.written.push(String(chunk)))
  child.kill = vi.fn(() => {
    // 真实 kill 之后会有 exit 事件；用 setImmediate 避免同步重入 provider 的回调
    setImmediate(() => child.emit('exit', 0, null))
    return true
  })
  return child
}

/** 用一次性假子进程驱动 provider；返回每次 spawn 出来的 child */
function stubSpawn(): FakeChild[] {
  const children: FakeChild[] = []
  vi.mocked(spawn).mockImplementation(((..._args: unknown[]) => {
    const child = makeFakeChild()
    children.push(child)
    return child as unknown as ChildProcess
  }) as never)
  return children
}

/**
 * 按脚本内容决定 osascript 的返回，模拟一台 macOS 上的真实情况：
 * Spotify 在放、Music 暂停、VLC 的脚本字典不含这些术语（编译失败）、其余没在运行。
 */
function stubOsascript(): void {
  vi.mocked(execFile).mockImplementation(((
    file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    expect(file).toBe('osascript')
    const script = args[1] ?? ''
    const fail = () => callback(Object.assign(new Error('osascript: syntax error'), { code: 1 }), '', '')
    if (script.includes('tell application "VLC"')) {
      fail()
      return {} as never
    }
    if (script.includes('tell application "Spotify"')) {
      callback(null, 'playing\n', '')
      return {} as never
    }
    if (script.includes('tell application "Music"')) {
      callback(null, 'paused\n', '')
      return {} as never
    }
    // 脚本跑通了但应用没在运行 → 空输出
    callback(null, '', '')
    return {} as never
  }) as never)
}

/** 断言 on-disk 的实现满足「pause/play 不得抛错」这一条契约 */
describe('provider 契约（可平台无关验证的部分）', () => {
  it.each(['freebsd', 'openbsd', 'sunos', 'aix', 'android'])(
    '%s 平台降级为 none provider',
    async (platform) => {
      const provider = createProviderForPlatform(platform as NodeJS.Platform)
      expect(provider.kind).toBe(NO_PROVIDER_KIND)
      // service 用这个值做轮询间隔，必须是有限正数（NaN/0 会让 setInterval 疯转）
      expect(provider.pollingIntervalMs).toBeGreaterThan(0)
      expect(Number.isFinite(provider.pollingIntervalMs)).toBe(true)
      // 契约：list 不得抛错，且必须返回空列表（否则状态机会以为「外面有人在放」）
      await expect(provider.list()).resolves.toEqual([])
      await expect(provider.pause('anything')).resolves.toBeUndefined()
      await expect(provider.play('anything')).resolves.toBeUndefined()
      // 幂等：service 的退出路径可能调两次
      await expect(provider.dispose()).resolves.toBeUndefined()
      await expect(provider.dispose()).resolves.toBeUndefined()
    }
  )

  it('linux 平台返回 linux provider', () => {
    // 依赖 providers/linux.ts（MPRIS over D-Bus 实现）存在；它按契约导出 createLinuxProvider
    expect(createProviderForPlatform('linux').kind).toBe('linux')
  })

  it('win32 / darwin 平台返回各自的 provider', () => {
    const win = createProviderForPlatform('win32')
    expect(win.kind).toBe('win32')
    expect(win.pollingIntervalMs).toBeGreaterThan(0)

    const mac = createProviderForPlatform('darwin')
    expect(mac.kind).toBe('darwin')
    expect(mac.pollingIntervalMs).toBeGreaterThan(0)
  })

  it('每个平台的 kind 互不相同（service 靠 kind 判断能力与日志归属）', () => {
    const kinds = ['linux', 'win32', 'darwin', 'freebsd'].map(
      (platform) => createProviderForPlatform(platform as NodeJS.Platform).kind
    )
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('非本机平台的 provider 不会起任何子进程', async () => {
    // 守的是「在 Linux 上误用 win32/darwin provider」这类问题：
    // 实现里都有 platform 守卫，绝不能在本机真的去 spawn powershell.exe / osascript
    const win = createProviderForPlatform('win32')
    const mac = createProviderForPlatform('darwin')

    if (process.platform !== 'win32') {
      await expect(win.list()).resolves.toEqual([])
      await expect(win.pause('Spotify.exe')).resolves.toBeUndefined()
      await expect(win.play('Spotify.exe')).resolves.toBeUndefined()
      await expect(win.dispose()).resolves.toBeUndefined()
    }
    if (process.platform !== 'darwin') {
      await expect(mac.list()).resolves.toEqual([])
      await expect(mac.pause('Spotify')).resolves.toBeUndefined()
      await expect(mac.play('Spotify')).resolves.toBeUndefined()
      await expect(mac.dispose()).resolves.toBeUndefined()
    }
    expect(vi.mocked(spawn)).not.toHaveBeenCalled()
    expect(vi.mocked(execFile)).not.toHaveBeenCalled()
  })
})

describe('createAudioFocusProvider', () => {
  it('跟随 process.platform 选择 provider', () => {
    expect(createAudioFocusProvider().kind).toBe(createProviderForPlatform(process.platform).kind)
  })

  it('未知平台（模拟）返回 none，不抛错', () => {
    // 用 spy 改 process.platform：这是唯一能让 createAudioFocusProvider 走 default 分支的方式
    const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('freebsd')
    try {
      expect(createAudioFocusProvider().kind).toBe(NO_PROVIDER_KIND)
    } finally {
      spy.mockRestore()
    }
  })
})

/**
 * Windows：SMTC provider 的装配层。
 *
 * 把 `process.platform` 伪装成 win32 + 打桩 spawn，就能在没有 Windows 的机器上覆盖
 * 「起什么进程、传什么参数、怎么解析 stdout、退出后怎么退避重启、命令怎么写进 stdin」。
 */
describe('win32 provider（spawn 打桩）', () => {
  let platformSpy: ReturnType<typeof vi.spyOn>
  let children: FakeChild[]

  beforeEach(() => {
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    children = stubSpawn()
  })

  afterEach(() => {
    platformSpy.mockRestore()
    vi.mocked(spawn).mockReset()
  })

  it('第一次 list 起一条 powershell.exe，参数里带 EncodedCommand 的脚本', async () => {
    const provider = createProviderForPlatform('win32')
    await expect(provider.list()).resolves.toEqual([])
    expect(children).toHaveLength(1)

    const call = vi.mocked(spawn).mock.calls[0]
    expect(call[0]).toBe('powershell.exe')
    const args = call[1] as string[]
    // 必须是 Windows PowerShell 5.1 的静默调用方式（不能要求用户装 pwsh）
    expect(args).toContain('-NoProfile')
    expect(args).toContain('-NonInteractive')
    const encodedAt = args.indexOf('-EncodedCommand')
    expect(encodedAt).toBeGreaterThan(0)

    // -EncodedCommand 必须是 base64(UTF-16LE)，否则 PowerShell 解析出乱码
    const script = Buffer.from(args[encodedAt + 1], 'base64').toString('utf16le')
    expect(script).toContain('[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]')
    expect(script).toContain('RequestAsync()')
    expect(script).toContain('System.Runtime.WindowsRuntime')
    // 泛型反射 helper：AsTask 的模板方法靠名字前缀抓，且必须排除两泛型参数的重载
    expect(script).toContain('AsTask')
    expect(script).toContain('MakeGenericMethod')
    expect(script).toContain('GetGenericArguments().Count -eq 1')
    // 控制动词
    expect(script).toContain('TryPauseAsync')
    expect(script).toContain('TryPlayAsync')
    // 快照输出走 UTF-8 字节直写（中文标题不能受控制台代码页影响）
    expect(script).toContain('$stdoutStream.Write')
    expect(script).toContain('$utf8.GetBytes')
    // stdin 协议 + 700ms 节奏 + EOF 自杀（避免父进程没了留下孤儿 powershell）
    expect(script).toContain('Start-Sleep -Milliseconds 700')
    expect(script).toContain("if ($stdinClosed) { break }")

    // 同一拍再调一次：不该重复起进程（常驻子进程的全部意义）
    await provider.list()
    expect(children).toHaveLength(1)
    await provider.dispose()
  })

  it('解析每行 JSON 快照：跳过本应用、容忍半行、未知状态按 Stopped', async () => {
    const provider = createProviderForPlatform('win32')
    await provider.list()
    const child = children[0]

    // 半行 + 完整行：模拟一个 chunk 恰好切在 JSON 中间
    child.stdout.write('[{"id":"Spotify.exe","label":"Song","status":"Pla')
    await flush()
    // 半行还没凑齐，此时不得把残缺内容当成快照
    await expect(provider.list()).resolves.toEqual([])

    child.stdout.write(
      'ying"},{"id":"com.aurora.music","label":"Aurora","status":"Playing"},' +
        // 自家会话的另外两种 AUMID 形态：安装目录里的 exe 路径、带空格的可执行名
        '{"id":"D:/Apps/Aurora Music/Aurora Music.exe","label":"Aurora","status":"Playing"},' +
        '{"id":"vlc.exe","label":"","status":"Changing"}]\n'
    )
    await flush()

    await expect(provider.list()).resolves.toEqual([
      { id: 'Spotify.exe', label: 'Song', status: 'Playing' },
      // 本应用自己必须被过滤掉，否则会自激（自己暂停自己）：上面两条 aurora 会话都不见了
      { id: 'vlc.exe', label: 'vlc.exe', status: 'Stopped' },
    ])

    // 单个对象（ConvertTo-Json 对单元素集合会塌陷成对象）也要能吃
    child.stdout.write('{"id":"Music.UI.exe","label":"Music","status":"Paused"}\n')
    await flush()
    await expect(provider.list()).resolves.toEqual([
      { id: 'Music.UI.exe', label: 'Music', status: 'Paused' },
    ])

    await provider.dispose()
  })

  it('pause/play 写 stdin，且 id 里的换行不得变成第二条命令', async () => {
    const provider = createProviderForPlatform('win32')
    await provider.list()
    const child = children[0]

    await provider.pause('Spotify.exe')
    await flush()
    await provider.play('Spotify.exe')
    await flush()
    // 注入尝试：id 来自 SMTC（外部数据），换行必须被清掉
    await provider.pause('Spotify.exe\r\nplay evil.exe')
    await flush()

    const written = child.written.join('')
    expect(written).toContain('pause Spotify.exe\n')
    expect(written).toContain('play Spotify.exe\n')
    // 只允许出现我们发出的三个换行，注入的那行没有独立成行
    expect(written.split('\n').filter(Boolean)).toHaveLength(3)
    expect(written).not.toContain('\r')
    expect(written).not.toContain('\nplay evil.exe')

    await provider.dispose()
  })

  it('子进程退出后限频重启（退避期内不再拉新进程）', async () => {
    const provider = createProviderForPlatform('win32')
    await provider.list()
    expect(children).toHaveLength(1)

    // 模拟脚本崩溃退出：list 返回空（不能返回过期快照，过期 Playing 会让状态机一直让位）
    children[0].emit('exit', 1, null)
    await expect(provider.list()).resolves.toEqual([])
    expect(children).toHaveLength(1)

    // 退避（首次 1s）过后，下一次轮询自动重启
    await sleep(1100)
    await provider.list()
    expect(children).toHaveLength(2)

    await provider.dispose()
  })

  it('dispose 幂等且会杀掉子进程，之后不再重启', async () => {
    const provider = createProviderForPlatform('win32')
    await provider.list()
    const child = children[0]

    await provider.dispose()
    expect(child.kill).toHaveBeenCalledTimes(1)
    // 重复调用安全
    await expect(provider.dispose()).resolves.toBeUndefined()

    await expect(provider.list()).resolves.toEqual([])
    await expect(provider.pause('Spotify.exe')).resolves.toBeUndefined()
    expect(children).toHaveLength(1)
  })
})

/**
 * macOS：AppleScript provider 的装配层（execFile 打桩）。
 *
 * 能在这里验证的是「调谁、调几次、怎么解析」；真机上各播放器的脚本字典是否支持
 * 这些术语、自动化授权是否放行，属于交付里明确列出的未验证点。
 */
describe('darwin provider（execFile 打桩）', () => {
  let platformSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    stubOsascript()
  })

  afterEach(() => {
    platformSpy.mockRestore()
    vi.mocked(execFile).mockReset()
  })

  it('并发查询全部已知播放器，只保留在运行的那些', async () => {
    const provider = createProviderForPlatform('darwin')
    await expect(provider.list()).resolves.toEqual([
      { id: 'Music', label: 'Music', status: 'Paused' },
      { id: 'Spotify', label: 'Spotify', status: 'Playing' },
      // VLC 脚本编译失败 → 本拍跳过；其余没在运行 → 空输出，跳过
    ])

    // 每个应用一次 osascript 调用；脚本必须先判 is running，否则会启动用户的播放器
    const calls = vi.mocked(execFile).mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(9)
    for (const call of calls) {
      expect(call[0]).toBe('osascript')
      const script = String((call[1] as string[])[1])
      expect(script).toContain('is running')
    }

    await provider.dispose()
  })

  it('编译失败/被拒绝的应用进入冷却，不会每拍都白跑', async () => {
    const provider = createProviderForPlatform('darwin')
    await provider.list()
    const firstRound = vi.mocked(execFile).mock.calls.length

    await provider.list()
    const secondRound = vi.mocked(execFile).mock.calls.length - firstRound
    // VLC 已进冷却：第二轮少一个应用（9 → 8）
    expect(secondRound).toBeLessThan(firstRound)

    await provider.dispose()
  })

  it('pause/play 只对已知应用生效，且命令脚本带 is running 守卫', async () => {
    const provider = createProviderForPlatform('darwin')

    await provider.pause('Spotify')
    const pauseCalls = vi.mocked(execFile).mock.calls.length
    const pauseScript = String((vi.mocked(execFile).mock.calls[0][1] as string[])[1])
    expect(pauseScript).toContain('tell application "Spotify" to pause')
    expect(pauseScript).toContain('is running')

    await provider.play('Music')
    expect(vi.mocked(execFile).mock.calls.length).toBe(pauseCalls + 1)
    const playScript = String(
      (vi.mocked(execFile).mock.calls[pauseCalls][1] as string[])[1]
    )
    expect(playScript).toContain('tell application "Music" to play')

    // 未知 id：绝不把它拼进脚本（id 来自 provider 外部，按不可信输入处理）
    await provider.pause('/tmp/evil.app')
    expect(vi.mocked(execFile).mock.calls.length).toBe(pauseCalls + 1)

    await provider.dispose()
    // dispose 之后不再起进程
    const afterDispose = vi.mocked(execFile).mock.calls.length
    await provider.pause('Spotify')
    await provider.play('Spotify')
    await expect(provider.list()).resolves.toEqual([])
    expect(vi.mocked(execFile).mock.calls.length).toBe(afterDispose)
  })
})
