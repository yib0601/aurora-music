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

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('scanFolder 的加密文件上报', () => {
  it('密文文件被认出并上报，且不进曲库；同目录的正常文件照常入库', async () => {
    const root = tmpDir()
    fs.writeFileSync(path.join(root, '陈奕迅 - 十年 [mqms2].mflac0.flac'), cipherBuffer())
    fs.writeFileSync(path.join(root, '晴天.wav'), wavBuffer())

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
    fs.writeFileSync(path.join(root, '陈奕迅 - 十年.mflac'), cipherBuffer())

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
