import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseEncryptedAudioName } from '@aurora/shared'
import { redownloadEncryptedAudio, type RedownloadDeps } from '../encryptedRedownload.service'
import type { EncryptedAudioFile, OnlineSourceConfig, Track } from '@/types'

/**
 * 批量替换的**真实磁盘**集成验证。
 *
 * 与 `encryptedRedownload.service.test.ts` 的分工：那一份把 download / import / trash
 * 全 mock 掉，证明的是「编排按预期调用依赖」；这一份把三者换成真实文件操作，
 * 证明的是「跑完之后磁盘上的状态确实变了」——多选没有误伤未选中的文件、
 * 新副本真的落盘、原件真的被移走、并发跑完不重不漏。
 *
 * 只有搜索/取址两条外部链路用替身（它们需要真实音源服务，属于联网依赖）。
 * 目录一律从 `os.tmpdir()` 派生，仓库公开，夹具里不写死任何真实用户路径。
 */

const SOURCE: OnlineSourceConfig = {
  id: 'fixture',
  name: 'FIXTURE',
  sourceUrl: 'http://127.0.0.1/fixture',
  enabled: true,
}

/** 真实形态的加密文件名：`歌手 - 歌名 [mqms2].<加密扩展名>.<容器后缀>` */
const NAMES = [
  '陈奕迅 - 十年 [mqms2].mflac0.flac',
  '周杰伦 - 稻香 [mqms2].mgg1.flac',
  '孙燕姿 - 遇见 [mqms2].mflac0.flac',
]

let root: string
let downloadDir: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-encrypted-batch-'))
  downloadDir = path.join(root, 'downloads')
  fs.mkdirSync(downloadDir, { recursive: true })
  for (const name of NAMES) {
    // 内容是密文而不是合法容器 —— 识别本来只看文件名，不看内容
    fs.writeFileSync(path.join(root, name), Buffer.from('QMC-ENCRYPTED-FIXTURE-PAYLOAD'))
  }
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** 从磁盘上的文件名出发构造识别结果（走真实的 parseEncryptedAudioName） */
function scannedFiles(): EncryptedAudioFile[] {
  return NAMES.map((name) => {
    const full = path.join(root, name)
    const parsed = parseEncryptedAudioName(name)!
    return {
      path: full,
      size: fs.statSync(full).size,
      family: parsed.family,
      token: parsed.token,
      title: parsed.title,
      artist: parsed.artist,
    }
  })
}

function realDeps(over: Partial<RedownloadDeps> = {}): RedownloadDeps {
  return {
    // 外部依赖：按查询词回一条同名同歌手的候选（匹配算法本身由单测覆盖）
    search: vi.fn(async (query: string) => {
      const [artist, title] = query.split(' ')
      return [
        {
          id: `mid-${title}`,
          title,
          artist,
          album: 'fixture',
          duration: 200,
          audioUrl: `https://fixture.invalid/${encodeURIComponent(title)}.flac`,
          source: SOURCE.id,
          sourceName: SOURCE.name,
        },
      ]
    }),
    ensurePlayable: vi.fn(async (t: Track) => t),
    // 真实写盘
    downloadFile: vi.fn(async (payload) => {
      const safe = payload.title.replace(/[/\\:*?"<>|]/g, '_')
      const savedPath = path.join(downloadDir, `${payload.artist || '未知艺术家'} - ${safe}.flac`)
      fs.writeFileSync(savedPath, Buffer.from(`AUDIO:${payload.title}`))
      return { savedPath }
    }),
    importFile: vi.fn(async (p: string) =>
      ({ id: p, path: p, title: path.basename(p), artist: '', album: '', duration: 0, addedAt: 0, playCount: 0, liked: false }) as Track
    ),
    // 与桌面端 shell.trashItem 等价的可见效果：文件离开原目录
    removeSourceFile: vi.fn(async (p: string) => {
      fs.rmSync(p)
    }),
    config: () => ({ sources: [SOURCE], downloadDir, quality: 'flac' }),
    replaceSource: true,
    concurrency: 3,
    ...over,
  }
}

/**
 * 原始目录里还剩下的加密文件（不含 downloads 子目录）。
 *
 * 排序后再比：readdir 的次序由文件系统决定（ext4 是哈希序、不保证字面序），
 * 拿它直接 deepEqual 会让用例在某些机器上偶发红。
 */
const remainingOriginals = () =>
  fs.readdirSync(root).filter((n) => NAMES.includes(n)).sort()

/** 期望的「全部还在」形态（同样排好序，供 deepEqual 使用） */
const ALL_NAMES_SORTED = [...NAMES].sort()

const downloaded = () => fs.readdirSync(downloadDir).sort()

describe('批量替换：真实磁盘', () => {
  it('只处理选中的两首：新副本落盘、两条原件消失、未选中的那首原地不动', async () => {
    const all = scannedFiles()
    const results = await redownloadEncryptedAudio(all.slice(0, 2), realDeps())

    expect(results.map((r) => r.outcome)).toEqual(['done', 'done'])
    expect(results.every((r) => r.sourceRemoved === true)).toBe(true)

    // 新副本两份，且都是真的文件
    expect(downloaded()).toEqual([
      expect.stringContaining('周杰伦'),
      expect.stringContaining('陈奕迅'),
    ].sort())
    for (const name of downloaded()) {
      expect(fs.statSync(path.join(downloadDir, name)).size).toBeGreaterThan(0)
    }

    // 未选中的第三首**必须还在**：多选最容易出的错就是「顺手全删了」
    expect(remainingOriginals()).toEqual(['孙燕姿 - 遇见 [mqms2].mflac0.flac'])
    expect(downloaded().some((n) => n.includes('遇见'))).toBe(false)
  })

  it('并发跑完不重不漏：三条一次跑，每首恰好下载一次、清理一次', async () => {
    const all = scannedFiles()
    const deps = realDeps()
    const results = await redownloadEncryptedAudio(all, deps)

    expect(results).toHaveLength(3)
    expect(results.every((r) => r.outcome === 'done')).toBe(true)
    expect(deps.downloadFile).toHaveBeenCalledTimes(3)
    expect(deps.removeSourceFile).toHaveBeenCalledTimes(3)
    expect(downloaded()).toHaveLength(3)
    expect(remainingOriginals()).toEqual([])
  })

  it('入库失败（解析不出元信息）→ 原件必须还在，只多一份新文件', async () => {
    const all = scannedFiles()
    const results = await redownloadEncryptedAudio(all.slice(0, 1), realDeps({
      importFile: vi.fn(async () => null),
    }))

    expect(results[0]).toMatchObject({ outcome: 'done', imported: false })
    expect(results[0].sourceRemoved).toBeUndefined()
    // 原件仍在（三首都还在：另两首本就没被选中），新副本也在：用户还有得选，不是两头空
    expect(remainingOriginals()).toEqual(ALL_NAMES_SORTED)
    expect(downloaded()).toHaveLength(1)
  })

  it('清理失败（如系统无回收站）→ 下载结论不受影响，原件如实保留', async () => {
    const all = scannedFiles()
    const results = await redownloadEncryptedAudio(all.slice(0, 1), realDeps({
      removeSourceFile: vi.fn(async () => {
        throw new Error('gio: no trash support')
      }),
    }))

    expect(results[0].outcome).toBe('done')
    expect(results[0].sourceRemoved).toBe(false)
    expect(results[0].cleanupError).toContain('trash')
    // 清理失败 → 三首原件全在（这首没删掉，另两首没被选中），新副本照常落盘
    expect(remainingOriginals()).toEqual(ALL_NAMES_SORTED)
    expect(downloaded()).toHaveLength(1)
  })

  it('取消后：已启动的跑完、排队的不再启动，且没有半截文件残留', async () => {
    const all = scannedFiles()
    let done = 0
    const results = await redownloadEncryptedAudio(all, realDeps({
      concurrency: 1,
      isCanceled: () => done >= 1,
      onProgress: () => {
        done += 1
      },
    }))

    expect(results.map((r) => r.outcome)).toEqual(['done', 'canceled', 'canceled'])
    // 只下了一首 → 只有一个新文件、只少了一个原件
    expect(downloaded()).toHaveLength(1)
    expect(remainingOriginals()).toHaveLength(2)
  })
})
