/**
 * 端到端串联验证：慢源 → 主进程执行器（shared）→ 渲染层 messageOf 归一
 *
 * 用法：node scripts/verify-hall-error-message.cjs
 * 自包含：脚本自己起一个「内置延迟桩服务」，不依赖任何外部服务或本机音源。
 *
 * 覆盖两段可独立证伪的链路：
 *   1. 执行器侧：源正常 → 正常列表；源慢于超时预算 → 抱中文超时错误，而不是英文 AbortError
 *   2. 渲染层侧：把 Electron IPC 回传后的真实错误形态（name 退化成 Error + message 带前缀）
 *      喂给 messageOf，断言剥前缀 / 翻中文
 *
 * 慢源复刻的是用户实际现象：音源服务本身可用、但慢于执行器的超时预算（10s），
 * 中止由 fetchWithTimeout 的 AbortController 发起。
 */
const http = require('http')
const path = require('path')

const shared = require(path.resolve(__dirname, '../packages/shared/dist/index.js'))

const HALL_TIMEOUT_MS = 10000
/** 桩服务的响应延迟：必须大于执行器预算，否则测不出超时分支 */
const STUB_DELAY_MS = HALL_TIMEOUT_MS + 6000

/** 复刻 app 的 messageOf（渲染层归一），保持与源码同规则 */
function messageOf(err) {
  const raw = err instanceof Error ? err.message : String(err)
  let msg = raw.replace(/^Error invoking remote method '[^']*':\s*/, '').trim()
  if (!msg) return '加载失败'
  for (let i = 0; i < 3; i++) {
    const next = msg.replace(/^(?:[A-Za-z]*Error|DOMException):\s*/, '').trim()
    if (next === msg) break
    msg = next
  }
  if (/abort/i.test(msg) || /abort/i.test(raw)) return '请求超时：音源服务未在超时时间内响应'
  if (/failed to fetch|networkerror|load failed|fetch failed/i.test(msg)) {
    return '网络不可达：请检查音源服务是否在运行、地址与端口是否正确'
  }
  return msg
}

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
}

/** 内置桩服务：/fast 立即回合法 JSON，/slow 延迟到超时之后才回 */
function startStub() {
  const server = http.createServer((req, res) => {
    const body = JSON.stringify({
      list: [{ id: '1', name: '桩歌单', coverUrl: '', listenNum: 1, creatorName: '桩', createTime: '2026-01-01' }],
    })
    if (req.url.startsWith('/slow')) {
      const timer = setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(body)
      }, STUB_DELAY_MS)
      // 客户端超时中止时清掉定时器，别让进程被挂住的响应拖着不退出
      res.on('close', () => clearTimeout(timer))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(body)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

;(async () => {
  const { server, port } = await startStub()
  const base = `http://127.0.0.1:${port}`
  const good = { id: 'good', name: 'QQ_Music', sourceUrl: `${base}/fast/aurora`, enabled: true }
  const slow = { id: 'slow', name: 'QQ_Music', sourceUrl: `${base}/slow/aurora`, enabled: true }

  try {
    // 1. 正常源：端点派生 + 响应解析必须出数据
    const t = Date.now()
    const list = await shared.fetchRecommendPlaylists(good, {
      categoryId: '10000000',
      sortId: '5',
      page: 1,
      limit: 30,
    })
    check('正常源出数据', list.length === 1 && list[0].name === '桩歌单', `${list.length} 项 / ${Date.now() - t}ms`)

    // 2. 慢源：必须是中文超时错误（执行器会包上源名，这是刻意的）
    const t2 = Date.now()
    try {
      await shared.fetchToplistGroups(slow, { preview: 3 })
      check('慢源超时抛错', false, '居然成功了')
    } catch (err) {
      check(
        '慢源超时抛中文错误',
        /音源「QQ_Music」请求超时（10000ms）/.test(err.message) && !/aborted/i.test(err.message),
        `${err.name}: ${err.message} / ${Date.now() - t2}ms`
      )
    }
  } finally {
    server.close()
  }

  // 3. 渲染层归一：喂进 Electron IPC 回传的真实形态（preload 转发后 name 退化成 Error）
  const ipcLike = new Error(
    "Error invoking remote method 'hall:recommend': Error: 音源「QQ_Music」请求超时（10000ms）"
  )
  check('IPC 前缀被剥掉、中文结论保留', messageOf(ipcLike) === '音源「QQ_Music」请求超时（10000ms）', messageOf(ipcLike))

  const legacyAbort = new Error(
    "Error invoking remote method 'hall:recommend': AbortError: The operation was aborted."
  )
  check(
    '历史英文 AbortError 翻成中文',
    messageOf(legacyAbort) === '请求超时：音源服务未在超时时间内响应',
    messageOf(legacyAbort)
  )

  const netErr = new Error("Error invoking remote method 'hall:toplists': TypeError: Failed to fetch")
  check('网络层英文错误翻成中文', /网络不可达/.test(messageOf(netErr)), messageOf(netErr))

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
})()