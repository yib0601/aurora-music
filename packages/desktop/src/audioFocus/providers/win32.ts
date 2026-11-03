import { spawn, type ChildProcess } from 'node:child_process'
import type { AudioFocusProvider, ExternalPlayer, ExternalPlaybackStatus } from '../types'

/**
 * Windows：系统媒体会话（SMTC = System Media Transport Controls）。
 *
 * ## 为什么是一条常驻 PowerShell，而不是每次列举都起一个
 * SMTC 的入口是 WinRT 的 `GlobalSystemMediaTransportControlsSessionManager.RequestAsync()`，
 * 只能从 .NET/WinRT 侧调用。PowerShell 5.1（`powershell.exe`，**不是** `pwsh`：Windows 自带、
 * 不要求用户另装）可以调，但它没有 await，冷启动 + `Add-Type` 编译要 1~3s。
 * 每次轮询起一个进程的代价（进程创建 + WinRT 封装初始化）远超轮询间隔本身，
 * 所以这里起**一条**长驻子进程：它自己每 700ms 输出一行 JSON 快照，同时从 stdin
 * 接收控制命令。因此 `list()` 只是一次内存读取，不需要再起进程。
 *
 * ## 数据流
 *   provider.list() ──读到的是──> 最近一行快照（子进程推送，700ms 一行）
 *   provider.pause()/play() ──写──> 子进程 stdin：`pause <id>` / `play <id>`
 *   子进程 stdout ──每行──> [{ id, label, status }]（status ∈ Playing/Paused/Stopped）
 *
 * `id` = SMTC 的 `SourceAppUserModelId`（稳定，重启不变）；`label` = 会话标题，取不到则用 id。
 *
 * ## 失败模式（全部吞掉，绝不抛给上层）
 *   - 没有 `powershell.exe`（非 Windows、被禁用、被杀软拦）：spawn 报 error → 退避重试，list 返回 []；
 *   - 没有 SMTC 访问能力（受限能力/系统太老）：脚本里 RequestAsync 失败 → 一直输出 []；
 *   - 脚本卡住/崩溃：看门狗按「启动超时」「快照过期」杀进程，退出后限频重启，
 *     退避指数增长（1s→30s 封顶），避免 crash-loop 把 CPU 打满；
 *   - 子进程活着但一行都没输出：视为不可用，`list()` 返回空数组（不返回过期快照：
 *     过期的 `Playing` 会让状态机一直「让位」给一个其实已安静的播放器）。
 *
 * ## 未验证点（本机是 Linux，无法实测）
 *   见本目录 README 的说明与任务交付里的「未验证点」清单：SMTC 受限能力是否允许
 *   桌面 PowerShell 调用 RequestAsync、PS 5.1 的 AsTask 反射写法、Windows 中文标题的
 *   stdout 编码、`TryPauseAsync` 对各类播放器的实效性，都只在逻辑层验证过。
 */

/** 子进程自身推送快照的节奏，也是 provider 建议的轮询间隔 */
const SNAPSHOT_TICK_MS = 700
/** 首行快照的等待上限：PowerShell 冷启动 + Add-Type 编译慢，给足余量 */
const STARTUP_TIMEOUT_MS = 8000
/** 多久没有新快照就认为脚本卡死（约 2 个 tick 的宽限） */
const SNAPSHOT_STALE_MS = 5000
/** 重启退避：首次 1s，指数增长，封顶 30s */
const RESTART_BASE_DELAY_MS = 1000
const RESTART_MAX_DELAY_MS = 30000
/** 子进程活过这个时长才算「健康」——健康退出的重启不清零退避，崩溃循环才清零增长 */
const HEALTHY_LIFETIME_MS = 10000
/** stdout 里没等到换行的缓冲上限，防止脚本异常时把内存灌满 */
const MAX_LINE_BUFFER = 1024 * 1024
/** 命令行的 id 上限（AUMID 实际上很短，这里只防异常输入） */
const MAX_ID_LENGTH = 512

/**
 * 本应用自己的 SMTC 会话 id 特征。
 *
 * Electron/Chromium 会把正在出声的页面注册成一条 SMTC 会话，`SourceAppUserModelId`
 * 由 AUMID 决定，可能是：
 *   - 打包时声明的 appId（`com.aurora.music`）；
 *   - NSIS 快捷方式的 AUMID / 进程默认值，即可执行文件名（`Aurora-Music.exe`）；
 *   - 用户自定义安装目录下的 exe 路径（可能连品牌分隔符都不是 `-`，例如 `Aurora Music.exe`）。
 * 三种形态都要盖住——漏掉的后果是「我们把自己当成外部播放器」，本应用一起播就被自己按停，
 * 或干脆自激地来回 pause/play。宁可多匹配（误把某个同名应用当自己、少管一个播放器），
 * 也不能漏（自己按停自己，用户完全无法理解）。
 */
const SELF_ID_HINTS = ['aurora-music', 'com.aurora.music', 'auroramusic', 'aurora music', 'aurora']

/**
 * 本进程可执行文件名也作为自身特征（去扩展名、小写）。
 *
 * 比写死品牌名更稳：用户把安装目录/exe 改名（`D:\Apps\MyPlayer\MyPlayer.exe`）时，
 * AUMID 就变成改后的名字，靠 `SELF_ID_HINTS` 会漏——而运行时 `process.execPath`
 * 永远指向真实的自己。
 */
function selfExeHint(): string {
  try {
    const base = process.execPath.split(/[\\/]/).pop() ?? ''
    return base.replace(/\.exe$/i, '').toLowerCase().trim()
  } catch {
    return ''
  }
}

function isWindowsHost(): boolean {
  return process.platform === 'win32'
}

function looksLikeSelf(id: string): boolean {
  const lower = id.toLowerCase()
  if (SELF_ID_HINTS.some((hint) => lower.includes(hint))) return true
  const exeHint = selfExeHint()
  return exeHint.length > 2 && lower.includes(exeHint)
}

/** SMTC 的播放状态归一：只认三态，其余（Closed/Opened/Changing/未知）算「没在出声」 */
function normalizeStatus(raw: unknown): ExternalPlaybackStatus {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (text === 'playing') return 'Playing'
  if (text === 'paused') return 'Paused'
  // Closed / Opened / Changing / 缺字段：不是「在出声」。*不能*映射成 Paused——
  // 状态机会把 Paused 的播放器当成「我们暂停的、稍后要还回去」，凭空按播放别人的播放器
  // 比「少管一个」糟得多。
  return 'Stopped'
}

/**
 * 内联 PowerShell 脚本（Windows PowerShell 5.1 语法）。
 *
 * 约定：**每行一条 JSON**，永远不输出半行；任何异常都转成 `[]`。
 * stdin 逐行读 `pause <id>` / `play <id>`；stdin EOF（父进程没了）立即退出，避免孤儿进程。
 */
function buildPowerShellScript(): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    // stdout 直接写 UTF-8 字节，不依赖 [Console]::OutputEncoding：
    // 后者在重定向场景下 setter 可能抛错，而且默认代码页会把中文标题变成乱码。
    '$stdoutStream = [Console]::OpenStandardOutput()',
    '$utf8 = New-Object System.Text.UTF8Encoding $false',
    '',
    '# ---- WinRT projection + AsTask generic reflection helper ----',
    '# Windows PowerShell 5.1 has no await: an IAsyncOperation<T> must first be converted',
    '# to Task<T> via System.WindowsRuntimeSystemExtensions.AsTask<T>() and then awaited synchronously.',
    '# AsTask is generic, so the concrete overload has to be reflected out of the operation type.',
    '$asTaskGeneric = $null',
    '$mediaPropsType = $null',
    '$boolType = [System.Boolean]',
    'try {',
    '  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null',
    '  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null',
    '  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {',
    "    $_.Name -eq 'AsTask' -and",
    '    $_.GetParameters().Count -eq 1 -and',
    "    $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation') -and",
    // 必须排除 AsTask(IAsyncOperationWithProgress<TResult, TProgress>)：它的参数类型名
    // 同样以 IAsyncOperation 开头但是两泛型参数，选中它会让 MakeGenericMethod 直接抛错
    '    $_.GetParameters()[0].ParameterType.GetGenericArguments().Count -eq 1',
    '  } | Select-Object -First 1)',
    '  try {',
    '    $mediaPropsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]',
    '  } catch { $mediaPropsType = $null }',
    '} catch { $asTaskGeneric = $null }',
    '',
    'function Await-WinRt($operation, $resultType) {',
    "  if ($null -eq $operation -or $null -eq $asTaskGeneric) { throw 'winrt-unavailable' }",
    '  $method = $asTaskGeneric.MakeGenericMethod($resultType)',
    '  $task = $method.Invoke($null, @($operation))',
    "  if (-not $task.Wait(4000)) { throw 'winrt-timeout' }",
    '  return $task.Result',
    '}',
    '',
    '# ---- Acquire the session manager; on failure keep emitting [] and let the caller degrade ----',
    '$manager = $null',
    '$managerRetry = 0',
    'if ($null -ne $asTaskGeneric) {',
    '  try {',
    '    $request = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()',
    '    $manager = Await-WinRt $request ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])',
    '  } catch { $manager = $null }',
    '}',
    '',
    'function Write-Snapshot($items) {',
    "  $json = '[]'",
    '  try {',
    '    if ($null -ne $items -and $items.Count -gt 0) {',
    '      $json = ConvertTo-Json -InputObject $items -Compress -Depth 4',
    "      if ([string]::IsNullOrWhiteSpace($json)) { $json = '[]' }",
    '    }',
    "  } catch { $json = '[]' }",
    '  try {',
    '    $bytes = $utf8.GetBytes(($json + [char]10))',
    '    $stdoutStream.Write($bytes, 0, $bytes.Length)',
    '    $stdoutStream.Flush()',
    '  } catch { }',
    '}',
    '',
    'function Invoke-PlayerCommand([string]$line) {',
    '  try {',
    "    $space = $line.IndexOf(' ')",
    '    if ($space -lt 1) { return }',
    '    $verb = $line.Substring(0, $space).ToLowerInvariant()',
    '    $id = $line.Substring($space + 1).Trim()',
    '    if ($id.Length -eq 0 -or $null -eq $manager) { return }',
    '    $target = $null',
    '    try {',
    '      foreach ($s in $manager.GetSessions()) {',
    '        if ($null -ne $s -and $s.SourceAppUserModelId -eq $id) { $target = $s; break }',
    '      }',
    '    } catch { return }',
    '    if ($null -eq $target) { return }',
    "    if ($verb -eq 'pause') {",
    '      [void](Await-WinRt $target.TryPauseAsync() $boolType)',
    "    } elseif ($verb -eq 'play') {",
    '      [void](Await-WinRt $target.TryPlayAsync() $boolType)',
    '    }',
    '  } catch { }',
    '}',
    '',
    '# ---- Non-blocking stdin: poll ReadLineAsync + IsCompleted, never stall the snapshot loop ----',
    '# stdin is a redirected pipe (not a console), so the .NET side uses streaming async reads.',
    '$stdinReader = $null',
    'try { $stdinReader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8) } catch { $stdinReader = $null }',
    '$readTask = $null',
    '# Without stdin there is no control channel: emit one [] then exit cleanly instead of waiting to be killed',
    '$stdinClosed = ($null -eq $stdinReader)',
    '',
    'while ($true) {',
    '  if (-not $stdinClosed) {',
    '    try {',
    '      if ($null -eq $readTask) { $readTask = $stdinReader.ReadLineAsync() }',
    '      if ($null -ne $readTask -and $readTask.IsCompleted) {',
    '        $line = $null',
    '        try { $line = $readTask.Result } catch { $line = $null }',
    '        $readTask = $null',
    '        if ($null -eq $line) { $stdinClosed = $true }',
    '        elseif ($line.Trim().Length -gt 0) { Invoke-PlayerCommand ($line.Trim()) }',
    '      }',
    '    } catch { $stdinClosed = $true }',
    '  }',
    '',
    '  # A one-shot manager at startup is too brittle: the SMTC service may not be ready during',
    '  # early login and a single miss leaves us blind for the whole session. Retry about every 14s.',
    '  if ($null -eq $manager -and $null -ne $asTaskGeneric) {',
    '    $managerRetry = $managerRetry + 1',
    '    if (($managerRetry % 20) -eq 0) {',
    '      try {',
    '        $request = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()',
    '        $manager = Await-WinRt $request ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])',
    '      } catch { $manager = $null }',
    '    }',
    '  }',
    '',
    '  $out = New-Object System.Collections.ArrayList',
    '  if ($null -ne $manager) {',
    '    try {',
    '      foreach ($s in $manager.GetSessions()) {',
    '        try {',
    '          if ($null -eq $s) { continue }',
    '          $sid = $s.SourceAppUserModelId',
    '          if ([string]::IsNullOrWhiteSpace($sid)) { continue }',
    "          $status = 'Stopped'",
    '          try {',
    '            $playback = $s.GetPlaybackInfo()',
    '            if ($null -ne $playback) {',
    '              $raw = [string]$playback.PlaybackStatus',
    "              if ($raw -eq 'Playing') { $status = 'Playing' }",
    "              elseif ($raw -eq 'Paused') { $status = 'Paused' }",
    "              else { $status = 'Stopped' }",
    '            }',
    '          } catch { }',
    '          $label = [string]$sid',
    '          if ($null -ne $mediaPropsType) {',
    '            try {',
    '              $props = Await-WinRt $s.TryGetMediaPropertiesAsync() $mediaPropsType',
    '              if ($null -ne $props -and -not [string]::IsNullOrWhiteSpace($props.Title)) { $label = [string]$props.Title }',
    '            } catch { }',
    '          }',
    '          $entry = New-Object psobject -Property @{ id = [string]$sid; label = $label; status = $status }',
    '          [void]$out.Add($entry)',
    '        } catch { }',
    '      }',
    '    } catch { }',
    '  }',
    '',
    '  Write-Snapshot $out',
    '  if ($stdinClosed) { break }',
    '  Start-Sleep -Milliseconds 700',
    '}',
  ].join('\n')
}

/**
 * `-EncodedCommand` 要求 base64(UTF-16LE)：PowerShell 用 UTF-16 解析命令行参数，
 * 直接把带中文注释的脚本塞进 argv 会在 cmd/ConPTY 转换时丢字符。
 */
function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * 解析子进程输出的一行 JSON。
 * 兼容三种形态：数组（正常）、单个对象（ConvertTo-Json 对单元素集合有时会塌陷）、
 * 空/非法行（返回 null，调用方据此不刷新快照）。
 */
function parseSnapshotLine(line: string): ExternalPlayer[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (parsed === null || parsed === undefined) return null
  const rawItems = Array.isArray(parsed) ? parsed : [parsed]
  const players: ExternalPlayer[] = []
  const seen = new Set<string>()
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (!id || seen.has(id) || looksLikeSelf(id)) continue
    const rawLabel = typeof record.label === 'string' ? record.label.trim() : ''
    players.push({
      // id 必须原样返回（状态机靠它认人），label 仅用于日志
      id,
      label: rawLabel || id,
      status: normalizeStatus(record.status),
    })
    seen.add(id)
  }
  return players
}

/** 清理要写进子进程 stdin 的 id：换行会破坏「一行一条命令」的协议 */
function sanitizeId(id: string): string {
  return id.replace(/[\r\n]/g, ' ').trim().slice(0, MAX_ID_LENGTH)
}

class Win32AudioFocusProvider implements AudioFocusProvider {
  readonly kind = 'win32'
  /**
   * 子进程自己 700ms 推一次快照，`list()` 只是读缓存；保持同频，
   * 让上层拿到的状态延迟不超过一拍（service 会按 max(300, 本值) 轮询）。
   */
  readonly pollingIntervalMs = SNAPSHOT_TICK_MS

  private child: ChildProcess | null = null
  private snapshot: ExternalPlayer[] = []
  /** 最近一次成功解析快照的时间；0 表示本次启动还没收到过 */
  private snapshotAt = 0
  private childStartedAt = 0
  private lineBuffer = ''
  /** 连续失败次数（用于指数退避）；健康退出的下一轮会清零 */
  private failures = 0
  private nextStartAt = 0
  private disposed = false
  private timers = new Set<ReturnType<typeof setTimeout>>()

  async list(): Promise<ExternalPlayer[]> {
    // 非 Windows 直接空列表：正常路径上根本不会构造这个 provider（见 index.ts），
    // 这里兜住「测试/误用」场景，绝不能在本机真的去 spawn powershell.exe
    if (this.disposed || !isWindowsHost()) return []
    this.ensureChild()
    this.watchdog()
    if (this.snapshotAt === 0) return []
    // 快照过期就给空列表而不是旧值：过期的 Playing 会让状态机一直「让位」给一个
    // 其实已经安静的播放器，表现为本应用再也不续播
    if (Date.now() - this.snapshotAt > SNAPSHOT_STALE_MS) return []
    // 拷贝一份：上层会把数组存进状态机快照，别让后续更新从背后改掉它的内容
    return this.snapshot.slice()
  }

  async pause(id: string): Promise<void> {
    this.sendCommand('pause', id)
  }

  async play(id: string): Promise<void> {
    this.sendCommand('play', id)
  }

  async dispose(): Promise<void> {
    // 幂等：service 退出时会调一次，异常路径可能再调一次
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    const child = this.child
    this.child = null
    this.snapshot = []
    this.snapshotAt = 0
    this.lineBuffer = ''
    if (!child) return
    try {
      child.stdin?.end()
    } catch {
      /* 管道已关，忽略 */
    }
    try {
      child.kill()
    } catch {
      /* 已经退出，忽略 */
    }
    // 给子进程一点时间自己退出；超时也不无限等（Electron 退出路径不能被拖住）
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      try {
        child.once('exit', finish)
        child.once('error', finish)
      } catch {
        finish()
        return
      }
      this.after(500, finish)
    })
  }

  /** 起子进程前的一切门槛：已退出 / 已有 / 还在退避窗口 都不起 */
  private ensureChild(): void {
    if (this.disposed || this.child) return
    const now = Date.now()
    if (now < this.nextStartAt) return
    this.spawnChild(now)
  }

  private spawnChild(now: number): void {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      // 组策略把执行策略设成 AllSigned 时 -EncodedCommand 也可能被拦，显式 Bypass 更稳
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShellCommand(buildPowerShellScript()),
    ]

    let child: ChildProcess
    try {
      child = spawn('powershell.exe', args, {
        // 不要弹黑框（Electron 无控制台，隐藏窗口否则会闪一个 conhost）
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    } catch {
      // spawn 同步抛错（极少见）：当作一次失败，走退避
      this.registerFailure(0)
      return
    }

    this.child = child
    this.childStartedAt = now
    this.lineBuffer = ''

    try {
      child.stdout?.setEncoding('utf8')
      // 带上身份判断：旧进程被杀后仍可能吐出最后一两行，不能让它们覆盖新进程的快照
      child.stdout?.on('data', (chunk: string) => {
        if (this.child === child) this.onStdout(chunk)
      })
    } catch {
      /* 拿不到 stdout：等下看门狗杀它 */
    }
    // stdin 在子进程死后写会 EPIPE；不挂监听会变成未捕获的 'error' 事件打死进程
    try {
      child.stdin?.on('error', () => {})
    } catch {
      /* 忽略 */
    }
    child.on('error', () => this.handleChildDown(child))
    child.on('exit', () => this.handleChildDown(child))
  }

  private onStdout(chunk: string): void {
    this.lineBuffer += chunk
    let newlineAt = this.lineBuffer.indexOf('\n')
    while (newlineAt >= 0) {
      const line = this.lineBuffer.slice(0, newlineAt).trim()
      this.lineBuffer = this.lineBuffer.slice(newlineAt + 1)
      if (line) this.consumeLine(line)
      newlineAt = this.lineBuffer.indexOf('\n')
    }
    // 没有换行的超长输出：脚本异常时的防呆，直接丢弃而不是无限增长
    if (this.lineBuffer.length > MAX_LINE_BUFFER) this.lineBuffer = ''
  }

  private consumeLine(line: string): void {
    const players = parseSnapshotLine(line)
    if (players === null) return
    this.snapshot = players
    this.snapshotAt = Date.now()
  }

  private watchdog(): void {
    const child = this.child
    if (!child) return
    const now = Date.now()
    if (this.snapshotAt >= this.childStartedAt) {
      // 收到过输出：长时间不刷新说明脚本卡在某个 WinRT 调用上
      if (now - this.snapshotAt > SNAPSHOT_STALE_MS) this.killChild(child)
      return
    }
    // 还没收到任何输出：PowerShell 冷启动慢，但也不能无限等
    if (now - this.childStartedAt > STARTUP_TIMEOUT_MS) this.killChild(child)
  }

  private killChild(child: ChildProcess): void {
    if (this.child !== child) return
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
    // Windows 上 kill 偶尔不落地、也不一定有 exit 事件；兜底一秒后强制认定它已死，
    // 否则「有 child 就不重启」会让功能永久停摆
    this.after(1000, () => {
      if (this.child === child) this.handleChildDown(child)
    })
  }

  /** 子进程退出（或确信已死）后的统一处理：清快照、算退避、等下次 list 重启 */
  private handleChildDown(child: ChildProcess): void {
    if (this.child !== child) return
    this.child = null
    const lifetime = Date.now() - this.childStartedAt
    this.lineBuffer = ''
    this.snapshot = []
    this.snapshotAt = 0
    this.registerFailure(lifetime)
  }

  private registerFailure(lifetimeMs: number): void {
    if (this.disposed) return
    if (lifetimeMs >= HEALTHY_LIFETIME_MS) {
      // 活够久才崩：不认为是在 crash-loop，退避从头算
      this.failures = 0
    }
    this.failures = Math.min(this.failures + 1, 8)
    const delay = Math.min(
      RESTART_MAX_DELAY_MS,
      RESTART_BASE_DELAY_MS * Math.pow(2, Math.max(0, this.failures - 1))
    )
    this.nextStartAt = Date.now() + delay
  }

  private sendCommand(verb: 'pause' | 'play', id: string): void {
    if (this.disposed || !isWindowsHost()) return
    const safeId = sanitizeId(id)
    if (!safeId) return
    // 命令要发的人一定在最近快照里；子进程若刚好挂了，这一拍就是「没控住」，
    // 下一次轮询会重启子进程并由状态机重试（契约允许静默失败）
    this.ensureChild()
    const child = this.child
    if (!child || !child.stdin || child.stdin.destroyed) return
    try {
      child.stdin.write(`${verb} ${safeId}\n`)
    } catch {
      /* 管道已断：等下一拍 */
    }
  }

  /** 记录定时器，dispose 时统一清掉（否则退出路径会多挂 1s 的定时器） */
  private after(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    this.timers.add(timer)
  }
}

/** 构造 win32 provider（无副作用：子进程推迟到第一次 list/pause/play） */
export function createWin32Provider(): AudioFocusProvider {
  return new Win32AudioFocusProvider()
}
