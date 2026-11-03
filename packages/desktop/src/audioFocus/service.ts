import { BrowserWindow, ipcMain } from 'electron'
import { AudioFocusInterlock, type InterlockEffects } from './interlock'
import { AUDIO_FOCUS_CHANNELS } from './types'
import { createAudioFocusProvider } from './providers'
import type { AudioFocusProvider } from './types'

/**
 * 归还外部播放器前的等待：播放引擎切歌/续播之间会有一次短暂的 pause→play，
 * 若一暂停就立刻归还，别人会在两首歌之间被反复按暂停/播放（听感上是抖动）。
 */
const RESUME_EXTERNALS_DELAY_MS = 1200

/**
 * 续播自己前的等待：让位对象可能只是在切歌（短暂变 Paused 又变 Playing），
 * 等一拍再起，避免和对方撞在一起。
 */
const RESUME_OURS_DELAY_MS = 900

/**
 * 「本应用已在播放，用户才打开开关」的认领窗口。
 *
 * 开启那一刻没有任何外部快照；窗口内出现的「正在出声」一律按「先于我们存在」抢占，
 * 而不是按「打断我们的人」让位。5s 是给 Windows 上 PowerShell 预热（首行快照可能
 * 要 1~3s）留的余量。
 */
const ADOPT_WINDOW_MS = 5000

/**
 * 音频焦点服务（主进程侧的唯一实例）。
 *
 * 职责边界：
 *   - 知道「本应用此刻是否在出声」：只有渲染层知道，所以由渲染层上报（send，不等回执）；
 *   - 知道「别的播放器此刻在做什么」：由 provider 轮询；
 *   - 裁定交给 AudioFocusInterlock（纯逻辑），本类只负责执行裁定结果 + 定时器 + IPC。
 *
 * 三条硬约束（踩过才知道）：
 *   1. **关掉开关必须立刻停轮询**，不能只是「收到快照后什么都不做」——Linux 上每次轮询
 *      都是一串 D-Bus 方法调用，空转会让用户在没有该功能时白付成本。
 *   2. **provider 的任何异常都不得传出本类**：轮询循环被一次异常打断后就不会再起来，
 *      表现为「功能时灵时不灵」，这种 bug 现场极难复现。
 *   3. **退出/关闭时必须归还**：被我们暂停的播放器如果没还回去，用户会以为自己的
 *      播放器坏了（特别是浏览器里的播放）。
 */
class AudioFocusService {
  private provider: AudioFocusProvider = createAudioFocusProvider()
  private interlock = new AudioFocusInterlock()
  private window: BrowserWindow | null = null
  private enabled = false
  private lastKnownOursPlaying = false
  /** 让位是我们干的：关闭功能时要把它恢复回来，否则用户会觉得「关掉开关反而更糟」 */
  private pausedOursByUs = false
  /**
   * 「播放中才打开开关」的认领窗口截止时刻。
   *
   * 开启那一刻我们还没有任何外部快照，此刻正在出声的人其实**先于我们**存在，
   * 应当被抢占而不是被当成打断者。窗口覆盖 Windows 上 PowerShell 预热（首拍可能拿不到人）。
   */
  private adoptUntil = 0
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private resumeExternalsTimer: ReturnType<typeof setTimeout> | null = null
  private resumeOursTimer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private disposed = false

  /** 平台是否真的有可用的控制通道（'none' 表示这端只能隐藏开关） */
  get supported(): boolean {
    return this.provider.kind !== 'none'
  }

  attach(win: BrowserWindow): void {
    this.window = win
    this.registerIpc()
    console.log(`[AudioFocus] provider=${this.provider.kind} supported=${this.supported}`)
  }

  /**
   * 开关切换（渲染层 → 主进程）。
   * 返回值是「平台是否支持」而不是「是否已生效」：不支持时前端据此提示，
   * 免得用户对着一个永远没反应的开关反复点。
   */
  setEnabled(enabled: boolean): boolean {
    if (this.disposed) return false
    if (enabled === this.enabled) return this.supported
    this.enabled = enabled

    if (!enabled) {
      this.stopPolling()
      this.clearResumeTimers()
      this.adoptUntil = 0
      // 归还：被我们暂停的播放器还回去；被我们按下暂停的自己也要恢复
      this.apply(this.interlock.release())
      this.interlock = new AudioFocusInterlock()
      if (this.pausedOursByUs) {
        this.pausedOursByUs = false
        this.sendControl('resume')
      }
      console.log('[AudioFocus] disabled')
      return this.supported
    }

    // 重新开启：状态机从干净状态起步。
    // **先开轮询再对齐播放态**：开启瞬间 interlock 里没有任何外部快照，先走
    // onOursPlaying(true) 只是空操作，紧接着第一拍 poll 会看到「对方在播 + 本应用在播」，
    // 用户开着歌打开开关的第一秒就会把本应用自己按停。adoptUntil 给这几秒内的
    // 「正在出声的人」定性为「先于我们存在」，按抢占处理而不是让位。
    this.interlock = new AudioFocusInterlock()
    this.adoptUntil = this.lastKnownOursPlaying ? Date.now() + ADOPT_WINDOW_MS : 0
    this.startPolling()
    if (this.lastKnownOursPlaying) this.apply(this.interlock.onOursPlaying(true))
    console.log('[AudioFocus] enabled')
    return this.supported
  }

  onOursPlaying(playing: boolean): void {
    this.lastKnownOursPlaying = playing
    // 本应用停了就不需要再「认领」任何先于我们存在的播放器
    if (!playing) this.adoptUntil = 0
    // 播放态一旦是「在播」，无论谁点的（用户手动 / 我们下发的 resume），
    // 都不再欠用户一次恢复：否则「让位 → 用户手动播放 → 用户手动暂停 → 关开关」
    // 会让关闭动作把用户刚停掉的播放重新拉起来。
    if (playing) this.pausedOursByUs = false
    if (!this.enabled || this.disposed) return
    this.apply(this.interlock.onOursPlaying(playing))
  }

  dispose(): void {
    if (this.disposed) return
    this.stopPolling()
    this.clearResumeTimers()
    this.adoptUntil = 0
    // **顺序要紧**：apply() 首行会因 disposed 直接返回，先置位等于把归还丢掉，
    // 结果是「起播时暂停了别人的浏览器，退出后它永远停在暂停」。
    // provider 的 pause/play 是同步派发（D-Bus 写 socket / 子进程写 stdin 都在调用
    // 当场发生，只是返回的 promise 尚未 settle），所以尽力归还这一步不依赖 await。
    try {
      this.apply(this.interlock.release())
    } catch (err) {
      console.error('[AudioFocus] 退出归还失败:', err)
    }
    this.disposed = true
    try {
      void this.provider.dispose().catch(() => {})
    } catch (err) {
      console.error('[AudioFocus] provider dispose 失败:', err)
    }
    this.unregisterIpc()
  }

  /** 窗口重建（macOS 关窗后从 Dock 重新打开）：把命令目标换成新窗口 */
  setWindow(win: BrowserWindow): void {
    this.window = win
  }

  private registerIpc(): void {
    // 只接受本窗口的消息：这些通道能控制本机的其他播放器，
    // 不该由任何被加载进来的第三方内容（插件页/远程页）顺带拥有
    const fromOurWindow = (sender: Electron.WebContents) =>
      !this.window || this.window.isDestroyed() || sender === this.window.webContents

    ipcMain.on(AUDIO_FOCUS_CHANNELS.ours, (event, playing: unknown) => {
      if (!fromOurWindow(event.sender)) return
      if (typeof playing !== 'boolean') return
      this.onOursPlaying(playing)
    })

    ipcMain.handle(AUDIO_FOCUS_CHANNELS.enable, (event, enabled: unknown) => {
      if (!fromOurWindow(event.sender)) return false
      if (typeof enabled !== 'boolean') return false
      return this.setEnabled(enabled)
    })
  }

  private unregisterIpc(): void {
    // 两个 API 分开兜：任何一个不存在/被宿主环境裁剪，都不能连累另一个，
    // 否则「dispose 后重新 init」仍会抛 second handler
    try {
      ipcMain.removeAllListeners(AUDIO_FOCUS_CHANNELS.ours)
    } catch (err) {
      console.error('[AudioFocus] 注销 ours 监听失败:', err)
    }
    try {
      ipcMain.removeHandler(AUDIO_FOCUS_CHANNELS.enable)
    } catch (err) {
      console.error('[AudioFocus] 注销 enable handler 失败:', err)
    }
  }

  private startPolling(): void {
    if (this.pollTimer || this.disposed) return
    const interval = Math.max(300, this.provider.pollingIntervalMs)
    void this.pollOnce()
    this.pollTimer = setInterval(() => void this.pollOnce(), interval)
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async pollOnce(): Promise<void> {
    // 上一拍还没回来就跳过这一拍：某个播放器卡住时不能让轮询请求堆积
    if (this.polling || !this.enabled || this.disposed) return
    this.polling = true
    try {
      const players = await this.provider.list()
      if (!this.enabled || this.disposed) return
      this.apply(
        this.interlock.onSnapshot(players, {
          adoptPlayingNow: this.adoptUntil > 0 && Date.now() < this.adoptUntil,
        }),
      )
    } catch (err) {
      // provider 契约要求不抛错，这里只是最后一道保险：一轮失败不影响下一轮
      console.error('[AudioFocus] 轮询失败:', err)
    } finally {
      this.polling = false
    }
  }

  private apply(effects: InterlockEffects): void {
    if (this.disposed) return
    try {
      if (effects.pauseExternals.length > 0) {
        console.log('[AudioFocus] 抢占，暂停外部播放器:', effects.pauseExternals.join(', '))
        for (const id of effects.pauseExternals) void this.provider.pause(id).catch(() => {})
      }
      if (effects.resumeExternals.length > 0) {
        console.log('[AudioFocus] 归还，恢复外部播放器:', effects.resumeExternals.join(', '))
        for (const id of effects.resumeExternals) void this.provider.play(id).catch(() => {})
      }
      if (effects.pauseOurs) {
        console.log('[AudioFocus] 让位，暂停本应用')
        this.pausedOursByUs = true
        this.sendControl('pause')
      }
      if (effects.resumeOurs) {
        console.log('[AudioFocus] 对方安静，续播本应用')
        this.pausedOursByUs = false
        this.sendControl('resume')
      }
      if (effects.scheduleResumeExternals) this.scheduleResumeExternals()
      if (effects.scheduleResumeOurs) this.scheduleResumeOurs()
    } catch (err) {
      console.error('[AudioFocus] 执行裁定失败:', err)
    }
  }

  private scheduleResumeExternals(): void {
    // 已在排队就不再重置：轮询间隔（win32 700ms）短于延迟（1200ms）时，
    // 每拍都重建会让定时器永远到不了点
    if (this.resumeExternalsTimer) return
    this.clearResumeTimers()
    this.resumeExternalsTimer = setTimeout(() => {
      this.resumeExternalsTimer = null
      if (!this.enabled || this.disposed) return
      this.apply(this.interlock.onResumeExternalsDue())
    }, RESUME_EXTERNALS_DELAY_MS)
  }

  private scheduleResumeOurs(): void {
    if (this.resumeOursTimer) return
    this.clearResumeTimers()
    this.resumeOursTimer = setTimeout(() => {
      this.resumeOursTimer = null
      if (!this.enabled || this.disposed) return
      this.apply(this.interlock.onResumeOursDue())
    }, RESUME_OURS_DELAY_MS)
  }

  private clearResumeTimers(): void {
    if (this.resumeExternalsTimer) {
      clearTimeout(this.resumeExternalsTimer)
      this.resumeExternalsTimer = null
    }
    if (this.resumeOursTimer) {
      clearTimeout(this.resumeOursTimer)
      this.resumeOursTimer = null
    }
  }

  private sendControl(action: 'pause' | 'resume'): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    try {
      win.webContents.send('media-control', action)
    } catch (err) {
      console.error('[AudioFocus] 下发播放控制失败:', err)
    }
  }
}

let service: AudioFocusService | null = null

/** 启动音频焦点服务（必须在主窗口创建之后调用：命令要下发到那个窗口） */
export function initAudioFocus(win: BrowserWindow): void {
  if (service) return
  service = new AudioFocusService()
  service.attach(win)
}

/** 退出清理：归还被暂停的播放器、停轮询、释放 provider */
export function disposeAudioFocus(): void {
  service?.dispose()
  service = null
}

/**
 * 窗口重建后重新挂载（macOS：关掉窗口不退出应用，从 Dock 点开时 createWindow 会建新窗口）。
 * 不重新挂载的话 service 手里的引用指向已销毁窗口，让位/续播命令会被 sendControl 静默丢弃，
 * 而 IPC 仍然通——表现为「开关一切正常，但让位/续播不生效」。
 */
export function attachAudioFocusWindow(win: BrowserWindow): void {
  service?.setWindow(win)
}
