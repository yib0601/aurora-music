import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EncryptedAudioFile } from '@aurora/shared'

/**
 * 扫描器对**加密音频**的识别与上报（`onEncryptedFile` 回调 + `importAudioFile`）。
 *
 * 为什么必须锁这组行为：这是整条「加密文件 → 按名重下」链路的入口，
 * 判据错一次就是两种严重后果——
 *   1. 认不出来：回到旧行为（静默丢弃），用户看到「扫完一首没进来」；
 *   2. 认错（把正常文件/损坏文件当加密文件）：每次扫描都在页面上挂一条
 *      提示，让用户去「重下」一首其实本地已经有的歌。
 *
 * 依赖只有 database / mediaCache / coverFile 被 mock（都要 Electron 运行时），
 * music-metadata 用的是**真实实现**：只有真解析过一遍，才能证明「正常 WAV 照常入库、
 * 密文解析失败且被认出」这两件事发生在同一个扫描流程里。
 */

const mocks = vi.hoisted(() => ({
  insertTracks: vi.fn(),
  getTracksByPaths: vi.fn(() => new Map<string, unknown>()),
  deleteTracksWithMissingFiles: vi.fn(() => 0),
  countTracksByFolder: vi.fn(() => 0),
  updateTrack: vi.fn(),
  registerCoverFile: vi.fn(),
  isUsableCoverFile: vi.fn(() => false),
}))

vi.mock('../database', () => ({
  insertTracks: mocks.insertTracks,
  getTracksByPaths: mocks.getTracksByPaths,
  deleteTracksWithMissingFiles: mocks.deleteTracksWithMissingFiles,
  countTracksByFolder: mocks.countTracksByFolder,
  updateTrack: mocks.updateTrack,
}))
vi.mock('../mediaCache', () => ({ registerCoverFile: mocks.registerCoverFile }))
vi.mock('../coverFile', () => ({ isUsableCoverFile: mocks.isUsableCoverFile }))

let scanFolder: typeof import('../scanner').scanFolder
let importAudioFile: typeof import('../scanner').importAudioFile

beforeAll(async () => {
  ;({ scanFolder, importAudioFile } = await import('../scanner'))
})

/** 最小合法 WAV（8kHz 单声道 16bit）：给「正常文件仍能入库」用真实可解析的内容 */
function wavBuffer(seconds = 0.1): Buffer {
  const sampleRate = 8000
  const channels = 1
  const bits = 16
  const samples = Math.floor(sampleRate * seconds)
  const dataLen = (samples * channels * bits) / 8
  const buf = Buffer.alloc(44 + dataLen)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataLen, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE((sampleRate * channels * bits) / 8, 28)
  buf.writeUInt16LE((channels * bits) / 8, 32)
  buf.writeUInt16LE(bits, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataLen, 40)
  return buf
}

/** 密文形态：头部不是任何已知容器（真实 QQ 音乐加密文件就是这样） */
function cipherBuffer(size = 4096): Buffer {
  const buf = Buffer.alloc(size)
  for (let i = 0; i < size; i++) buf[i] = (i * 37 + 11) & 0xff
  // 确保前 4 字节不是 fLaC / OggS / RIFF / ID3
  buf.write('QMCX', 0)
  return buf
}

let dir: string

function tmpDir(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-encrypted-'))
  return dir
}

/**
 * 把文件的 mtime 拨回 30 秒前，模拟「早已落盘完成」。
 *
 * 扫描器有一条**静默期**闸门（shared/encryptedAudio 的 `isStillDownloading`）：
 * mtime 在 ENCRYPTED_SETTLE_MS 内的文件视为「平台正在写」，本次不上报。
 * 测试里刚 writeFileSync 出来的文件正好落在窗口内，因此凡是要断言「会上报」的
 * 夹具都必须先过这一道——否则测的就不是识别逻辑，而是时钟。
 */
function settle(filePath: string, ageMs = 30_000): void {
  const when = new Date(Date.now() - ageMs)
  fs.utimesSync(filePath, when, when)
}

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('scanFolder 的加密文件上报', () => {
  it('密文文件被认出并上报，且不进曲库；同目录的正常文件照常入库', async () => {
    const root = tmpDir()
    const cipher = path.join(root, '陈奕迅 - 十年 [mqms2].mflac0.flac')
    fs.writeFileSync(cipher, cipherBuffer())
    fs.writeFileSync(path.join(root, '晴天.wav'), wavBuffer())
    settle(cipher)

    const hits: EncryptedAudioFile[] = []
    const tracks = await scanFolder(
      root,
      path.join(root, '.userdata'),
      undefined,
      (file) => hits.push(file)
    )

    expect(tracks.map((t) => t.title)).toEqual(['晴天'])
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      family: 'qqmusic',
      token: 'mflac0',
      title: '十年',
      artist: '陈奕迅',
    })
    // 大小取自 stat，供 UI 展示
    expect(hits[0].size).toBeGreaterThan(0)
    // 只有正常文件被写库
    expect(mocks.insertTracks).toHaveBeenCalledTimes(1)
  })

  it('损坏但没有平台标记的文件不上报（不制造误报）', async () => {
    const root = tmpDir()
    fs.writeFileSync(path.join(root, '坏文件.flac'), cipherBuffer(2048))

    const hits: EncryptedAudioFile[] = []
    await scanFolder(
      root,
      path.join(root, '.userdata'),
      undefined,
      (file) => hits.push(file)
    )

    expect(hits).toEqual([])
  })

  it('不传回调时不报错（老调用点零改动仍可用）', async () => {
    const root = tmpDir()
    fs.writeFileSync(path.join(root, '陈奕迅 - 十年 [mqms2].mgg2.flac'), cipherBuffer())
    await expect(scanFolder(root, path.join(root, '.userdata'))).resolves.toEqual([])
  })
})

describe('importAudioFile', () => {
  it('把已落盘的单个文件解析入库并返回曲目', async () => {
    const root = tmpDir()
    const filePath = path.join(root, '晴天.wav')
    fs.writeFileSync(filePath, wavBuffer())

    const track = await importAudioFile(filePath, path.join(root, '.userdata'))

    expect(track).toMatchObject({ title: '晴天', path: filePath })
    expect(mocks.insertTracks).toHaveBeenCalledTimes(1)
    expect(mocks.insertTracks.mock.calls[0][0]).toHaveLength(1)
  })

  it('解析不出来的文件返回 null，不写库', async () => {
    const root = tmpDir()
    const filePath = path.join(root, '陈奕迅 - 十年 [mqms2].mflac0.flac')
    fs.writeFileSync(filePath, cipherBuffer())

    const track = await importAudioFile(filePath, path.join(root, '.userdata'))

    expect(track).toBeNull()
    expect(mocks.insertTracks).not.toHaveBeenCalled()
  })

  it('文件不存在时返回 null 而不抛错（调用方无需再包一层 catch）', async () => {
    const root = tmpDir()
    await expect(importAudioFile(path.join(root, '不存在.wav'), root)).resolves.toBeNull()
  })
})

describe('裸加密扩展名的收集', () => {
  it('`.mflac`（PC 端命名，没有追加容器后缀）同样被收集并上报', async () => {
    const root = tmpDir()
    const cipher = path.join(root, '陈奕迅 - 十年.mflac')
    fs.writeFileSync(cipher, cipherBuffer())
    settle(cipher)

    const hits: EncryptedAudioFile[] = []
    await scanFolder(
      root,
      path.join(root, '.userdata'),
      undefined,
      (file) => hits.push(file)
    )

    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ family: 'qqmusic', token: 'mflac', title: '十年', artist: '陈奕迅' })
  })
})

describe('「仍在下载」的文件不上报（批量替换期间的核心安全闸门）', () => {
  /**
   * 为什么这组必须存在：QQ 音乐 / 本应用自己下载时，目录里先出现的就是最终文件名，
   * 而加密标记就写在名字里。若照常上报，用户会在下载进行中看到一批「待处理」，
   * 点「替换」就把正在写的文件移进回收站 —— 平台的下载直接报废，且不可恢复
   * （文件半截，回收站里也没有完整版）。
   */

  it('名字带 .part 的中间文件既不入库、也不上报成全集的成员', async () => {
    const root = tmpDir()
    // 名字里加密标记齐全，只有末尾的 .part 说明它还在写
    const mid = path.join(root, '陈奕迅 - 十年 [mqms2].mflac0.flac.part')
    fs.writeFileSync(mid, cipherBuffer())
    settle(mid)

    const hits: EncryptedAudioFile[] = []
    const tracks = await scanFolder(
      root,
      path.join(root, '.userdata'),
      undefined,
      (file) => hits.push(file)
    )

    expect(tracks).toEqual([])
    expect(hits).toEqual([])
  })

  it('刚写完（mtime 在静默期内）的密文本次不上报，静默期过后才上报', async () => {
    const root = tmpDir()
    const cipher = path.join(root, '陈奕迅 - 十年 [mqms2].mflac0.flac')
    fs.writeFileSync(cipher, cipherBuffer())
    // 不 settle：mtime 就是现在，处于静默期内

    const firstRound: EncryptedAudioFile[] = []
    await scanFolder(root, path.join(root, '.userdata'), undefined, (f) => firstRound.push(f))
    expect(firstRound).toEqual([])

    // 模拟「平台写完了，过了静默期，下次扫描」
    settle(cipher)
    const secondRound: EncryptedAudioFile[] = []
    await scanFolder(root, path.join(root, '.userdata'), undefined, (f) => secondRound.push(f))
    expect(secondRound).toHaveLength(1)
    expect(secondRound[0]).toMatchObject({ token: 'mflac0', title: '十年' })
  })

  it('正常音频即使刚写完也照常入库（静默期只作用于「解析失败 + 认得出加密标记」这条窄路）', async () => {
    const root = tmpDir()
    // 不 settle：正常文件不该被静默期拖住
    fs.writeFileSync(path.join(root, '晴天.wav'), wavBuffer())

    const tracks = await scanFolder(root, path.join(root, '.userdata'))

    expect(tracks.map((t) => t.title)).toEqual(['晴天'])
  })
})

/**
 * 「被静默期挡下的文件」必须能被调用方看见。
 *
 * 端侧靠这一条回调决定要不要安排补扫：一批下载里**最后一首**写完后再没有任何
 * 文件事件，不补扫它就要等到下次启动或手动重扫才出现在「待处理」里。
 * 而 `none`（真损坏）与 `deferred`（还在写）必须区分清楚——判反了会让一批坏文件
 * 把补扫额度耗光，真正在下载的文件反而补不上。
 */
describe('静默期挡下的文件通过 onDeferredEncrypted 上报', () => {
  it('刚写完的密文走 deferred，不进上报全集', async () => {
    const root = tmpDir()
    const cipher = path.join(root, '陈奕迅 - 十年 [mqms2].mflac0.flac')
    fs.writeFileSync(cipher, cipherBuffer())
    // 不 settle：mtime 就是现在

    const reported: EncryptedAudioFile[] = []
    const deferred: string[] = []
    await scanFolder(
      root,
      path.join(root, '.userdata'),
      undefined,
      (f) => reported.push(f),
      (p) => deferred.push(p)
    )

    expect(reported).toEqual([])
    expect(deferred).toEqual([cipher])
  })

  it('真损坏的文件（认不出加密标记）走 none：既不上报也不推迟，否则会白耗补扫额度', async () => {
    const root = tmpDir()
    fs.writeFileSync(path.join(root, '坏文件.flac'), cipherBuffer(2048))
    // 不 settle，保证「不走 deferred」不是被静默期碰巧挡下的结果

    const reported: EncryptedAudioFile[] = []
    const deferred: string[] = []
    await scanFolder(
      root,
      path.join(root, '.userdata'),
      undefined,
      (f) => reported.push(f),
      (p) => deferred.push(p)
    )

    expect(reported).toEqual([])
    expect(deferred).toEqual([])
  })

  it('已过静默期的密文走 encrypted，不会被重复算成 deferred（两者互斥）', async () => {
    const root = tmpDir()
    const cipher = path.join(root, '陈奕迅 - 十年 [mqms2].mflac0.flac')
    fs.writeFileSync(cipher, cipherBuffer())
    settle(cipher)

    const reported: EncryptedAudioFile[] = []
    const deferred: string[] = []
    await scanFolder(
      root,
      path.join(root, '.userdata'),
      undefined,
      (f) => reported.push(f),
      (p) => deferred.push(p)
    )

    expect(reported).toHaveLength(1)
    expect(deferred).toEqual([])
  })
})
