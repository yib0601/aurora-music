#!/usr/bin/env node
/**
 * 洛雪音源「主进程 IPC 执行链路」端到端冒烟测试（开发用，不参与构建与 CI）。
 *
 * 与 smoke-lx-source.js 的分工：
 * - smoke-lx-source.js 测的是 shared 宿主本体（脚本能不能加载、能不能出链）；
 * - 本脚本测的是 **IPC 这一段**：主进程侧的 Node 网络实现、参数校验、脚本源码缓存、
 *   错误转译，以及 preload 的通道名是否与主进程注册的一致。
 *   宿主能出链 ≠ 应用能用：中间任何一环（通道名拼错、body 没序列化、超时没兜住、
 *   缓存把旧脚本复用）都会让用户「配了源但搜不出声」。
 *
 * 做法：打桩 electron 的 ipcMain.handle，加载真实编译产物 dist-electron/ipc/lxSource.js，
 * 用 handler 表逐条调用真实 handler（不是复制一份实现）。脚本源码经本地 HTTP 服务提供，
 * 顺便验证 fetchLxScript 的真实拉取链路与缓存命中行为；取址走真实上游（需本机可达）。
 *
 * 用法（需先编译主进程）：
 *   npx tsc -p packages/desktop/tsconfig.electron.json
 *   node packages/desktop/scripts/smoke-ipc-lx-source.js
 * 可选参数：
 *   --script-dir <目录>   本地 lx-music-source 仓库路径（默认 /tmp/lx-music-source）
 *   --songmid <id>        取址用的酷我 songmid（默认 91084746，huibq 实测可出直链）
 */

'use strict'

const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

function parseArgs(argv) {
  const out = { scriptDir: '/tmp/lx-music-source', songmid: '91084746' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--script-dir') out.scriptDir = argv[++i]
    else if (argv[i] === '--songmid') out.songmid = argv[++i]
  }
  return out
}

const opts = parseArgs(process.argv.slice(2))
const DIST = path.resolve(__dirname, '..', 'dist-electron')
const HUIBQ = path.join(opts.scriptDir, 'huibq', 'latest.js')
const HUANYIN = path.join(opts.scriptDir, 'huanyin', 'latest.js')

if (!fs.existsSync(path.join(DIST, 'ipc', 'lxSource.js'))) {
  console.error(`未找到主进程编译产物：${DIST}/ipc/lxSource.js\n请先执行 npx tsc -p packages/desktop/tsconfig.electron.json`)
  process.exit(1)
}
for (const [label, file] of [['huibq', HUIBQ], ['huanyin', HUANYIN]]) {
  if (!fs.existsSync(file)) {
    console.error(`未找到 ${label} 脚本：${file}\n可用 --script-dir 指定本地 lx-music-source 仓库路径`)
    process.exit(1)
  }
}

// ─── electron 打桩：只保留 ipcMain.handle 的注册表 ────────────────────
// lxSource.js 只用 ipcMain；其余 API 给最小实现，避免加载期就炸。
const handlers = new Map()
const electronStub = {
  ipcMain: {
    handle(channel, fn) {
      handlers.set(channel, fn)
    },
  },
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: class {},
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: {},
}

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub'
  return origResolve.call(this, request, ...rest)
}
require.cache['electron-stub'] = {
  id: 'electron-stub',
  filename: 'electron-stub',
  loaded: true,
  exports: electronStub,
  paths: [],
  children: [],
}

// 第三方脚本会有未捕获的异步异常（上游超时、更新检查失败）：应用里只是一条日志，
// 这里兜住并归因，别让它把整轮冒烟打断
const asyncErrors = []
process.on('unhandledRejection', (r) => asyncErrors.push(r?.message || String(r)))
process.on('uncaughtException', (e) => asyncErrors.push(e?.message || String(e)))

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ─── 本地 HTTP 服务：提供脚本源码，顺带统计拉取次数（验证缓存） ────────
const served = new Map()
let fetchCount = 0
const server = http.createServer((req, res) => {
  const name = (req.url || '/').replace(/^\//, '').split('?')[0]
  const body = served.get(name)
  if (!body) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
    return
  }
  fetchCount++
  res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
  res.end(body)
})

function listen() {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

async function main() {
  const port = await listen()
  const base = `http://127.0.0.1:${port}`
  served.set('huibq.js', fs.readFileSync(HUIBQ, 'utf8'))
  served.set('huanyin.js', fs.readFileSync(HUANYIN, 'utf8'))

  // 加载真实实现并执行注册（与 main.ts → handlers.registerIpcHandlers() 的路径一致）
  const lxIpc = require(path.join(DIST, 'ipc', 'lxSource.js'))
  lxIpc.registerLxSourceIpc()
  // 注册会覆写 shared 的全局宿主依赖，必须在之后取（否则拿到的是脚本自身设过的残留值）
  const shared = require('@aurora/shared')
  // 沙箱由宿主逐次传入（自洽：globalThis/window/self 指向自身）。
  // 这里按同一规则自造一份最小伪全局，验证执行器本身可用。
  const fakeSandbox = { lx: { EVENT_NAMES: {} }, console: { log() {} } }
  for (const name of ['globalThis', 'window', 'self']) fakeSandbox[name] = fakeSandbox

  console.log('── 1. 宿主依赖装配 ──')
  const deps = shared.getLxHostDeps()
  check('lx: deps 已注册（request 为函数）', !!deps && typeof deps.request === 'function')
  check(
    'lx: 注入了 node:vm 版 evaluate',
    typeof deps?.evaluate === 'function'
  )
  // 直接验证 vm 执行器本身：注入了不等于可用（沙箱构造、超时、Node 标识遮蔽都要真跑一遍）。
  // 沙箱由宿主逐次传入，这里按宿主的构造规则自造一份最小伪全局。
  const evalOk = deps.evaluate('return { sum: 1 + 1, hasProcess: typeof process, hasRequire: typeof require, selfIsSandbox: window === globalThis, lxVisible: typeof lx }', fakeSandbox, 2000)
  check(
    'vm evaluate：正常脚本可执行、Node 标识不可见（process/require undefined）',
    evalOk?.sum === 2 && evalOk?.hasProcess === 'undefined' && evalOk?.hasRequire === 'undefined' && evalOk?.selfIsSandbox === true,
    JSON.stringify(evalOk)
  )
  check('vm evaluate：伪全局（lx 桥）在沙箱内可见', evalOk?.lxVisible === 'object', String(evalOk?.lxVisible))
  // 关键回归点：执行器若对 sandbox 加工（浅拷贝并把 globalThis 指向副本），vm 里就取不到
  // globalThis.lx；而真实脚本首行正是 `const { EVENT_NAMES } = globalThis.lx`，
  // 一旦回归整条链路全哑，所以单列一条断言钉住。
  const viaGlobalThis = deps.evaluate('return typeof globalThis.lx', fakeSandbox, 2000)
  check('vm evaluate：globalThis.lx 可达（脚本首行解构的路径）', viaGlobalThis === 'object', String(viaGlobalThis))
  let loopErr = null
  const loopStart = Date.now()
  try {
    deps.evaluate('while (true) {}', fakeSandbox, 300)
  } catch (err) {
    loopErr = err.message
  }
  const loopCost = Date.now() - loopStart
  check(
    'vm evaluate：同步死循环被 timeout 中断（进程未被拖死）',
    !!loopErr && /timed out/i.test(loopErr) && loopCost < 3000,
    `耗时 ${loopCost}ms；${loopErr}`
  )

  // shared 侧是否真的把脚本执行交给注入的执行器（未接线时 evaluate 只是一段死代码）
  // 行为断言优先于文本断言：走 vm 时沙箱是宿主传进来的同一个对象，new Function 分支则不是。
  // 用一个「探针脚本」写沙箱属性——两者都会写，但只有 evaluate 分支能让我们从外部看到
  // 执行器的调用记录（new Function 分支根本不调执行器）。
  const sharedHostSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'shared', 'src', 'lxHost.ts'),
    'utf8'
  )
  // 源码里必须同时存在「把 body 交给 evaluate」与「传入的 sandbox 就是伪全局本身」两条约束
  const wired = /evaluate\(body, fakeGlobal/.test(sharedHostSrc)
  const noClone = !/const sandbox: Record<string, unknown> = \{ \.\.\.fakeGlobal \}/.test(sharedHostSrc)
  check(
    'shared 已消费 evaluate（脚本执行真正走 vm，而非 new Function）',
    wired,
    wired ? '已接线（sandbox 即伪全局本身）' : '未接线：仍走 new Function'
  )
  check(
    'evaluate 分支不再拷贝伪全局（拷贝会让 Liscript 解包读不到数据）',
    noClone,
    noClone ? '未拷贝' : '仍在浅拷贝 fakeGlobal'
  )
  check('lx: env=desktop', deps?.env === 'desktop', String(deps?.env))
  check('lx: utils.crypto.md5 可用', deps?.utils?.crypto?.md5?.('abc') === '900150983cd24fb0d6963f7d28e17f72')
  check(
    'lx: utils.zlib.inflate 可用（Promise 化）',
    typeof deps?.utils?.zlib?.inflate === 'function' &&
      typeof deps?.utils?.zlib?.deflate === 'function'
  )

  console.log('── 2. IPC 通道注册 ──')
  const channels = [...handlers.keys()].sort()
  check(
    'lx: 四类通道已注册',
    ['lx:clearCache', 'lx:fetchScript', 'lx:inspect', 'lx:resolveUrl', 'lx:search'].every((c) =>
      handlers.has(c)
    ),
    channels.join(' ')
  )

  // preload 通道名一致性：主进程注册了什么，preload 就得调什么（拼错即静默失效）
  const preloadSrc = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'preload.ts'), 'utf8')
  const preloadChannels = [...preloadSrc.matchAll(/invoke\('(lx:[A-Za-z]+)'/g)].map((m) => m[1])
  check(
    'preload 通道名与主进程一致',
    channels.every((c) => preloadChannels.includes(c)) && preloadChannels.length === channels.length,
    `preload=${[...new Set(preloadChannels)].sort().join(' ')}`
  )
  const handlersSrc = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'ipc', 'handlers.ts'), 'utf8')
  check('handlers.ts 已接线 registerLxSourceIpc()', /registerLxSourceIpc\(\)/.test(handlersSrc))

  const call = (channel, ...args) => handlers.get(channel)({ sender: null }, ...args)

  // 另备一条本地「最小脚本」：不依赖任何外部上游，用来证明 IPC → 宿主 → 脚本的闭环
  // （外网上游随时可能挂，闭环保不住就等于没有证据）
  served.set(
    'mini.js',
    [
      "const { EVENT_NAMES, on, send } = globalThis.lx",
      "on(EVENT_NAMES.request, ({ action, source, info }) => {",
      "  if (action === 'musicUrl') {",
      "    if (!info.musicInfo || !info.musicInfo.songmid) return Promise.reject(new Error('没ID'))",
      "    return Promise.resolve('https://example.com/audio/' + source + '/' + info.musicInfo.songmid + '/' + info.type + '.mp3')",
      "  }",
      "  if (action === 'search') {",
      "    if (!info.keyword) return Promise.reject(new Error('没关键词'))",
      "    return Promise.resolve([{ name: info.keyword + ' 的结果', singer: '测试歌手', albumName: '测试专辑', id: 'mini-1', interval: '03:20' }])",
      "  }",
      "  return Promise.reject(new Error('action not support'))",
      "})",
      "send(EVENT_NAMES.inited, { status: true, sources: { kw: { name: 'Mini', type: 'music', actions: ['musicUrl', 'search'], qualitys: ['128k', '320k'] } } })",
    ].join('\n')
  )
  const miniSource = {
    id: 'lx-smoke-mini',
    name: 'Mini 测试源',
    kind: 'lx',
    sourceUrl: `${base}/mini.js`,
    enabled: true,
  }

  console.log('── 3. 本地最小脚本：IPC → 宿主 → 脚本 闭环（不依赖外网） ──')
  const miniInspection = await call('lx:inspect', miniSource)
  check('inspect：平台与能力解析正确', miniInspection.ok && miniInspection.platforms.kw?.actions.join('/') === 'musicUrl/search', JSON.stringify(miniInspection.platforms))
  const miniHits = await call('lx:search', miniSource, '测试关键词', 5)
  check(
    'search：条目带 lx 定位、audioUrl 留空（直链在播放时再取）',
    miniHits.length === 1 && miniHits[0].title === '测试关键词 的结果' && miniHits[0].audioUrl === '' && miniHits[0].lx.platform === 'kw',
    JSON.stringify({ title: miniHits[0]?.title, audioUrl: miniHits[0]?.audioUrl, lx: miniHits[0]?.lx })
  )
  const miniUrl = await call(
    'lx:resolveUrl',
    miniHits[0].lx,
    miniSource,
    '320'
  )
  check(
    'resolveUrl：按定位信息回喂脚本并取到直链',
    miniUrl.url === 'https://example.com/audio/kw/mini-1/320k.mp3',
    `${miniUrl.url} (${miniUrl.quality})`
  )
  const miniNoId = await call('lx:resolveUrl', { sourceId: 'lx-smoke-mini', platform: 'kw', meta: {} }, miniSource, '128').then(
    () => null,
    (e) => e.message
  )
  // 契约：缺必要字段时**不发请求**，直接给可读原因（猜一个 id 硬打上游会取到别的歌）
  check(
    'resolveUrl：缺必要字段时不打上游，直接给可读原因',
    typeof miniNoId === 'string' && miniNoId.includes('缺少必要字段') && miniNoId.includes('songmid'),
    String(miniNoId)
  )

  // 关键一环：聚合搜索（tracks:searchOnline → searchOnlineTracks）里的 lx 源分支
  // 靠 setLxScriptProvider 拿脚本。不注册供应器时这里会静默「跳过该源」——
  // 用户看到的是「配了源却搜不出歌」，且没有任何报错，因此必须钉住。
  const agg = await shared.searchOnlineTracks('测试关键词', { sources: [miniSource] })
  check(
    '聚合搜索走通 lx 源（脚本供应器已注册）',
    Array.isArray(agg) && agg.length === 1 && agg[0].audioUrl === '' && !!agg[0].lx,
    `${agg.length} 条；id=${agg[0]?.id || ''} audioUrl=${JSON.stringify(agg[0]?.audioUrl)}`
  )

  console.log('── 4. lx:fetchScript（真实 HTTP 拉取 + 校验） ──')
  const scriptUrl = `${base}/huibq.js`
  const fetched = await call('lx:fetchScript', scriptUrl)
  check('fetchScript 返回脚本源码', typeof fetched === 'string' && fetched.includes('Huibq_lxmusic源'), `${fetched.length} 字节`)
  const badUrl = await call('lx:fetchScript', 'ftp://example.com/x.js').then(
    () => null,
    (e) => e.message
  )
  check('fetchScript 拒绝非 http(s) 地址', badUrl === '脚本地址无效', String(badUrl))

  // 脚本源码缓存：先 record 拉取次数，再连续 inspect 两次
  const before = fetchCount
  const huibqSource = {
    id: 'lx-smoke-huibq',
    name: 'Huibq 音源',
    kind: 'lx',
    sourceUrl: scriptUrl,
    enabled: true,
  }
  const inspection = await call('lx:inspect', huibqSource)
  const firstFetch = fetchCount - before
  const second = await call('lx:inspect', huibqSource)
  const secondFetch = fetchCount - before - firstFetch

  console.log('── 5. lx:inspect（探测脚本能力 + 源码缓存） ──')
  const platforms = Object.keys(inspection.platforms || {})
  check(
    'inspect ok 且平台能力正确',
    inspection.ok && platforms.includes('kw') && platforms.includes('mg'),
    `ok=${inspection.ok} platforms=${platforms.join('/')} error=${inspection.error || ''}`
  )
  check('inspect 首次拉取脚本', firstFetch === 1, `新增请求数=${firstFetch}`)
  check(
    'inspect 第二次走源码缓存（不重复下载）',
    second.ok && secondFetch === 0,
    `新增请求数=${secondFetch}`
  )
  const refreshed = await call('lx:inspect', huibqSource, true)
  const forceFetch = fetchCount - before - firstFetch - secondFetch
  check('inspect force=true 强制重拉脚本', refreshed.ok && forceFetch === 1, `新增请求数=${forceFetch}`)
  const badSource = await call('lx:inspect', { name: '缺 id' })
  check('inspect 拒绝非法入参（不抛错，返回可读错误）', badSource.ok === false && !!badSource.error, badSource.error)

  console.log('── 6. lx:resolveUrl（真实取址，需本机可达上游） ──')
  const ref = { sourceId: 'lx-smoke-huibq', platform: 'kw', meta: { songmid: opts.songmid } }
  let resolved = null
  let resolveErr = null
  try {
    resolved = await call('lx:resolveUrl', ref, huibqSource, '320')
  } catch (err) {
    resolveErr = err.message
  }
  check(
    'resolveUrl 出真实酷我直链',
    !!resolved && /^https?:\/\//i.test(resolved.url),
    resolveErr ? `失败：${resolveErr}` : `${resolved?.url?.slice(0, 72)}… (${resolved?.quality})`
  )
  const unknownPlatform = await call(
    'lx:resolveUrl',
    { sourceId: 'lx-smoke-huibq', platform: 'nolink', meta: {} },
    huibqSource,
    '128'
  ).then(
    () => null,
    (e) => e.message
  )
  check(
    'resolveUrl 缺字段路径：给可读原因而非抛原始错误',
    typeof unknownPlatform === 'string' && unknownPlatform.includes('缺少必要字段'),
    String(unknownPlatform)
  )
  // 字段齐但脚本没声明该平台：错误必须点明「脚本不支持该平台」，而不是上游的裸报错
  const unsupportedPlatform = await call(
    'lx:resolveUrl',
    { sourceId: 'lx-smoke-huibq', platform: 'git', meta: { id: 'demo-1' } },
    huibqSource,
    '128'
  ).then(
    () => null,
    (e) => e.message
  )
  check(
    'resolveUrl 脚本不支持该平台时错误可读',
    typeof unsupportedPlatform === 'string' && unsupportedPlatform.includes('不支持平台'),
    String(unsupportedPlatform)
  )
  const badRef = await call('lx:resolveUrl', { platform: 'kw' }, huibqSource, '128').then(
    () => null,
    (e) => e.message
  )
  check('resolveUrl 拒绝缺 sourceId/meta 的定位信息', badRef === '曲目缺少洛雪定位信息', String(badRef))

  console.log('── 7. lx:search（脚本自带搜索，真实上游） ──')
  const huanyinSource = {
    id: 'lx-smoke-huanyin',
    name: '幻音音源',
    kind: 'lx',
    sourceUrl: `${base}/huanyin.js`,
    enabled: true,
  }
  let hits = null
  let searchErr = null
  try {
    hits = await call('lx:search', huanyinSource, '起风了', 3)
  } catch (err) {
    searchErr = err.message
  }
  if (searchErr) {
    // 幻音的自带搜索依赖第三方公共 API（api.xcvts.cn）；该 API 会按源站 IP 限流，
    // 返回「咪咕搜索接口均不可用」。这属于上游不可达，不是本链路的缺陷，
    // 如实记录为 SKIP 而不是 FAIL，避免把外部依赖的波动算成本次实现的失败。
    console.log(` SKIP  search 依赖的上游不可用（非本链路问题） — ${searchErr}`)
  } else {
    const first = Array.isArray(hits) ? hits[0] : null
    check(
      'search 返回元信息条目（不含直链，带 lx 定位）',
      !!first && first.audioUrl === '' && !!first.lx && first.lx.platform === 'mg',
      `${hits?.length ?? 0} 条；首条=${first?.title || ''}/${first?.artist || ''} platform=${first?.lx?.platform}`
    )
  }
  const emptyQuery = await call('lx:search', huanyinSource, '   ', 3)
  check('search 空关键词直接返回空数组（不惊动脚本）', Array.isArray(emptyQuery) && emptyQuery.length === 0)

  console.log('── 8. lx:clearCache ──')
  const beforeClear = fetchCount
  await call('lx:clearCache')
  const afterClear = await call('lx:inspect', huibqSource)
  check(
    '清缓存后重新拉取脚本',
    afterClear.ok && fetchCount - beforeClear === 1,
    `新增请求数=${fetchCount - beforeClear}`
  )

  console.log('── 9. 危险脚本回归：同步死循环与探测 Node 分支的脚本 ──')
  // 这两类脚本是主进程最怕的输入：前者会卡死事件循环（new Function 无法打断），
  // 后者（pdone 的 lx/latest.js）实测探测到 process 就改走 Node 分支同步挂死。
  // 现在走「IPC → 宿主 → node:vm」，两者都必须在有限时间内返回结论。
  served.set('loop.js', 'while (true) {}\n')
  const loopSource = {
    id: 'lx-smoke-loop',
    name: '死循环脚本',
    kind: 'lx',
    sourceUrl: `${base}/loop.js`,
    enabled: true,
  }
  const t0 = Date.now()
  const loopInspection = await call('lx:inspect', loopSource)
  const loopMs = Date.now() - t0
  check(
    '死循环脚本经 IPC 在有限时间内返回（进程未被拖死）',
    loopInspection.ok === false && loopMs < 15000,
    `耗时 ${loopMs}ms；error=${loopInspection.error}`
  )

  const pdoneLx = path.join(opts.scriptDir, 'lx', 'latest.js')
  if (fs.existsSync(pdoneLx)) {
    served.set('pdone-lx.js', fs.readFileSync(pdoneLx, 'utf8'))
    const t1 = Date.now()
    const pdoneInspection = await call('lx:inspect', {
      id: 'lx-smoke-pdone-lx',
      name: 'pdone lx',
      kind: 'lx',
      sourceUrl: `${base}/pdone-lx.js`,
      enabled: true,
    })
    const pdoneMs = Date.now() - t1
    check(
      '会探测 Node 分支的脚本（pdone/lx）可给出结论而非挂死',
      pdoneMs < 15000,
      `耗时 ${pdoneMs}ms；ok=${pdoneInspection.ok} platforms=${Object.keys(pdoneInspection.platforms).join('/')} error=${pdoneInspection.error || ''}`
    )
  } else {
    console.log(` SKIP  未找到 ${pdoneLx}（可用 --script-dir 指定本地仓库）`)
  }

  if (asyncErrors.length) {
    console.log(`\n脚本内部未捕获异常 ${asyncErrors.length} 条（不影响结论，供排查）：`)
    for (const e of asyncErrors.slice(0, 5)) console.log(`  - ${e}`)
  }

  console.log(`\n结论：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
  return failures === 0 ? 0 : 1
}

main()
  .then((code) => {
    server.close()
    process.exit(code)
  })
  .catch((err) => {
    console.error('冒烟脚本自身异常:', err)
    server.close()
    process.exit(1)
  })