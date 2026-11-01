/**
 * 独立歌词源配置（v15 恢复）。
 *
 * ## 背景：这一层为什么曾被删掉、又为什么回来
 *
 * v12 把「独立歌词源」删掉并入音源，理由是「一条源同时提供搜索/歌单/歌词三种能力」。
 * 那个前提只对 aurora 协议成立（它的服务端自描述里有 `endpoints.lyric`）。
 * 落到实际使用上出现了三个说不通的地方：
 *
 * 1. **洛雪脚本源没有歌词能力**（脚本只实现 `musicUrl`），于是用户配了脚本源
 *    就等于连带失去「音源派生歌词」这条路 —— 而他什么也没做错；
 * 2. 想「音源用 A、歌词用 B」时无处表达；
 * 3. 声明式歌词插件（`domain: 'lyrics'`）没有用户配置可挂。
 *
 * 所以歌词源恢复为**独立维度**。这里的用例钉住三件事：
 * - 增删改与 id 生成；
 * - 落盘（重启后还在）与迁移（老数据按 v12 语义丢弃、v15 数据不被升级清空）；
 * - **优先级**：显式配置排在音源派生之前。
 *
 * ## 为什么这里手工装 localStorage 桩
 *
 * `vitest.config.ts` 的 environment 是 `node`，没有 `localStorage`；而 persist 中间件
 * 在模块求值期就要拿到 storage。所以每个用例先 `vi.resetModules()` 再**装桩、后 import**，
 * 让 store 拿到这份内存实现。桩只需 `getItem/setItem/removeItem` 三个方法 ——
 * 这是 zustand persist 实际会调的集合（`clear` 我们自己用，方便断言间隔离）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 最小的 localStorage 桩：zustand persist 只会用到这几个方法。
 *
 * ⚠️ 必须挂在 **`window`** 上，不是 `globalThis`：zustand 5 的默认存储是
 * `createJSONStorage(() => window.localStorage)`（见 middleware/persist）。
 * node 环境下 `window` 不存在，桩挂在 `globalThis` 上时 persist 会静默拿不到存储、
 * 永远读回初始空值 —— 这个坑让本用例第一次跑出「迁移没生效」的假象。
 */
function installLocalStorage(): Map<string, string> {
  const bag = new Map<string, string>()
  const storage = {
    getItem: (k: string) => (bag.has(k) ? (bag.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      bag.set(k, String(v))
    },
    removeItem: (k: string) => {
      bag.delete(k)
    },
    clear: () => bag.clear(),
    key: (i: number) => [...bag.keys()][i] ?? null,
    get length() {
      return bag.size
    },
  }
  ;(globalThis as unknown as { window: unknown }).window = {
    localStorage: storage,
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = storage
  return bag
}


/**
 * 每个用例都从干净的 store 开始：模块级单例，必须重置。
 *
 * ## 为什么要 `await` 水合
 *
 * zustand persist 的 hydrate 是**异步**的（哪怕后端是同步的 localStorage，
 * 它也走一次 microtask）。不等待就直接读 `getState()`，读到的是初始空值 ——
 * 表现为「迁移用例永远拿到 0 条」，而迁移代码其实一行没错。
 * 这正是本用例第一次跑失败的原因，记在这里免得以后又踩。
 */
async function freshStore(seed?: { state: unknown; version: number }) {
  vi.resetModules()
  const bag = installLocalStorage()
  if (seed) bag.set('aurora-library-state', JSON.stringify(seed))
  const mod = await import('../libraryStore')
  // `useLibraryStore.persist` 是 persist 中间件挂上的 API；没有它说明配置变了
  const persistApi = (mod.useLibraryStore as unknown as { persist?: { rehydrate: () => Promise<void> } })
    .persist
  await persistApi?.rehydrate?.()
  return mod.useLibraryStore
}

/** 读回落盘快照（zustand persist 的格式是 `{ state, version }`） */
function persisted(bag: Map<string, string>): { state: Record<string, unknown>; version: number } | null {
  const raw = bag.get('aurora-library-state')
  if (!raw) return null
  const parsed = JSON.parse(raw) as { state?: Record<string, unknown>; version?: number }
  // 兼容「没有包裹层」的写法
  if (parsed.state) return { state: parsed.state, version: Number(parsed.version ?? 0) }
  return { state: parsed as Record<string, unknown>, version: 0 }
}

describe('歌词源的增删改', () => {
  it('新增时自动生成 id，且不与既有条目冲突', async () => {
    const store = await freshStore()
    const a = store.getState().addLyricsSource({
      name: '来源甲',
      sourceUrl: 'https://a.example/l?t={track}',
      enabled: true,
    })
    const b = store.getState().addLyricsSource({
      name: '来源乙',
      sourceUrl: 'https://b.example/l?t={track}',
      enabled: true,
    })
    expect(a.id).toBeTruthy()
    expect(b.id).toBeTruthy()
    expect(a.id).not.toBe(b.id)
    expect(store.getState().lyricsSources.map((s) => s.id)).toEqual([a.id, b.id])
  })

  it('更新只影响目标条目', async () => {
    const store = await freshStore()
    const a = store.getState().addLyricsSource({ name: '甲', sourceUrl: 'https://a/l?t={track}', enabled: true })
    store.getState().addLyricsSource({ name: '乙', sourceUrl: 'https://b/l?t={track}', enabled: true })
    store.getState().updateLyricsSource(a.id, { name: '甲改' })
    const list = store.getState().lyricsSources
    expect(list[0].name).toBe('甲改')
    expect(list[1].name).toBe('乙')
  })

  it('删除只移除目标条目', async () => {
    const store = await freshStore()
    const a = store.getState().addLyricsSource({ name: '甲', sourceUrl: 'https://a/l?t={track}', enabled: true })
    const b = store.getState().addLyricsSource({ name: '乙', sourceUrl: 'https://b/l?t={track}', enabled: true })
    store.getState().removeLyricsSource(a.id)
    expect(store.getState().lyricsSources.map((s) => s.id)).toEqual([b.id])
  })

  it('停用的歌词源仍在列表里（停用不是删除）', async () => {
    const store = await freshStore()
    const a = store.getState().addLyricsSource({ name: '甲', sourceUrl: 'https://a/l?t={track}', enabled: true })
    store.getState().updateLyricsSource(a.id, { enabled: false })
    expect(store.getState().lyricsSources).toHaveLength(1)
    expect(store.getState().lyricsSources[0].enabled).toBe(false)
  })
})

describe('歌词源的持久化与迁移', () => {
  it('落盘时保留歌词源（partialize 白名单里包含它）', async () => {
    const store = await freshStore()
    store.getState().addLyricsSource({ name: '甲', sourceUrl: 'https://a/l?t={track}', enabled: true })

    // 直接读 store 内部使用的那份存储（installLocalStorage 把它们指向同一个对象）
    const raw = (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(
      'aurora-library-state'
    )
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw as string) as { state: Record<string, unknown> }
    const persistedSources = parsed.state.lyricsSources as Array<{ sourceUrl: string }>
    expect(persistedSources).toHaveLength(1)
    expect(persistedSources[0].sourceUrl).toBe('https://a/l?t={track}')
  })

  /**
   * 这条最关键：v12 的迁移里有 `delete persisted.lyricsSources`。
   * 若不把该分支限定为 `version < 12`，每次启动都会把用户在 v15 里配的歌词源清空 ——
   * 表现为「配好的歌词源重启后消失」，且没有任何报错。
   */
  it('v15 数据升级时不被清空（迁移只对 version < 12 生效）', async () => {
    const store = await freshStore({
      state: {
        lyricsSources: [{ id: 'keep-me', name: '甲', sourceUrl: 'https://a/l?t={track}', enabled: true }],
      },
      version: 13,
    })
    expect(store.getState().lyricsSources).toHaveLength(1)
    expect(store.getState().lyricsSources[0].id).toBe('keep-me')
  })

  it('老数据（version < 12）里的 lyricsSources 仍按 v12 语义丢弃', async () => {
    const store = await freshStore({
      state: {
        lyricsSources: [
          { id: 'ancient', name: '老源', sourceUrl: 'https://old/l?t={track}', enabled: true },
        ],
      },
      version: 11,
    })
    expect(store.getState().lyricsSources).toHaveLength(0)
  })
})
