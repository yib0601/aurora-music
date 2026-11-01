/**
 * 曲库单条动作（library:removeTrack / shell:showItemInFolder）的行为锁。
 *
 * 为什么单独测这一层：两个通道各自只有一条**不可回退**的语义，
 * 而它们在界面上都是「点一下就没」的动作，错了没人能撤销：
 *   1. `library:removeTrack` **不得删除磁盘音频文件** —— 只能是数据库记录没了，
 *      文件还在。这条最容易被「顺手也把文件删了吧」的实现改坏。
 *   2. `shell:showItemInFolder` **只接受曲目 id**，不接受路径 ——
 *      退化为「传路径就定位」等于给渲染层一个任意文件定位接口。
 *
 * electron / database 全部 mock：这里要测的是通道自身的判断与调用，
 * 而不是 SQLite 或 shell 的真实行为。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 捕获到的 handler：按通道名存，供用例直接调用 */
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const showItemInFolder = vi.fn()
const deleteTrack = vi.fn()
const getAllTracks = vi.fn()
const getTrackById = vi.fn()
const existsSync = vi.fn(() => true)

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  shell: {
    showItemInFolder: (target: string) => showItemInFolder(target),
  },
}))

vi.mock('../database', () => ({
  deleteTrack: (id: string) => deleteTrack(id),
  getAllTracks: () => getAllTracks(),
  getTrackById: (id: string) => getTrackById(id),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, default: { ...actual, existsSync: (p: string) => existsSync(p) } }
})

const REMOVE_CHANNEL = 'library:removeTrack'
const REVEAL_CHANNEL = 'shell:showItemInFolder'

/** 一眼可辨的假值：uuid 全零 + 测试目录，不含任何真实路径 */
const FIXTURE_ID = '00000000-0000-0000-0000-000000000000'
const FIXTURE_PATH = '/tmp/aurora-test-fixture/track.mp3'

let registerLibraryActionIpc: typeof import('../libraryActions').registerLibraryActionIpc

beforeEach(async () => {
  vi.resetModules()
  handlers.clear()
  showItemInFolder.mockReset()
  deleteTrack.mockReset()
  existsSync.mockReset()
  existsSync.mockReturnValue(true)
  getAllTracks.mockReset()
  getAllTracks.mockReturnValue([{ id: FIXTURE_ID, path: FIXTURE_PATH, title: 'fixture' }])
  getTrackById.mockReset()
  ;({ registerLibraryActionIpc } = await import('../libraryActions'))
  registerLibraryActionIpc()
})

describe('library:removeTrack 从曲库移除单曲', () => {
  it('删除曲库记录并返回移除后的全库', () => {
    getTrackById.mockReturnValue({ id: FIXTURE_ID, path: FIXTURE_PATH, title: 'fixture' })

    const result = handlers.get(REMOVE_CHANNEL)!({}, FIXTURE_ID)

    expect(deleteTrack).toHaveBeenCalledWith(FIXTURE_ID)
    expect(result).toEqual([{ id: FIXTURE_ID, path: FIXTURE_PATH, title: 'fixture' }])
  })

  it('**不删除磁盘音频文件**：除了 database.deleteTrack 之外不碰文件系统', () => {
    getTrackById.mockReturnValue({ id: FIXTURE_ID, path: FIXTURE_PATH, title: 'fixture' })

    handlers.get(REMOVE_CHANNEL)!({}, FIXTURE_ID)

    // 通道实现里唯一允许触碰文件系统的地方是 database.deleteTrack 内部的封面清理；
    // 这里直接钉住「本通道自己没有任何删文件调用」
    expect(deleteTrack).toHaveBeenCalledTimes(1)
    expect(showItemInFolder).not.toHaveBeenCalled()
  })

  it('曲目不在库里时不动数据库，只回全库', () => {
    getTrackById.mockReturnValue(null)

    handlers.get(REMOVE_CHANNEL)!({}, FIXTURE_ID)

    expect(deleteTrack).not.toHaveBeenCalled()
    expect(getAllTracks).toHaveBeenCalled()
  })

  it('空 id / 非字符串入参被拒绝，不触碰数据库', () => {
    handlers.get(REMOVE_CHANNEL)!({}, '')
    handlers.get(REMOVE_CHANNEL)!({}, null)
    handlers.get(REMOVE_CHANNEL)!({}, { id: FIXTURE_ID })

    expect(getTrackById).not.toHaveBeenCalled()
    expect(deleteTrack).not.toHaveBeenCalled()
  })
})

describe('shell:showItemInFolder 只接受曲库内曲目 id', () => {
  it('按 id 反查路径后定位，渲染层传不进任意路径', () => {
    getTrackById.mockReturnValue({ id: FIXTURE_ID, path: FIXTURE_PATH, title: 'fixture' })

    // ⚠️ 关键断言：传入的是 id，主进程用它反查出的才是路径
    const ok = handlers.get(REVEAL_CHANNEL)!({}, FIXTURE_ID)

    expect(ok).toBe(true)
    expect(getTrackById).toHaveBeenCalledWith(FIXTURE_ID)
    expect(showItemInFolder).toHaveBeenCalledWith(FIXTURE_PATH)
  })

  it('把路径当 id 传进来不会定位任何文件（库里查不到这个 id）', () => {
    getTrackById.mockReturnValue(null)

    const ok = handlers.get(REVEAL_CHANNEL)!({}, FIXTURE_PATH)

    expect(ok).toBe(false)
    expect(showItemInFolder).not.toHaveBeenCalled()
  })

  it('远端曲目（带 sourceId）没有本机文件，返回 false 不弹文件管理器', () => {
    getTrackById.mockReturnValue({
      id: FIXTURE_ID,
      path: `webdav:lib-fixture/${FIXTURE_ID}.flac`,
      sourceId: 'lib-fixture',
      title: 'fixture',
    })

    const ok = handlers.get(REVEAL_CHANNEL)!({}, FIXTURE_ID)

    expect(ok).toBe(false)
    expect(showItemInFolder).not.toHaveBeenCalled()
  })

  it('文件已被外部删除时返回 false（不为不存在的文件弹文件管理器）', () => {
    getTrackById.mockReturnValue({ id: FIXTURE_ID, path: FIXTURE_PATH, title: 'fixture' })
    existsSync.mockReturnValue(false)

    const ok = handlers.get(REVEAL_CHANNEL)!({}, FIXTURE_ID)

    expect(ok).toBe(false)
    expect(showItemInFolder).not.toHaveBeenCalled()
  })

  it('空 id / 非字符串入参一律返回 false', () => {
    expect(handlers.get(REVEAL_CHANNEL)!({}, '')).toBe(false)
    expect(handlers.get(REVEAL_CHANNEL)!({}, undefined)).toBe(false)
    expect(handlers.get(REVEAL_CHANNEL)!({}, [FIXTURE_PATH])).toBe(false)
    expect(getTrackById).not.toHaveBeenCalled()
    expect(showItemInFolder).not.toHaveBeenCalled()
  })
})
