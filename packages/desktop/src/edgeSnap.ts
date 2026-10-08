import { BrowserWindow, screen } from 'electron'

/**
 * Linux 顶边吸附：把窗口拖到显示器顶边时最大化，从顶边拖离时还原。
 *
 * ── 为什么要在主进程自己实现，而不是交给窗口管理器 ──
 *
 * 本项目的窗口是 frame:false 无边框窗，标题栏拖动走渲染层的
 * `-webkit-app-region: drag`（globals.css 的 .titlebar-drag），由 Chromium 发起
 * 客户端拖动。GNOME 那套「拖到屏幕顶部即最大化」的贴顶逻辑在 mutter 里位于
 * meta-window-drag.c → update_move_maybe_tile()，裁决点是
 * `meta_prefs_get_edge_tiling() && !maximized && !tiled_side_by_side`，并依赖
 * `meta_window_can_maximize()` 为真。
 *
 * 现场实测（Fedora 45 / GNOME Shell 51 / mutter 51.0，Wayland 会话 + Xwayland，
 * 本机会话 edge-tiling=true）：该链路没有落地——窗口拖到屏幕顶部后停在原地，
 * 既不最大化也不贴顶；同一时刻用 `xdotool windowmove` 移动同一个窗口却完全正常
 * （应用侧 move 事件、几何、工作区换算都对）。mutter 源码侧也排除了「窗口属性
 * 导致能力位丢失」这一解释：本窗口的 _NET_WM_ALLOWED_ACTIONS 实测含
 * MAXIMIZE_HORZ/VERT，而 MWM 的 decorations=0（无边框）只影响 mwm_decorated，
 * 不参与 has_maximize_func 的判定，且拖动逻辑中根本没有引用 decorated。
 *
 * 也就是说：WM 那条路能不能走通，取决于 mutter 在客户端拖动下的行为，不好赌。
 * 这里改为在主进程侧直接实现同一语义，判据只用**窗口自身的 bounds**——
 * 实测由 WM 移动窗口产生的 ConfigureNotify 同样会触发 `move` 事件，
 * 因此这条判据覆盖真实拖动链路，而不依赖任何指针注入或 WM 内部状态。
 *
 * ── 与窗口管理器不冲突 ──
 *
 * 若将来某个 WM 自己就把贴顶做对了，这里最多是「提前一点最大化」：触发条件是
 * 窗口顶边贴到显示器顶边，结果也同样是最大化，语义一致；`snapped` 只记录
 * 「这次最大化是吸附触发的」，用于决定拖离顶边时是否要还原，不会去动
 * 用户用标题栏按钮或系统快捷键做出的最大化。
 */

/**
 * 判定「已拖到屏幕顶部」的容差（px）。
 *
 * 不能取 0：无边框窗在 Linux 上带客户端阴影，Electron 的 getBounds() 报的是可视
 * 窗口边缘，而窗口管理器钳制的是含阴影的外框。实测本机外框上边比可视上边高 10px
 * （_GTK_FRAME_EXTENTS 的上边距），于是窗口被顶到最上时 getBounds().y 仍等于
 * workArea.y + 10，永远到不了 workArea.y。这里留出余量覆盖该内缩，同时远小于
 * GNOME 自身的贴顶感应区（约 6 倍拖动阈值，≈48px），不会误吸附。
 */
const TOP_TOLERANCE = 32

/** 重新「上膛」所需的离开距离：窗口要真正离开顶边这么远，才允许再次吸附（px） */
const REARM_DISTANCE = 32

/**
 * 给窗口挂上顶边吸附。仅 Linux 生效：Windows / macOS 上无边框窗的贴顶
 * 由系统处理，不需要也不应在这里插手。
 */
export function attachEdgeSnap(win: BrowserWindow): void {
  if (process.platform !== 'linux') return

  // armed：窗口当前是否已离开顶边（防止「启动时窗口恰好在顶部」被误判成贴顶）
  let armed = false
  // snapped：当前的最大化是否由本模块触发（决定拖离顶边时是否还原）
  let snapped = false
  // busy：正在应用最大化/还原，期间忽略自身引起的 move 事件，避免自激循环
  let busy = false

  const release = () => {
    busy = false
  }
  win.on('maximize', release)
  win.on('unmaximize', () => {
    release()
    // 窗口不再是最大化状态时，吸附标记必须同步失效。
    // 不只在下面 move 分支里靠「拖离顶边」清：窗口管理器自己也会取消最大化——
    // mutter 在 edge-tiling=true 时对已最大化窗口有 shake-loose 处理
    // （meta-window-drag.c：ABS(dy) 超过阈值即 meta_window_unmaximize），
    // 用户把最大化窗口往下拽就会走到那条分支。若 snapped 不同步清掉，
    // 下次普通拖离顶边会被误判成「吸附造成的最大化」而被还原。
    snapped = false
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
        win.maximize()
      }
      return
    }

    // 拖离顶边：若是吸附造成的最大化，还原并让窗口继续跟随拖动
    if (win.isMaximized() && snapped) {
      busy = true
      snapped = false
      win.unmaximize()
      return
    }

    if (bounds.y > topEdge + REARM_DISTANCE) armed = true
  })
}