/**
 * `library:trashEncryptedSource` 的三条信任边界。
 *
 * 这条通道是整条「加密音频批量替换」链路里**唯一会动用户磁盘**的地方，
 * 而且动的是「删除」这个方向。判据一旦放宽，最坏情况是：渲染层给一个任意路径，
 * 主进程把它送进回收站 —— 那不是「重下去重了」这种可修的 bug，是用户数据没了。
 *
 * 所以三个边界各锁一条用例，且都要能从 mock 调用上看出「没走到 shell」：
 *   1. 路径不在已扫描目录内 → 拒绝（与 fs:readFile 共用 ipc/scanRoots 白名单）
 *   2. 文件名不带平台加密标记 → 拒绝（白名单目录里也有用户正常的歌）
 *   3. 合法目标 → 走 trashItem（**不是 unlink**，要可撤销）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const trashItem = vi.fn(async (_path: string) => {})
const unlink = vi.fn(async (_path: string) => {})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  shell: {
    trashItem: (target: string) => trashItem(target),
  },
}))

const access = vi.fn(async (_path: string, _mode?: number) => {})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    default: {
      ...actual,
      promises: { ...actual.promises, access: (p: string, m?: number) => access(p, m) },
      unlink: (p: string) => unlink(p),
    },
  }
})

type EncryptedSourceModule = typeof import('../encryptedSource')
type ScanRootsModule = typeof import('../scanRoots')

let registerEncryptedSourceIpc: EncryptedSourceModule['registerEncryptedSourceIpc']
let LIBRARY_TRASH_SOURCE_CHANNEL: EncryptedSourceModule['LIBRARY_TRASH_SOURCE_CHANNEL']
let registerScanRoot: ScanRootsModule['registerScanRoot']
let unregisterScanRoot: ScanRootsModule['unregisterScanRoot']

/** 一眼可辨的假路径：不含任何本机真实目录 */
const ROOT = '/tmp/aurora-test-fixture/qqmusic'
const ENCRYPTED = `${ROOT}/陈奕迅 - 十年 [mqms2].mflac0.flac`
const NORMAL_TRACK = `${ROOT}/周杰伦 - 稻香.flac`

beforeEach(async () => {
  vi.resetModules()
  handlers.clear()
  trashItem.mockClear()
  unlink.mockClear()
  access.mockReset()
  access.mockResolvedValue(undefined)
  ;({ registerEncryptedSourceIpc, LIBRARY_TRASH_SOURCE_CHANNEL } = await import(
    '../encryptedSource'
  ))
  ;({ registerScanRoot, unregisterScanRoot } = await import('../scanRoots'))
  registerEncryptedSourceIpc()
})

const call = (filePath: unknown) =>
  handlers.get(LIBRARY_TRASH_SOURCE_CHANNEL)!({}, filePath) as Promise<{
    ok: boolean
    reason?: string
  }>

describe('library:trashEncryptedSource 信任边界', () => {
  it('合法目标（扫描目录内 + 带加密标记）→ 走 trashItem，不 unlink', async () => {
    registerScanRoot(ROOT)

    const result = await call(ENCRYPTED)

    expect(result).toEqual({ ok: true })
    expect(trashItem).toHaveBeenCalledWith(ENCRYPTED)
    expect(unlink).not.toHaveBeenCalled()
  })

  it('路径不在已扫描目录内 → 拒绝，绝不碰 shell', async () => {
    const result = await call('/etc/passwd.mflac0.flac')

    expect(result).toEqual({ ok: false, reason: 'outsideRoot' })
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('`..` 穿越不会被当成「在目录内」', async () => {
    registerScanRoot(ROOT)

    const result = await call(`${ROOT}/../outside.mflac0.flac`)

    expect(result).toEqual({ ok: false, reason: 'outsideRoot' })
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('扫描目录内的**正常歌曲**（文件名无加密标记）→ 拒绝', async () => {
    registerScanRoot(ROOT)

    const result = await call(NORMAL_TRACK)

    expect(result).toEqual({ ok: false, reason: 'notEncrypted' })
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('非绝对路径 / 非字符串 → 拒绝', async () => {
    registerScanRoot(ROOT)

    expect(await call('relative/path.mflac0.flac')).toEqual({ ok: false, reason: 'invalidPath' })
    expect(await call('')).toEqual({ ok: false, reason: 'invalidPath' })
    expect(await call(null)).toEqual({ ok: false, reason: 'invalidPath' })
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('文件已不存在 → 按成功返回（目标状态已达成），不调 shell', async () => {
    registerScanRoot(ROOT)
    access.mockRejectedValue(new Error('ENOENT'))

    const result = await call(ENCRYPTED)

    expect(result).toEqual({ ok: true })
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('回收站不可用 → 如实返回失败，**不回退成 unlink**', async () => {
    registerScanRoot(ROOT)
    trashItem.mockRejectedValueOnce(new Error('gio: no trash support'))

    const result = await call(ENCRYPTED)

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('failed')
    expect(unlink).not.toHaveBeenCalled()
  })

  it('用户移除扫描目录后，原路径立刻失去授权', async () => {
    registerScanRoot(ROOT)
    unregisterScanRoot(ROOT)

    expect(await call(ENCRYPTED)).toEqual({ ok: false, reason: 'outsideRoot' })
    expect(trashItem).not.toHaveBeenCalled()
  })
})
