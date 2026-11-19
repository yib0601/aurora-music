import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 水合（读盘恢复）的端到端回归：`persist.partialize` ↔ `persist.merge` 必须**互为逆运算**。
 *
 * 前一个文件测的是内存里的行为，这里真正走一遍「写进存储 → 重新加载模块 → 从存储恢复」。
 * 之所以单独成文件：要换掉模块级单例（`vi.resetModules()`），而别的用例依赖同一个实例。
 *
 * node 环境下没有 localStorage，zustand persist 会退化成 noop，所以这里塞一个内存实现。
 */
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string) {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  clear() {
    this.map.clear()
  }
  key(index: number) {
    return Array.from(this.map.keys())[index] ?? null
  }
  get length() {
    return this.map.size
  }
}

const STORAGE_KEY = 'aurora-hall-cache'
const storage = new MemoryStorage()

vi.mock('@/services/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/platform')>()
  return { ...actual, hallRecommend: vi.fn(), hallToplists: vi.fn() }
})

/** 重新加载 store 模块：模拟一次冷启动（persist 在模块初始化时读盘） */
async function bootStore() {
  vi.resetModules()
  const mod = await import('@/stores/musicHallStore')
  const lib = await import('@/stores/libraryStore')
  lib.useLibraryStore.setState({
    onlineSources: [
      { id: 'src-1', name: '我的音源', sourceUrl: 'https://music.example.com?key=K1', enabled: true },
    ] as never,
  })
  return mod.useMusicHallStore
}

/**
 * 等 persist 把这次 set 真正写进存储。
 *
 * persist 的写盘挂在一条 promise 链上（`savedSetState → setItem → storage.setItem`），
 * 只 `await` 一个 `setTimeout(0)` 在机器忙时（全量跑、多 worker 抢占）会抢跑，
 * 断言看到的是 `getItem → null` 这种假失败。这里轮询到 key 出现为止。
 */
async function waitForPersist(key = STORAGE_KEY, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (storage.getItem(key) !== null) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

beforeEach(() => {
  storage.clear()
  // zustand persist 的默认存储是 `createJSONStorage(() => window.localStorage)`
  // （见 zustand/middleware 的 persist 默认项），node 环境没有 window，
  // 不装这个替身就整条落盘路径都是 noop —— 测试会「通过」但什么都没验证。
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: storage },
    writable: true,
    configurable: true,
  })
})

describe('音乐库缓存的水合', () => {
  it('落盘的列表与时刻在下次启动被恢复，且三态是「已就绪」', async () => {
    const store = await bootStore()
    const data = [{ id: 'p1', name: '缓存里的歌单', listenNum: 123 }] as never
    store.setState({
      recommend: { loading: false, error: '上一次失败留下的文案', data },
      recommendCachedAt: 1_700_000_000_000,
    })
    await waitForPersist()

    // 写盘形状：只有 data / cachedAt / query，没有 loading / error
    // （zustand persist 的外壳是 `{ state, version }`）
    const raw = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}').state
    expect(raw.recommend).toEqual({
      data,
      cachedAt: 1_700_000_000_000,
      query: { categoryId: '10000000', sortId: '5', page: 1 },
    })

    const rebooted = await bootStore()
    const state = rebooted.getState()
    expect(state.recommend.data).toEqual(data)
    expect(state.recommend.loading).toBe(false)
    expect(state.recommend.error).toBeNull()
    expect(state.recommendCachedAt).toBe(1_700_000_000_000)
  })

  it('筛选条件对不上的缓存被丢弃（旧分类的结果不能冒充新分类）', async () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          recommend: {
            data: [{ id: 'p1', name: '别的分类的歌单' }],
            cachedAt: Date.now(),
            query: { categoryId: '9999', sortId: '5', page: 1 },
          },
          toplists: null,
        },
        version: 0,
      })
    )

    const rebooted = await bootStore()

    expect(rebooted.getState().recommend.data).toEqual([])
    expect(rebooted.getState().recommendCachedAt).toBeNull()
  })

  it('存储里的坏数据（手改 / 半截写入）不会进 store', async () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { recommend: { data: 'not-an-array', cachedAt: 'x' } }, version: 0 })
    )

    const rebooted = await bootStore()

    expect(rebooted.getState().recommend.data).toEqual([])
    expect(rebooted.getState().recommendCachedAt).toBeNull()
    expect(rebooted.getState().toplists.data).toEqual([])
  })
})
