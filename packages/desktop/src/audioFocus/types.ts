/**
 * 音频焦点（与其他播放器互斥）—— 契约层。
 *
 * 这个功能的用户语义只有两句：
 *   1. 本应用开始播放时，把正在出声的其他播放器暂停掉；
 *   2. 本应用播放期间，别人又出声了，就让位（暂停自己），对方安静后自动续播。
 *
 * 实现被切成三层，各自只认这一层契约：
 *   types.ts      ← 你在这里：外部播放器与 provider 的形状、IPC 通道名
 *   interlock.ts  纯状态机（无 IO、无定时器），「谁该停、谁该起」只由它裁定
 *   service.ts    真正的 IO：轮询 provider、执行裁定结果、和渲染层对账
 *   providers/*   各平台的实现（Linux = MPRIS over D-Bus，Windows = SMTC，macOS = AppleScript）
 *
 * **为什么状态机要与平台通道分离**：互斥的判断（让位优先级、去抖、手动操作覆盖自动操作）
 * 是最容易出 bug 的地方，纯函数化之后可以用假时钟把「一拍之内几个人抢着播」这类
 * 时序问题在单测里穷举，而不必依赖真实的 D-Bus / 媒体会话。
 */

/** 外部播放器的播放状态：与 MPRIS 的 PlaybackStatus 取值一一对应 */
export type ExternalPlaybackStatus = 'Playing' | 'Paused' | 'Stopped'

/**
 * 一个可被我们控制的外部播放器。
 *
 * `id` 必须稳定（Linux 上用 MPRIS 的 bus name，Windows 上用 SMTC 的 SourceAppUserModelId，
 * macOS 上用应用名）——它是状态机记录「哪些是我暂停的、哪些是让我让位的」的唯一键，
 * 一旦每次列举都变，恢复逻辑就会永远找不到人。
 */
export interface ExternalPlayer {
  id: string
  /** 用于日志与「谁抢了播放」的可读名称（不参与任何判断） */
  label: string
  status: ExternalPlaybackStatus
}

/**
 * 平台侧播放器控制通道。
 *
 * 每个 provider 自行决定用什么机制（D-Bus / PowerShell / AppleScript），
 * 上层只依赖「列出现在有哪些播放器、把某个暂停、把某个恢复」这三件事。
 * **不得抛出异常给上层**：实时音频路径上任何一次窗口都没有，失败的结论只能是
 * 「这一拍没控住」，下一拍轮询会再试；异常上抛只会把轮询循环打死。
 */
export interface AudioFocusProvider {
  /** 平台标识，仅用于日志（'linux' | 'win32' | 'darwin'） */
  readonly kind: string
  /**
   * 建议的轮询间隔。各平台成本不同：Linux 走 D-Bus 方法调用很便宜（<100ms），
   * Windows 每次列举要起一次 PowerShell，必须留足间隔，否则会明显吃 CPU。
   */
  readonly pollingIntervalMs: number
  /** 列出现在存在的外部播放器（**不得包含本应用自己**） */
  list(): Promise<ExternalPlayer[]>
  /** 暂停某个播放器：目标已暂停/已退出时静默成功 */
  pause(id: string): Promise<void>
  /** 恢复播放某个播放器：目标已不在或不支持播放时静默失败 */
  play(id: string): Promise<void>
  /** 释放资源（子进程、D-Bus 连接等）；重复调用必须安全 */
  dispose(): Promise<void>
}

/**
 * 渲染层 ↔ 主进程的通道名。
 *
 * 渲染层是唯一知道「本应用此刻是否真的在出声」的地方（Howl / Capacitor 播放引擎都在那边），
 * 主进程只做裁定与执行，所以它是状态的上报方、是命令（media-control 的 pause/resume）的接收方。
 *
 * 注意：这里**不**复用 `mpris:*` 通道——那组通道属于「本应用对外暴露 MPRIS」，
 * 与「本应用去控制别人」是相反方向的能力，混用会让日志失去指向。
 */
export const AUDIO_FOCUS_CHANNELS = {
  /** 渲染层 → 主进程：本应用播放状态变化（send，不等待回执） */
  ours: 'audio-focus:ours',
  /** 渲染层 → 主进程：开关切换（invoke，回执为平台是否支持） */
  enable: 'audio-focus:enable',
} as const

/**
 * `media-control` 通道新增的动作：主进程裁定「让位」时下发。
 *
 * 为什么必须新增 `pause` / `resume` 而不是复用 `toggle-play`：
 * toggle 的语义取决于收到命令那一刻的状态，而主进程下发命令与渲染层执行之间存在
 * 至少一次 IPC 往返；期间用户若手动点了播放条，toggle 会把「暂停」翻成「播放」，
 * 表现为「别人一开始出声，我这边反而从暂停变播放」——这类反向操作在实测里很显眼。
 */
export type AudioFocusMediaControlAction = 'pause' | 'resume'
