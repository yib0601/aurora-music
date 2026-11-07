/**
 * 「其他应用播放声音时：暂停播放 / 继续播放」设置的**持久化与迁移**回归。
 *
 * 这条链路最容易出的错不是逻辑，而是两件事：
 *   1. 「忘写进 partialize 白名单」：落盘时被静默裁掉 → 用户选了继续播放、重启又变回暂停，
 *      而且没有任何报错；
 *   2. 「旧字段迁移错方向」：v15 把原来的「互斥开关 + 行为选择」两行合并成一个两档设置，
 *      老数据里只有布尔开关（`audioFocusEnabled`）。开着 → 暂停播放、关着 → 继续播放，
 *      映射错了会让用户升级后行为反转（尤其「一直关着」的用户突然开始被让位）。
 *
 * localStorage 桩必须挂在 **window** 上（zustand 5 的默认 storage 是
 * `createJSONStorage(() => window.localStorage)`），理由与 lyricsSources.test.ts 相同。
 */
import { describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'aurora-library-state'

function installLocalStorage(): Map<string, string> {
  const bag = new Map<string, string>()
  const storage = {
    getItem: (key: string) => (bag.has(key) ? (bag.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      bag.set(key, String(value))
    },
    removeItem: (key: string) => {
      bag.delete(key)
    },
    clear: () => bag.clear(),
    key: (index: number) => [...bag.keys()][index] ?? null,
    get length() {
      return bag.size
    },
  }
  ;(globalThis as unknown as { window: unknown }).window = { localStorage: storage }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = storage
  return bag
}

/** 每个用例从干净的单例 + 空存储开始；persist 的 hydrate 是异步的，必须等它 */
async function freshStore(seed?: { state: Record<string, unknown>; version: number }) {
  vi.resetModules()
  const bag = installLocalStorage()
  if (seed) bag.set(STORAGE_KEY, JSON.stringify(seed))
  const mod = await import('../libraryStore')
  const persistApi = (
    mod.useLibraryStore as unknown as { persist?: { rehydrate: () => Promise<void> } }
  ).persist
  await persistApi?.rehydrate?.()
  return { store: mod.useLibraryStore, bag }
}

function persistedState(bag: Map<string, string>): Record<string, unknown> {
  const raw = bag.get(STORAGE_KEY)
  expect(raw, 'persist 没有写任何东西').toBeTruthy()
  return (JSON.parse(raw as string) as { state: Record<string, unknown> }).state
}

describe('默认值与写入', () => {
  it('全新安装默认「暂停播放」（= 参与互斥，功能默认生效）', async () => {
    const { store } = await freshStore()
    expect(store.getState().audioFocusYieldBehavior).toBe('pause')
  })

  it('setter 写入；非法值一律回落 pause', async () => {
    const { store } = await freshStore()
    store.getState().setAudioFocusYieldBehavior('continue')
    expect(store.getState().audioFocusYieldBehavior).toBe('continue')
    // 运行时兜底：调用方传坏值不得把状态写成第三态（设置页会两格都不亮）
    store.getState().setAudioFocusYieldBehavior('bogus' as never)
    expect(store.getState().audioFocusYieldBehavior).toBe('pause')
  })
})

describe('持久化', () => {
  it('「继续播放」落盘（partialize 白名单放行），且不再写出旧开关字段', async () => {
    const { store, bag } = await freshStore()
    store.getState().setAudioFocusYieldBehavior('continue')
    const persisted = persistedState(bag)
    expect(persisted.audioFocusYieldBehavior).toBe('continue')
    expect(persisted).not.toHaveProperty('audioFocusEnabled')
  })

  it('重启（重新水合）后仍是「继续播放」', async () => {
    const { store } = await freshStore({
      state: { audioFocusYieldBehavior: 'continue' },
      version: 14,
    })
    expect(store.getState().audioFocusYieldBehavior).toBe('continue')
  })

  it('持久化里的坏值 → 水合时归一化为 pause（设置页不出现两格都不亮）', async () => {
    const { store } = await freshStore({
      state: { audioFocusYieldBehavior: 'sideways' },
      version: 14,
    })
    expect(store.getState().audioFocusYieldBehavior).toBe('pause')
  })
})

/**
 * v15 迁移：旧的「互斥开关」布尔值要一一映射到新取值，
 * 不能让「一直关着开关」的用户升级后突然开始被让位。
 */
describe('旧数据（audioFocusEnabled 布尔开关）迁移', () => {
  it('旧开关开着 → 暂停播放', async () => {
    const { store } = await freshStore({ state: { audioFocusEnabled: true }, version: 14 })
    expect(store.getState().audioFocusYieldBehavior).toBe('pause')
  })

  it('旧开关关着 → 继续播放（保留用户「不干预」的意图）', async () => {
    const { store } = await freshStore({ state: { audioFocusEnabled: false }, version: 14 })
    expect(store.getState().audioFocusYieldBehavior).toBe('continue')
  })

  it('更老的数据（两个字段都没有）→ 默认暂停播放', async () => {
    const { store } = await freshStore({ state: { theme: 'light' }, version: 13 })
    expect(store.getState().audioFocusYieldBehavior).toBe('pause')
    expect(store.getState().theme).toBe('light')
  })

  it('同时存在新值与时旧开关时，以新值为准（不覆盖用户后来的选择）', async () => {
    const { store } = await freshStore({
      state: { audioFocusEnabled: true, audioFocusYieldBehavior: 'continue' },
      version: 14,
    })
    expect(store.getState().audioFocusYieldBehavior).toBe('continue')
  })
})

/**
 * 自定义 merge 的回归锁：归一化/迁移只该动这一个字段，不能顺手吞掉别的持久化状态。
 * likedTrackIds 还要走 onRehydrateStorage 复活成 Set（那条路在 merge 之后执行）。
 */
describe('merge 的边界', () => {
  it('不影响其它持久化字段与 likes 的水合', async () => {
    const { store } = await freshStore({
      state: { theme: 'light', likedTrackIds: ['t1', 't2'], audioFocusYieldBehavior: 'continue' },
      version: 14,
    })
    expect(store.getState().theme).toBe('light')
    expect(store.getState().audioFocusYieldBehavior).toBe('continue')
    expect([...store.getState().likedTracks].sort()).toEqual(['t1', 't2'])
  })
})
