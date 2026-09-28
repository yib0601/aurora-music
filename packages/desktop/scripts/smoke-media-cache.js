#!/usr/bin/env node
/**
 * 媒体缓存端到端冒烟测试（开发用，不参与构建与 CI）。
 *
 * 为什么需要它：这套缓存的正确性几乎全在「容量按比例分配 + 各池 LRU 驱逐 +
 * 老索引/老文件接管」这些边角上，纯 typecheck 覆盖不到，而手工验证要真的把
 * 配额写爆。脚本在本机起一个最小 HTTP 服务器提供音频与图片，用临时 userData
 * 目录驱动真实的主进程模块，断言：
 *   - 总容量按 80/15/5 切给音频/封面/歌词，小档位下各池之和不超过总量
 *   - 未命中时不阻塞调用方（返回 null 并后台下载），下次命中返回协议地址
 *   - 协议读取的内容与 Range 语义正确，未知文件与路径穿越请求被拒
 *   - 封面/歌词落盘后计入占用，清空与关闭缓存后不再命中
 *   - 池内超限时按最久未用驱逐，且驱逐通知带上对应曲目（曲库据此回填 coverPath）
 *   - 旧版单池索引（键为 sha1、无 version 字段）升级后仍能命中，不重复下载
 *
 * 用法：pnpm --filter @aurora/desktop smoke:cache
 * 前置：先 `pnpm --filter @aurora/desktop exec tsc -p tsconfig.electron.json` 编译主进程。
 */

'use strict'

// 主进程模块依赖 electron 运行时（app.getPath），用 ELECTRON_RUN_AS_NODE 让
// Electron 以 node 模式跑本脚本，再给 electron 模块打桩（不启动真实窗口）。
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const electron = require('electron')
  const res = spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  process.exit(res.status ?? 1)
}

const Module = require('module')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-cache-smoke-'))
const USER_DATA = path.join(TMP_ROOT, 'userdata')
const COVER_DIR = path.join(USER_DATA, 'aurora-music', 'covers')
const LYRIC_DIR = path.join(USER_DATA, 'aurora-music', 'lyrics')
const AUDIO_DIR = path.join(USER_DATA, 'audio-cache')
const INDEX_FILE = path.join(AUDIO_DIR, 'index.json')
fs.mkdirSync(USER_DATA, { recursive: true })

const CACHE_MODULE = path.join(__dirname, '..', 'dist-electron', 'ipc', 'mediaCache.js')
if (!fs.existsSync(CACHE_MODULE)) {
  console.error('未找到编译产物，请先运行：pnpm --filter @aurora/desktop exec tsc -p tsconfig.electron.json')
  process.exit(1)
}

const ipcHandlers = new Map()
const originalLoad = Module._load
Module._load = function (request) {
  if (request === 'electron') {
    return {
      app: { getPath: (name) => (name === 'userData' ? USER_DATA : TMP_ROOT) },
      ipcMain: { handle: (channel, fn) => ipcHandlers.set(channel, fn) },
    }
  }
  return originalLoad.apply(this, arguments)
}

const mod = require(CACHE_MODULE)

// ─── 断言 ───
let passed = 0
const failures = []
function check(name, cond, detail) {
  if (cond) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n !== 'index.json')
  } catch {
    return []
  }
}

async function waitFor(fn, timeout = 8000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, 40))
  }
}

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex')

const AUDIO_BODY = Buffer.alloc(64 * 1024, 7)
const IMAGE_BODY = Buffer.alloc(48 * 1024, 9)

// ─── 测试用 HTTP 服务器 ───
const hits = { audio: 0, image: 0, slow: 0 }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const send = (body, type) => {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(body.length) })
    res.end(body)
  }
  if (url.pathname === '/audio.mp3') {
    hits.audio++
    return send(AUDIO_BODY, 'audio/mpeg')
  }
  if (url.pathname === '/cover.jpg') {
    hits.image++
    return send(IMAGE_BODY, 'image/jpeg')
  }
  if (url.pathname === '/slow-cover.jpg') {
    // 慢响应：用来制造「下载途中清空缓存」的竞态
    hits.slow++
    return setTimeout(() => send(IMAGE_BODY, 'image/jpeg'), 400)
  }
  res.writeHead(404)
  res.end()
})

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  console.log('1) 容量按比例分配')
  const big = mod.poolLimitsMB(1024)
  check(
    '1GB 档位切出 80/15/5',
    Math.abs(big.audio - 819.2) < 0.01 && Math.abs(big.cover - 153.6) < 0.01 && Math.abs(big.lyrics - 51.2) < 0.01,
    JSON.stringify(big)
  )
  const small = mod.poolLimitsMB(16)
  const smallSum = small.audio + small.cover + small.lyrics
  check('小档位下各池之和不超过总量', smallSum <= 16.0001 && smallSum > 15.5, `sum=${smallSum}`)
  check('关闭档位各池为 0', Object.values(mod.poolLimitsMB(0)).every((v) => v === 0))

  console.log('2) 旧版单池索引升级后仍命中（不重复下载）')
  // 造一条 v1 索引：键为 sha1(缓存键)，无 version 字段，文件与键同名
  const legacyKey = 'legacy-src|9'
  const legacyFile = `${sha1(legacyKey)}.mp3`
  fs.mkdirSync(AUDIO_DIR, { recursive: true })
  fs.writeFileSync(path.join(AUDIO_DIR, legacyFile), AUDIO_BODY)
  fs.writeFileSync(
    INDEX_FILE,
    JSON.stringify({
      entries: { [sha1(legacyKey)]: { file: legacyFile, size: AUDIO_BODY.length, lastUsed: Date.now(), url: `${base}/audio.mp3` } },
    }),
    'utf-8'
  )

  const ipc = (channel) => ipcHandlers.get(channel)
  mod.initMediaCache()
  mod.registerMediaCacheIpc()
  const legacyHit = mod.resolveCachedAudio(legacyKey, `${base}/audio.mp3`)
  check('旧索引条目被接管并命中', legacyHit.src === `aurora-cache://localhost/audio/${legacyFile}`, String(legacyHit.src))
  check('命中不触发网络请求', hits.audio === 0, `hits=${hits.audio}`)
  ipc('cache:configure')(null, { limitMB: 1024 })

  console.log('3) 音频：未命中后台写入，下次命中')
  const audioKey = 'src-a|100'
  const firstMiss = mod.resolveCachedAudio(audioKey, `${base}/audio.mp3`)
  check('首次返回 null（不阻塞播放）', firstMiss.src === null)
  const audioHit = await waitFor(() => mod.resolveCachedAudio(audioKey, `${base}/audio.mp3`).src)
  check('后台写入后命中，形态为 <pool>/<file>', /^aurora-cache:\/\/localhost\/audio\/[a-f0-9]{40}\.mp3$/.test(String(audioHit)), String(audioHit))
  check('确实请求过歌源一次', hits.audio === 1, `hits=${hits.audio}`)

  const full = await mod.serveCachedMedia(new Request(audioHit))
  const fullBody = Buffer.from(await full.arrayBuffer())
  check('协议读取内容一致', full.status === 200 && fullBody.length === AUDIO_BODY.length && fullBody.equals(AUDIO_BODY))
  const ranged = await mod.serveCachedMedia(
    new Request(audioHit, { headers: { range: 'bytes=10-19' } })
  )
  const rangedBody = Buffer.from(await ranged.arrayBuffer())
  check(
    'Range 请求返回 206 与正确字节',
    ranged.status === 206 && rangedBody.length === 10 && rangedBody.equals(AUDIO_BODY.subarray(10, 20)),
    `${ranged.status}/${rangedBody.length}`
  )
  const missing = await mod.serveCachedMedia(new Request('aurora-cache://localhost/audio/deadbeef.mp3'))
  check('未在索引中的文件返回 404', missing.status === 404)
  const traversal = await mod.serveCachedMedia(
    new Request(`aurora-cache://localhost/audio/..%2F..%2F..%2Fetc%2Fpasswd`)
  )
  check('路径穿越请求被拒', traversal.status === 404, String(traversal.status))
  const overflow = await mod.serveCachedMedia(
    new Request(audioHit, { headers: { range: `bytes=${AUDIO_BODY.length + 10}-` } })
  )
  check(
    '越界 Range 返回 416 而不是畸形 206',
    overflow.status === 416 && overflow.headers.get('content-range') === `bytes */${AUDIO_BODY.length}`,
    `${overflow.status} ${overflow.headers.get('content-range')}`
  )
  const tailRange = await mod.serveCachedMedia(
    new Request(audioHit, { headers: { range: `bytes=0-${AUDIO_BODY.length + 999}` } })
  )
  check(
    'Range 末端超界被截断到文件尾',
    tailRange.status === 206 && tailRange.headers.get('content-length') === String(AUDIO_BODY.length),
    `${tailRange.status} len=${tailRange.headers.get('content-length')}`
  )

  console.log('4) 歌词：写入即计入占用，可读回')
  const lyric = '[00:01.00]测试歌词'
  mod.writeCachedLyrics('track-lyric-1', lyric)
  const lyricPath = path.join(LYRIC_DIR, 'track-lyric-1.lrc')
  check('歌词文件落盘到既定路径', fs.existsSync(lyricPath))
  check('读回内容一致', mod.readCachedLyrics('track-lyric-1') === lyric)
  check('不存在的歌词返回 null', mod.readCachedLyrics('track-lyric-none') === null)
  const usageAfterLyric = ipc('cache:usage')()
  check('歌词计入总占用', usageAfterLyric.usedBytes >= Buffer.byteLength(lyric), JSON.stringify(usageAfterLyric))

  console.log('5) 封面：本地登记 + 远端缓存')
  const localCover = path.join(COVER_DIR, 'track-cover-local.jpg')
  fs.mkdirSync(COVER_DIR, { recursive: true })
  fs.writeFileSync(localCover, IMAGE_BODY)
  mod.registerCoverFile('track-cover-local', localCover)
  const usedAfterCover = ipc('cache:usage')().usedBytes
  check('本地封面登记后计入占用', usedAfterCover > usageAfterLyric.usedBytes, `${usedAfterCover} > ${usageAfterLyric.usedBytes}`)

  const coverKey = 'cover-src-a|100'
  check('远端封面首次未命中', mod.resolveCachedCover(coverKey, `${base}/cover.jpg`).src === null)
  const coverHit = await waitFor(() => mod.resolveCachedCover(coverKey, `${base}/cover.jpg`).src)
  check('远端封面命中缓存协议地址', /^aurora-cache:\/\/localhost\/cover\/[a-f0-9]{40}\.jpg$/.test(String(coverHit)), String(coverHit))
  const coverResp = await mod.serveCachedMedia(new Request(coverHit))
  const coverBody = Buffer.from(await coverResp.arrayBuffer())
  check('远端封面内容一致', coverBody.equals(IMAGE_BODY))

  // 删曲目会连带删掉封面文件，索引里的僵尸条目必须一并销掉，否则占用只涨不降
  const usedBeforeForget = ipc('cache:usage')().usedBytes
  fs.unlinkSync(localCover)
  mod.forgetCachedFile(localCover)
  const usedAfterForget = ipc('cache:usage')().usedBytes
  check(
    '外部删文件后索引条目被销掉（占用回落）',
    usedAfterForget === usedBeforeForget - IMAGE_BODY.length,
    `${usedBeforeForget} → ${usedAfterForget}`
  )
  check('未登记的文件调用 forget 不报错', (mod.forgetCachedFile(path.join(COVER_DIR, 'nope.jpg')), true))

  console.log('6) 驱逐：池内 LRU + 通知调用方回填曲库')
  const evicted = []
  mod.setCacheEvictListener((p) => evicted.push(p))
  // 1MB 总容量：各池配额被缩放到 audio≈0.57MB / cover≈0.29MB / lyrics≈0.14MB
  ipc('cache:configure')(null, { limitMB: 1 })
  const limits = mod.poolLimitsMB(1)
  const coverQuota = Math.floor(limits.cover * 1024 * 1024)
  for (let i = 0; i < 20; i++) {
    const p = path.join(COVER_DIR, `track-evict-${i}.jpg`)
    fs.writeFileSync(p, Buffer.alloc(Math.floor(coverQuota / 5) + 1, i))
    mod.registerCoverFile(`track-evict-${i}`, p)
    await new Promise((r) => setTimeout(r, 3)) // 让 lastUsed 可区分
  }
  const coverFilesLeft = listDir(COVER_DIR).filter((n) => n.startsWith('track-evict-'))
  check('封面池按配额淘汰', coverFilesLeft.length > 0 && coverFilesLeft.length < 20, `left=${coverFilesLeft.length}`)
  check('最旧的先被删', !coverFilesLeft.includes('track-evict-0.jpg'), coverFilesLeft.join(','))
  check('驱逐通知带池与曲目 id', evicted.some((e) => e.pool === 'cover' && e.trackId === 'track-evict-0'))
  check('驱逐通知带绝对路径', evicted.every((e) => path.isAbsolute(e.filePath)))
  const audioSurvived = fs.existsSync(path.join(AUDIO_DIR, legacyFile))
  check('音频池不受封面池影响（池隔离）', audioSurvived)
  const usageNow = ipc('cache:usage')()
  check('总占用不超过总量', usageNow.usedBytes <= 1024 * 1024, JSON.stringify(usageNow))

  console.log('7) 关闭不删数据 / 清空才删')
  // 「关闭」只停止新增缓存：磁盘上已有的歌词、封面、音频一个都不能动——
  // 配置项被重新解释就静默删用户文件，是升级时最不能接受的行为
  ipc('cache:configure')(null, { limitMB: 0 })
  check(
    '关闭缓存保留既有文件',
    fs.existsSync(lyricPath) && listDir(COVER_DIR).length > 0 && listDir(AUDIO_DIR).length > 0,
    `covers=${listDir(COVER_DIR).length} audio=${listDir(AUDIO_DIR).length}`
  )
  mod.writeCachedLyrics('track-lyric-2', lyric)
  check('关闭缓存后不再写新歌词', !fs.existsSync(path.join(LYRIC_DIR, 'track-lyric-2.lrc')))
  check('关闭缓存后不再拉取新内容', (() => {
    const before = hits.audio
    const res = mod.resolveCachedAudio('src-a|300', `${base}/audio.mp3`)
    return res.src === null && hits.audio === before
  })())
  check('关闭缓存下已有内容仍可命中（冻结而非失效）', mod.resolveCachedAudio(audioKey, `${base}/audio.mp3`).src !== null)
  // 关闭档位下封面照样会写盘（提取封面是曲库功能），必须照常登记：
  // 不登记就成了既不受配额约束、也不被「清空缓存」删除的孤儿文件
  const coverUnderOff = path.join(COVER_DIR, 'track-off-1.jpg')
  fs.writeFileSync(coverUnderOff, IMAGE_BODY)
  mod.registerCoverFile('track-off-1', coverUnderOff)
  check('关闭档位下写入的封面仍被登记（占用可见）', ipc('cache:usage')().usedBytes > 0, JSON.stringify(ipc('cache:usage')()))

  // 关闭档位期间未登记的历史文件，改回有容量时应被收编
  const strayFile = path.join(COVER_DIR, 'track-stray-1.jpg')
  fs.writeFileSync(strayFile, IMAGE_BODY)
  ipc('cache:configure')(null, { limitMB: 1024 })
  mod.writeCachedLyrics('track-lyric-3', lyric)
  check(
    '重新开启容量会收编未登记的同目录文件',
    ipc('cache:usage')().usedBytes >= IMAGE_BODY.length * 2 && ipc('cache:usage')().count >= 2,
    JSON.stringify(ipc('cache:usage')())
  )

  // 制造三类内容，验证清空会一并清理、且把被删封面报给调用方做精确回填
  const coverForClear = path.join(COVER_DIR, 'track-clear-1.jpg')
  fs.writeFileSync(coverForClear, IMAGE_BODY)
  mod.registerCoverFile('track-clear-1', coverForClear)
  let removedCovers = null
  mod.setCacheClearListener((files) => {
    removedCovers = files
  })
  ipc('cache:clear')()
  check(
    '清空回调带被删封面清单（供精确回填曲库）',
    Array.isArray(removedCovers) && removedCovers.length > 0 && removedCovers.every((f) => path.isAbsolute(f)),
    JSON.stringify(removedCovers)
  )
  check('清空后占用归零', ipc('cache:usage')().usedBytes === 0)
  check('清空后音频文件被删', listDir(AUDIO_DIR).length === 0, listDir(AUDIO_DIR).join(','))
  check('清空后封面/歌词文件被删', listDir(COVER_DIR).length === 0 && listDir(LYRIC_DIR).length === 0)
  check('清空后不再命中', mod.resolveCachedAudio(audioKey, `${base}/audio.mp3`).src === null)

  console.log('8) 竞态：下载途中清空缓存')
  check('触发慢速封面下载', mod.resolveCachedCover('slow|1', `${base}/slow-cover.jpg`).src === null)
  await new Promise((r) => setTimeout(r, 80)) // 让请求真正发出并卡在 await 上
  ipc('cache:clear')()
  await new Promise((r) => setTimeout(r, 700)) // 等下载流程走完（此刻缓存已被清空）
  check(
    '清空后完成的下载不会把自己重新登记回去',
    ipc('cache:usage')().usedBytes === 0 && listDir(COVER_DIR).length === 0,
    JSON.stringify(ipc('cache:usage')())
  )

  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
  if (failures.length > 0) {
    console.log('失败项：\n - ' + failures.join('\n - '))
  }
  server.close()
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('冒烟脚本异常:', err)
  server.close()
  process.exit(1)
})
