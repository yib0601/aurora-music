#!/usr/bin/env node
/**
 * WebDAV 媒体库来源的端到端冒烟测试（开发用，不参与构建与 CI）。
 *
 * 为什么需要它：这个功能依赖两样外部东西——一台真实的 WebDAV 服务器（群晖/威联通/
 * Nextcloud/rclone）和一个真实的 Electron 运行时（better-sqlite3 是按 Electron ABI
 * 编译的，普通 node 加载不了）。开发者手边通常没有 NAS，而纯单测只有 shared 层、
 * 覆盖不到「主进程建库迁移 + 扫描入库 + Range 元数据解析」这条主链路。
 *
 * 本脚本在本机起一个行为正确的最小 WebDAV 服务器（Basic 鉴权 / PROPFIND Depth:1
 * 返回 207 / GET 支持 Range 返回 206），构造带真实 ID3v2.3 标签的 MPEG 音频，然后在
 * Electron 运行时里调用真实的主进程模块，断言：
 *   - 建库与 schema 迁移在真实 better-sqlite3 上成功，且不动存量数据
 *   - 递归列举只收音频、跳过 @eaDir 之类的缩略图目录
 *   - 从远端 Range 读到的文件头能解析出标题/艺术家/专辑
 *   - 截断缓冲区下的 MP3 时长被正确还原（不是只算读到那一段）
 *   - 重扫复用记录（id 与播放统计稳定）
 *   - 口令不进入任何曲目记录
 *   - 服务器不可达时抛错且曲库完整保留（断网不清库）
 *   - 移除来源只删该来源的曲目
 *   - aurora-remote 代理链路（解析→鉴权→Range 转发）返回 206 与正确字节
 *
 * 用法：pnpm --filter @aurora/desktop smoke:webdav
 * 前置：先 `pnpm --filter @aurora/desktop exec tsc -p tsconfig.electron.json` 编译主进程。
 */

'use strict'

// better-sqlite3 按 Electron ABI 编译，普通 node 加载会报 NODE_MODULE_VERSION 不匹配。
// 用 ELECTRON_RUN_AS_NODE 让 Electron 以 node 模式跑本脚本，ABI 就对齐了。
// （此时没有可用的 app 对象，脚本里用 Module._load 拦截 electron 提供一个桩。）
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

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-smoke-'))
const USER_DATA = path.join(TMP_ROOT, 'userdata')
fs.mkdirSync(USER_DATA, { recursive: true })

const DESKTOP_DIST = path.join(__dirname, '..', 'dist-electron')
if (!fs.existsSync(path.join(DESKTOP_DIST, 'ipc', 'librarySource.js'))) {
  console.error('未找到编译产物，请先运行：pnpm --filter @aurora/desktop exec tsc -p tsconfig.electron.json')
  process.exit(1)
}

// database.ts 只用到 electron 的 app.getPath('userData')；换成临时目录，
// 绝不碰用户真实的曲库（<userData>/aurora-music/library.db）
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: (name) => (name === 'userData' ? USER_DATA : TMP_ROOT) } }
  }
  return originalLoad.apply(this, arguments)
}

const shared = require('@aurora/shared')

// ─── 测试夹具：真实 ID3v2.3 标签 + MPEG1 Layer III / 128kbps / 44.1kHz 帧 ───
const MP3_FRAME_BYTES = 417

function syncsafe(n) {
  return Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f])
}

function textFrame(id, text) {
  // 编码字节 0x03 = UTF-8，中文标签才不会被当成 latin1 解出乱码
  const body = Buffer.concat([Buffer.from([0x03]), Buffer.from(text, 'utf-8')])
  const size = Buffer.from([(body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff])
  return Buffer.concat([Buffer.from(id, 'ascii'), size, Buffer.from([0x00, 0x00]), body])
}

/** 秒数可预期的 CBR MP3：duration = frames * 1152 / 44100 */
function makeMp3({ title, artist, album, frames }) {
  const tagBody = Buffer.concat([textFrame('TIT2', title), textFrame('TPE1', artist), textFrame('TALB', album)])
  const id3 = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([0x03, 0x00, 0x00]), syncsafe(tagBody.length), tagBody])
  const audio = Buffer.alloc(MP3_FRAME_BYTES * frames)
  for (let i = 0; i < frames; i++) {
    const o = i * MP3_FRAME_BYTES
    audio[o] = 0xff
    audio[o + 1] = 0xfb
    audio[o + 2] = 0x90
    audio[o + 3] = 0x00
  }
  return Buffer.concat([id3, audio])
}

// ─── 最小 WebDAV 服务器 ───
const USER = 'bob'
const PASS = 'p@ss word'
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`, 'utf-8').toString('base64')

function createWebdavServer(files, dirs) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const pathname = decodeURIComponent(url.pathname).replace(/^\/dav\/?/, '').replace(/\/$/, '')

    // 未鉴权一律 401：验证 Basic 头真的被带上了
    if (req.headers.authorization !== AUTH) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dav"' })
      return res.end()
    }

    if (req.method === 'PROPFIND') {
      // 真实服务器对缺失/非法 Depth 会返回 400，据此验证客户端确实发了 Depth: 1
      if (String(req.headers.depth) !== '1') return res.writeHead(400).end('Depth must be 1')
      if (!dirs.has(pathname)) return res.writeHead(404).end()
      const enc = (p) => p.split('/').map(encodeURIComponent).join('/')
      const out = []
      const push = (rel, isDir, size) =>
        out.push(
          `<D:response><D:href>/dav/${enc(rel)}${isDir ? '/' : ''}</D:href><D:propstat><D:prop>` +
            `<D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>` +
            `<D:getcontentlength>${size}</D:getcontentlength>` +
            `<D:getlastmodified>Wed, 01 Jan 2025 00:00:00 GMT</D:getlastmodified>` +
            `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
        )
      push(pathname, true, 0)
      const prefix = pathname ? `${pathname}/` : ''
      for (const d of dirs) {
        if (d === pathname || d === '') continue
        if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) push(d, true, 0)
      }
      for (const f of Object.keys(files)) {
        if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) push(f, false, files[f].length)
      }
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
      return res.end(`<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${out.join('')}</D:multistatus>`)
    }

    if (req.method === 'GET') {
      const file = files[pathname]
      if (!file) return res.writeHead(404).end()
      const range = req.headers.range
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(String(range))
        if (!m) return res.writeHead(416).end()
        const start = parseInt(m[1], 10)
        const end = m[2] ? Math.min(parseInt(m[2], 10), file.length - 1) : file.length - 1
        const chunk = file.subarray(start, end + 1)
        res.writeHead(206, {
          'Content-Type': 'audio/mpeg',
          'Content-Range': `bytes ${start}-${end}/${file.length}`,
          'Content-Length': String(chunk.length),
          'Accept-Ranges': 'bytes',
        })
        return res.end(chunk)
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(file.length) })
      return res.end(file)
    }

    res.writeHead(405).end()
  })
}

// ─── 断言 ───
let failures = 0
function check(cond, msg) {
  if (cond) {
    console.log('  ✅ ' + msg)
  } else {
    failures++
    console.error('  ❌ ' + msg)
  }
}

async function main() {
  const files = {
    'Music/Album One/01 反方向的钟.mp3': makeMp3({ title: '反方向的钟', artist: '周杰伦', album: '范特西', frames: 3000 }),
    'Music/Album One/02 简单爱.mp3': makeMp3({ title: '简单爱', artist: '周杰伦', album: '范特西', frames: 600 }),
    'Music/Album One/cover.jpg': Buffer.alloc(2048, 0x33),
    // 群晖缩略图目录：混进来会让曲库出现大量重复垃圾条目
    'Music/@eaDir/01 反方向的钟.mp3': makeMp3({ title: '缩略图里的假歌', artist: 'x', album: 'y', frames: 10 }),
  }
  const dirs = new Set(['', 'Music', 'Music/Album One', 'Music/@eaDir'])

  const server = createWebdavServer(files, dirs)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  console.log(`\n本机 WebDAV 服务器: http://127.0.0.1:${port}/dav\n`)

  const db = require(path.join(DESKTOP_DIST, 'ipc', 'database.js'))
  const lib = require(path.join(DESKTOP_DIST, 'ipc', 'librarySource.js'))

  console.log('【数据库与迁移】')
  db.initDatabase()
  check(true, 'initDatabase() 在真实 better-sqlite3 上成功')
  // 存量本机曲目：验证 schema 迁移与 upsert 不会破坏老数据
  db.insertTracks([
    { id: 'legacy-1', path: '/home/me/Music/old.mp3', title: '老歌', artist: '老歌手', album: '老专辑', duration: 100, fileSize: 1000, addedAt: 111, playCount: 7, liked: true },
  ])
  db.updateTrack('legacy-1', { playCount: 7, liked: true })
  check(db.getTrackById('legacy-1').playCount === 7, '存量曲目在新 schema 下读写正常')

  console.log('\n【扫描入库】')
  const cfg = {
    id: 'lib-smoke', kind: 'webdav', name: '测试 NAS',
    baseUrl: `http://127.0.0.1:${port}/dav`, username: USER, password: PASS,
    rootPath: 'Music', enabled: true,
  }
  lib.syncLibrarySources([cfg])

  const probe = await lib.probeLibrarySource('lib-smoke')
  check(probe.ok === true, `probeLibrarySource 连接成功（${probe.message}）`)

  const progress = []
  const result = await lib.scanLibrarySource('lib-smoke', (t) => progress.push(t.title))
  check(result.complete === true, '扫描完成且完全可信')
  check(result.failedDirs === 0, '无目录列举失败')
  check(progress.length === 2, `渐进式回调收到 2 首（实际 ${progress.length}）`)
  check(!progress.some((t) => t.includes('缩略图')), '@eaDir 里的文件未被收录')

  const remote = db.getAllTracks().filter((t) => t.sourceId === 'lib-smoke')
  check(remote.length === 2, `库内远端曲目 2 首（实际 ${remote.length}）`)

  console.log('\n【元数据解析（读远端文件头）】')
  const zhong = remote.find((t) => t.title === '反方向的钟')
  check(!!zhong, '从 ID3 标签解析出标题「反方向的钟」')
  if (zhong) {
    check(zhong.artist === '周杰伦', `艺术家正确（${zhong.artist}）`)
    check(zhong.album === '范特西', `专辑正确（${zhong.album}）`)
    check(zhong.path === 'webdav:lib-smoke/Album One/01 反方向的钟.mp3', `存储坐标正确（${zhong.path}）`)
    check(
      zhong.remoteUrl === 'aurora-remote://lib-smoke/Album%20One/01%20%E5%8F%8D%E6%96%B9%E5%90%91%E7%9A%84%E9%92%9F.mp3',
      'remoteUrl 由 (sourceId, 相对路径) 正确派生'
    )
    // 3000 帧 × 1152 采样 / 44100Hz = 78.367s；只算"读到的那一段"（前 1MB）会得到约 5/6 的值
    const expected = (3000 * 1152) / 44100
    check(Math.abs(zhong.duration - expected) < 0.05, `截断缓冲区的时长被还原为 ${zhong.duration.toFixed(3)}s（期望 ${expected.toFixed(3)}s）`)
    check(zhong.fileSize === files['Music/Album One/01 反方向的钟.mp3'].length, 'fileSize 取自远端 getcontentlength')
  }

  console.log('\n【重扫复用】')
  db.updateTrack(zhong.id, { playCount: 5, liked: true })
  await lib.scanLibrarySource('lib-smoke')
  const zhong2 = db.getAllTracks().find((t) => t.path === zhong.path)
  check(zhong2.id === zhong.id, '重扫后 id 稳定（封面缓存与播放统计不会错位）')
  check(zhong2.playCount === 5 && zhong2.liked === true, '重扫后播放统计与收藏被保留')

  console.log('\n【口令不外泄】')
  check(!JSON.stringify(db.getAllTracks()).includes(PASS), '口令没有出现在任何曲目记录里')

  console.log('\n【aurora-remote 代理链路】')
  const parsedUrl = shared.parseRemoteAudioUrl(zhong.remoteUrl)
  check(!!parsedUrl && parsedUrl.sourceId === 'lib-smoke', 'remoteUrl 能被主进程解析出 sourceId')
  check(parsedUrl.path === 'Album One/01 反方向的钟.mp3', `解析出的相对路径正确（${parsedUrl.path}）`)
  const upstream = await fetch(shared.resolveRemoteUrl(cfg, parsedUrl.path), {
    headers: shared.webdavHeaders(cfg, { Range: 'bytes=0-1023' }),
  })
  check(upstream.status === 206, `上游返回 206（实际 ${upstream.status}）`)
  check(
    upstream.headers.get('content-range') === `bytes 0-1023/${files['Music/Album One/01 反方向的钟.mp3'].length}`,
    `Content-Range 可原样透传给播放器（${upstream.headers.get('content-range')}）`
  )
  const chunk = new Uint8Array(await upstream.arrayBuffer())
  check(chunk.length === 1024 && chunk[0] === 0x49 && chunk[1] === 0x44 && chunk[2] === 0x33, 'Range 取回的数据是真实音频（前 3 字节为 ID3）')

  console.log('\n【跨来源去重】')
  // 把同一首歌也放一份到本机目录，制造「本机 + NAS 都有这首歌」的真实场景。
  // 关键在于两边的时长是分别算出来的：本机是对整文件做完整解析，远端是对
  // 前 1MB 的 Range 做解析再按真实长度等比还原，两者不会逐位相等。
  const localDir = path.join(TMP_ROOT, 'local-music')
  fs.mkdirSync(localDir, { recursive: true })
  fs.writeFileSync(path.join(localDir, '01 反方向的钟.mp3'), files['Music/Album One/01 反方向的钟.mp3'])
  const scanner = require(path.join(DESKTOP_DIST, 'ipc', 'scanner.js'))
  await scanner.scanFolder(localDir, USER_DATA)

  const allNow = db.getAllTracks()
  const localCopy = allNow.find((t) => !t.sourceId && t.path.startsWith(localDir))
  const remoteCopy = allNow.find((t) => t.sourceId === 'lib-smoke' && t.path.includes('反方向的钟'))
  check(!!localCopy && !!remoteCopy, '同一首歌同时存在于本机与 NAS')
  if (localCopy && remoteCopy) {
    const delta = Math.abs(localCopy.duration - remoteCopy.duration)
    console.log(
      `     本机完整解析 ${localCopy.duration.toFixed(4)}s ｜ 远端文件头估算 ${remoteCopy.duration.toFixed(4)}s ｜ 差 ${delta.toFixed(4)}s`
    )
    check(delta > 0, '两侧时长确实不逐位相等（这正是不能用严格浮点相等去重的原因）')
    check(delta <= shared.DURATION_MATCH_TOLERANCE, `差值在 ${shared.DURATION_MATCH_TOLERANCE}s 容差内`)

    const dedup = shared.dedupeTracksForDisplay(allNow)
    check(dedup.hidden === 1, `去重隐藏 1 条重复（实际 ${dedup.hidden}）`)
    check(dedup.tracks.some((t) => t.id === localCopy.id), '本机副本优先保留')
    check(!dedup.tracks.some((t) => t.id === remoteCopy.id), 'NAS 副本被隐藏')
    check(db.getAllTracks().length === allNow.length, '去重只影响展示，记录一条都没删')

    // 时长不同（加长版/现场版）不能被误合并
    const other = { ...remoteCopy, id: 'fake-long', title: remoteCopy.title, artist: remoteCopy.artist, duration: remoteCopy.duration + 30 }
    check(shared.dedupeTracksForDisplay([remoteCopy, other]).hidden === 0, '时长差超出容差时不会被误判成同一首')
  }

  console.log('\n【断网不清库】')
  server.close()
  await new Promise((r) => setTimeout(r, 150))
  let threw = false
  try {
    await lib.scanLibrarySource('lib-smoke')
  } catch {
    threw = true
  }
  check(threw, '服务器不可达时扫描抛错（而不是静默返回空库）')
  check(db.getAllTracks().filter((t) => t.sourceId === 'lib-smoke').length === 2, '不可达时曲库被完整保留')
  check(db.getTrackById('legacy-1') !== null, '本机存量曲目未受影响')

  console.log('\n【移除来源】')
  const removed = lib.removeLibrarySourceTracks('lib-smoke')
  check(removed === 2, `移除来源删除该来源的 2 条记录（实际 ${removed}）`)
  check(db.getAllTracks().filter((t) => t.sourceId === 'lib-smoke').length === 0, '该来源曲目已清空')
  check(db.getTrackById('legacy-1') !== null, '本机曲目在移除来源后仍然存在')

  db.closeDatabase()
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })

  console.log(failures ? `\n=== 冒烟测试失败：${failures} 项 ===` : '\n=== 冒烟测试全部通过 ===')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error('冒烟测试异常:', e)
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  process.exit(1)
})
