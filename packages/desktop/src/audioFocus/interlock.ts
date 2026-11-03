import type { ExternalPlayer, ExternalPlaybackStatus } from './types'

/**
 * 互斥仲裁结果。状态机只**描述**要发生什么，不执行任何 IO：
 * 主进程的 service 拿到这份结果后再去调 provider / 给渲染层发命令。
 * 这样「谁让谁」的全部规则都可以用假时钟在单测里穷举，不必起 D-Bus。
 */
export interface InterlockEffects {
  /** 需要暂停的外部播放器 id（本应用开始播放时抢占） */
  pauseExternals: string[]
  /** 需要恢复的外部播放器 id（本应用停止后归还） */
  resumeExternals: string[]
  /** 需要暂停本应用（有别人在出声，让位） */
  pauseOurs: boolean
  /** 需要恢复本应用（让位对象安静了，续播） */
  resumeOurs: boolean
  /** 请求上层安排一次「延迟恢复外部播放器」（去抖：切歌瞬间的假暂停不该归还） */
  scheduleResumeExternals: boolean
  /** 请求上层安排一次「延迟恢复本应用」（等对方安静稳定一下再起，避免和对方抢） */
  scheduleResumeOurs: boolean
}

/** 状态机对外可见的状态快照（只用于日志与单测断言，不要基于它做业务判断） */
export interface InterlockState {
  oursPlaying: boolean
  /** 被本应用暂停、等待归还的外部播放器 */
  pausedByUs: string[]
  /** 导致本应用让位的外部播放器（它们全部安静后本应用才续播） */
  yieldedTo: string[]
  resumeExternalsPending: boolean
  resumeOursPending: boolean
}

const EMPTY: InterlockEffects = {
  pauseExternals: [],
  resumeExternals: [],
  pauseOurs: false,
  resumeOurs: false,
  scheduleResumeExternals: false,
  scheduleResumeOurs: false,
}

function makeEffects(patch: Partial<InterlockEffects>): InterlockEffects {
  return { ...EMPTY, ...patch }
}

/**
 * 互斥仲裁状态机（纯逻辑，无定时器）。
 *
 * ## 规则（按优先级）
 * 1. **用户手动播放 > 自动让位**：本应用从「没在播」变成「在播」时，一律清空让位标记，
 *    并把当时正在出声的播放器全部暂停。用户点了播放就是明确意图，不能被上一轮让位状态否掉。
 * 2. **本应用在播期间，外部播放器出声 → 本应用让位**（暂停自己），并记住是谁抢的。
 *    只认两种「抢」：a) 从没被我们暂停过的新播放器；b) 我们暂停过、**确认停过**、
 *    之后又被恢复的（用户手动恢复）。「我们发了 Pause 但对方始终没停」不算抢——
 *    那种情况多半是控制通道失效，若据此让位，本应用会变成「一有别人出声就把自己按停」，
 *    比两个声音重叠更糟。这类只按 pauseRetryMs 节流重试暂停，绝不让位。
 * 3. **让位对象全部安静 → 本应用自动续播**。对象退出（从列表消失）也算安静，
 *    否则「对方被关掉了，我却永远停在暂停」是很容易验收失败的一类 bug。
 * 4. **本应用停止 → 归还被我们暂停的播放器**，且只归还仍然处于 Paused 的那些：
 *    用户若手动停掉了某个播放器，我们不该替他按播放。
 * 5. 让位状态下**不归还**其他播放器：我们此刻是被动方，再点起第三个人只会让场面更乱。
 * 6. **「播放中才打开开关」**（service 传 adoptPlayingNow）：此刻正在出声的人先于我们存在，
 *    按抢占处理（见 onSnapshot 的参数说明），不算「打断我们」。
 *
 * ## 为什么需要「延迟」而不是立即执行
 * - 切歌/连续播放时，播放引擎会有一次短暂的暂停再起；若一暂停就归还别人的播放器，
 *   对方会在两首歌之间被我们反复按暂停/播放，听感上是抖动。
 * - 让位后对方只是切歌（短暂 Paused→Playing）时，立刻续播自己会和对方撞在一起。
 * 延迟的实际时长由 service 决定（它才是持有时钟的一方），状态机只发「请安排」的意图。
 */
export class AudioFocusInterlock {
  private oursPlaying = false
  private players: ExternalPlayer[] = []
  private pausedByUs = new Set<string>()
  /** 被我们暂停、且**观察到真的停了**的播放器（见 onSnapshot 里的说明） */
  private confirmedPaused = new Set<string>()
  private yieldedTo = new Set<string>()
  private resumeExternalsPending = false
  private resumeOursPending = false
  /** 我们自己发出暂停的时刻：暂停不是瞬间生效的，轮询回来的旧状态要有一段豁免期 */
  private pausedAt = new Map<string, number>()
  /** 上次重试暂停的时刻（按 id）：控制通道失效时定期再试，但不许因此让位 */
  private retryAt = new Map<string, number>()
  private readonly now: () => number
  private readonly pauseGraceMs: number
  private readonly pauseRetryMs: number

  constructor(options: { now?: () => number; pauseGraceMs?: number; pauseRetryMs?: number } = {}) {
    this.now = options.now ?? (() => Date.now())
    this.pauseGraceMs = options.pauseGraceMs ?? 2000
    this.pauseRetryMs = options.pauseRetryMs ?? 10_000
  }

  /** 渲染层上报本应用播放状态（重复上报同一值必须无副作用） */
  onOursPlaying(playing: boolean): InterlockEffects {
    if (playing === this.oursPlaying) return makeEffects({})

    this.oursPlaying = playing
    // 任何一侧已重新出声，之前排队的「续播自己」就过期了
    this.resumeOursPending = false

    if (playing) {
      this.resumeExternalsPending = false
      // 规则 1：用户主动播放优先，上一轮让位标记作废
      this.yieldedTo.clear()
      const playingIds = this.playingIds()
      if (playingIds.length === 0) return makeEffects({})
      for (const id of playingIds) {
        this.pausedByUs.add(id)
        // 新一轮抢占：上一轮「确认停过」的结论作废
        this.confirmedPaused.delete(id)
      }
      // 乐观改写内部快照：不等下一次轮询。暂停在途的那一拍里，同一批人可能仍报 Playing，
      // 不标记就会被后续的「重试/让位」逻辑当成一次新的外部播放。
      this.markStatus(playingIds, 'Paused')
      return makeEffects({ pauseExternals: playingIds })
    }

    // 规则 4/5：只有「没在让位」且「确实有被我暂停的人」才安排归还
    if (this.yieldedTo.size === 0 && this.pausedByUs.size > 0) {
      this.resumeExternalsPending = true
      return makeEffects({ scheduleResumeExternals: true })
    }
    return makeEffects({})
  }

  /**
   * 轮询到外部播放器快照（顺序无关，只认 id/status）。
   *
   * `adoptPlayingNow` 用于「本应用已经在播放时用户才打开开关」：那一刻还没拿到过任何快照，
   * 现在正在出声的人其实是**先于我们**存在的，应当被抢占，而不是被当成「打断我们的人」。
   * 没有这个开关，用户一边播歌一边打开互斥，第一拍会把自己按停（service 在开启后
   * 保留几秒的 adopt 窗口，覆盖 Windows 上 PowerShell 预热这种首拍拿不到人的情况）。
   */
  onSnapshot(players: ExternalPlayer[], options: { adoptPlayingNow?: boolean } = {}): InterlockEffects {
    this.players = players
    const playingIds = this.playingIds()

    if (this.oursPlaying) {
      // 先记账：被我们暂停过、这次快照里确实停在 Paused 的，才算「暂停真的生效」
      for (const player of this.players) {
        if (player.status === 'Paused' && this.pausedByUs.has(player.id)) {
          this.confirmedPaused.add(player.id)
        }
      }
      if (playingIds.length === 0) return makeEffects({})

      if (options.adoptPlayingNow) {
        const adopt = playingIds.filter((id) => !this.pausedByUs.has(id))
        if (adopt.length > 0) {
          for (const id of adopt) {
            this.pausedByUs.add(id)
            this.confirmedPaused.delete(id)
          }
          this.markStatus(adopt, 'Paused')
          return makeEffects({ pauseExternals: adopt })
        }
      }

      // 只有这两类才让位：
      //   a) 从没被我们暂停过的新播放器出声 —— 用户主动开的；
      //   b) 我们暂停过、确认停过，之后又被恢复 —— 用户手动恢复的。
      // 第三类（发过 Pause 但从没确认生效）**不让位**：控制通道失效时（Windows 的
      // stdin 泵坏了 / macOS 的自动化授权被拒 / 播放器不支持 Pause），按「对方在播
      // 就让位」处理会变成「本应用一听到别人出声就把自己按停」，比两个声音重叠更糟。
      // 这类改为按 pauseRetryMs 节流重试，等通道恢复或对方自己停下。
      const yieldCandidates = playingIds.filter(
        (id) => !this.pausedByUs.has(id) || this.confirmedPaused.has(id),
      )

      if (yieldCandidates.length === 0) {
        const now = this.now()
        const retry: string[] = []
        for (const id of playingIds) {
          const last = this.retryAt.get(id)
          if (last === undefined || now - last >= this.pauseRetryMs) {
            this.retryAt.set(id, now)
            retry.push(id)
          }
        }
        if (retry.length > 0) {
          // 重试同样走「乐观标记」，覆盖「暂停在路上」的那一拍
          this.markStatus(retry, 'Paused')
          return makeEffects({ pauseExternals: retry })
        }
        return makeEffects({})
      }

      this.oursPlaying = false
      // **不 clear pausedByUs**：里面可能还有「我们先暂停、与被让位对象无关」的第三个
      // 播放器，丢了它等于让它永久停在暂停（本应用停止/关闭时也没人还它）
      this.confirmedPaused.clear()
      for (const id of yieldCandidates) this.pausedAt.delete(id)
      this.retryAt.clear()
      this.yieldedTo = new Set(yieldCandidates)
      this.resumeExternalsPending = false
      return makeEffects({ pauseOurs: true })
    }

    // 规则 3：让位对象是否已经全部安静；期间冒出的其他播放器一并记入
    if (this.yieldedTo.size === 0) return makeEffects({})
    let grew = false
    for (const id of playingIds) {
      if (!this.yieldedTo.has(id)) {
        this.yieldedTo.add(id)
        grew = true
      }
    }
    if (grew) return makeEffects({})

    const stillPlaying = playingIds.filter((id) => this.yieldedTo.has(id))
    if (stillPlaying.length > 0) {
      // 对方又出声了：已排队的续播作废（到点时会重新判定，这里只负责取消意图）
      this.resumeOursPending = false
      return makeEffects({})
    }

    // **只在没排过队时发一次**：轮询间隔（win32 700ms）短于 service 的续播延迟（900ms）时，
    // 每拍都发会让 service 每拍重置定时器，自动续播永远不触发
    if (this.resumeOursPending) return makeEffects({})
    this.resumeOursPending = true
    return makeEffects({ scheduleResumeOurs: true })
  }

  /** 上层安排的「归还外部播放器」到点了 */
  onResumeExternalsDue(): InterlockEffects {
    this.resumeExternalsPending = false
    // 到点前状态又变了：我们已经重新出声或在让位，这一轮归还作废
    if (this.oursPlaying || this.yieldedTo.size > 0) return makeEffects({})

    const targets: string[] = []
    for (const id of this.pausedByUs) {
      // 只归还「仍然停在暂停」的：用户手动停掉/关掉的，不该替他按播放。
      // 刚发出暂停、快照还没更新（豁免窗口内仍是 Playing）的也要还，
      // 否则那一下 Pause 随后生效就永远停在暂停。
      if (this.isLikelyPaused(id)) targets.push(id)
    }
    this.pausedByUs.clear()
    // 归还之后这些 id 不再是我们「刚按下暂停」的对象：豁免窗口必须一并清掉，
    // 否则紧接着本应用重新起播时，会把它当成「我们正在暂停中」而漏掉抢占，
    // 变成两个应用一起出声
    for (const id of targets) this.pausedAt.delete(id)
    return makeEffects({ resumeExternals: targets })
  }

  /** 上层安排的「续播自己」到点了 */
  onResumeOursDue(): InterlockEffects {
    this.resumeOursPending = false
    if (this.oursPlaying) return makeEffects({})
    if (this.yieldedTo.size === 0) return makeEffects({})
    // 让位对象又出声了（切歌间隙的抖动、或用户又点了一次播放）：继续让位
    if (this.playingIds().some((id) => this.yieldedTo.has(id))) return makeEffects({})

    this.yieldedTo.clear()
    this.oursPlaying = true
    return makeEffects({ resumeOurs: true })
  }

  /** 功能被关闭 / 应用退出：把仍被我们暂停的播放器还回去 */
  release(): InterlockEffects {
    const targets: string[] = []
    for (const id of this.pausedByUs) {
      if (this.isLikelyPaused(id)) targets.push(id)
    }
    this.pausedByUs.clear()
    this.pausedAt.clear()
    this.yieldedTo.clear()
    this.resumeExternalsPending = false
    this.resumeOursPending = false
    this.oursPlaying = false
    return makeEffects({ resumeExternals: targets })
  }

  getState(): InterlockState {
    return {
      oursPlaying: this.oursPlaying,
      pausedByUs: [...this.pausedByUs],
      yieldedTo: [...this.yieldedTo],
      resumeExternalsPending: this.resumeExternalsPending,
      resumeOursPending: this.resumeOursPending,
    }
  }

  /**
   * 当前「真的在出声」的外部播放器。
   *
   * 暂停不是瞬间生效的：我们刚对某个播放器发出 Pause，下一次轮询很可能仍读到 Playing。
   * 若照单全收，会把「我们自己刚暂停的人」当成「有人抢了播放」。豁免窗口内的 id
   * 一律视为已暂停；窗口过后仍为 Playing 的，还要再看它是否被我们暂停过且确认停过
   * （见 onSnapshot），只有「确认停过又被恢复」才让位，否则只重试暂停。
   */
  private playingIds(): string[] {
    const at = this.now()
    return this.players
      .filter((p) => {
        if (p.status !== 'Playing') return false
        const pausedAt = this.pausedAt.get(p.id)
        return pausedAt === undefined || at - pausedAt >= this.pauseGraceMs
      })
      .map((p) => p.id)
  }

  /**
   * 这个播放器现在是否「停着（或刚被我们按了暂停）」。
   *
   * 与 playingIds() 用同一套豁免窗口：快照里还是 Playing、但我们刚发过 Pause 的，
   * 按「已暂停」处理，归还时不能漏掉它。
   */
  private isLikelyPaused(id: string): boolean {
    const status = this.statusOf(id)
    if (status === 'Paused') return true
    if (status !== 'Playing') return false
    const pausedAt = this.pausedAt.get(id)
    return pausedAt !== undefined && this.now() - pausedAt < this.pauseGraceMs
  }

  /** 乐观改写内部快照里这些播放器的状态（见 onOursPlaying 里的说明） */
  private markStatus(ids: string[], status: ExternalPlaybackStatus): void {
    if (ids.length === 0) return
    const wanted = new Set(ids)
    const at = this.now()
    for (const id of ids) {
      if (status === 'Paused') this.pausedAt.set(id, at)
      else this.pausedAt.delete(id)
    }
    this.players = this.players.map((p) => (wanted.has(p.id) ? { ...p, status } : p))
  }

  private statusOf(id: string): ExternalPlaybackStatus | null {
    return this.players.find((p) => p.id === id)?.status ?? null
  }
}
