#!/usr/bin/env node
/**
 * 顶边吸附（edgeSnap）端到端冒烟测试。
 *
 * 为什么需要它：无边框窗没有 WM 标题栏，拖到屏幕顶部不会触发 GNOME 的贴顶，
 * 修复落在主进程的 edgeSnap.ts。该模块的判据是「窗口 bounds 顶边贴到显示器顶边」，
 * 本次会话里指针注入（XTEST / XWarpPointer / uinput 三条路径）在本机全部失效，
 * 无法用合成鼠标做人工拖动；但实测 WM 移动窗口产生的 ConfigureNotify 同样会触发
 * Electron 的 `move` 事件，因此用 `xdotool windowmove` 驱动真实窗口移动，
 * 就能走完与真实拖动完全相同的判据链路。
 *
 * 覆盖场景：
 *   1) 未到顶边 → 不触发
 *   2) 拖到顶边 → 最大化
 *   3) 最大化后静止 → 不抖动（不陷入 maximize/unmaximize 自激循环）
 *   4) 还原后再次拖到顶边 → 再次最大化（armed 重新上膛）
 *   5) 启动时窗口就在顶边 → 不误判（初始未上膛）
 *
 * 用法：pnpm --filter @aurora/desktop smoke:edge-snap
 * 前置：`npx tsc -p tsconfig.electron.json` 已编译主进程；
 *       需要一个可用的 X11 显示（本机走 --ozone-platform=x11，同 .desktop 的 Exec）。
 */

'use strict'

const { app, BrowserWindow, screen } = require('electron')
const { execFileSync } = require('node:child_process')
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

function xid(win) {
  return win.getNativeWindowHandle().readUInt32LE(0)
}

function moveTo(win, x, y) {
  execFileSync('xdotool', ['windowmove', '--sync', String(xid(win)), String(x), String(y)], {
    env: process.env,
    timeout: 8000,
  })
}

/** 与 main.ts 的 createWindow 同构：无边框 + 不透明 + thickFrame:false */
function makeWindow(x, y, title) {
  return new BrowserWindow({
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
  })
}

async function main() {
  await app.whenReady()

  const display = screen.getPrimaryDisplay()
  const topEdge = display.workArea.y
  console.log(`\n显示器: bounds=${JSON.stringify(display.bounds)} workArea=${JSON.stringify(display.workArea)} topEdge=${topEdge}`)
  if (!process.env.DISPLAY) {
    console.log('!! 没有 DISPLAY：本测试需要 X11（--ozone-platform=x11）')
    app.exit(1)
    return
  }

  // ─── 场景 1-4：同一个窗口 ───
  console.log('\n【场景 1】未到顶边不触发')
  const win = makeWindow(240, 520, 'EDGESNAP-MAIN')
  attachEdgeSnap(win)
  await sleep(900)
  check(!win.isMaximized(), '初始状态未最大化', `max=${win.isMaximized()}`)

  moveTo(win, 240, topEdge + 220)
  await sleep(400)
  check(!win.isMaximized(), '停在半空不触发最大化', `bounds=${JSON.stringify(win.getBounds())}`)

  console.log('\n【场景 2】拖到顶边 → 最大化')
  // 分步逼近，模拟真实拖动经过顶边
  for (const y of [topEdge + 120, topEdge + 40, topEdge + 8, topEdge, topEdge]) {
    moveTo(win, 240, y)
    await sleep(180)
  }
  await sleep(600)
  check(win.isMaximized(), '触顶后窗口已最大化', `max=${win.isMaximized()} bounds=${JSON.stringify(win.getBounds())}`)

  console.log('\n【场景 3】最大化后静止不抖动')
  const before = JSON.stringify(win.getBounds())
  let flips = 0
  const onFlip = () => flips++
  win.on('maximize', onFlip)
  win.on('unmaximize', onFlip)
  await sleep(1200)
  win.removeListener('maximize', onFlip)
  win.removeListener('unmaximize', onFlip)
  check(flips === 0, '1.2s 内没有 maximize/unmaximize 反复', `翻转次数=${flips}`)
  check(JSON.stringify(win.getBounds()) === before, '几何保持稳定', `${before} -> ${JSON.stringify(win.getBounds())}`)

  console.log('\n【场景 4】还原后再次触顶 → 再次最大化')
  win.unmaximize()
  await sleep(500)
  check(!win.isMaximized(), '已还原', `max=${win.isMaximized()}`)
  moveTo(win, 260, topEdge + 300)
  await sleep(400)
  check(!win.isMaximized(), '离开顶边仍不触发', `max=${win.isMaximized()}`)
  moveTo(win, 260, topEdge)
  await sleep(800)
  check(win.isMaximized(), '第二次触顶同样最大化', `max=${win.isMaximized()}`)

  // ─── 场景 5：启动即在顶边 ───
  console.log('\n【场景 5】启动时窗口就在顶边 → 不误判')
  const atTop = makeWindow(240, topEdge, 'EDGESNAP-ATTOP')
  attachEdgeSnap(atTop)
  await sleep(1000)
  check(!atTop.isMaximized(), '启动即贴顶不会自动最大化（未上膛）', `max=${atTop.isMaximized()}`)

  console.log('\n【场景 5b】该窗口先离开再回来 → 正常吸附')
  moveTo(atTop, 240, topEdge + 320)
  await sleep(400)
  moveTo(atTop, 240, topEdge)
  await sleep(800)
  check(atTop.isMaximized(), '离开后再触顶能最大化', `max=${atTop.isMaximized()}`)

  win.destroy()
  atTop.destroy()
  console.log('\n' + (failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`))
  app.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('冒烟测试异常退出:', err)
  app.exit(1)
})