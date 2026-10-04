#!/usr/bin/env node
/**
 * 悬空封面路径端到端冒烟测试（开发用，不参与构建与 CI）。
 *
 * 为什么需要它：库里 coverPath 指向的封面文件被媒体缓存驱逐（或被外部清掉）后，
 * 主进程原先把「记录里有 coverPath」直接当成「封面已就绪」早退返回。那个路径
 * 已经被渲染层当成功结果缓存，于是 img 永久 404 —— 右侧 Now Playing 面板与
 * 播放条退回占位图（实测现场），列表里则表现为封面整片消失。
 *
 * 本脚本在**真实数据库的副本**上跑真实的 ensureCover / fetchOnlineCover / ensureRemoteCover：
 *   - 悬空 coverPath：不再早退，改走重新提取，并把库里的悬空路径清成 NULL
 *   - 有效 coverPath：仍然早退（不重复解析、不重复落盘）
 *   - 无 coverPath + 有内嵌封面：正常提取并回填
 *
 * 用法：pnpm --filter @aurora/desktop smoke:cover
 * 前置：`npx tsc -p tsconfig.electron.json` 已编译主进程；
 *       用 AURORA_SMOKE_DB 指定真实库路径（默认取本机 userData 下的 library.db）。
 */

'use strict'

// 主进程模块依赖 electron 运行时（app.getPath），让 Electron 以 node 模式跑，
// 再给 electron 模块打桩（不启动真实窗口）。
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
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REAL_DB =
  process.env.AURORA_SMOKE_DB ||
  path.join(os.homedir(), '.config/@aurora/desktop/aurora-music/library.db')
const REAL_COVERS = path.join(path.dirname(REAL_DB), 'covers')

// 沙箱目录：数据库与封面缓存都复制一份，绝不动真实数据。
// 注意主进程的库路径是 <userData>/aurora-music/library.db（见 database.getDbPath），
// 沙箱布局必须与之同构，否则代码会开出一个空库、所有查询都返回 null。
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-cover-smoke-'))
const sandboxCovers = path.join(sandbox, 'aurora-music', 'covers')
const sandboxDb = path.join(sandbox, 'aurora-music', 'library.db')
fs.mkdirSync(sandboxCovers, { recursive: true })
fs.copyFileSync(REAL_DB, sandboxDb)
for (const ext of ['-wal', '-shm']) {
  if (fs.existsSync(REAL_DB + ext)) fs.copyFileSync(REAL_DB + ext, sandboxDb + ext)
}
for (const f of (() => {
  try {
    return fs.readdirSync(REAL_COVERS)
  } catch {
    return []
  }
})()) {
  fs.copyFileSync(path.join(REAL_COVERS, f), path.join(sandboxCovers, f))
}

// electron 打桩：app.getPath('userData') 指向沙箱
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

const { initDatabase, getTrackById, updateTrack } = require('../dist-electron/ipc/database.js')
const { ensureCover, fetchOnlineCover } = require('../dist-electron/ipc/scanner.js')
const { ensureRemoteCover } = require('../dist-electron/ipc/librarySource.js')
const { initMediaCache } = require('../dist-electron/ipc/mediaCache.js')

// initMediaCache 用打桩后的 userData，索引与文件都落在沙箱
initMediaCache()
initDatabase()

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const shot = (id) => getTrackById(id)
const sandboxCoverOf = (id) => {
  const hits = fs.readdirSync(sandboxCovers).filter((f) => f.startsWith(`${id}.`))
  return hits.length ? path.join(sandboxCovers, hits[0]) : null
}

// ─── 构造样本：从真实库里挑一首「文件仍在、封面被删」的曲目 ────────────────
const db = require('better-sqlite3')(sandboxDb)
const victim = db
  .prepare(
    `SELECT id, path, title FROM tracks
      WHERE (cover_path IS NULL OR cover_path = '') AND path LIKE '/home/%'
      ORDER BY rowid LIMIT 1`
  )
  .get()
if (!victim) {
  console.error('沙箱库里找不到可用样本（需要一首无 cover_path 且文件仍在的曲目）')
  process.exit(2)
}
const victimId = victim.id


async function main() {
  console.log(`沙箱: ${sandbox}`)
  console.log(`样本: ${victim.title} (${victimId})\n`)
  console.log('场景 1：库里存的是悬空 coverPath（文件已被驱逐）')

  // 故意把不存在的路径写回记录，模拟「上一次运行残留 / 缓存目录被外部清掉」
  const stalePath = path.join(sandboxCovers, `${victimId}.jpg`)
  check('前置：该路径当前确实不存在', !fs.existsSync(stalePath), stalePath)
  updateTrack(victimId, { coverPath: stalePath })
  check('前置：库里已写入悬空路径', shot(victimId).coverPath === stalePath)

  const recovered = await ensureCover(shot(victimId), sandbox)
  // 提取落盘用的是 <trackId>.<ext>，与那条 stale 路径可能同名——判据不是「路径不同」，
  // 而是「前置为不存在 → 调用后确实存在」（旧实现在这里直接早退，文件仍不存在）
  check('ensureCover 不再早退返回悬空路径', !!recovered && fs.existsSync(recovered), `返回 ${recovered}`)
  check(
    '库里被回填为可用的封面路径',
    shot(victimId).coverPath === recovered && fs.existsSync(shot(victimId).coverPath),
    `coverPath=${shot(victimId).coverPath}`
  )

  console.log('\n场景 2：coverPath 有效时仍走早退（不重复解析 / 不重复落盘）')
  const keptMtime = fs.statSync(recovered).mtimeMs
  const again = await ensureCover(shot(victimId), sandbox)
  check('早退返回同一个有效路径', again === recovered, `返回 ${again}`)
  check('未重复写盘', fs.statSync(recovered).mtimeMs === keptMtime)

  console.log('\n场景 3：无 coverPath 时正常提取（基线，确认没把功能改坏）')
  updateTrack(victimId, { coverPath: undefined })
  check('前置：coverPath 已清空', !shot(victimId).coverPath)
  const fresh = await ensureCover(shot(victimId), sandbox)
  check('无路径时正常提取出封面', !!fresh && fs.existsSync(fresh))

  console.log('\n场景 4：fetchOnlineCover 同样不再被悬空路径拦住')
  // 场景 3 刚把有效路径写回库里，这里重新制造悬空路径（写入 + 删文件）
  updateTrack(victimId, { coverPath: stalePath })
  if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath)
  check(
    '前置：库里是悬空路径且文件不存在',
    shot(victimId).coverPath === stalePath && !fs.existsSync(stalePath),
    `coverPath=${shot(victimId).coverPath} stale=${stalePath} exists=${fs.existsSync(stalePath)}`
  )
  const online = await fetchOnlineCover(shot(victimId), sandbox, undefined).catch((e) => `THROW:${e.message}`)
  if (typeof online === 'string' && online.startsWith('THROW:')) {
    // 未配置歌源 / 无匹配时抛错或返回 null 都是正常终态；关键是不能把那条已删路径当成功返回
    check('未把已删路径当成功结果返回', online !== stalePath, online.slice(0, 80))
  } else {
    check('未把已删路径当成功结果返回', online !== stalePath && (online === null || fs.existsSync(online)), `返回 ${online}`)
  }

  console.log('\n场景 5：ensureRemoteCover 同样做悬空校验')
  const remoteVictim = db
    .prepare(`SELECT id FROM tracks WHERE cover_path IS NOT NULL AND cover_path != '' LIMIT 1`)
    .get()
  if (remoteVictim) {
    updateTrack(remoteVictim.id, { coverPath: stalePath })
    const r = await ensureRemoteCover(shot(remoteVictim.id), sandbox).catch(() => null)
    check('远端曲目悬空路径不再早退返回它', r !== stalePath, `返回 ${r}`)
  }

  db.close()
  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
  console.log(`沙箱保留在 ${sandbox}（可手动检查；不属于仓库产物）`)
  return failures === 0 ? 0 : 1
}

main().then((code) => process.exit(code))
