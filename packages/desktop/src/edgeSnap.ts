import { BrowserWindow, screen } from 'electron'

/**
 * Linux 顶边吸附：把窗口拖到显示器顶边时最大化，从顶边拖离时还原。
 *
 * ── 为什么要在主进程自己实现，而不是交给窗口管理器 ──
 *
 * 本项目的窗口是 frame:false 无边框窗，标题栏拖动走渲染层的
 * `-webkit-app-region: drag`（globals.css 的 .titlebar-drag），由 Chromium 以
 * 「客户端拖动」方式实现（每个 motion 事件自己算位置后设窗口几何，见
 * ui/base/x/x11_desktop_window_move_client.cc）。
 *
 * GNOME 那套「拖到屏幕顶部即最大化」的贴顶逻辑在 mutter 里位于
 * meta-window-drag.c → update_move_maybe_tile()，但它只在**WM 自己的 grab op
 * 期间**运行；而进入 grab op 的入口对本应用都走不通：
 *   · 裸左键按下：meta_window_handle_ungrabbed_event 要求
 *     (event_mods & grab_mods) == grab_mods，而 grab_mods 取
 *     org.gnome.desktop.wm.preferences mouse-button-modifier（本机实测 '<Super>'），
 *     裸左键不满足；且本窗口 decorations=0，连自绘边框都没有；
 *   · EWMH _NET_WM_MOVERESIZE：这条确实能进入 grab op，但 Chromium 的 X11 客户端
 *     拖动路径并不发它——用 X11 客户端订阅 root 的 ClientMessage 实测，拖动全程
 *     0 条 _NET_WM_MOVERESIZE，故这个入口对本应用实际是关闭的。
 *
 * 这一点已用**对照实验**钉死（本机 Fedora 45 / GNOME Shell 51 / mutter 51.0，
 * Wayland 会话 + Xwayland，且会话真实 edge-tiling=true——注意 `gsettings get
 * org.gnome.mutter edge-tiling` 不带 XDG_CURRENT_DESKTOP 会读成 false，那是由
 * Fedora 的 /usr/share/glib-2.0/schemas/00_org.gnome.shell.gschema.override 的
 * `[org.gnome.mutter:GNOME] edge-tiling=true` 覆盖提供的）：
 *   · 同一个未最大化无边框窗，按 Chromium 拖动语义逐帧逼近顶边，**不挂本模块**
 *     → isMaximized=false、maximize 事件 0 次、窗口停在 y=workArea.y 处不动；
 *   · 挂上本模块后同样驱动 → isMaximized=true，几何收口到完整工作区。
 * 即「拖到顶部不最大化」在真实链路里确实发生，本模块补上的是系统缺失的那一截，
 * 而不是在 WM 已生效时重复做一遍；判据只用**窗口自身的 bounds**——
 * 实测由 WM 移动窗口产生的 ConfigureNotify 同样会触发 Electron 的 `move` 事件，
 * 全程不依赖指针注入或 WM 内部状态。
 *
 * ── 与窗口管理器同处的分工 ──
 *
 * 本机的窗口管理器其实已经在接管拖动手势的执行：客户端拖动发出的每一帧窗口移动
 * 请求都由 WM 在服务端落实（客户端只通过 ConfigureNotify 得知结果），只是它不跑
 * 贴顶逻辑——这正是上面那条缺失的一截。
 *
 * 因此这里要说清的不是「将来会不会冲突」，而是「同一手势上有两个 actor」：
 * WM 的贴顶判据是**指针位置**（mutter: `y >= rect.y && y <= work_area.y`），
 * 本模块的判据是**窗口上沿**。若某个桌面环境将来把 WM 贴顶也接通了，两边会在顶边
 * 处几乎同时动作、结果相同（都是最大化），差别只在于谁先抢到；不会出现相反结果。
 * `snapped` 只记录「这次最大化是吸附触发的」，用于决定拖离顶边时是否还原，
 * 不会去动用户用标题栏按钮或系统快捷键做出的最大化。仅 Linux 生效，
 * Windows / macOS 由系统处理。
 */

/**
 * 判定「已拖到屏幕顶部」的容差（px）。
 *
 * 实测依据（无边框窗，未最大化，逐帧逼近）：窗口被拖到最上时
 * `getBounds().y` 会停在 workArea.y（本例 32，即距顶 0px）——上限不是更小的值，
 * 也就是说「拖到顶」这一状态的可达极小值就是 workArea.y 本身，不需要为客户端阴影
 * 额外放宽（曾按 10px 阴影内缩放宽到 32，实测属三倍过冲：窗口停在距顶 1~32px 时
 * 就会被抢着最大化，用户在顶栏正下方摆窗会被误伤）。
 *
 * 取 8 而非 0：留一点余量吸收拖动末帧与 WM 取整误差，同时与下面「停在距顶 10px
 * 不触发」有明显的安全间隔。
 */
const TOP_TOLERANCE = 8

/**
 * 重新「上膛」所需的离开距离（px）。
 *
 * 必须显著大于 TOP_TOLERANCE：两者若接近，边界附近 1px 抖动就会让
 * 「上膛 → 吸附」反复切换。这里留出 32px 迟滞带。
 */
const REARM_DISTANCE = 40

/**
 * 拖离吸附后，等待多久再纠回尺寸（ms）。
 *
 * 不能在 unmaximize() 当场纠：那一刻拖动仍在进行，拖动引擎会持续下发窗口几何把
 * 纠偏覆盖掉，而纠偏自身又触发 move 回到本判据，与 WM 的恢复几何互斗（实测有失败）。
 *
 * 也不能用「move 静默这么久」判定拖动结束——真实拖动与用户边缘缩放期间 move
 * 一直在到达，静默判据会把纠偏无限推后：连续快速拖离时永远等不到，且悬挂期内
 * 用户手动调整的尺寸会在最后被纠偏覆盖掉（实测均复现）。
 *
 * 因此改为**从拖离那一刻起算的有界延时**，并在任何非本模块发起的外部缩放出现时
 * 立即取消挂起的纠偏（见 markExternalResize）。
 */
const RESTORE_DELAY_MS = 300

/*
 * 已知边界（实测，正常拖动下不可达）：纠偏只写一次。若窗口管理器在 300ms 之后
 * 仍以陈旧尺寸持续驱动窗口（需要它的尺寸查询缓存连续 300ms 以上不刷新），
 * 残留的错误尺寸不会被再次纠正。Chromium 的拖动循环每帧都取当前尺寸，
 * 该窗口期通常只有一个 WM 往返（实测 3~7ms，高负载下同样），故正常拖动、
 * 连续快速拖离、悬挂期内用户缩放等场景均已验证正确。
 * 不为此加「松手后再补一次纠偏」：那需要重新引入「move 静默」判据，
 * 而该判据已被证伪——真实拖动与用户缩放期间 move 从不停，
 * 会重新引入「连续快速拖离不纠偏」与「覆盖用户缩放」两个问题。
 */

/**
 * 悬挂期内的「让位」阈值（ms）：取消最大化后多久之内的尺寸变化仍算 WM 的恢复几何。
 *
 * 取消最大化会立刻（约一帧内）产生一次尺寸变化，那是 WM 恢复出的错误几何，必须
 * 继续纠偏；而用户在这么短的时间内不可能完成一次边缘缩放。因此超过该阈值再出现的
 * 尺寸变化一律视为用户操作，立即放弃挂起的纠偏——否则用户刚调好的尺寸会被抹回
 * 吸附前的值（实测复现，且这是会改用户操作结果的问题）。
 */
const RESTORE_GRACE_MS = 150

/**
 * 当前是否跑在 X11（含 Xwayland）后端上。
 *
 * 本模块的判据是窗口 bounds 的**绝对坐标**，这在 Wayland 原生后端下不成立：
 * 位置由合成器决定、客户端拿不到可靠坐标。若不设这道守卫，在「Wayland 会话且
 * Xwayland 不可达」的机器上（main.ts 的 injectX11BackendOnLinux 此时会保持
 * Wayland 后端）本模块会带着失效判据挂上去。
 *
 * 判定与 main.ts 的那套保持一致，以命令行现状为准：
 *   · 显式带了 --ozone-platform=… → 以它为准（排障时用户可传 wayland 退回）；
 *   · 没带 → 由会话类型判断（非 Wayland 会话即 X11）。
 */
export function isX11Backend(): boolean {
  const explicit = process.argv.find((arg) => arg.startsWith('--ozone-platform'))
  if (explicit) return explicit.includes('x11')
  return process.env.XDG_SESSION_TYPE !== 'wayland'
}

/**
 * 给窗口挂上顶边吸附。仅 Linux 且 X11 后端生效：Windows / macOS 上无边框窗的
 * 贴顶由系统处理；Wayland 原生后端下坐标不可靠（见 isX11Backend）。
 */
export function attachEdgeSnap(win: BrowserWindow): void {
  if (process.platform !== 'linux') return
  if (!isX11Backend()) return

  // armed：窗口当前是否已离开顶边（防止「启动时窗口恰好在顶部」被误判成贴顶）
  let armed = false
  // snapped：当前的最大化是否由本模块触发（决定拖离顶边时是否还原）
  let snapped = false
  // busy：正在应用最大化/还原，期间忽略自身引起的 move 事件，避免自激循环
  let busy = false
  // snappedSize：吸附前的可视尺寸。拖离还原时若被 WM 的恢复几何带偏（见下方说明），
  // 用它纠回。只记尺寸不记位置——拖离后窗口应停在用户拖到的位置，而非弹回原处。
  // 只在没有待消费目标时写入：若上一次纠偏还没执行、用户又立刻拖回顶边重新吸附，
  // 覆盖成「此刻已被 WM 破坏的尺寸」会把错误尺寸固化下来（棘轮式污染，实测复现）。
  let snappedSize: { width: number; height: number } | null = null
  // restoreTimer：延时纠偏句柄，从拖离起算的有界延时
  let restoreTimer: NodeJS.Timeout | null = null
  // restoring：本模块正在 write 尺寸，用于把自己引起的 resize 与外部缩放区分开
  let restoring = false
  // unmaximizedAt：本次还原发生的时刻，用于划出「WM 恢复几何」与「用户缩放」的边界
  let unmaximizedAt = 0

  const clearRestore = () => {
    if (restoreTimer) clearTimeout(restoreTimer)
    restoreTimer = null
  }

  /**
   * 外部（用户 / 拖动引擎 / WM）改变了窗口尺寸。
   *
   * 纠偏只在「WM 取消最大化刚带出的那次错误尺寸」这一小段窗口期内有效：过了
   * RESTORE_GRACE_MS 之后的尺寸变化都属于用户操作（或拖动引擎），必须立即放弃纠偏，
   * 否则用户刚调好的尺寸会在延时到点那一刻被抹回吸附前的值（实测复现）。
   */
  const markExternalResize = () => {
    if (restoring) return
    if (Date.now() - unmaximizedAt > RESTORE_GRACE_MS) clearRestore()
  }

  const release = () => {
    busy = false
  }
  win.on('maximize', release)
  win.on('unmaximize', () => {
    release()
    // 窗口不再处于最大化状态时，吸附标记必须同步失效。
    // 不能只在下面 move 分支里靠「拖离顶边」清：退出最大化的路径不止那一条——
    // 系统快捷键、桌面环境自身行为（如 mutter 的 shake-loose），
    // 以及用户点标题栏按钮，都会让窗口离开最大化状态。
    // 漏清会让 snapped 残留为 true，之后任意一次普通拖离顶边都会被误判成
    // 「吸附造成的最大化」而被额外还原一次。
    snapped = false
  })
  // 尺寸被外部改变 → 让位（见 markExternalResize 说明）
  win.on('resize', markExternalResize)
  win.on('closed', () => {
    clearRestore()
  })

  win.on('move', () => {
    if (busy || win.isDestroyed() || win.isFullScreen()) return

    const bounds = win.getBounds()
    // 顶边取**工作区**顶部而不是显示器物理顶部：GNOME 不允许普通窗口压到顶栏区域，
    // 实测拖到屏幕最上方时 mutter 会把窗口 y 钳在 workArea.y（本机 =32），
    // 用户感知的「屏幕顶部」就是这个位置。
    const topEdge = screen.getDisplayMatching(bounds).workArea.y

    if (bounds.y <= topEdge + TOP_TOLERANCE) {
      // 已到顶边：上过膛且尚未最大化才吸收，避免对已是最大化的窗口重复调用
      if (armed && !win.isMaximized()) {
        busy = true
        armed = false
        snapped = true
        // 只在没有待消费目标时记录：上一次纠偏尚未执行、用户又立刻拖回顶边重新吸附
        // 时，覆盖会记下「此刻已被 WM 破坏的尺寸」，把错误尺寸棘轮式固化（实测复现）。
        if (!snappedSize) snappedSize = { width: bounds.width, height: bounds.height }
        win.maximize()
      }
      return
    }

    // 拖离顶边：若是吸附造成的最大化，还原并继续跟随拖动。
    // 只调 unmaximize()，不在这一刻纠尺寸：此时拖动仍在进行，拖动引擎会持续下发
    // 窗口几何把纠偏覆盖掉，而纠偏自身又触发 move 回到本判据，与 WM 的恢复几何
    // 互斗（实测反而把窗口留在过渡尺寸上）。改为稍后统一纠一次，见 scheduleRestore。
    if (win.isMaximized() && snapped) {
      busy = true
      snapped = false
      unmaximizedAt = Date.now()
      win.unmaximize()
      scheduleRestore()
      return
    }

    if (bounds.y > topEdge + REARM_DISTANCE) armed = true
  })

  /**
   * 取消最大化之后，WM 恢复出的几何未必等于吸附前的尺寸。
   * 实测（本机 GNOME/mutter，minHeight 600）：窗口高度 ≤ minHeight + 42 时，
   * 取消最大化会把它抬高到 minHeight + 42（如 600 → 642，宽度也随之被抬）。
   * 这与本模块无关（不挂本模块、纯 maximize()/unmaximize() 同样如此），但本模块
   * 是唯一会走到该路径的地方，故在这里补一次纠偏。
   *
   * 计时从拖离那一刻起算、且只排一次：不用「move 静默」判定（真实拖动与用户缩放
   * 期间 move 一直在到达，静默判据会让纠偏无限推后——连续快速拖离时永远等不到，
   * 实测复现）。用户在悬挂期内调整窗口则由 resize 让位，见 markExternalResize。
   */
  function scheduleRestore() {
    clearRestore()
    restoreTimer = setTimeout(() => {
      restoreTimer = null
      if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return
      const target = snappedSize
      snappedSize = null
      if (!target) return
      const b = win.getBounds()
      if (b.width === target.width && b.height === target.height) return
      // 暂时屏蔽自己的 resize：否则会被 markExternalResize 当成用户操作
      restoring = true
      win.setBounds({ x: b.x, y: b.y, width: target.width, height: target.height })
      restoring = false
    }, RESTORE_DELAY_MS)
  }
}