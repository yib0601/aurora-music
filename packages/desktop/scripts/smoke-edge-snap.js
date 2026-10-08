#!/usr/bin/env node
/**
 * 顶边吸附（edgeSnap）端到端冒烟测试。
 *
 * 为什么需要它：无边框窗不进入 WM 的 grab op，GNOME 的贴顶链路对本应用不生效
 * （见 src/edgeSnap.ts 顶部说明与对照实验），修复落在主进程的 edgeSnap.ts。
 *
 * 【驱动方式的选择】本机指针注入全线失效（XTEST / XWarpPointer / uinput 都不
 * 驱动 mutter，已反复复现），无法合成真实鼠标拖动。这里改用**与 Chromium 客户端
 * 拖动等价的驱动语义**：Chromium 的 X11 拖动实现
 * （ui/base/x/x11_desktop_window_move_client.cc）在每个 motion 事件里取当前真实
 * 尺寸、只改位置后设窗口几何。本测试的 dragToTop() 严格照此逐步驱动，
 * 因此走的是与真实拖动相同的主进程判据链路（`move` 事件 + 窗口 bounds）。
 *
 * 覆盖场景：
 *   1) 未最大化的窗口：拖动过程中不误触发，到顶边才最大化
 *   2) 拖动过程稳定性：全程不发生 maximize/unmaximize 反复（抖动）
 *   3) 停在顶栏下方（距顶 10px）不被误吸附 —— 容差边界的下侧
 *   4) 最大化后静止与拖离的行为
 *   5) 还原后再次触顶能重新吸附
 *   6) 启动时窗口就在顶边不误判
 *   7) 无 edgeSnap 的对照：同样驱动到顶边，WM 不会自己接管（证明修复必要）
 *
 * 用法：pnpm --filter @aurora/desktop smoke:edge-snap
 * 前置：`npx tsc -p tsconfig.electron.json` 已编译主进程；需要可用的 X11 显示。
 */

'use strict'

const { app, BrowserWindow, screen } = require('electron')
const path = require('node:path')

const DIST = path.join(__dirname, '..', 'dist-electron')
const { attachEdgeSnap } = require(path.join(DIST, 'edgeSnap.js'))

let failures = 0
function check(ok, label, detail) {
  if (ok) {
    console.log(`  ✅ ${label}`)
  } else {
    failures++
    console.log(`  ❌ ${label}${detail ? `　— ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 与 main.ts 的 createWindow 同构：无边框 + 不透明 + thickFrame:false + 最小尺寸 */
function makeWindow(x, y, title) {
  const w = new BrowserWindow({
    // 高度必须离 minHeight 有余量：若窗口高度恰好等于 minHeight，WM 会把它视作
    // 尺寸被锁定，取消最大化时的恢复几何会带上过渡值（实测 900x600 被带成 900x642），
    // 那是测试参数落在边界上的伪影，不是吸附逻辑的问题。
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    x,
    y,
    transparent: false,
    frame: false,
    backgroundColor: '#0a0a0f',
    hasShadow: true,
    thickFrame: false,
    roundedCorners: true,
    show: true,
    webPreferences: { sandbox: true },
  })
  w.setTitle(title)
  w.loadURL(`data:text/html,<body style="margin:0;background:%230a0a0f">
    <div style="-webkit-app-region:drag;height:44px;background:%23151820"></div></body>`)
  return w
}

/** 记录 maximize/unmaximize 翻转次数，用于检测抖动 */
function watchFlips(win) {
  const st = { flips: 0 }
  const on = () => st.flips++
  win.on('maximize', on)
  win.on('unmaximize', on)
  st.stop = () => {
    win.removeListener('maximize', on)
    win.removeListener('unmaximize', on)
    return st.flips
  }
  return st
}

/**
 * 按 Chromium 客户端拖动语义逐步移动：每步取当前真实尺寸，只改位置。
 * 这是本测试相对「xdotool windowmove 纯位置请求」更贴近真实拖动的地方，
 * 也是能照出「拖动中抖动」的前提——若每步改用陈旧尺寸（frozen）会把抖动
 * 掩盖掉，反而测不出来。
 *
 * preDelay/stepMs 可调：吸附发生后若在极短延迟内立刻继续下移，
 * 最容易踩到「窗口刚被最大化、旧几何尚未收敛」的时序，是抖动的关键一档。
 */
async function dragTo(win, targetY, { fromY = null, stepMs = 70, preDelayMs = 0 } = {}) {
  if (preDelayMs) await sleep(preDelayMs)
  let y = fromY === null ? win.getBounds().y : fromY
  const step = y > targetY ? -12 : 12
  while (step < 0 ? y > targetY : y < targetY) {
    const b = win.getBounds()
    win.setBounds({ x: b.x, y, width: b.width, height: b.height })
    await sleep(stepMs)
    y += step
  }
  const b = win.getBounds()
  win.setBounds({ x: b.x, y: targetY, width: b.width, height: b.height })
  await sleep(200)
}

async function main() {
  await app.whenReady()

  const display = screen.getPrimaryDisplay()
  const topEdge = display.workArea.y
  console.log(
    `\n显示器: bounds=${JSON.stringify(display.bounds)} workArea=${JSON.stringify(display.workArea)} 顶边=${topEdge}`
  )
  if (!process.env.DISPLAY) {
    console.log('!! 没有 DISPLAY：本测试需要 X11（--ozone-platform=x11）')
    app.exit(1)
    return
  }
  check(display.workArea.y > 0, `顶边不是屏幕物理 0（GNOME 顶栏占位，real=${display.workArea.y}）`)

  const win = makeWindow(260, topEdge + 560, 'EDGESNAP-MAIN')
  attachEdgeSnap(win)
  await sleep(1600)

  console.log('\n【场景 1】未最大化窗口：拖动过程不误触发，到顶边才最大化')
  check(!win.isMaximized(), '初始未最大化')
  await dragTo(win, topEdge + 300)
  check(!win.isMaximized(), '拖到半空仍不触发', `bounds=${JSON.stringify(win.getBounds())}`)

  console.log('\n【场景 2】拖动过程无抖动：触顶后立刻反向拖离，全程计数')
  // 关键：watch 必须横跨「到顶 → 拖离」整段。只统计到顶那一段会漏掉抖动，
  // 因为抖动发生在吸附之后的下移过程中。
  const flips = watchFlips(win)
  const preSize = win.getBounds()
  await dragTo(win, topEdge, { stepMs: 16 }) // 用最小步进延迟逼近真实拖动节奏
  await sleep(340)
  const reached = win.isMaximized()
  await dragTo(win, topEdge + 400, { preDelayMs: 0, stepMs: 16 }) // 吸附后不等待即下移
  await sleep(700)
  const after = win.getBounds()
  check(reached, '抵达顶边后已最大化', `max=${win.isMaximized()}`)
  check(!win.isMaximized(), '拖离顶边后已还原', `max=${win.isMaximized()}`)
  // 终态结构断言：只数翻转次数会漏掉「尺寸被 WM 缩过」的畸形收尾
  // （曾实测卡在 1717x937 这种非拖动前尺寸）。
  check(
    after.width === preSize.width && after.height === preSize.height,
    '还原后尺寸回到吸附前的值（未被 WM 缩成畸形尺寸）',
    `吸附前 ${preSize.width}x${preSize.height} → 还原后 ${after.width}x${after.height}`
  )
  check(flips.stop() <= 2, '整段（到顶+拖离）翻转次数不超过 2（无抖动）', `翻转=${flips.flips}`)

  console.log('\n【场景 2b】零延迟 + 最小步进的极端时序下不抖动')
  await dragTo(win, topEdge + 420, { stepMs: 0 })
  const flips2 = watchFlips(win)
  await dragTo(win, topEdge, { stepMs: 0 })
  check(win.isMaximized(), '极紧时序下仍能触顶最大化', `max=${win.isMaximized()}`)
  await dragTo(win, topEdge + 420, { preDelayMs: 0, stepMs: 0 })
  await sleep(700)
  check(flips2.stop() <= 2, '极紧时序下翻转不超过 2 次', `翻转=${flips2.flips}`)
  check(!win.isMaximized(), '极紧时序下也能干净还原', `max=${win.isMaximized()}`)

  console.log('\n【场景 3】停在顶栏下方（距顶 10px）不被误吸附')
  await sleep(500)
  await dragTo(win, topEdge + 400)
  check(!win.isMaximized(), '已还原并可正常摆窗')
  await dragTo(win, topEdge + 10)
  await sleep(400)
  check(!win.isMaximized(), '停在距顶 10px 不触发（容差 8px 之外）', `bounds=${JSON.stringify(win.getBounds())}`)

  console.log('\n【场景 3b】窗口高度接近 minHeight 时，拖离还原不被 WM 抬高')
  // 回归：WM 取消最大化时若窗口高度 ≤ minHeight + 42，恢复几何会被抬高
  // （实测 600 → 642、800x600 → 832x642）。该缺陷与吸附逻辑无关，但只有走到
  // 吸附→拖离这条路径才会暴露，故必须在此锁定。
  win.setBounds({ x: 300, y: topEdge + 400, width: 900, height: 600 })
  await sleep(600)
  const small = win.getBounds()
  check(small.height === 600, '已缩到 minHeight 边界附近（900x600）', `bounds=${JSON.stringify(small)}`)
  await dragTo(win, topEdge)
  await sleep(700)
  check(win.isMaximized(), '该尺寸下触顶仍能最大化', `max=${win.isMaximized()}`)
  await dragTo(win, topEdge + 400)
  // 纠偏在拖动停止后触发（RESTORE_DELAY_MS），需等够
  await sleep(1600)
  const restored = win.getBounds()
  check(
    restored.height === small.height,
    '拖离后高度被纠回 minHeight 边界值（未被 WM 抬到 642）',
    `${small.height} → ${restored.height}`
  )
  check(
    restored.width === small.width,
    '拖离后宽度被纠回（未被 WM 抬宽）',
    `${small.width} → ${restored.width}`
  )
  check(!win.isMaximized(), '纠偏后仍处于非最大化状态', `max=${win.isMaximized()}`)
  // 纠偏后吸附能力必须完好（防止 busy 卡死）
  await dragTo(win, topEdge)
  await sleep(700)
  check(win.isMaximized(), '纠偏之后仍能再次触顶最大化（未卡死）', `max=${win.isMaximized()}`)
  win.unmaximize()
  await sleep(700)
  win.setBounds({ x: 260, y: topEdge + 560, width: 1200, height: 800 })
  await sleep(700)

  console.log('\n【场景 3c】棘轮防护：纠偏未执行就立刻重新吸附，不得固化错误尺寸')
  // 不纠偏就立刻拖回顶边：若吸附时覆盖记录，第二次会把「已被 WM 破坏的尺寸」记进去
  win.setBounds({ x: 300, y: topEdge + 400, width: 900, height: 600 })
  await sleep(600)
  await dragTo(win, topEdge)
  await sleep(500)
  check(win.isMaximized(), '第一次触顶最大化')
  await dragTo(win, topEdge + 380) // 拖离，但不给它 RESTORE_DELAY_MS 的机会
  await dragTo(win, topEdge, { preDelayMs: 0, stepMs: 0 }) // 立刻又拖回顶边
  await sleep(500)
  check(win.isMaximized(), '立刻重新触顶仍最大化')
  await dragTo(win, topEdge + 380)
  await sleep(1200) // 等纠偏到点
  const afterRatchet = win.getBounds()
  check(
    afterRatchet.width === 900 && afterRatchet.height === 600,
    '两次吸附后尺寸仍是 900x600（错误尺寸未被棘轮式固化）',
    `${afterRatchet.width}x${afterRatchet.height}`
  )

  console.log('\n【场景 3d】连续快速拖离：纠偏必须仍然发生')
  // 有界延时判据：连续多轮吸附/拖离，最后必须收敛回原始尺寸
  win.setBounds({ x: 300, y: topEdge + 400, width: 900, height: 600 })
  await sleep(600)
  for (let i = 0; i < 5; i++) {
    await dragTo(win, topEdge, { stepMs: 20 })
    await sleep(120)
    await dragTo(win, topEdge + 380, { stepMs: 20 })
    await sleep(120)
  }
  await sleep(1500)
  const afterBurst = win.getBounds()
  check(
    afterBurst.width === 900 && afterBurst.height === 600,
    '连续 5 轮快速拖离后尺寸收敛回 900x600',
    `${afterBurst.width}x${afterBurst.height}`
  )
  check(!win.isMaximized(), '连续快速操作后未卡在最大化', `max=${win.isMaximized()}`)

  console.log('\n【场景 3e】悬挂期内用户缩放：纠偏必须让位，不得覆盖用户操作')
  await dragTo(win, topEdge, { stepMs: 20 })
  await sleep(500)
  await dragTo(win, topEdge + 380, { stepMs: 20 })
  // 拖离后立刻模拟用户边缘缩放（ResizeHandles 走同一 setBounds 通道），
  // 使其明显晚于 WM 的恢复几何（超过让位阈值）
  await sleep(260)
  for (const h of [660, 720, 760]) {
    win.setBounds({ x: 300, y: topEdge + 380, width: 900, height: h })
    await sleep(60)
  }
  const userSize = win.getBounds()
  await sleep(1200) // 越过纠偏延时
  const afterUser = win.getBounds()
  check(
    afterUser.height === userSize.height && afterUser.width === userSize.width,
    '用户缩放结果未被纠偏覆盖',
    `用户设为 ${userSize.width}x${userSize.height} → 最终 ${afterUser.width}x${afterUser.height}`
  )

  console.log('\n【场景 4】最大化后静止稳定；手动还原不被误伤')
  await dragTo(win, topEdge)
  await sleep(700)
  check(win.isMaximized(), '再次触顶能最大化', `max=${win.isMaximized()}`)
  const still = watchFlips(win)
  await sleep(1200)
  check(still.stop() === 0, '最大化后静止 1.2s 无翻转', `翻转=${still.flips}`)

  console.log('\n【场景 5】还原后再次触顶 → 重新吸附')
  win.unmaximize()
  await sleep(500)
  check(!win.isMaximized(), '已还原')
  await dragTo(win, topEdge + 360)
  await dragTo(win, topEdge)
  await sleep(700)
  check(win.isMaximized(), '第二次触顶同样最大化', `max=${win.isMaximized()}`)

  console.log('\n【场景 6】启动时窗口就在顶边 → 不误判')
  const atTop = makeWindow(260, topEdge, 'EDGESNAP-ATTOP')
  attachEdgeSnap(atTop)
  await sleep(1400)
  check(!atTop.isMaximized(), '启动即贴顶不会自动最大化（未上膛）', `max=${atTop.isMaximized()}`)
  await dragTo(atTop, topEdge + 420)
  await dragTo(atTop, topEdge)
  await sleep(700)
  check(atTop.isMaximized(), '离开后再触顶能最大化', `max=${atTop.isMaximized()}`)

  console.log('\n【场景 7】对照：不挂 edgeSnap，WM 不会自己接管贴顶（证明修复必要）')
  const ctrl = makeWindow(260, topEdge + 560, 'EDGESNAP-CONTROL')
  const ctrlMax = watchFlips(ctrl)
  await sleep(1500)
  await dragTo(ctrl, topEdge)
  await sleep(900)
  check(
    !ctrl.isMaximized() && ctrlMax.stop() === 0,
    '无 edgeSnap 时拖到顶边不最大化（WM 未接管）',
    `max=${ctrl.isMaximized()} 翻转=${ctrlMax.flips} bounds=${JSON.stringify(ctrl.getBounds())}`
  )

  win.destroy()
  atTop.destroy()
  ctrl.destroy()
  console.log('\n' + (failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`))
  app.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('冒烟测试异常退出:', err)
  app.exit(1)
})