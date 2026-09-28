#!/usr/bin/env node
/**
 * 更新下载的端到端冒烟测试（开发用，不参与构建与 CI）。
 *
 * 为什么需要它：下载链路依赖两样不可控的外部东西——真实的 Electron 网络栈
 * （net.fetch 走 Chromium，才会跟随系统代理；Node 的 fetch 是直连，绕开代理
 * 正是「下载很慢」的病根）和真实的 HTTP 源站行为（Range 续传、传输中断）。
 * 公网既不可重复也不可控，所以本脚本在本机起一个最小安装包源站，精确制造四种
 * 场景并在 Electron 运行时里调用真实的主进程模块，断言：
 *   - 正常下载：返回字节数与 sha256 完全一致，进度事件递进，线路说明到达
 *   - 传输中断：第二个源按 Range 从断点续传，最终文件仍然完整
 *   - 首源龟速：看门狗在观察窗口后主动换到更快的源，续传后文件完整
 *   - 用户取消：立即中止并抛出「已取消下载」
 *   - 首源 HTTP 错误：直接降级到下一个源
 *
 * 用法：pnpm --filter @aurora/desktop smoke:updater
 * 前置：先 `npx tsc -p tsconfig.electron.json` 编译主进程。
 */

const { app } = require('electron')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const { downloadInstaller } = require('../dist-electron/ipc/updater.js')

const SIZE = 6 * 1024 * 1024
const PAYLOAD = crypto.randomBytes(SIZE)
const EXPECTED_SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex')

let failures = 0
function check(cond, msg) {
  if (cond) console.log('  ✅ ' + msg)
  else {
    failures++
    console.error('  ❌ ' + msg)
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function parseRange(header, total) {
  if (!header) return null
  const matched = /bytes=(\d+)-(\d*)/.exec(header)
  if (!matched) return null
  const start = Number(matched[1])
  const end = matched[2] ? Math.min(Number(matched[2]), total - 1) : total - 1
  if (start > end) return null
  return { start, end }
}

/**
 * 极简安装包源站：
 * - delayMs / chunkSize 控制吐数据的速度（200ms × 64KB ≈ 320KB/s，低于看门狗阈值）
 * - cutAfter 在第 N 字节处掐断连接，模拟传输中断
 * - status 直接返回错误码，模拟源站不可用
 * - ignoreRange 无视 Range 头、永远整包重发（部分镜像/中转就是这样），
 *   用来验证「换源后无法续传时必须截断重下」而不是把新旧字节拼在一起
 * - liarRange 声称 206 却从 0 开始发数据（Content-Range 起点也是 0）：
 *   只看状态码就追加写会缝出坏包，必须靠 Content-Range 起点识破
 * - truncateChunked 对「整包请求」不给 Content-Length（chunked）并在中途「干净」结束：
 *   这类截断不会被 Chromium 当成错误，必须靠长度对账发现（Range 探测仍正常应答）
 * - noContentRange 模拟加速层剥掉 Content-Range（只留 206 + Content-Length）：
 *   'resume' = 只发剩余部分（真续传，应当被采纳）；'full' = 从头发整包（应当被识破重下）
 * - chunkedFull 整包 chunked 但不截断（验证「没有长度依据时应当失败」）
 * - probeLengthOnly 对 `Range: bytes=0-0` 回 206 + Content-Length: 1 且不发 Content-Range
 *   （不能把这 1 字节当成包体大小）
 * - hangProbe 对 `Range: bytes=0-0` 不回响应，验证探测超时有界、不会拖死整次下载
 */
function startSource({
  delayMs = 0,
  chunkSize = 64 * 1024,
  cutAfter = null,
  status = 200,
  ignoreRange = false,
  liarRange = false,
  truncateChunked = false,
  chunkedFull = false,
  noContentRange = null,
  probeLengthOnly = false,
  hangProbe = false,
} = {}) {
  const state = { requests: 0, ranges: [], bytesSent: 0 }
  const server = http.createServer((req, res) => {
    state.requests++
    if (status !== 200) {
      res.writeHead(status, { 'Content-Length': '0' })
      res.end()
      return
    }
    if (req.headers.range) state.ranges.push(req.headers.range)

    const isProbe = req.headers.range === 'bytes=0-0'
    if (isProbe && hangProbe) {
      // 故意挂着不回响应头
      return
    }
    if (isProbe && probeLengthOnly) {
      res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Length': '1' })
      res.end(PAYLOAD.subarray(0, 1))
      return
    }

    const asked = parseRange(req.headers.range, SIZE)
    let range = ignoreRange ? null : asked
    let sendContentRange = !!range
    let chunked = false

    if (liarRange && asked) {
      // 谎报续传：回 206 且 Content-Range 也谎称从 0 开始
      range = { start: 0, end: SIZE - 1 }
      sendContentRange = true
    } else if (noContentRange && asked) {
      // 长度只报一半：'resume' 时长度是「剩余部分」，'full' 时是「整包」
      const from = noContentRange === 'full' ? 0 : asked.start
      range = { start: from, end: SIZE - 1 }
      sendContentRange = false
    } else if ((truncateChunked || chunkedFull) && !range) {
      chunked = true
    }

    if (chunked) {
      // 不给长度：客户端只能靠「流是否干净结束」判断，截断看起来就是正常结束
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' })
    } else {
      const start = range ? range.start : 0
      const stop = range ? range.end : SIZE - 1
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(stop - start + 1),
        'Accept-Ranges': 'bytes',
      }
      if (sendContentRange && range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${SIZE}`
      res.writeHead(range ? 206 : 200, headers)
    }

    let pos = range ? range.start : 0
    const end = chunked ? (truncateChunked ? Math.floor(SIZE / 2) - 1 : SIZE - 1) : range ? range.end : SIZE - 1
    let sentOnThisRequest = 0

    const pump = () => {
      if (res.destroyed) return
      if (pos > end) {
        res.end()
        return
      }
      const length = Math.min(chunkSize, end - pos + 1)
      res.write(PAYLOAD.subarray(pos, pos + length))
      state.bytesSent += length
      sentOnThisRequest += length
      pos += length
      if (cutAfter !== null && sentOnThisRequest >= cutAfter) {
        // 模拟传输中断：不发 end，直接掐掉连接
        res.destroy()
        return
      }
      if (delayMs > 0) setTimeout(pump, delayMs)
      else setImmediate(pump)
    }
    pump()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        server,
        port,
        state,
        url: `http://127.0.0.1:${port}/Aurora-Music-test.rpm`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

function tmpFile(tag) {
  return path.join(os.tmpdir(), `aurora-updater-smoke-${tag}-${Date.now()}.rpm`)
}

function collect() {
  const progress = []
  const routes = []
  return {
    progress,
    routes,
    onProgress: (payload) => progress.push(payload),
    onRoute: (route) => routes.push(route),
  }
}

// ─── 场景 1：正常下载 ───
async function scenarioHappyPath() {
  console.log('\n【场景 1】单源正常下载')
  // 稍微限速到约 4MB/s：太快的话整个下载不到一秒就结束，看不出速度上报是否工作
  const src = await startSource({ delayMs: 15 })
  const sink = tmpFile('happy')
  const bus = collect()
  try {
    const bytes = await downloadInstaller({
      candidates: [src.url],
      savePath: sink,
      signal: new AbortController().signal,
      onProgress: bus.onProgress,
      onRoute: bus.onRoute,
    })
    check(bytes === SIZE, `返回字节数等于安装包大小（${bytes} / ${SIZE}）`)
    check(sha256File(sink) === EXPECTED_SHA, '落地文件 sha256 与源文件一致')
    check(
      bus.progress.length >= 2 && bus.progress[bus.progress.length - 1].received === SIZE,
      `进度事件递进并收尾于完整大小（${bus.progress.length} 次）`
    )
    check(
      bus.progress.some((p) => typeof p.speed === 'number' && p.speed > 0),
      '进度事件带上了实时速度'
    )
    check(bus.routes.length === 1 && /代理|直连/.test(bus.routes[0].label), `线路说明已推送：${bus.routes[0] && bus.routes[0].label}`)
  } finally {
    fs.rmSync(sink, { force: true })
    await src.close()
  }
}

// ─── 场景 2：传输中断后换源续传 ───
async function scenarioResumeAfterCut() {
  console.log('\n【场景 2】首源传输中断，换源 Range 续传')
  const broken = await startSource({ cutAfter: 1024 * 1024 })
  const healthy = await startSource()
  const sink = tmpFile('resume')
  const bus = collect()
  try {
    const bytes = await downloadInstaller({
      candidates: [broken.url, healthy.url],
      savePath: sink,
      signal: new AbortController().signal,
      onProgress: bus.onProgress,
      onRoute: bus.onRoute,
    })
    const resumeHeader = healthy.state.ranges[0]
    check(healthy.state.requests >= 1, '中断后确实换了第二个源')
    check(!!resumeHeader && /^bytes=\d+-$/.test(resumeHeader), `第二个源收到 Range 请求：${resumeHeader}`)
    check(Number(/bytes=(\d+)-/.exec(resumeHeader || 'bytes=0-')[1]) > 0, '续传起点大于 0（没有从头重下）')
    check(bytes === SIZE && sha256File(sink) === EXPECTED_SHA, '续传拼出的文件 sha256 与源文件一致')
  } finally {
    fs.rmSync(sink, { force: true })
    await broken.close()
    await healthy.close()
  }
}

// ─── 场景 3：首源龟速，看门狗换源 ───
async function scenarioSlowWatchdog() {
  console.log('\n【场景 3】首源龟速（约 320KB/s），看门狗换到更快的源')
  const slow = await startSource({ delayMs: 200, chunkSize: 64 * 1024 })
  const fast = await startSource()
  const sink = tmpFile('slow')
  const bus = collect()
  const startedAt = Date.now()
  try {
    const bytes = await downloadInstaller({
      candidates: [slow.url, fast.url],
      savePath: sink,
      signal: new AbortController().signal,
      onProgress: bus.onProgress,
      onRoute: bus.onRoute,
    })
    check(fast.state.requests >= 1, '看门狗触发后切到了更快的源')
    check(slow.state.bytesSent < SIZE, `龟速源没有把整个包拖完（只发了 ${(slow.state.bytesSent / 1048576).toFixed(2)} MB）`)
    check(bytes === SIZE && sha256File(sink) === EXPECTED_SHA, '换源续传后的文件 sha256 与源文件一致')
    check(Date.now() - startedAt < 30000, `整体在合理时间内完成（${((Date.now() - startedAt) / 1000).toFixed(1)}s）`)
  } finally {
    fs.rmSync(sink, { force: true })
    await slow.close()
    await fast.close()
  }
}

// ─── 场景 4：用户取消 ───
async function scenarioCancel() {
  console.log('\n【场景 4】下载中取消')
  const src = await startSource({ delayMs: 100, chunkSize: 64 * 1024 })
  const sink = tmpFile('cancel')
  const ctrl = new AbortController()
  const bus = collect()
  try {
    const timer = setTimeout(() => ctrl.abort(), 1200)
    let error = null
    try {
      await downloadInstaller({
        candidates: [src.url],
        savePath: sink,
        signal: ctrl.signal,
        onProgress: bus.onProgress,
        onRoute: bus.onRoute,
      })
    } catch (err) {
      error = err
    }
    clearTimeout(timer)
    check(!!error && /取消/.test(error.message), `取消后抛出「已取消下载」：${error && error.message}`)
    check(fs.existsSync(sink) && fs.statSync(sink).size < SIZE, '取消后中断在已写入的字节上（不删除文件，由 IPC 层清理）')
  } finally {
    fs.rmSync(sink, { force: true })
    await src.close()
  }
}

// ─── 场景 5：首源 HTTP 错误直接降级 ───
async function scenarioHttpError() {
  console.log('\n【场景 5】首源 HTTP 500，直接降级')
  const bad = await startSource({ status: 500 })
  const good = await startSource()
  const sink = tmpFile('http')
  const bus = collect()
  try {
    const bytes = await downloadInstaller({
      candidates: [bad.url, good.url],
      savePath: sink,
      signal: new AbortController().signal,
      onProgress: bus.onProgress,
      onRoute: bus.onRoute,
    })
    check(bytes === SIZE && sha256File(sink) === EXPECTED_SHA, 'HTTP 错误后降级到下一个源并下载完整')
  } finally {
    fs.rmSync(sink, { force: true })
    await bad.close()
    await good.close()
  }
}

// ─── 场景 6：换源后目标源不支持 Range，必须截断重下 ───
async function scenarioNoRangeOnRetry() {
  console.log('\n【场景 6】首源中断，第二个源无视 Range（整包重发）')
  const broken = await startSource({ cutAfter: 1024 * 1024 })
  const noRange = await startSource({ ignoreRange: true })
  const sink = tmpFile('norange')
  const bus = collect()
  try {
    const bytes = await downloadInstaller({
      candidates: [broken.url, noRange.url],
      savePath: sink,
      signal: new AbortController().signal,
      onProgress: bus.onProgress,
      onRoute: bus.onRoute,
    })
    check(noRange.state.ranges.length >= 1, `第二个源确实收到了 Range 请求：${noRange.state.ranges[0]}`)
    check(bytes === SIZE, `重下后字节数正确（${bytes} / ${SIZE}）`)
    check(sha256File(sink) === EXPECTED_SHA, '截断重下后 sha256 与源文件一致（没有把新旧字节拼在一起）')
  } finally {
    fs.rmSync(sink, { force: true })
    await broken.close()
    await noRange.close()
  }
}

// ─── 场景 7：换源后对端「谎报续传」（206 但从头发数据）───
async function scenarioLiarRange() {
  console.log('\n【场景 7】第二个源回 206 却从 0 开始发数据')
  const broken = await startSource({ cutAfter: 1024 * 1024 })
  const liar = await startSource({ liarRange: true })
  const sink = tmpFile('liar')
  const bus = collect()
  try {
    const bytes = await downloadInstaller({
      candidates: [broken.url, liar.url],
      savePath: sink,
      signal: new AbortController().signal,
      onProgress: bus.onProgress,
      onRoute: bus.onRoute,
      expectedSize: SIZE,
    })
    check(liar.state.ranges.length >= 1, `第二个源确实收到了 Range 请求：${liar.state.ranges[0]}`)
    check(bytes === SIZE, `拼接结果长度正确（${bytes} / ${SIZE}，未把整包缝在已下载字节后面）`)
    check(sha256File(sink) === EXPECTED_SHA, '识破谎报续传后截断重下，sha256 与源文件一致')
  } finally {
    fs.rmSync(sink, { force: true })
    await broken.close()
    await liar.close()
  }
}

// ─── 场景 8：源不给长度（chunked）且中途干净结束 ───
async function scenarioChunkedTruncation() {
  console.log('\n【场景 8】源无 Content-Length 且被截断（chunked 干净结束）')
  const cut = await startSource({ truncateChunked: true })
  const sink1 = tmpFile('chunked-alone')
  const bus1 = collect()
  try {
    let error = null
    try {
      await downloadInstaller({
        candidates: [cut.url],
        savePath: sink1,
        signal: new AbortController().signal,
        onProgress: bus1.onProgress,
        onRoute: bus1.onRoute,
        expectedSize: SIZE,
      })
    } catch (err) {
      error = err
    }
    check(!!error, `唯一源被截断时必须报错而不是静默成功：${error && error.message}`)
    check(!!error && /不完整/.test(error.message), '错误信息点明「安装包不完整」')
  } finally {
    fs.rmSync(sink1, { force: true })
    await cut.close()
  }

  const cut2 = await startSource({ truncateChunked: true })
  const healthy = await startSource()
  const sink2 = tmpFile('chunked-retry')
  const bus2 = collect()
  try {
    const bytes = await downloadInstaller({
      candidates: [cut2.url, healthy.url],
      savePath: sink2,
      signal: new AbortController().signal,
      onProgress: bus2.onProgress,
      onRoute: bus2.onRoute,
      expectedSize: SIZE,
    })
    check(healthy.state.requests >= 1, '截断后换到了下一个源')
    check(
      !!healthy.state.ranges[0] && Number(/bytes=(\d+)-/.exec(healthy.state.ranges[0])[1]) > 0,
      `续传起点用了磁盘实际字节数：${healthy.state.ranges[0]}`
    )
    check(bytes === SIZE && sha256File(sink2) === EXPECTED_SHA, '补齐后 sha256 与源文件一致')
  } finally {
    fs.rmSync(sink2, { force: true })
    await cut2.close()
    await healthy.close()
  }
}

// ─── 场景 9：加速层剥掉 Content-Range，但内容确实是从断点续的 ───
async function scenarioNoContentRangeResume() {
  console.log('\n【场景 9】206 但无 Content-Range，长度等于剩余部分（真续传）')
  const broken = await startSource({ cutAfter: 1024 * 1024 })
  const stripped = await startSource({ noContentRange: 'resume' })
  const sink = tmpFile('noc-resume')
  const bus = collect()
  try {
    const bytes = await downloadInstaller({
      candidates: [broken.url, stripped.url],
      savePath: sink,
      signal: new AbortController().signal,
      onProgress: bus.onProgress,
      onRoute: bus.onRoute,
      expectedSize: SIZE,
    })
    check(bytes === SIZE, `识别为真续传并拼出完整长度（${bytes} / ${SIZE}）`)
    check(sha256File(sink) === EXPECTED_SHA, 'sha256 与源文件一致（没有被误判成整包重下）')
    check(stripped.state.requests <= 2, `没有多余的整包重下（该源 ${stripped.state.requests} 次请求）`)
  } finally {
    fs.rmSync(sink, { force: true })
    await broken.close()
    await stripped.close()
  }
}

// ─── 场景 10：206 无 Content-Range，但其实是整包从头发的 ───
async function scenarioNoContentRangeFull() {
  console.log('\n【场景 10】206 但无 Content-Range，长度等于整包（实为从头发）')
  const broken = await startSource({ cutAfter: 1024 * 1024 })
  const liarByLength = await startSource({ noContentRange: 'full' })
  const sink = tmpFile('noc-full')
  const bus = collect()
  try {
    const bytes = await downloadInstaller({
      candidates: [broken.url, liarByLength.url],
      savePath: sink,
      signal: new AbortController().signal,
      onProgress: bus.onProgress,
      onRoute: bus.onRoute,
      expectedSize: SIZE,
    })
    check(bytes === SIZE, `识破后截断重下，长度正确（${bytes} / ${SIZE}）`)
    check(sha256File(sink) === EXPECTED_SHA, 'sha256 与源文件一致（没有追加出超长文件）')
  } finally {
    fs.rmSync(sink, { force: true })
    await broken.close()
    await liarByLength.close()
  }
}

// ─── 场景 11：没有 release 字节数时，靠 Range 探测仍能发现截断 ───
async function scenarioTruncationWithoutExpectedSize() {
  console.log('\n【场景 11】chunked 截断且未传 expectedSize（需靠 Range 探测对账）')
  const cut = await startSource({ truncateChunked: true })
  const sink = tmpFile('chunked-no-size')
  const bus = collect()
  try {
    let error = null
    try {
      await downloadInstaller({
        candidates: [cut.url],
        savePath: sink,
        signal: new AbortController().signal,
        onProgress: bus.onProgress,
        onRoute: bus.onRoute,
      })
    } catch (err) {
      error = err
    }
    check(!!error, `没有 expectedSize 也要能发现截断：${error && error.message}`)
    check(!!error && /不完整/.test(error.message), '错误信息点明「安装包不完整」')
    check(
      cut.state.ranges.some((r) => /^bytes=0-0$/.test(r)),
      `确实用 Range 探测过总长（收到的探测请求：${cut.state.ranges.join(', ')}）`
    )
  } finally {
    fs.rmSync(sink, { force: true })
    await cut.close()
  }
}

// ─── 场景 12：长度完全未知时 206（无 CR）不得被当成整包采纳 ───
async function scenarioUntrustedPartialResponse() {
  console.log('\n【场景 12】长度完全未知 + 206 无 Content-Range（起点无法确认）')
  // 首个源既不给长度、也把 Range 探测挂住（超时后仍无长度依据）；
  // 第二个源回 206 却不说从哪开始发数据 —— 这种响应必须弃用
  const headless = await startSource({ truncateChunked: true, hangProbe: true })
  const ambiguous = await startSource({ noContentRange: 'resume' })
  const sink = tmpFile('untrusted')
  const bus = collect()
  try {
    let error = null
    try {
      await downloadInstaller({
        candidates: [headless.url, ambiguous.url],
        savePath: sink,
        signal: new AbortController().signal,
        onProgress: bus.onProgress,
        onRoute: bus.onRoute,
      })
    } catch (err) {
      error = err
    }
    check(!!error, `无法确认起点时必须失败而不是拼出错位文件：${error && error.message}`)
    check(ambiguous.state.requests >= 1, '确实尝试过第二个源（弃用而不是直接放弃整次下载）')
    check(
      !fs.existsSync(sink) || fs.statSync(sink).size !== SIZE,
      `没有产出「长度正确但内容错位」的文件（落盘 ${fs.existsSync(sink) ? fs.statSync(sink).size : 0} 字节）`
    )
  } finally {
    fs.rmSync(sink, { force: true })
    await headless.close()
    await ambiguous.close()
  }
}

// ─── 场景 13：探测响应用 Content-Length 冒充总长 ───
async function scenarioProbeLengthMismatch() {
  console.log('\n【场景 13】探测响应只有 Content-Length: 1（不得当成包体大小）')
  const src = await startSource({ truncateChunked: true, probeLengthOnly: true })
  const sink = tmpFile('probe-cl')
  const bus = collect()
  try {
    let error = null
    try {
      await downloadInstaller({
        candidates: [src.url],
        savePath: sink,
        signal: new AbortController().signal,
        onProgress: bus.onProgress,
        onRoute: bus.onRoute,
      })
    } catch (err) {
      error = err
    }
    check(!!error, `应当失败：${error && error.message}`)
    check(
      !!error && !/应为 1 字节/.test(error.message),
      '没有把探测请求的 Content-Length(1) 当成包体大小'
    )
  } finally {
    fs.rmSync(sink, { force: true })
    await src.close()
  }
}

// ─── 场景 14：探测被源挂住时必须超时放弃 ───
async function scenarioProbeHang() {
  console.log('\n【场景 14】Range 探测被源挂住（不回响应头）')
  const src = await startSource({ chunkedFull: true, hangProbe: true })
  const sink = tmpFile('probe-hang')
  const bus = collect()
  const startedAt = Date.now()
  try {
    let error = null
    try {
      await downloadInstaller({
        candidates: [src.url],
        savePath: sink,
        signal: new AbortController().signal,
        onProgress: bus.onProgress,
        onRoute: bus.onRoute,
      })
    } catch (err) {
      error = err
    }
    const seconds = (Date.now() - startedAt) / 1000
    check(!!error, `没有长度依据时如实失败：${error && error.message}`)
    check(seconds < 30, `探测挂住不会拖死整次下载（${seconds.toFixed(1)}s 内结束）`)
  } finally {
    fs.rmSync(sink, { force: true })
    await src.close()
  }
}

// ─── 场景 15：官方摘要校验（内容级）───
async function scenarioDigestCheck() {
  console.log('\n【场景 15】安装包 sha256 摘要校验')
  const bad = await startSource()
  const badSink = tmpFile('digest-bad')
  const bus = collect()
  try {
    let error = null
    try {
      await downloadInstaller({
        candidates: [bad.url],
        savePath: badSink,
        signal: new AbortController().signal,
        onProgress: bus.onProgress,
        onRoute: bus.onRoute,
        expectedSize: SIZE,
        expectedDigest: `sha256:${'0'.repeat(64)}`,
      })
    } catch (err) {
      error = err
    }
    check(!!error && /校验失败/.test(error.message), `摘要不符必须失败：${error && error.message}`)
    check(!fs.existsSync(badSink), '摘要不符的坏包被清理（不会留在下载目录里）')
  } finally {
    fs.rmSync(badSink, { force: true })
    await bad.close()
  }

  const good = await startSource()
  const goodSink = tmpFile('digest-ok')
  try {
    const bytes = await downloadInstaller({
      candidates: [good.url],
      savePath: goodSink,
      signal: new AbortController().signal,
      onProgress: () => {},
      onRoute: () => {},
      expectedSize: SIZE,
      expectedDigest: `sha256:${EXPECTED_SHA}`,
    })
    check(bytes === SIZE && sha256File(goodSink) === EXPECTED_SHA, '摘要正确时正常完成')
  } finally {
    fs.rmSync(goodSink, { force: true })
    await good.close()
  }
}

async function main() {
  await app.whenReady()
  await scenarioHappyPath()
  await scenarioResumeAfterCut()
  await scenarioSlowWatchdog()
  await scenarioCancel()
  await scenarioHttpError()
  await scenarioNoRangeOnRetry()
  await scenarioLiarRange()
  await scenarioChunkedTruncation()
  await scenarioNoContentRangeResume()
  await scenarioNoContentRangeFull()
  await scenarioTruncationWithoutExpectedSize()
  await scenarioUntrustedPartialResponse()
  await scenarioProbeLengthMismatch()
  await scenarioProbeHang()
  await scenarioDigestCheck()

  console.log('\n' + (failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`))
  app.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('冒烟测试异常退出:', err)
  app.exit(1)
})
