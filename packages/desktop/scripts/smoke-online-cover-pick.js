#!/usr/bin/env node
/**
 * 在线封面挑选端到端冒烟测试（开发用，不参与构建与 CI）。
 *
 * 为什么需要它：在线兜底原先只按标题挑封面（歌手与时长仅加分），歌源里
 * 同名结果大量是翻唱与搬运条目（「杀死那个石家庄人」贴成「醉美谋女郎」的翻唱版），
 * 封面一旦落盘就被当成正式封面——比没有封面更糟，且用户几乎不可能察觉。
 *
 * 本脚本在**真实数据库的副本**上、用**真实歌源**跑真实的 fetchOnlineCover：
 *   - 「杀死那个石家庄人」：带封面的候选全是翻唱/搬运，旧算法必贴错，新算法返回 null
 *   - 「浪漫手机」：存在原版条目，新旧算法都必须命中，证明没有把可用封面一起拦掉
 *   - 「Plain Jane (Remix)」：本地即 Remix 且歌源原版与它同长，不得借用原版封面
 *
 * 用法：ELECTRON_RUN_AS_NODE=1 npx electron scripts/smoke-online-cover-pick.js
 *       （`pnpm smoke:cover-online` 在无 X server / DISPLAY 的环境下起不来 Electron，
 *        该路径会显式报错退出 1，不会静默假绿）
 * 前置：`npx tsc -p tsconfig.electron.json` 与 `npm --prefix ../shared run build` 已执行；
 *       歌源地址可用 AURORA_SMOKE_SOURCE 覆盖（默认本机 127.0.0.1:3201）。
 */

'use strict'

// 主进程模块依赖 electron 运行时（app.getPath），让 Electron 以 node 模式跑，
// 再给 electron 模块打桩（不启动真实窗口）。
//
// 注意 spawnSync 的 status 在「子进程被信号打死」时是 null，若直接落到
// `res.status ?? 1` 之外的路径或忽略 signal，脚本会在 Electron 根本没跑起来
// （无 X server / DISPLAY 缺失）时照样打印成功退出，形成假绿。这里显式判定。
if (!process.versions.electron) {
  if (process.env.ELECTRON_RUN_AS_NODE === '1') {
    console.error('已在 ELECTRON_RUN_AS_NODE 下仍拿不到 electron 运行时，环境异常')
    process.exit(1)
  }
  const { spawnSync } = require('node:child_process')
  const electron = require('electron')
  const res = spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  if (res.error) {
    console.error('启动 Electron 失败：', res.error.message)
    process.exit(1)
  }
  if (res.signal) {
    console.error(`Electron 子进程被信号 ${res.signal} 终止（常见原因：无 X server / DISPLAY）`)
    process.exit(1)
  }
  if (res.status !== 0) {
    console.error(`Electron 子进程退出码 ${res.status}`)
    process.exit(res.status ?? 1)
  }
  process.exit(0)
}

const Module = require('module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REAL_DB =
  process.env.AURORA_SMOKE_DB ||
  path.join(os.homedir(), '.config/@aurora/desktop/aurora-music/library.db')
const REAL_COVERS = path.join(path.dirname(REAL_DB), 'covers')

const API_KEY = process.env.AURORA_SMOKE_KEY || '22fd9f64-ee25-43a7-a899-d9981630f481'
const SOURCE_BASE = process.env.AURORA_SMOKE_SOURCE || 'http://127.0.0.1:3201'

// 沙箱目录：数据库与封面缓存都复制一份，绝不动真实数据。
// 主进程的库路径是 <userData>/aurora-music/library.db（见 database.getDbPath），
// 沙箱布局必须与之同构，否则代码会开出一个空库。
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-online-cover-'))
const sandboxCovers = path.join(sandbox, 'aurora-music', 'covers')
const sandboxDb = path.join(sandbox, 'aurora-music', 'library.db')
fs.mkdirSync(sandboxCovers, { recursive: true })
fs.copyFileSync(REAL_DB, sandboxDb)
for (const ext of ['-wal', '-shm']) {
  if (fs.existsSync(REAL_DB + ext)) fs.copyFileSync(REAL_DB + ext, sandboxDb + ext)
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
  exports: { app: { getPath: () => sandbox } },
  paths: [],
  children: [],
}

const shared = require('@aurora/shared')
const { initDatabase, getTrackById, updateTrack } = require('../dist-electron/ipc/database.js')
const { fetchOnlineCover } = require('../dist-electron/ipc/scanner.js')
const { initMediaCache } = require('../dist-electron/ipc/mediaCache.js')

initMediaCache()
initDatabase()

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const info = (msg) => console.log(`       ${msg}`)

const SOURCE = {
  id: 'src-my',
  name: 'MY',
  sourceUrl: `${SOURCE_BASE}/?key=${API_KEY}`,
  enabled: true,
  endpoints: {
    search: `/aurora?query={query}&quality={quality}&key=${API_KEY}`,
    playlist: `/aurora/playlist?url={url}&key=${API_KEY}`,
  },
}

/**
 * 旧算法的忠实复刻：只有「标题匹配（归一化后相等或互含）+ 歌手/时长加分」，
 * 没有歌手门禁、没有版本标记排除、没有时长兜底。归一化等纯函数直接复用
 * shared 里的同一份实现，保证新旧差异**只**来自被修的判据本身。
 */
function legacyPick(candidates, track) {
  const wantTitle = shared.normalizeForMatch(shared.cleanTitleForQuery(track.title, track.artist))
  const wantArtist = shared.normalizeForMatch(track.artist)
  let best = null
  let bestScore = 0
  for (const c of candidates) {
    if (!c.coverUrl || !/^https?:\/\//i.test(c.coverUrl)) continue
    const ct = shared.normalizeForMatch(shared.cleanTitleForQuery(c.title, c.artist))
    if (!wantTitle || !ct) continue
    if (ct !== wantTitle && !ct.includes(wantTitle) && !wantTitle.includes(ct)) continue
    let score = 2
    const ca = shared.normalizeForMatch(c.artist)
    if (wantArtist && ca && (ca === wantArtist || ca.includes(wantArtist) || wantArtist.includes(ca))) {
      score += 1
    }
    if (track.duration > 0 && c.duration > 0 && Math.abs(c.duration - track.duration) <= 3) score += 2
    if (score > bestScore) {
      best = c
      bestScore = score
    }
  }
  return best
}

const describe = (c) =>
  c ? `「${c.title}」/ ${c.artist} / ${Math.round(c.duration)}s / 专辑「${c.album}」` : '（无）'

const db = require('better-sqlite3')(sandboxDb)

function findTrack(titleLike) {
  return db
    .prepare('SELECT id, title FROM tracks WHERE title = ? LIMIT 1')
    .get(titleLike)
}

/** 读文件头确认落盘的确实是一张图片（封面缓存扩展名只管 jpg/png/webp/gif/bmp） */
function isImageFile(file) {
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(12)
  const read = fs.readSync(fd, head, 0, 12, 0)
  fs.closeSync(fd)
  const h = head.subarray(0, read)
  if (h.length < 4) return false
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return true
  if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return true
  if (h.toString('latin1', 0, 4) === 'GIF8') return true
  if (h[0] === 0x42 && h[1] === 0x4d) return true
  return h.toString('latin1', 0, 4) === 'RIFF' && h.toString('latin1', 8, 12) === 'WEBP'
}

function coversOf(trackId) {
  return fs.readdirSync(sandboxCovers).filter((f) => f.startsWith(`${trackId}.`))
}

/**
 * 搜索候选。第三方歌源偶发 500（限流/上游抖动），失败时退避重试，
 * 否则冒烟测试会变成在测歌源可用性而不是在测挑选逻辑。
 */
async function searchFor(track, attempts = 4) {
  const rawArtist = track.artist
  const artist = shared.firstArtistOf(rawArtist)
  const title = shared.cleanTitleForQuery(track.title, rawArtist)
  const query = shared.tradToSimp(`${artist} ${title}`).trim()
  let lastErr
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1500 * i))
    try {
      const candidates = await shared.searchOnlineTracks(query, { sources: [SOURCE], quality: 'flac' })
      if (candidates.length > 0) return { query, candidates }
      lastErr = new Error('歌源返回 0 条候选')
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`歌源连续 ${attempts} 次未返回候选：${lastErr && lastErr.message}`)
}

/** fetchOnlineCover 内部会自带一次搜索，源抖动时会抛错；同样退避重试 */
async function ensureOnlineCover(trackId, attempts = 4) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1500 * i))
    updateTrack(trackId, { coverPath: undefined })
    try {
      return await fetchOnlineCover(getTrackById(trackId), sandbox, {
        sources: [SOURCE],
        quality: 'flac',
      })
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`fetchOnlineCover 连续 ${attempts} 次失败：${lastErr && lastErr.message}`)
}

async function main() {
  console.log(`沙箱: ${sandbox}`)
  console.log(`歌源: ${SOURCE_BASE}\n`)

  // ── 场景 1：带封面的候选全是翻唱/搬运 —— 必须不贴错 ──────────────────
  const victim = findTrack('杀死那个石家庄人')
  if (!victim) {
    console.error('沙箱库里找不到样本曲目「杀死那个石家庄人」')
    process.exit(2)
  }
  const victimRow = getTrackById(victim.id)
  console.log('场景 1：杀死那个石家庄人（歌源里同名候选多为翻唱/搬运）')
  const s1 = await searchFor(victimRow)
  info(`查询词「${s1.query}」命中 ${s1.candidates.length} 条候选`)
  const legacyVictim = legacyPick(s1.candidates, victimRow)
  info(`旧算法会选：${describe(legacyVictim)}`)
  const legacyWrong =
    !!legacyVictim &&
    shared.normalizeForMatch(legacyVictim.artist) !== shared.normalizeForMatch(victimRow.artist)
  check('旧算法确实会贴错（选中歌手与本地曲目不符）', legacyWrong)

  // 清掉库里的 coverPath，逼 fetchOnlineCover 真正走在线挑选与下载
  updateTrack(victim.id, { coverPath: undefined })
  const before = coversOf(victim.id).length
  const got = await ensureOnlineCover(victim.id)
  check('新算法不贴错封面（无合格候选时返回 null）', got === null, got ? `返回 ${got}` : 'null')
  check('新算法没有落盘任何封面文件', coversOf(victim.id).length === before)
  check(
    '库里的 coverPath 仍为空（未把错图登记成封面）',
    !getTrackById(victim.id).coverPath,
    String(getTrackById(victim.id).coverPath)
  )

  // ── 场景 2：存在原版条目 —— 必须照常命中，不能把可用封面一起拦掉 ──────
  console.log('\n场景 2：浪漫手机（歌源存在原版条目）')
  const good = findTrack('浪漫手机')
  if (!good) {
    console.error('沙箱库里找不到样本曲目「浪漫手机」')
    process.exit(2)
  }
  const goodRow = getTrackById(good.id)
  const s2 = await searchFor(goodRow)
  info(`查询词「${s2.query}」命中 ${s2.candidates.length} 条候选`)
  const legacyGood = legacyPick(s2.candidates, goodRow)
  info(`旧算法会选：${describe(legacyGood)}`)

  updateTrack(good.id, { coverPath: undefined })
  const gotGood = await ensureOnlineCover(good.id)
  check('新算法命中并落盘封面', !!gotGood && fs.existsSync(gotGood), String(gotGood))
  check('落盘内容确实是图片', !!gotGood && isImageFile(gotGood))
  check(
    '回填进库的 coverPath 与新落盘文件一致',
    getTrackById(good.id).coverPath === gotGood,
    String(getTrackById(good.id).coverPath)
  )
  const lv = legacyPick(s2.candidates, goodRow)
  const nv = shared.pickCoverCandidate(s2.candidates, {
    title: goodRow.title,
    artist: goodRow.artist,
    duration: goodRow.duration,
    album: goodRow.album,
  })
  check(
    '正例上新旧算法选中同一条候选（未收紧到误杀）',
    !!lv && !!nv && lv.id === nv.id,
    `旧=${describe(lv)} 新=${describe(nv)}`
  )
  check(
    '命中候选确实是原版录音室版（专辑为「十一月的萧邦」而非现场/精选）',
    !!nv && nv.album === '十一月的萧邦' && nv.artist === '周杰伦',
    describe(nv)
  )

  // ── 场景 3：本地条目本身是版本（Remix）——歌源里同长原版不得借封面 ──────
  console.log('\n场景 3：Plain Jane (Remix)（本地即 Remix，歌源原版与该 Remix 同长）')
  const remix = findTrack('Plain Jane (Remix)')
  if (!remix) {
    console.error('沙箱库里找不到样本曲目「Plain Jane (Remix)」')
    process.exit(2)
  }
  const remixRow = getTrackById(remix.id)
  const s3 = await searchFor(remixRow)
  info(`查询词「${s3.query}」命中 ${s3.candidates.length} 条候选`)
  const legacyRemix = legacyPick(s3.candidates, remixRow)
  info(`旧算法会选：${describe(legacyRemix)}`)
  const nv3 = shared.pickCoverCandidate(s3.candidates, {
    title: remixRow.title,
    artist: remixRow.artist,
    duration: remixRow.duration,
    album: remixRow.album,
  })
  check(
    '本地 Remix 不借用原版/Live 候选的封面',
    nv3 === null || shared.normalizeForMatch(nv3.title) === shared.normalizeForMatch(remixRow.title),
    describe(nv3)
  )

  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}（沙箱 ${sandbox}）`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('冒烟测试异常:', err)
  process.exit(1)
})