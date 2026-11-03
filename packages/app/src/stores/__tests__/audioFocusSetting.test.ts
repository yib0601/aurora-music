/**
 * 「音频焦点 / 与其他播放器互斥」开关的**持久化**回归。
 *
 * 这条链路最容易出的错不是逻辑，而是「忘写进 partialize 白名单」：
 * 落盘时被静默裁掉 → 用户打开开关、重启后又变回关，而且没有任何报错。
 * 设置项本身只是库里的一个布尔值，所以这里钉的是：
 *   1. 默认关闭（接管系统媒体会话属于有外部副作用的开关，必须显式打开）；
 *   2. setter 能改；
 *   3. 真的写进了 `aurora-library-state`（白名单放行）；
 *   4. 水合能读回 true（重启后仍然开着）；
 *   5. 老版本数据（没有这个字段）升级后回落成 false，且迁移不清掉已存的值。
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

describe('音频焦点开关的默认值与写入', () => {
  it('默认关闭（不能默认接管系统媒体会话）', async () => {
    const { store } = await freshStore()
    expect(store.getState().audioFocusEnabled).toBe(false)
  })

  it('setter 单向写入，重复写同一值无副作用', async () => {
    const { store } = await freshStore()
    store.getState().setAudioFocusEnabled(true)
    expect(store.getState().audioFocusEnabled).toBe(true)
    store.getState().setAudioFocusEnabled(true)
    expect(store.getState().audioFocusEnabled).toBe(true)
    store.getState().setAudioFocusEnabled(false)
    expect(store.getState().audioFocusEnabled).toBe(false)
  })
})

describe('音频焦点开关的持久化', () => {
  it('开启后落盘（partialize 白名单放行）', async () => {
    const { store, bag } = await freshStore()
    store.getState().setAudioFocusEnabled(true)
    expect(persistedState(bag).audioFocusEnabled).toBe(true)
  })

  it('重启（重新水合）后仍是开', async () => {
    const { store } = await freshStore({ state: { audioFocusEnabled: true }, version: 14 })
    expect(store.getState().audioFocusEnabled).toBe(true)
  })

  it('老数据没有该字段 → 升级后为关（不误开有外部副作用的开关）', async () => {
    const { store } = await freshStore({ state: { theme: 'light' }, version: 13 })
    expect(store.getState().audioFocusEnabled).toBe(false)
    expect(store.getState().theme).toBe('light')
  })

  it('老数据里已有该字段时，迁移不得丢掉它', async () => {
    const { store } = await freshStore({ state: { audioFocusEnabled: true }, version: 13 })
    expect(store.getState().audioFocusEnabled).toBe(true)
  })
})
