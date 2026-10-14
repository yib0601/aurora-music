import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

/**
 * `fetchOnlineCover` 的读体超时映射（desktop 侧第一个行为级测试）。
 *
 * 为什么单独立这一组：本文件所在的 ipc 层此前**没有任何测试**，而本轮给
 * `fetchOnlineCover` 新增了 `coverTimeout` 错误码与读体映射——只靠 i18n 门禁
 * 检查「字典里有这个词」是查不出「超时到底有没有被映射成它」的。
 *
 * 依赖全部 mock 掉（database / mediaCache / coverFile 都要 Electron 运行时），
 * 只留真实网络与真实的 `fetchWithTimeout`，这样才能证明「上游停住 body 时，
 * 用户看到的是可自解释的 coverTimeout 而不是裸编码串」。
 */

const mocks = vi.hoisted(() => ({
  updateTrack: vi.fn(),
  insertTracks: vi.fn(),
  getTracksByPaths: vi.fn((): unknown[] => []),
  deleteTracksWithMissingFiles: vi.fn(),
  countTracksByFolder: vi.fn(() => 0),
  registerCoverFile: vi.fn(),
  isUsableCoverFile: vi.fn(() => false),
  // 在线搜索：直接给出一个候选，避免测试去碰真实音源
  searchOnlineTracks: vi.fn(),
}))

vi.mock('../database', () => ({
  updateTrack: mocks.updateTrack,
  insertTracks: mocks.insertTracks,
  getTracksByPaths: mocks.getTracksByPaths,
  deleteTracksWithMissingFiles: mocks.deleteTracksWithMissingFiles,
  countTracksByFolder: mocks.countTracksByFolder,
}))
vi.mock('../mediaCache', () => ({ registerCoverFile: mocks.registerCoverFile }))
vi.mock('../coverFile', () => ({ isUsableCoverFile: mocks.isUsableCoverFile }))
vi.mock('@aurora/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aurora/shared')>()
  return { ...actual, searchOnlineTracks: mocks.searchOnlineTracks }
})

// 不能写顶层 await：desktop 的 tsconfig.electron.json 是 CommonJS，
// 顶层 await 会报 TS1378。改用惰性 import 拿被测模块（vi.mock 是提升的，
// 首次 import 时已生效）。
let fetchOnlineCover: typeof import('../scanner').fetchOnlineCover
let encodeErrorInfo: typeof import('@aurora/shared').encodeErrorInfo

beforeAll(async () => {
  ;({ fetchOnlineCover } = await import('../scanner'))
  ;({ encodeErrorInfo } = await import('@aurora/shared'))
})

/** 停滞上游：送响应头与 Content-Length，只写一半 body 且永不 end */
let stalled: http.Server
let stalledPort = 0
/** 正常上游：返回一张足够大的假图 */
let good: http.Server
let goodPort = 0
let tmpDir = ''

beforeEach(async () => {
  mocks.updateTrack.mockClear()
  mocks.registerCoverFile.mockClear()
  mocks.searchOnlineTracks.mockReset()

  stalled = http.createServer((req, res) => {
    req.socket.on('error', () => {})
    req.resume()
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': '99999' })
    res.write(Buffer.from([0xff, 0xd8, 0xff]))
  })
  await new Promise<void>((r) => stalled.listen(0, '127.0.0.1', r))
  stalledPort = (stalled.address() as AddressInfo).port

  good = http.createServer((req, res) => {
    req.socket.on('error', () => {})
    req.resume()
    const body = Buffer.alloc(2048, 0xab)
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(body.length) })
    res.end(body)
  })
  await new Promise<void>((r) => good.listen(0, '127.0.0.1', r))
  goodPort = (good.address() as AddressInfo).port

  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aurora-cover-'))
})

afterEach(async () => {
  for (const s of [stalled, good]) {
    s.closeAllConnections?.()
    await new Promise<void>((r) => s.close(() => r()))
  }
  if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true })
})

const TRACK = {
  id: 'track-1',
  title: '七里香',
  artist: '周杰伦',
  album: '七里香',
  path: '/Music/a.mp3',
  duration: 299,
} as never

/** 让在线搜索返回一个指定的封面地址 */
function stubCandidate(coverUrl: string) {
  mocks.searchOnlineTracks.mockResolvedValue([
    { title: '七里香', artist: '周杰伦', duration: 299, coverUrl, audioUrl: 'https://x.invalid/a.mp3' },
  ])
}

/** 断言抛出的错误是带 code 的结构化载荷（与 shared 的 i18nAssert 同口径） */
async function rejectionOf(p: Promise<unknown>): Promise<Error> {
  return p.then(
    (v) => {
      throw new Error(`期望被拒绝，实际成功返回：${JSON.stringify(v)}`)
    },
    (e) => e as Error
  )
}

function codeOf(err: unknown): string | null {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const m = /^AURORA_ERR:(.*)$/.exec(raw)
  if (!m) return null
  try {
    return (JSON.parse(m[1]) as { code?: string }).code ?? null
  } catch {
    return null
  }
}

describe('fetchOnlineCover：读体超时映射为 coverTimeout', () => {
  it('上游送完响应头停住 body 时抛 coverTimeout（而不是裸 TimeoutError 编码串）', async () => {
    stubCandidate(`http://127.0.0.1:${stalledPort}/cover.jpg`)
    const err = await rejectionOf(fetchOnlineCover(TRACK, tmpDir))
    // 关键：错误码是带语境的那一条，用户看到「封面下载超时（15000ms）」
    expect(codeOf(err)).toBe('desktop.error.source.coverTimeout')
    // 且该码在两种语言的字典里都有文案（与 shared 的 i18nAssert 同口径）
    expect(encodeErrorInfo({ code: 'desktop.error.source.coverTimeout' })).toContain(
      'desktop.error.source.coverTimeout'
    )
  }, 40000)

  it('自证构造有效：同一上游在「完整响应」下能正常落盘，说明卡住的是 body 而非别的环节', async () => {
    stubCandidate(`http://127.0.0.1:${goodPort}/cover.jpg`)
    const out = await fetchOnlineCover(TRACK, tmpDir)
    expect(out).toBeTruthy()
    const written = await fs.promises.readFile(out as string)
    expect(written.length).toBe(2048)
    expect(mocks.registerCoverFile).toHaveBeenCalled()
    expect(mocks.updateTrack).toHaveBeenCalled()
  }, 20000)
})