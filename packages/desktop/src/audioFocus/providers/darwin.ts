import { execFile } from 'node:child_process'
import type { AudioFocusProvider, ExternalPlayer, ExternalPlaybackStatus } from '../types'

/**
 * macOS：AppleScript（osascript）。
 *
 * macOS 没有 SMTC/MPRIS 那种「系统级媒体会话」查询接口（现在媒体键走 MediaRemote 私有框架，
 * 不做私有 API 依赖），能稳定跨播放器用的只有 AppleScript：每个播放器自己暴露脚本字典，
 * 我们用 `osascript` 问它的播放状态、给它发 pause/play。
 *
 * ## 关键设计取舍
 * 1. **只问「已知可脚本化」的应用，且先判断 `is running`**：`tell application "X" to ...`
 *    对未运行的应用会**把它启动起来**——为了查状态而弹起用户的播放器是不可接受的行为，
 *    所以脚本第一句必须是 `if application "X" is running then`。
 * 2. **id 就是应用名**：AppleScript 里应用名是稳定标识（重启/升级不变），
 *    满足契约「id 必须稳定」的要求。
 * 3. **宁可漏，不可猜**：脚本字典里没有 `player state` 的应用（VLC/QuickTime Player 只有
 *    `playing` 布尔）单独分组；两者都没有的应用会在编译期就失败（osascript 退出码非 0），
 *    我们把这种应用列入「不支持」并**冷却 60s** 再试，避免每拍都起 9 个进程做无用功。
 *    AppleScript 是编译期解析术语的：字典里没有的词不是运行时错误，而是编译错误，
 *    所以「静默跳过」必须靠进程退出码判断，不能靠 try/catch。
 * 4. **单次调用 800ms 超时后 SIGKILL**：某个播放器卡住（例如正在弹「是否允许自动化」的
 *    授权框）不能把整轮列举拖死，更不能让 osascript 进程堆积。
 *
 * ## 未验证点（本机是 Linux，无法实测）
 *   - 各播放器脚本字典里到底有没有 `player state` / `pause` / `play`（尤其 VOX / Doppler /
 *     foobar2000 / IINA，属于按公开文档推断，未在真机核对）；
 *   - macOS 13+ 的「自动化」TCC 授权：首次控制某个播放器会弹系统授权框，用户拒绝后
 *     每次调用都会失败（本实现表现为该播放器在列表里消失，功能静默降级）；
 *   - App Store 沙盒版本是否允许 osascript 驱动其他应用（未验证）。
 */

/** 单次 osascript 调用的硬超时 */
const CALL_TIMEOUT_MS = 800
/** 应用级轮询间隔：9 个并发 osascript 已经不算便宜，1.5s 是实测感受与开销的折中 */
const POLLING_INTERVAL_MS = 1500
/** 「不支持/被拒绝」的应用冷却多久再试（播放器装了新版可能就支持了） */
const UNSUPPORTED_COOLDOWN_MS = 60_000

/** 状态查询方式：标准 `player state` 枚举，还是只有 `playing` 布尔属性 */
type StateKind = 'player-state' | 'playing'

interface ScriptablePlayer {
  /** 稳定 id = AppleScript 应用名 */
  name: string
  stateKind: StateKind
  pauseCommand: string
  playCommand: string
}

/**
 * 已知可脚本化、且值得管的播放器。
 *
 * 顺序无意义；同一应用只允许出现一次（id 重复会让状态机把同一个人当成两个人）。
 *
 * **本应用不会出现在列表里**：Aurora 是 Electron 应用，没有暴露 AppleScript 播放器字典，
 * 而这里又是白名单式枚举——不认识的 app 一律不问。所以既不会「自己暂停自己」，
 * 也不会因为某个播放器恰好在跑就顺手控制它。
 */
const SCRIPTABLE_PLAYERS: ScriptablePlayer[] = [
  // iTunes 系字典：player state ∈ playing/paused/stopped，pause/play 命令齐全
  { name: 'Music', stateKind: 'player-state', pauseCommand: 'pause', playCommand: 'play' },
  { name: 'Spotify', stateKind: 'player-state', pauseCommand: 'pause', playCommand: 'play' },
  { name: 'Swinsian', stateKind: 'player-state', pauseCommand: 'pause', playCommand: 'play' },
  // 这几家按公开文档只有 playing 布尔，没有 player state
  { name: 'VLC', stateKind: 'playing', pauseCommand: 'pause', playCommand: 'play' },
  { name: 'QuickTime Player', stateKind: 'playing', pauseCommand: 'pause', playCommand: 'play' },
  { name: 'IINA', stateKind: 'playing', pauseCommand: 'pause', playCommand: 'play' },
  // 以下按各自 AppleScript 支持推断为 player state 系（未在真机核对，见文件头「未验证点」）
  { name: 'VOX', stateKind: 'player-state', pauseCommand: 'pause', playCommand: 'play' },
  { name: 'Doppler', stateKind: 'player-state', pauseCommand: 'pause', playCommand: 'play' },
  { name: 'foobar2000', stateKind: 'player-state', pauseCommand: 'pause', playCommand: 'play' },
]

/** AppleScript 字符串字面量转义（应用名目前是常量，仍按输入不可信处理） */
function asAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function isDarwinHost(): boolean {
  return process.platform === 'darwin'
}

/**
 * 生成「查某个应用播放状态」的脚本。
 *
 * 返回的文本只取 playing/paused/stopped 三个英文词：AppleScript 枚举 `as text` 在
 * 本地化系统上可能返回本地化名字（中文系统上会变成「播放中」之类），所以脚本里显式
 * 比较枚举值再映射成固定英文，避免解析依赖系统语言。
 */
function buildStateScript(player: ScriptablePlayer): string {
  const name = asAppleScriptString(player.name)
  const mapping =
    player.stateKind === 'player-state'
      ? [
          'if player state is playing then',
          '  set st to "playing"',
          'else if player state is paused then',
          '  set st to "paused"',
          'else',
          '  set st to "stopped"',
          'end if',
        ]
      : [
          'if playing then',
          '  set st to "playing"',
          'else',
          '  set st to "paused"',
          'end if',
        ]
  return [
    'set st to ""',
    'try',
    // 必须先判 is running：直接 tell 一个没运行的应用会把它启动起来
    `  if application ${name} is running then`,
    `    tell application ${name}`,
    ...mapping.map((line) => `      ${line}`),
    '    end tell',
    '  end if',
    'end try',
    'return st',
  ].join('\n')
}

/** 生成控制脚本（pause/play）；同样带 is running 判断，绝不把别人的播放器拉起来 */
function buildCommandScript(name: string, command: string): string {
  const target = asAppleScriptString(name)
  return [
    'try',
    `  if application ${target} is running then`,
    `    tell application ${target} to ${command}`,
    '  end if',
    'end try',
  ].join('\n')
}

function parseState(text: string): ExternalPlaybackStatus | null {
  const value = text.trim().toLowerCase()
  if (!value) return null
  if (value.startsWith('playing')) return 'Playing'
  if (value.startsWith('paused')) return 'Paused'
  if (value.startsWith('stopped')) return 'Stopped'
  // 认不出来的输出（播放器自定义格式）：当作没查到，不猜——
  // 猜错方向的代价是「把别人的播放器按停」或「以为别人在放而让位」
  return null
}

interface ScriptResult {
  /** 脚本是否成功执行（编译失败/权限被拒/超时 都是 false） */
  ok: boolean
  /** 成功时的 stdout（未运行的应用返回空串） */
  output: string
}

/**
 * 跑一段 AppleScript。
 *
 * 超时由 `execFile` 的 timeout + SIGKILL 兜住；回调里任何错误都收敛成 `ok: false`，
 * 永不 reject（契约要求 provider 不向上抛错）。
 */
function runAppleScript(script: string): Promise<ScriptResult> {
  return new Promise<ScriptResult>((resolve) => {
    let settled = false
    const finish = (result: ScriptResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      execFile(
        'osascript',
        ['-e', script],
        {
          timeout: CALL_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          maxBuffer: 64 * 1024,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            finish({ ok: false, output: '' })
            return
          }
          finish({ ok: true, output: typeof stdout === 'string' ? stdout : String(stdout ?? '') })
        }
      )
    } catch {
      finish({ ok: false, output: '' })
    }
  })
}

/**
 * 用缓存里的上次状态构造一个「仍在列表里」的条目。
 * 没有任何历史（第一次就探不到）时返回 null：那时它确实还没被我们观测到过。
 */
function cachedPlayer(
  lastKnown: Map<string, ExternalPlayer['status']>,
  name: string
): ExternalPlayer | null {
  const status = lastKnown.get(name)
  return status === undefined ? null : { id: name, label: name, status }
}

class DarwinAudioFocusProvider implements AudioFocusProvider {
  readonly kind = 'darwin'
  readonly pollingIntervalMs = POLLING_INTERVAL_MS

  /** 编译失败/权限被拒的应用 → 冷却到什么时候（ms 时间戳） */
  private unsupportedUntil = new Map<string, number>()
  /**
   * 每个应用最近一次探到的状态。
   *
   * 用途：探不到（超时 / TCC 弹窗未答 / 冷却期）时不能让它从列表里消失——
   * 上层把「从列表消失」当成「对方安静了」，于是会误判续播，双方同时出声。
   * 拿不准时沿用上次结论，宁可让状态晚一拍更新，也不要把「未知」当成「安静」。
   */
  private lastKnown = new Map<string, ExternalPlayer['status']>()
  private disposed = false

  async list(): Promise<ExternalPlayer[]> {
    if (this.disposed || !isDarwinHost()) return []
    const now = Date.now()
    // 并发问：串行 9 个应用最坏 7.2s，远超轮询间隔
    const results = await Promise.all(
      SCRIPTABLE_PLAYERS.map(async (player) => {
        const cooldown = this.unsupportedUntil.get(player.name) ?? 0
        if (now < cooldown) return cachedPlayer(this.lastKnown, player.name)
        return this.probe(player)
      })
    )
    const players: ExternalPlayer[] = []
    for (const item of results) {
      if (item) players.push(item)
    }
    return players
  }

  async pause(id: string): Promise<void> {
    await this.sendCommand(id, 'pauseCommand')
  }

  async play(id: string): Promise<void> {
    await this.sendCommand(id, 'playCommand')
  }

  async dispose(): Promise<void> {
    // 没有常驻子进程可杀（每次查询都是一次性短命进程，且有超时兜底）；
    // 只标记关闭，让之后迟到的调用不再起进程。重复调用安全。
    this.disposed = true
    this.unsupportedUntil.clear()
  }

  private async probe(player: ScriptablePlayer): Promise<ExternalPlayer | null> {
    const result = await runAppleScript(buildStateScript(player))
    if (!result.ok) {
      // 编译失败（字典里没这些术语）、自动化权限被拒、或 800ms 没答复：
      // 一律冷却后再试——否则一个卡住的播放器会让每一拍都白付一次超时。
      // 但**不能**因此让它从列表里消失（见 lastKnown 的说明）。
      this.markUnsupported(player.name)
      return cachedPlayer(this.lastKnown, player.name)
    }
    // 成功但空输出 = 应用没在运行：正常状态，不算不支持
    const status = parseState(result.output)
    if (status === null) {
      // 应用确实没在运行：清掉缓存，之后按「不在列表」处理
      this.lastKnown.delete(player.name)
      return null
    }
    this.unsupportedUntil.delete(player.name)
    this.lastKnown.set(player.name, status)
    return { id: player.name, label: player.name, status }
  }

  /** pause/play 只接受已知应用名，避免把任意字符串拼进脚本 */
  private async sendCommand(id: string, key: 'pauseCommand' | 'playCommand'): Promise<void> {
    if (this.disposed || !isDarwinHost()) return
    const player = SCRIPTABLE_PLAYERS.find((item) => item.name === id)
    if (!player) return
    const result = await runAppleScript(buildCommandScript(player.name, player[key]))
    if (!result.ok) this.markUnsupported(player.name)
  }

  private markUnsupported(name: string): void {
    this.unsupportedUntil.set(name, Date.now() + UNSUPPORTED_COOLDOWN_MS)
  }
}

/** 构造 darwin provider（无副作用：osascript 只在 list/pause/play 时起） */
export function createDarwinProvider(): AudioFocusProvider {
  return new DarwinAudioFocusProvider()
}
