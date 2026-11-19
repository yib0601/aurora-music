import type { RecommendPlaylist, ToplistGroup } from '@/types'

/**
 * 音乐库首屏（推荐歌单 / 榜单列表）缓存的**口径**：新鲜度判定、快照形状、筛选条件等价判定。
 *
 * 边界：
 * - 只做纯计算：不读 store、不碰网络、不碰 localStorage。写入与落盘由
 *   `stores/musicHallStore.ts` 负责，UI 只消费 store 里的三态与时间戳。
 * - 不负责详情（榜单详情 / 歌单详情）：那两者按天变且单个大歌单 JSON 可达 ~1MB，
 *   落盘价值低、配额风险高，仍只在会话内复用。
 *
 * 时间戳与快照都是**外部输入**（localStorage 可被手改、可被旧版本写入），
 * 判定一律走这里的函数，不在调用点各写一遍 `Date.now() - cachedAt < ...`。
 */

/**
 * 缓存新鲜期。
 *
 * 上游（音源服务的推荐端点）是每日刷新的榜单型数据，6 小时足够让「一天开好几次」
 * 的用户几乎总命中缓存，又不会让早上的榜单撑到深夜。过期不等于不可用：store 会先
 * 拿旧数据渲染、再后台刷新（stale-while-revalidate），所以这个值只影响「打不打网络」，
 * 不影响「看不看得见」。
 */
export const HALL_CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** 一条落盘缓存：数据 + 写入时刻（epoch ms） */
export interface HallCacheEntry<T> {
  data: T[]
  cachedAt: number
}

/** 推荐歌单筛选条件（分类 / 排序 / 页码） */
export interface RecommendQuery {
  categoryId: string
  sortId: string
  page: number
}

/** 首次进入音乐库时的默认筛选（全部 / 最热 / 第一页） */
export const DEFAULT_RECOMMEND_QUERY: RecommendQuery = {
  categoryId: '10000000',
  sortId: '5',
  page: 1,
}

/**
 * 落盘快照（`persist.partialize` 的产物，也是 `merge` 的入参）。
 *
 * 刻意只放**两段列表 + 时刻**：loading / error 是运行期状态，落盘会让重启后
 * 出现「一个永远转圈」或「一条上一轮的错误横幅」。
 *
 * 推荐歌单额外带上取数时的筛选条件：缓存只对**同一组筛选**成立，
 * 用户改过分类/排序后不能把旧筛选的结果当成新的。
 */
export interface PersistedHallCache {
  recommend: (HallCacheEntry<RecommendPlaylist> & { query?: RecommendQuery }) | null
  toplists: HallCacheEntry<ToplistGroup> | null
}

/** 缓存是否仍在新鲜期内。`null` / `0` / 未来时刻 / 超过 TTL 一律判为不新鲜 */
export function isHallCacheFresh(cachedAt: number | null | undefined, now = Date.now()): boolean {
  if (!cachedAt || !Number.isFinite(cachedAt) || cachedAt <= 0) return false
  const age = now - cachedAt
  // age < 0：系统时间被回拨或数据来自未来。当作过期处理，宁可多打一次网络，
  // 也不要因为一个不可能的时间戳把缓存永久钉死
  return age >= 0 && age < HALL_CACHE_TTL_MS
}

/** 两组筛选条件是否等价（只为判断「这份缓存还算不算当前条件的数据」） */
export function sameRecommendQuery(a: RecommendQuery | null | undefined, b: RecommendQuery): boolean {
  if (!a) return false
  return a.categoryId === b.categoryId && a.sortId === b.sortId && a.page === b.page
}

/**
 * 从水合进 store 的未知形状里取出一条可用缓存。
 *
 * 落盘数据可能来自旧版本、手改或半截写入。任何不符形状的输入都返回 `null`
 * （= 没有缓存），绝不把半个对象塞进 `Resource` —— 那会让 UI 读 `data.length` 时崩。
 */
export function readHallCacheEntry<T>(raw: unknown): HallCacheEntry<T> | null {
  if (!raw || typeof raw !== 'object') return null
  const { data, cachedAt } = raw as { data?: unknown; cachedAt?: unknown }
  if (!Array.isArray(data)) return null
  if (typeof cachedAt !== 'number' || !Number.isFinite(cachedAt)) return null
  return { data: data as T[], cachedAt }
}

/** 读出推荐歌单缓存；筛选条件对不上就当作没有缓存（同一条目换了分类不算命中） */
export function readRecommendCacheEntry(
  raw: unknown,
  query: RecommendQuery
): HallCacheEntry<RecommendPlaylist> | null {
  const entry = readHallCacheEntry<RecommendPlaylist>(raw)
  if (!entry) return null
  const cachedQuery = (raw as { query?: RecommendQuery }).query
  if (!sameRecommendQuery(cachedQuery, query)) return null
  return entry
}
