/**
 * 桌面端「移除单曲 / 在文件夹中显示」的平台转发契约。
 *
 * 两条通道的信任边界不同，测试分两组：
 *   1. `removeTrack`：把曲目 id 透传给主进程 `library:removeTrack`，并把主进程返回的
 *      「移除后全库」原样交回 store（store 据此刷新，不做本地推导）。
 *      老版 preload 没有这条通道时返回空数组，由 store 判能力缺失后不动列表。
 *   2. `revealTrack`：**只透传曲目 id**，不传路径。渲染层即使拿着 track.path 也没法
 *      借这条通道定位任意本机文件——这是主进程侧安全约束在渲染层的对应契约。
 *      preload 缺 `showItemInFolder` 时，`platform.revealTrack` 必须是 undefined
 *      （UI 据「方法是否存在」隐藏入口，不是点了才失败）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  /** 捕获到的 IPC 调用：通道名 + 参数 */
  calls: [] as Array<{ channel: string; args: unknown[] }>,
  /** preload 暴露面：用例按需增删方法，模拟老版本 preload */
  api: {} as Record<string, unknown>,
  remaining: [] as unknown[],
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
  CapacitorHttp: { request: async () => ({ status: 200, data: '' }) },
}))
vi.mock('@capacitor/filesystem', () => ({
  Directory: { ExternalStorage: 'EXTERNAL_STORAGE' },
  Filesystem: {},
}))

vi.mock('@/stores/libraryStore', () => ({
  useLibraryStore: {
    getState: () => ({ onlineSources: [], downloadQuality: 'flac' }),
  },
}))

/** 一眼可辨的假值：uuid 全零 + 测试路径，不含任何真实路径/凭据 */
const FIXTURE_ID = '00000000-0000-0000-0000-000000000000'
const FIXTURE_PATH = '/tmp/aurora-test-fixture/track.mp3'

function installApi(extra: Record<string, unknown>) {
  state.api = {
    removeTrack: (id: string) => {
      state.calls.push({ channel: 'library:removeTrack', args: [id] })
      return Promise.resolve(state.remaining)
    },
    showItemInFolder: (id: string) => {
      state.calls.push({ channel: 'shell:showItemInFolder', args: [id] })
      return Promise.resolve(true)
    },
    ...extra,
  }
  ;(globalThis as unknown as { window: unknown }).window = { electronAPI: state.api }
}

afterEach(() => {
  state.calls = []
  state.remaining = []
  vi.unstubAllGlobals()
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('桌面端 removeTrack 转发', () => {
  it('透传曲目 id 并交回主进程给的移除后全库', async () => {
    state.remaining = [{ id: '00000000-0000-0000-0000-000000000001', path: FIXTURE_PATH }]
    installApi({})
    const { createDesktopPlatform } = await import('../index')
    const platform = createDesktopPlatform()

    const remaining = await platform.removeTrack?.(FIXTURE_ID)

    expect(state.calls).toEqual([{ channel: 'library:removeTrack', args: [FIXTURE_ID] }])
    expect(remaining).toEqual(state.remaining)
  })

  it('老版 preload 缺该通道时方法为 undefined（store 据此 no-op，不清空列表）', async () => {
    installApi({ removeTrack: undefined })
    const { createDesktopPlatform } = await import('../index')
    const platform = createDesktopPlatform()

    // ⚠️ 不能是「返回空数组」：移除最后一首歌时合法的结果也是空数组，
    // store 无从区分「没做成」与「删空了」，会把用户曲库清空
    expect(platform.removeTrack).toBeUndefined()
    expect(state.calls).toEqual([])
  })
})

describe('桌面端 revealTrack 只接受曲目 id', () => {
  it('把 id 透传给 shell:showItemInFolder，不传路径', async () => {
    installApi({})
    const { createDesktopPlatform } = await import('../index')
    const platform = createDesktopPlatform()

    const ok = await platform.revealTrack?.(FIXTURE_ID)

    expect(ok).toBe(true)
    // ⚠️ 关键断言：参数是 id，FIXTURE_PATH 一次都没被送到主进程
    expect(state.calls).toEqual([{ channel: 'shell:showItemInFolder', args: [FIXTURE_ID] }])
    expect(JSON.stringify(state.calls)).not.toContain(FIXTURE_PATH)
  })

  it('preload 缺 showItemInFolder 时方法为 undefined（UI 据此隐藏入口）', async () => {
    installApi({ showItemInFolder: undefined })
    const { createDesktopPlatform } = await import('../index')
    const platform = createDesktopPlatform()

    expect(platform.revealTrack).toBeUndefined()
  })
})
