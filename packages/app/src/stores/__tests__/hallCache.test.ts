import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 音乐库首屏（推荐歌单 / 榜单列表）落盘缓存的行为回归。
 *
 * 钉住四件事：
 *  1. 缓存新鲜时**不打网络**（冷启动首屏零等待的根据）；
 *  2. 缓存过期后请求期间**不清空旧数据**（否则用户会看到内容先消失再出现）；
 *  3. 刷新失败**保留旧数据**、只置 error —— 一次网络抖动不该把能看的内容换成报错；
 *  4. 没有缓存时的失败才进错误态（页面据此展示重试），以及水合快照的坏形状被丢弃。
 *
 * 落盘本身（localStorage 读写）由 zustand persist 负责，node 环境下 storage 不可用，
 * 所以这里只测 store 的行为与 `lib/hallCache` 的口径，不测「写没写进磁盘」。
 */
vi.mock('@/services/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/platform')>()
  return { ...actual, hallRecommend: vi.fn(), hallToplists: vi.fn() }
})

const { hallRecommend, hallToplists } = await import('@/services/platform')
const { useMusicHallStore } = await import('@/stores/musicHallStore')
const { useLibraryStore } = await import('@/stores/libraryStore')
const { HALL_CACHE_TTL_MS, isHallCacheFresh, readHallCacheEntry } = await import('@/lib/hallCache')

const mockedRecommend = vi.mocked(hallRecommend)
const mockedToplists = vi.mocked(hallToplists)

const CACHED = [{ id: 'p1', name: '缓存里的歌单', listenNum: 100 }] as never
const FRESH = [{ id: 'p2', name: '刚拉到的歌单', listenNum: 200 }] as never

/** 缓存时刻：`ago` 毫秒之前 */
const cachedAgo = (ago: number) => Date.now() - ago

beforeEach(() => {
  mockedRecommend.mockReset()
  mockedToplists.mockReset()
  useLibraryStore.setState({
    onlineSources: [
      {
        id: 'src-1',
        name: '我的音源',
        sourceUrl: 'https://music.example.com?key=K1',
        enabled: true,
      },
    ] as never,
  })
  useMusicHallStore.setState({
    recommend: { loading: false, error: null, data: [] },
    recommendCachedAt: null,
    toplists: { loading: false, error: null, data: [] },
    toplistsCachedAt: null,
    query: { categoryId: '10000000', sortId: '5', page: 1 },
  })
})

describe('推荐歌单的落盘缓存', () => {
  it('缓存新鲜时直接复用，不打网络', async () => {
    useMusicHallStore.setState({
      recommend: { loading: false, error: null, data: CACHED },
      recommendCachedAt: cachedAgo(60_000),
    })

    await useMusicHallStore.getState().loadRecommend()

    expect(mockedRecommend).not.toHaveBeenCalled()
    expect(useMusicHallStore.getState().recommend.data).toEqual(CACHED)
  })

  it('缓存过期后后台刷新：请求期间保留旧数据，成功后原地替换', async () => {
    useMusicHallStore.setState({
      recommend: { loading: false, error: null, data: CACHED },
      recommendCachedAt: cachedAgo(HALL_CACHE_TTL_MS + 1000),
    })
    mockedRecommend.mockImplementation(async () => {
      const during = useMusicHallStore.getState().recommend
      // 请求进行中：旧列表还在（不能闪成骨架 / 空态）
      expect(during.loading).toBe(true)
      expect(during.data).toEqual(CACHED)
      return FRESH
    })

    await useMusicHallStore.getState().loadRecommend()

    const after = useMusicHallStore.getState()
    expect(after.recommend.data).toEqual(FRESH)
    expect(after.recommend.error).toBeNull()
    expect(isHallCacheFresh(after.recommendCachedAt)).toBe(true)
  })

  it('刷新失败时保留旧数据，只置 error', async () => {
    const stale = cachedAgo(HALL_CACHE_TTL_MS + 1000)
    useMusicHallStore.setState({
      recommend: { loading: false, error: null, data: CACHED },
      recommendCachedAt: stale,
    })
    mockedRecommend.mockRejectedValueOnce(new Error('Failed to fetch'))

    await useMusicHallStore.getState().loadRecommend(true)

    const after = useMusicHallStore.getState()
    expect(after.recommend.data).toEqual(CACHED)
    expect(after.recommend.error).toBeTruthy()
    // 时刻不动：下次进入仍会重试，而不是把这次失败当成「刚刷新过」
    expect(after.recommendCachedAt).toBe(stale)
  })

  it('没有缓存时首次失败才进错误态（页面据此展示重试）', async () => {
    mockedRecommend.mockRejectedValueOnce(new Error('Failed to fetch'))

    await useMusicHallStore.getState().loadRecommend()

    const after = useMusicHallStore.getState()
    expect(after.recommend.data).toEqual([])
    expect(after.recommend.error).toBeTruthy()
    expect(after.recommendCachedAt).toBeNull()
  })

  it('改筛选条件后旧缓存不再算数', async () => {
    useMusicHallStore.setState({
      recommend: { loading: false, error: null, data: CACHED },
      recommendCachedAt: cachedAgo(60_000),
    })
    mockedRecommend.mockResolvedValue(FRESH)

    useMusicHallStore.getState().setQuery({ sortId: '1' })
    await useMusicHallStore.getState().loadRecommend()

    expect(mockedRecommend).toHaveBeenCalledTimes(1)
    expect(useMusicHallStore.getState().recommend.data).toEqual(FRESH)
  })
})

describe('榜单列表的落盘缓存', () => {
  it('缓存新鲜时复用；过期后刷新替换', async () => {
    const cached = [{ groupName: '飙升榜', toplists: [] }] as never
    const fresh = [{ groupName: '新歌榜', toplists: [] }] as never
    useMusicHallStore.setState({
      toplists: { loading: false, error: null, data: cached },
      toplistsCachedAt: cachedAgo(60_000),
    })

    await useMusicHallStore.getState().loadToplists()
    expect(mockedToplists).not.toHaveBeenCalled()

    useMusicHallStore.setState({ toplistsCachedAt: cachedAgo(HALL_CACHE_TTL_MS + 1000) })
    mockedToplists.mockResolvedValue(fresh)
    await useMusicHallStore.getState().loadToplists()

    expect(mockedToplists).toHaveBeenCalledTimes(1)
    expect(useMusicHallStore.getState().toplists.data).toEqual(fresh)
  })
})

describe('缓存口径（lib/hallCache）', () => {
  it('新鲜度判定：缺失 / 超期 / 未来时刻都算不新鲜', () => {
    expect(isHallCacheFresh(null)).toBe(false)
    expect(isHallCacheFresh(0)).toBe(false)
    expect(isHallCacheFresh(cachedAgo(-60_000))).toBe(false)
    expect(isHallCacheFresh(cachedAgo(HALL_CACHE_TTL_MS + 1))).toBe(false)
    expect(isHallCacheFresh(cachedAgo(1000))).toBe(true)
  })

  it('水合快照形状不对时当作没有缓存', () => {
    expect(readHallCacheEntry(null)).toBeNull()
    expect(readHallCacheEntry({ data: '不是数组', cachedAt: 1 })).toBeNull()
    expect(readHallCacheEntry({ data: [], cachedAt: 'x' })).toBeNull()
    expect(readHallCacheEntry({ data: [], cachedAt: 1 })).toEqual({ data: [], cachedAt: 1 })
  })
})
