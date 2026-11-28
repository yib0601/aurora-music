/**
 * 下载落盘「目标路径预定」的行为回归。
 *
 * 核心用例是②：并发预定同一个基名必须拿到两两不同的最终路径。旧的
 * uniqueSavePath 是「先探测哪个名字空着、之后再往那个路径写」，探测与写入之间
 * 隔着 await，并发下载会探到同一个空名字 —— 后写的把先写的覆盖掉。现在的实现
 * 靠 `O_EXCL` 创建 `.part` 来互斥，这条用例就是那次修复的看门狗。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  commitDownloadTarget,
  discardDownloadTarget,
  reserveDownloadTarget,
} from '../downloadTarget'

/** 每个用例一个全新临时目录（从 os.tmpdir 派生，不写死本机路径） */
let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-dltarget-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('reserveDownloadTarget', () => {
  it('同名文件已存在时顺延到 (1)', async () => {
    // 直接落一个已存在的最终文件，模拟「上次已经下过这首」
    const existing = path.join(dir, '周杰伦 - 晴天.mp3')
    fs.writeFileSync(existing, 'old')

    const target = await reserveDownloadTarget(dir, '周杰伦 - 晴天', '.mp3')
    expect(target.finalPath).toBe(path.join(dir, '周杰伦 - 晴天 (1).mp3'))
    expect(target.partPath).toBe(target.finalPath + '.part')
    // 预定即占位：part 文件此刻已经存在（写入方随后用 createWriteStream 覆盖它）
    expect(fs.existsSync(target.partPath)).toBe(true)
    // 已存在的最终文件一个字节都不能动
    expect(fs.readFileSync(existing, 'utf8')).toBe('old')
  })

  it('并发 5 个预定抢同一个基名，得到的最终路径两两不同', async () => {
    const targets = await Promise.all(
      Array.from({ length: 5 }, () => reserveDownloadTarget(dir, 'Artist - Title', '.flac'))
    )

    const finals = targets.map((t) => t.finalPath)
    const parts = targets.map((t) => t.partPath)
    expect(new Set(finals).size).toBe(5)
    expect(new Set(parts).size).toBe(5)
    // 占位是真实的：5 个 .part 都在磁盘上，不是只存在于返回值里
    for (const part of parts) expect(fs.existsSync(part)).toBe(true)
    // 且最终路径一个都还不存在（只有 commit 之后才会出现）
    for (const final of finals) expect(fs.existsSync(final)).toBe(false)
  })

  it('commit 后 .part 消失、最终文件存在且内容正确', async () => {
    const { finalPath, partPath } = await reserveDownloadTarget(dir, 'Artist - Title', '.mp3')
    // 模拟下载 + 封面嵌入：都写在 part 上
    fs.writeFileSync(partPath, 'full-audio-bytes')

    await commitDownloadTarget(partPath, finalPath)

    expect(fs.existsSync(partPath)).toBe(false)
    expect(fs.existsSync(finalPath)).toBe(true)
    expect(fs.readFileSync(finalPath, 'utf8')).toBe('full-audio-bytes')
  })

  it('discard 幂等：对不存在的路径不抛', async () => {
    const missing = path.join(dir, 'never-existed.mp3.part')
    await expect(discardDownloadTarget(missing)).resolves.toBeUndefined()
    // 连调两次也不抛
    await expect(discardDownloadTarget(missing)).resolves.toBeUndefined()

    // 真实存在的 part 也能删掉，删完再删一次仍不抛
    const { partPath } = await reserveDownloadTarget(dir, 'Artist - Title', '.mp3')
    await discardDownloadTarget(partPath)
    expect(fs.existsSync(partPath)).toBe(false)
    await expect(discardDownloadTarget(partPath)).resolves.toBeUndefined()
  })

  it('中文与空格文件名可用', async () => {
    const { finalPath, partPath } = await reserveDownloadTarget(dir, '陈奕迅 - 富士山下 (Live 版)', '.m4a')
    expect(path.basename(finalPath)).toBe('陈奕迅 - 富士山下 (Live 版).m4a')
    fs.writeFileSync(partPath, 'x')
    await commitDownloadTarget(partPath, finalPath)
    expect(fs.readFileSync(finalPath, 'utf8')).toBe('x')
  })
})
