#!/usr/bin/env node
/**
 * 洛雪音源脚本宿主冒烟测试（开发用，不参与构建与 CI）。
 *
 * 为什么需要它：洛雪脚本是第三方不可控代码，能力与返回结构五花八门
 * （有的只做 musicUrl 取址，有的自带 search；有的经 Liscript 自解压包装，
 * 有的就是混淆后的明文）。用真脚本在真实宿主里跑一遍，才能在改宿主实现时
 * 立刻看出「哪个环节不再兼容」，而不是等用户配好源之后才发现搜不出歌。
 *
 * 覆盖：
 *   1) 加载 / 初始化：能否拿到 inited 并解析出平台能力
 *   2) 取址：向脚本喂一份真实定位信息，拿到 http(s) 直链
 *   3) 自带搜索：脚本声明 search / musicSearch 时，搜索结果能否归一化成元信息
 *   4) 错误路径：脚本缺字段 / 宿主未注册时给出可读错误而非崩溃
 *
 * 用法：
 *   # 本地脚本目录（已克隆的 lx-music-source 仓库）
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/smoke-lx-source.js --dir /tmp/lx-music-source
 *   # 指定单条脚本
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/smoke-lx-source.js --file /tmp/lx-music-source/huibq/latest.js \
 *     --platform kw --id 91084746
 *
 * 前置：packages/shared 已构建（pnpm --filter @aurora/shared build）。
 *
 * 实测基线（2026-10-07，pdone/lx-music-source 全量 10 条）。
 * 命令：`node scripts/smoke-lx-source.js --dir /tmp/lx-music-source --platform kw --id 91084746 --timeout 12000`
 * （--id 传一个真实上游曲目 id：脚本多数不做入参校验，按名取址会返回 id=undefined 的无效地址）
 *
 *   可加载 6/10：changqing / huanyin / huibq / ikun / lx / qdy
 *   取到直链且**实拉可播** 3 条（kw 平台，id=91084746）：
 *     changqing → yinyue.haitangw.net 中转 [206 audio/mpeg]
 *     huibq     → 酷我 CDN 直链 [206 audio/mpeg]
 *     qdy       → 酷我 CDN 直链 [206 application/octet-stream]
 *   取到直链但本机拉不动 1 条：huanyin → sayqz 中转 [fetch failed]（代理可达性差异，非宿主问题）
 *   加载失败 4 条：flower / grass / juhe（脚本初始化失败，需各自外部配置）、
 *                 sixyin（脚本自报「加载源信息失败」，需访问其站点）
 *   取址失败 2 条：ikun（依赖第三方公共 API，本机不可达）、lx（其自建服务签名协议 + 本机不可达）
 *
 * 说明：脚本自身的网络请求会经宿主发出，需要本机可访问对应上游；不可达时该条脚本会
 *       如实报失败，不影响其它脚本的结论。
 */

'use strict'

const path = require('node:path')
const fs = require('node:fs')

/**
 * 第三方脚本内部常有未捕获的异步异常（服务器异常、更新检查失败等）。
 * Node 默认把它们当致命错误终止进程，而应用里只是一条日志——
 * 这里一并兜住并归到「当前正在跑的脚本」名下，否则一条坏脚本会打断整轮冒烟。
 */
const asyncErrors = []
process.on('unhandledRejection', (reason) => {
  asyncErrors.push(reason && reason.message ? reason.message : String(reason))
})
process.on('uncaughtException', (err) => {
  asyncErrors.push(err && err.message ? err.message : String(err))
})

/** 解析命令行参数为 { dir, file, platform, id, quality, keyword, verbose, timeout } */
function parseArgs(argv) {
  const out = { quality: '128k', keyword: '起风了', verbose: false, timeout: 12000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') out.dir = argv[++i]
    else if (a === '--file') out.file = argv[++i]
    else if (a === '--platform') out.platform = argv[++i]
    else if (a === '--id') out.id = argv[++i]
    else if (a === '--quality') out.quality = argv[++i]
    else if (a === '--keyword') out.keyword = argv[++i]
    else if (a === '--verbose') out.verbose = true
    else if (a === '--timeout') out.timeout = Number(argv[++i]) || 12000
  }
  return out
}

/** 加载 @aurora/shared（优先用构建产物，缺则回落到源码编译入口） */
function loadShared() {
  const dist = path.resolve(__dirname, '../../shared/dist/index.js')
  if (!fs.existsSync(dist)) {
    console.error(`未找到 @aurora/shared 构建产物：${dist}\n请先执行 pnpm --filter @aurora/shared build`)
    process.exit(1)
  }
  return require(dist)
}

/** 宿主网络实现：与主进程侧同一套语义（fetch + AbortController，回调式） */
function createRequest() {
  return (url, options = {}, callback) => {
    const method = String(options.method || 'get').toUpperCase()
    const controller = new AbortController()
    const timeout = Math.min(Number(options.response_timeout || options.timeout || 20000) || 20000, 60000)
    const timer = setTimeout(() => controller.abort(), timeout)
    const headers = { ...(options.headers || {}) }
    let body = options.body
    if (body && typeof body === 'object') {
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json'
      body = JSON.stringify(body)
    }
    fetch(url, { method, headers, body, signal: controller.signal, redirect: 'follow' })
      .then(async (resp) => {
        const raw = await resp.text()
        let parsed = raw
        try {
          parsed = JSON.parse(raw)
        } catch {
          /* 保持文本 */
        }
        callback(null, {
          statusCode: resp.status,
          statusMessage: resp.statusText,
          headers: Object.fromEntries(resp.headers.entries()),
          bytes: Buffer.byteLength(raw),
          raw,
          body: parsed,
        })
      })
      .catch((err) => callback(err, null, null))
      .finally(() => clearTimeout(timer))
    return () => controller.abort()
  }
}

/**
 * 拉一小段验证链接是否真的可播：返回可读结论（供基线一眼分辨「真链 / 假地址」）。
 * 只取 1KB 且不落盘，代价可忽略；失败不抛错，按不可播记录。
 */
async function probeUrl(url) {
  try {
    const resp = await fetch(url, { headers: { Range: 'bytes=0-1023' }, redirect: 'follow' })
    const ct = (resp.headers.get('content-type') || '').split(';')[0]
    if (![200, 206].includes(resp.status)) return `不可播 HTTP ${resp.status}`
    const buf = await resp.arrayBuffer()
    if (buf.byteLength === 0) return '不可播 空响应'
    return /audio|octet-stream|mpeg/i.test(ct) ? `可播 ${resp.status} ${ct}` : `可疑 ${resp.status} ${ct || '无类型'}`
  } catch (err) {
    return `不可播 ${(err && err.message) || '请求失败'}`
  }
}

/** 跑一条脚本：加载 -> 探测 -> 取址 / 搜索 */
async function runOne(shared, file, opts, print) {
  const source = {
    id: `smoke-${path.basename(path.dirname(file))}`,
    name: path.basename(path.dirname(file)),
    kind: 'lx',
    sourceUrl: file,
    script: fs.readFileSync(file, 'utf8'),
    enabled: true,
  }
  // verbose=false 时脚本内的 console 输出被宿主丢弃，避免第三方调试日志刷屏
  // callTimeoutMs 收紧：坏脚本的上游回退链可能连着打好几跳，
  // 冒烟要的是「能不能出链」的结论，不是等它把 60s 超时耗完
  const deps = { request: createRequest(), env: 'desktop', verbose: opts.verbose, callTimeoutMs: opts.timeout }
  shared.setLxHostDeps(deps)

  const line = []
  const say = (text) => {
    line.push(text)
    print(text)
  }
  const inspection = await shared.inspectLxSource(source, deps)
  if (!inspection.ok) {
    say(`加载失败：${inspection.error}`)
    return line
  }
  const platforms = Object.entries(inspection.platforms)
  say(
    `初始化成功${inspection.packed ? '（liscript 解包）' : ''}：` +
      platforms.map(([id, cap]) => `${id}[${cap.actions.join('/')}]`).join(' ')
  )

  // 自带搜索能力的平台优先跑搜索
  for (const [platform, cap] of platforms) {
    const action = cap.actions.includes('search')
      ? 'search'
      : cap.actions.includes('musicSearch')
        ? 'musicSearch'
        : null
    if (!action) continue
    try {
      const hits = await shared.searchLxSource(source, opts.keyword, deps, { limit: 3 })
      const mine = hits.filter((h) => h.lx && h.lx.platform === platform)
      say(`  搜索(${platform}) → ${mine.length} 条，例：${mine[0] ? mine[0].title + ' - ' + mine[0].artist : '无'}`)
      if (mine[0]) {
        try {
          const got = await shared.resolveLxSourceUrl(source, mine[0].lx, opts.quality, deps)
          say(`    按搜到的条目取址 → ${got.quality} ${String(got.url).slice(0, 96)}`)
        } catch (err) {
          say(`    按搜到的条目取址失败：${err.message}`)
        }
      }
    } catch (err) {
      say(`  搜索(${platform}) 失败：${err.message}`)
    }
  }

  // 取址：优先用命令行给的 id（真实上游 id 才可能出链），否则用元信息（咪咕这类按名取址的平台）。
  // 注意：这里直接调宿主的底层取址入口，**不做「必要字段是否齐全」的校验**——
  // 那层校验在 lxResolver 的编排里（应用走的是它）。所以「按名取址」时脚本若自己
  // 不校验入参，可能返回形如 id=undefined 的链接；这不代表应用会这么发请求。
  const targetPlatform = opts.platform && inspection.platforms[opts.platform] ? opts.platform : platforms[0][0]
  const meta = opts.id
    ? { songmid: opts.id, hash: opts.id, id: opts.id, name: opts.keyword, singer: '' }
    : { name: opts.keyword, singer: '', albumName: '' }
  try {
    const got = await shared.resolveLxSourceUrl(
      source,
      { sourceId: source.id, platform: targetPlatform, meta },
      opts.quality,
      deps
    )
    // 只取出一个「长得像 URL」的结果不算通过：脚本不会校验入参，按名取址时可能返回
    // 带 id=undefined 的无效地址。这里真拉一次（Range 1KB）才有基线价值。
    const probe = await probeUrl(got.url)
    say(
      `  取址(${targetPlatform}, ${opts.id ? 'id=' + opts.id : '按名'}) → ${got.quality} ` +
        `${String(got.url).slice(0, 88)} [${probe}]`
    )
  } catch (err) {
    say(`  取址(${targetPlatform}) 失败：${err.message}`)
  }

  // 错误路径：平台不存在时必须给出可读错误
  try {
    await shared.resolveLxSourceUrl(source, { sourceId: source.id, platform: '__nope__', meta }, '128k', deps)
    say('  错误路径异常：不存在的平台竟然没报错')
  } catch (err) {
    say(`  错误路径正常：${err.message}`)
  }

  return line
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const shared = loadShared()

  const files = []
  if (opts.file) files.push(path.resolve(opts.file))
  else {
    const dir = path.resolve(opts.dir || '/tmp/lx-music-source')
    if (!fs.existsSync(dir)) {
      console.error(`脚本目录不存在：${dir}\n用 --dir 指定已克隆的 lx-music-source 仓库，或用 --file 指定单条脚本`)
      process.exit(1)
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const f = path.join(dir, entry.name, 'latest.js')
      if (fs.existsSync(f)) files.push(f)
    }
  }
  if (files.length === 0) {
    console.error('没有找到任何脚本')
    process.exit(1)
  }

  console.log(`共 ${files.length} 条脚本，关键词「${opts.keyword}」`)
  let ok = 0
  for (const file of files) {
    console.log(`\n===== ${path.relative(process.cwd(), file)}`)
    asyncErrors.length = 0
    try {
      // 结果随产生随打印：坏脚本的上游回退链可能把单条脚本拖到超时，
      // 攒到最后一起输出会让前面的有效结论一起丢失
      const lines = await runOne(shared, file, opts, (l) => console.log(l))
      if (!lines[0].startsWith('加载失败')) ok++
    } catch (err) {
      console.log(`  意外失败：${err && err.message}`)
    }
    if (asyncErrors.length > 0) {
      console.log(`  脚本内部异步异常 ${asyncErrors.length} 条（不影响宿主）：${asyncErrors[0]}`)
    }
  }
  console.log(`\n可加载脚本：${ok}/${files.length}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})