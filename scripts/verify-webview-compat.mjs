#!/usr/bin/env node
/**
 * 车机旧 WebView 兼容回归锁
 * ---------------------------------------------------------------------------
 * 病灶（2026-10 车机歌曲列表整片白块事故）：
 *   tailwind v3.4 的 preflight 把按钮复位写成
 *     button, input:where([type=button]), input:where([type=reset]), input:where([type=submit]) { background-color: transparent; … }
 *   CSS 对**选择器列表**是全有或全无：解析不出 `:where()` 的车机 WebView（实测
 *   落在 Chrome 84–87 区间：`rgb(var(--tw-x) / .a)`、flex gap 生效，`:where()` 不生效）
 *   判定该选择器无效，于是**整条规则连其中本来有效的 `button` 一起被丢弃**。
 *   裸 <button> 因此失去作者背景声明，回落 UA 默认 buttonface（浅灰白 #EFEFEF）；
 *   曲目列表每行恰好都是裸 <button>，整张表就成了一片白块，白底白字还把歌名、
 *   歌手、时长全吃掉。
 *
 *   globals.css 补了一条不含 `:where()` 的同义复位（`button, input[type='button'] …`）。
 *   本脚本是它的回归锁：兜底被删、被重构成含 `:where()` 的写法、或产物 CSS 里的
 *   规则顺序被打乱（兜底跑到 preflight 之前）时立刻失败。
 *
 *   node scripts/verify-webview-compat.mjs            静态断言（CI / pnpm verify:webview）
 *   node scripts/verify-webview-compat.mjs --render   额外用本机 Chrome 渲染对照复现
 *
 * 运行前提：先构建过前端（`pnpm --filter @aurora/app build`），脚本读 packages/app/dist
 * 里最新的 index-*.css —— 只有产物 CSS 才能反映「浏览器实际看到的那份规则」。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS_DIR = join(ROOT, 'packages/app/dist/assets')
const CHROME = process.env.CHROME_BIN || 'google-chrome-stable'
const wantRender = process.argv.includes('--render')

const fail = (msg) => {
  console.error(`✗ ${msg}`)
  process.exitCode = 1
}
const ok = (msg) => console.log(`✓ ${msg}`)
const info = (msg) => console.log(`· ${msg}`)

/** 取最新一次 vite build 的产物 CSS */
function latestCss() {
  if (!existsSync(ASSETS_DIR)) return null
  const files = readdirSync(ASSETS_DIR)
    .filter((f) => /^index-.*\.css$/.test(f))
    .map((f) => ({ path: join(ASSETS_DIR, f), mtime: statSync(join(ASSETS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return files.length ? files[0].path : null
}

/** 从 '{' 位置找到配对的 '}'（跳过字符串字面量） */
function matchingBrace(css, open) {
  let depth = 0
  for (let i = open; i < css.length; i++) {
    const ch = css[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      i++
      while (i < css.length && css[i] !== quote) {
        if (css[i] === '\\') i++
        i++
      }
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return css.length - 1
}

/** 抽出顶层规则（at-rule 只保留头，不递归），保持文件顺序 */
function topLevelRules(css) {
  const rules = []
  let i = 0
  let segStart = 0
  while (i < css.length) {
    if (css[i] === '{') {
      const selector = css.slice(segStart, i).trim()
      const close = matchingBrace(css, i)
      rules.push({ selector, body: css.slice(i + 1, close) })
      i = close + 1
      segStart = i
    } else {
      i++
    }
  }
  return rules
}

/** 丢弃「选择器列表含 :where( 」的整条规则，模拟不支持 :where() 的引擎（递归处理 @media 内部） */
function stripWhereRules(css) {
  let out = ''
  let i = 0
  let segStart = 0
  while (i < css.length) {
    if (css[i] === '{') {
      const selector = css.slice(segStart, i).trim()
      const close = matchingBrace(css, i)
      const inner = css.slice(i + 1, close)
      out += selector.startsWith('@')
        ? css.slice(segStart, i + 1) + stripWhereRules(inner) + '}'
        : selector.includes(':where(')
          ? ''
          : css.slice(segStart, close + 1)
      i = close + 1
      segStart = i
    } else {
      i++
    }
  }
  return out + css.slice(segStart)
}

// ── 静态断言 ────────────────────────────────────────────────────────────────
// --css=<path> 可指定产物 CSS（默认取 dist 里最新那份；断言脚本自身也用这个口子自测）
const cssArg = process.argv.find((a) => a.startsWith('--css='))
const cssPath = cssArg ? resolve(cssArg.slice('--css='.length)) : latestCss()
if (!cssPath) {
  fail('找不到构建产物 CSS（packages/app/dist/assets/index-*.css）：先跑 pnpm --filter @aurora/app build')
  process.exit(1)
}
info(`产物 CSS：${cssPath.replace(ROOT + '/', '')}`)
const css = readFileSync(cssPath, 'utf8')
const rules = topLevelRules(css)

const isButtonReset = (r) =>
  !r.selector.includes(':where(') &&
  r.selector.split(',').some((s) => s.trim() === 'button') &&
  /background-color:\s*transparent/.test(r.body)

const resetIndex = rules.findIndex(isButtonReset)
const preflightIndex = rules.findIndex((r) => /button[^{]*:where\(\[type=button\]\)/.test(r.selector))

if (resetIndex < 0) {
  fail(
    '产物 CSS 里没有「不含 :where() 的 button 背景复位」——\n' +
      '  车机旧 WebView 会因此把裸 <button> 画成 UA 默认底色（歌曲列表整片白块）。\n' +
      '  兜底见 packages/app/src/styles/globals.css 的「老 WebView 的按钮背景兜底」块。'
  )
} else {
  ok('存在不含 :where() 的 button 背景复位（车机兜底在位）')
  if (/background-color:\s*transparent/.test(rules[resetIndex].body)) ok('兜底声明 background-color: transparent')
  if (preflightIndex >= 0 && resetIndex < preflightIndex) {
    fail(`兜底规则排在第 ${resetIndex + 1} 条，早于 preflight（第 ${preflightIndex + 1} 条）：同层会被后者反超`)
  } else if (preflightIndex >= 0) {
    ok('兜底排在 preflight 之后（同层后者生效，覆盖关系正确）')
  }
}

if (preflightIndex < 0) {
  info('preflight 里已找不到 `button,input:where([type=button])…`：上游若修掉了 :where() 写法，本条兜底可择机移除')
} else {
  info(`preflight 仍以 :where() 写选择器（第 ${preflightIndex + 1} 条）—— 车机必须依赖上面的兜底`)
}

// 断言：老引擎解析后，曲目行用的类仍在（怕有人顺手把 row-hover 也改写成 :where 写法）
const strippedCss = stripWhereRules(css)
for (const needle of ['.row-hover', '.bg-mint\\/\\[0\\.07\\]']) {
  if (!strippedCss.includes(needle)) fail(`老引擎解析（丢弃含 :where 的规则）后丢了 ${needle}`)
}

// ── 渲染对照（--render） ────────────────────────────────────────────────────
if (wantRender) {
  let chromeOk = true
  try {
    execFileSync(CHROME, ['--version'], { stdio: 'ignore' })
  } catch {
    chromeOk = false
    console.error(`✗ 找不到浏览器 ${CHROME}（可用 CHROME_BIN 指定）`)
    process.exitCode = 1
  }
  if (chromeOk) {
    const work = join(ROOT, '.tmp-verify-webview')
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, 'modern.css'), css)
    writeFileSync(join(work, 'legacy.css'), strippedCss.replace(/color-scheme\s*:\s*(dark|light)\s*;?/g, ''))

    const page = (cssHref) => `<!doctype html><html class="dark" data-ds-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="${cssHref}">
<style>body{margin:0;background:#0a1524}#probe{display:none}</style></head><body>
<ul class="flex flex-col">
  <li><button type="button" class="group row-hover w-full flex items-center gap-3 px-2 py-2 rounded-ds-sm text-left relative bg-mint/[0.07]">
    <span class="w-6 flex-shrink-0"></span><span class="w-9 h-9 rounded-ds-sm flex-shrink-0 bg-white/[0.06]"></span>
    <span class="flex-1 min-w-0"><span class="block text-mint">你的</span></span>
    <span class="w-12 text-right text-white/35">2:43</span></button></li>
  <li><button type="button" class="group row-hover w-full flex items-center gap-3 px-2 py-2 rounded-ds-sm text-left">
    <span class="w-6 flex-shrink-0"></span><span class="w-9 h-9 rounded-ds-sm flex-shrink-0 bg-white/[0.06]"></span>
    <span class="flex-1 min-w-0"><span class="block text-white/88">夏日漱石</span></span>
    <span class="w-12 text-right text-white/35">3:12</span></button></li>
</ul><pre id="probe"></pre>
<script>window.addEventListener('load',function(){
  var rows=[].map.call(document.querySelectorAll('ul button'),function(b){return getComputedStyle(b).backgroundColor})
  document.getElementById('probe').textContent='PROBE\\n'+rows.join('\\n')+'\\nPROBE'
})</script></body></html>`

    for (const tag of ['modern', 'legacy']) {
      writeFileSync(join(work, `page-${tag}.html`), page(`./${tag}.css`))
      const dump = execFileSync(
        CHROME,
        [
          '--headless=new',
          '--no-sandbox',
          '--disable-gpu',
          '--hide-scrollbars',
          '--window-size=1280,800',
          '--virtual-time-budget=3000',
          '--dump-dom',
          `file://${join(work, `page-${tag}.html`)}`,
        ],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
      )
      const bg = (dump.match(/PROBE\n([\s\S]*?)\nPROBE/)?.[1] || '').split('\n')
      // 判据只认「没有背景类的普通行」：它必须是 transparent。带上作者背景的当前播放行
      // （bg-mint/[0.07]）无论修复前后都是作者值，拿它当判据会把 rgba(0,245,212,.07) 误报成白块。
      const plain = bg[1]
      if (plain === 'rgba(0, 0, 0, 0)') {
        ok(`${tag}：无背景类的行按钮是作者背景（无 UA 默认底色）`)
      } else {
        fail(`${tag}：无背景类的行按钮落到了 ${plain} —— 车机上这就是那一整片白块`)
      }
    }
    info(`对照页留在 ${work.replace(ROOT + '/', '')}/，可直接用浏览器打开看渲染差异`)
  }
}

if (process.exitCode) console.error('\n车机 WebView 兼容锁未通过。')
else console.log('\n车机 WebView 兼容锁通过。')
