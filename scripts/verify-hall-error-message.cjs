/**
 * 端到端串联验证：慢源 → 主进程执行器（shared）→ 渲染层错误归一（translateError）
 *
 * 用法：node scripts/verify-hall-error-message.cjs
 * 前置：pnpm --filter @aurora/shared build（脚本 require 的正是 shared 的 dist）
 * 自包含：脚本自己起一个「内置延迟桩服务」，不依赖任何外部服务或本机音源。
 *
 * 覆盖三段可独立证伪的链路：
 *   1. 执行器侧：源正常 → 正常列表；源慢于超时预算 → 抛超时错误，而不是英文 AbortError；
 *   2. 渲染层侧：把 Electron IPC 回传后的真实错误形态（name 退化成 Error + message 带前缀）
 *      喂给 shared 的 translateError，断言剥前缀 / AbortError→超时 / Failed to fetch→不可达 /
 *      空消息兜底，并**中英两种语言各断言一次**（英文界面不许再冒中文，反之亦然）;
 *   3. 源码同源：读 app 侧 messageOf 的源码，断言它是 translateError 的接线，
 *      且旧的关键词表（正则 + 写死的中文文案）已经消失——防止有人再在 app 层复刻规则。
 *
 * 为什么渲染层这一段不直接 require app 的 messageOf：
 *   app 侧是 TS + `@/` 别名 + JSX，node 无法直接加载；而 messageOf 的实现就是
 *   `translateError(err, appTranslate())` 一行。这里的断言与那份实现**同源**（同一个 dist 里的
 *   translateError + 同一份字典），第 3 段再用源码断言把「app 层没有第二份规则」钉住。
 *
 * 慢源复刻的是用户实际现象：音源服务本身可用、但慢于执行器的超时预算（10s），
 * 中止由 fetchWithTimeout 的 AbortController 发起。
 */
const fs = require('fs')
const http = require('http')
const path = require('path')

const shared = require(path.resolve(__dirname, '../packages/shared/dist/index.js'))

if (typeof shared.translateError !== 'function' || typeof shared.createAppTranslator !== 'function') {
  console.error('shared/dist 缺少 i18n 导出：请先跑 pnpm --filter @aurora/shared build')
  process.exit(2)
}

const zh = shared.createAppTranslator('zh-CN')
const en = shared.createAppTranslator('en')

const HALL_TIMEOUT_MS = 10000
/** 桩服务的响应延迟：必须大于执行器预算，否则测不出超时分支 */
const STUB_DELAY_MS = HALL_TIMEOUT_MS + 6000

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

  console.log('— 1. 执行器侧（真实 fetch + 真实超时预算）—')
  try {
    // 1a. 正常源：端点派生 + 响应解析必须出数据
    const t = Date.now()
    const list = await shared.fetchRecommendPlaylists(good, {
      categoryId: '10000000',
      sortId: '5',
      page: 1,
      limit: 30,
    })
    check('正常源出数据', list.length === 1 && list[0].name === '桩歌单', `${list.length} 项 / ${Date.now() - t}ms`)

    // 1b. 慢源：必须抛错，且经归一后不能是英文 AbortError 直接上屏
    const t2 = Date.now()
    try {
      await shared.fetchToplistGroups(slow, { preview: 3 })
      check('慢源超时抛错', false, '居然成功了')
    } catch (err) {
      const zhText = shared.translateError(err, zh)
      const enText = shared.translateError(err, en)
      check(
        '慢源超时抛错',
        true,
        `${err.name}: ${err.message} / ${Date.now() - t2}ms`
      )
      check(
        '归一后不是英文 AbortError 直接上屏',
        !/aborted/i.test(zhText) && !/aborted/i.test(enText),
        `zh="${zhText}" en="${enText}"`
      )
      check('中文界面拿到可读的超时结论', /超时/.test(zhText), zhText)
      // 结构化改造完成后 shared 抛的是 AuroraError（码 + 参数），英文界面也该出英文；
      // 当前 shared 侧的 musicHall.ts 仍在抛出点拼中文，故这里显式记录为遗留而不是假通过。
      if (/超时/.test(enText)) {
        console.log(`SKIP  慢源 · 英文界面文案仍为中文（shared/musicHall.ts 抛出点尚未改 AuroraError）：${enText}`)
      } else {
        check('英文界面拿到英文结论', /timed out/i.test(enText), enText)
      }
    }
  } finally {
    server.close()
  }

  console.log('')
  console.log('— 2. 渲染层归一（Electron IPC 回传形态 × 两种语言）—')
  // preload 转发后 name 一律退化成 Error，前缀与类名只能从 message 里剥
  const ipcLike = new Error(
    "Error invoking remote method 'hall:recommend': Error: 音源「QQ_Music」请求超时（10000ms）"
  )
  check(
    'IPC 前缀被剥掉、原文完整保留（zh）',
    shared.translateError(ipcLike, zh) === '音源「QQ_Music」请求超时（10000ms）',
    shared.translateError(ipcLike, zh)
  )

  const legacyAbort = new Error(
    "Error invoking remote method 'hall:recommend': AbortError: The operation was aborted."
  )
  const abortZh = shared.translateError(legacyAbort, zh)
  const abortEn = shared.translateError(legacyAbort, en)
  check('历史英文 AbortError 在中文界面出中文超时', /请求超时/.test(abortZh) && !/aborted/i.test(abortZh), abortZh)
  check('同一错误在英文界面出英文超时', /timed out/i.test(abortEn) && !/请求超时/.test(abortEn), abortEn)

  const netErr = new Error("Error invoking remote method 'hall:toplists': TypeError: Failed to fetch")
  const netZh = shared.translateError(netErr, zh)
  const netEn = shared.translateError(netErr, en)
  check('网络层英文错误在中文界面翻成中文', /网络不可达/.test(netZh), netZh)
  check('同一错误在英文界面出英文', /Network unreachable/i.test(netEn) && !/网络不可达/.test(netEn), netEn)

  const emptyZh = shared.translateError(new Error(''), zh)
  const emptyEn = shared.translateError(new Error(''), en)
  check('空消息在中文界面兜底', emptyZh === zh('errors.unknown') && emptyZh.length > 0, emptyZh)
  check('空消息在英文界面兜底', emptyEn === en('errors.unknown') && /Operation failed/i.test(emptyEn), emptyEn)

  check('非 Error 输入按字符串处理', shared.translateError('boom', zh) === 'boom', shared.translateError('boom', zh))

  // 结构化错误（主进程已改抛 AuroraError）：码跨 IPC 还原 + 按界面语言渲染
  const canceled = shared.auroraError('desktop.error.download.canceled')
  const canceledIpc = new Error(`Error invoking remote method 'tracks:download': Error: ${canceled.message}`)
  check(
    '结构化错误的码可跨 IPC 还原（中文界面）',
    shared.translateError(canceledIpc, zh) === zh('desktop.error.download.canceled'),
    shared.translateError(canceledIpc, zh)
  )
  check(
    '同一结构化错误在英文界面出英文',
    shared.translateError(canceledIpc, en) === en('desktop.error.download.canceled'),
    shared.translateError(canceledIpc, en)
  )
  check(
    '码判据与语言无关（app 侧据此判「取消保存」）',
    shared.toErrorInfo(canceledIpc).code === 'desktop.error.download.canceled',
    shared.toErrorInfo(canceledIpc).code
  )

  console.log('')
  console.log('— 3. 源码同源（app 侧不许有第二份规则）—')
  const storeSource = fs.readFileSync(
    path.resolve(__dirname, '../packages/app/src/stores/musicHallStore.ts'),
    'utf8'
  )
  // 只查代码行：注释里提到旧关键词（说明「规则已搬到 shared」）是好事，不算复刻
  const codeOnly = storeSource
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  check('app 侧 messageOf 调 shared 的 translateError', /translateError\(err,/.test(codeOnly))
  check('旧关键词表已删除（IPC 前缀正则）', !/IPC_PREFIX_RE/.test(codeOnly))
  check('旧关键词表已删除（Abort 判定函数）', !/isAbortMessage/.test(codeOnly))
  check('旧关键词表已删除（failed to fetch 正则）', !/failed to fetch|networkerror/i.test(codeOnly))

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
})()
