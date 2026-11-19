import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  canBrowseHall,
  searchEndpointOf,
  translateError,
  type AppTranslator,
} from '@aurora/shared'
import type { MusicHallSource, ParsedSong, RecommendPlaylist, ToplistGroup, ToplistDetail } from '@/types'
import { hallRecommend, hallToplists, hallToplistSongs, supportsMusicHall } from '@/services/platform'
import { useLibraryStore } from '@/stores/libraryStore'
import { hallAvailabilityOf, type HallAvailability } from '@/lib/hallAvailability'
import {
  DEFAULT_RECOMMEND_QUERY,
  isHallCacheFresh,
  readHallCacheEntry,
  readRecommendCacheEntry,
  type PersistedHallCache,
  type RecommendQuery,
} from '@/lib/hallCache'
import { NAV_LABEL_KEYS } from '@/lib/routes'
import { appTranslate } from '@/i18n'

/**
 * 音乐库（旧称「音乐馆」，store / 类型 / 路由段名沿用 hall / MusicHall*）状态：
 * 推荐歌单 / 榜单列表 / 榜单详情的加载态与数据缓存。
 *
 * **列表落盘、详情只在会话内**：
 * - 推荐歌单与榜单列表写进 localStorage（`aurora-hall-cache`）：冷启动与断网时首屏
 *   直接出内容，不必先等一次上游请求；
 * - 落盘数据带 `cachedAt`，超过 `HALL_CACHE_TTL_MS`（见 `lib/hallCache.ts`）视为过期。
 *   过期不等于不可用：先拿旧数据渲染、再后台刷新，刷新失败保留旧数据；
 * - 榜单/歌单**详情**不落盘：内容按天变，且单个大歌单的上游 JSON 可达 ~1MB，
 *   落盘收益低、配额风险高，仍只在会话内复用。
 */

/**
 * 歌单详情首屏取数（首屏只取前 N 首，随后按源回的 `truncated` 决定是否补全量）。
 *
 * 200 是「一屏滚动几下的量」与「上游一次取数的成本」之间的折中：歌单详情页一屏约 12 行，
 * 200 首足够覆盖用户进页面后的前几次滚动；再大就接近全量（实测 647 首的上游 JSON ~1.1MB），
 * 首屏优势会被吃掉。源不支持 `?limit=` 时这个参数会被自动剔除，退化成一次全量请求。
 */
const PLAYLIST_FIRST_PAGE = 200

/** 单条异步资源的状态：loading / error / data 三态互斥 */
interface Resource<T> {
  loading: boolean
  error: string | null
  data: T
}

const emptyResource = <T,>(data: T): Resource<T> => ({ loading: false, error: null, data })

/**
 * 歌单详情数据：歌单名 + 曲目。
 *
 * 曲目**原样**用歌单解析协议的结果（ParsedSong）——不再裁剪成 `{title, artist}`。
 * 裁剪会让新版音源服务带出的专辑 / 时长 / 封面全部流失，歌单详情页因此只剩歌名 + 歌手
 * （榜单详情页一直有完整字段，两页厚度对不上）。协议最小集之外的字段缺席时，
 * 由页面按 `?? 0` 兜底，不在这一层补空值。
 */
export interface PlaylistDetailData {
  name: string
  songs: ParsedSong[]
}

interface MusicHallState {
  /** 推荐歌单 */
  recommend: Resource<RecommendPlaylist[]>
  /** 推荐歌单的落盘时刻（epoch ms）；null = 没有可用缓存（新鲜度判定见 lib/hallCache） */
  recommendCachedAt: number | null
  /** 推荐歌单筛选条件 */
  query: RecommendQuery
  /** 榜单列表 */
  toplists: Resource<ToplistGroup[]>
  /** 榜单列表的落盘时刻（epoch ms）；null = 没有可用缓存 */
  toplistsCachedAt: number | null
  /** 榜单详情：按 topId 缓存（会话内） */
  toplistDetail: Record<string, Resource<ToplistDetail | null>>
  /** 歌单详情（来自歌单解析端点）：按歌单号缓存 */
  playlistDetail: Record<string, Resource<PlaylistDetailData | null>>

  setQuery: (patch: Partial<RecommendQuery>) => void
  loadRecommend: (force?: boolean) => Promise<void>
  loadToplists: (force?: boolean) => Promise<void>
  loadToplistDetail: (id: string, force?: boolean) => Promise<void>
  loadPlaylistDetail: (id: string, force?: boolean) => Promise<void>
}

/**
 * 取当前可用的在线音乐音源。
 *
 * 判据是**插件能力**（`canBrowseHall`），不是「服务地址形态」——
 * 改造前这里调 `musicHallSourceOf()`，它只看 aurora 协议能否派生出推荐/榜单端点，
 * 于是「哪些源能提供在线发现」被绑死在一种协议形态上：装来的声明式插件即使在清单里
 * 声明了推荐端点，也永远不会被选中。
 *
 * 现在任何实现了 `recommendPlaylists` 或 `toplists` 的插件都自动候选，
 * 顺序按用户的音源配置顺序（第一个能用的胜出，与既有行为一致）。
 */
export function pickHallSource(): MusicHallSource | null {
  const sources = useLibraryStore.getState().onlineSources
  for (const source of sources) {
    if (!source || source.enabled === false) continue
    if (canBrowseHall(source)) return source as unknown as MusicHallSource
  }
  return null
}

/**
 * 当前配置下的音乐库可用性（`ok` 之外的四种原因见 `lib/hallAvailability.ts`）。
 *
 * 读的是**当前快照**而不是订阅：store 内的异步分支与事件回调用它，
 * 需要跟随变化重渲染的场景（导航入口、主屏落点）走 `hooks/useHallAvailability.ts`。
 */
export function hallAvailability(): HallAvailability {
  return hallAvailabilityOf(useLibraryStore.getState().onlineSources, supportsMusicHall())
}

/**
 * 无音源 / 平台不支持的统一提示（UI 空态与列表错误态共用一处）。
 * 返回**已按当前语言渲染**的文案；空串表示可用。
 *
 * 「是否可用」不在这里判：口径统一由 `hallAvailabilityOf` 给出，
 * 否则侧栏入口、主屏落点、本页空态会各有一套说法（正是本次要修的问题）。
 * 这里只负责把结论翻译成文案。
 *
 * `t` 由调用方注入：组件里传 `useT()`（语言切换会重渲染），
 * store 内的异步分支走默认值 `appTranslate()`（每次调用读语言快照，不是模块级求值）。
 */
export function hallUnavailableReason(t: AppTranslator = appTranslate()): string {
  // 本页是应用首屏，空态文案要同时交代「为什么空」与「本地内容仍可用」——
  // 只说原因会让用户以为应用坏了。
  // 页面名不写死在这一层：用占位符注入，免得 routes.ts 改一次名这里漏一处
  // （「音乐库 / 我的音乐」的取名沿革见 lib/routes.ts）。
  const names = { hall: t(NAV_LABEL_KEYS.hall), library: t(NAV_LABEL_KEYS.library) }
  switch (hallAvailability()) {
    case 'ok':
      return ''
    case 'unsupportedEnv':
      return t('hall.unavailable.unsupportedEnv', names)
    case 'noSource':
      return t('hall.unavailable.noSource', names)
    case 'allDisabled':
      return t('hall.unavailable.allDisabled')
    case 'sourceUnsupported':
      return t('hall.unavailable.sourceUnsupported', names)
  }
}

/**
 * 错误文案归一：保证用户看到的是结论而非堆栈（页面层与 service 层的统一入口）。
 *
 * 归一规则本身在 `@aurora/shared` 的 i18n/errors.ts（`toErrorInfo` + `translateError`）：
 *   - 剥掉 Electron 的 `Error invoking remote method '<channel>':` 前缀与 `AbortError:` 一类类名前缀；
 *   - AbortError（跨 IPC 后 name 已退化，只剩 message）→ 超时；
 *   - `TypeError: Failed to fetch` → 网络不可达；
 *   - 空 message → 通用失败文案；未识别的文本原样透出（宁可显示原文也不抹平信息量）。
 * 这一层只负责**接线**：把原始错误连同当前语言的翻译函数交给内核。
 * 旧实现在 app 侧复刻了一份关键词表，每加一种错误就得补一条正则，且文案写死中文。
 */
export function messageOf(err: unknown, t: AppTranslator = appTranslate()): string {
  return translateError(err, t)
}

export const useMusicHallStore = create<MusicHallState>()(
  persist<MusicHallState, [], [], PersistedHallCache>(
    (set, get) => ({
      recommend: emptyResource<RecommendPlaylist[]>([]),
      recommendCachedAt: null,
      query: DEFAULT_RECOMMEND_QUERY,
      toplists: emptyResource<ToplistGroup[]>([]),
      toplistsCachedAt: null,
      toplistDetail: {},
      playlistDetail: {},

      setQuery: (patch) =>
        set({
          query: { ...get().query, ...patch },
          // 筛选条件变了，「新鲜」不再指当前这组条件：清掉时间戳让下一次 loadRecommend
          // 重新取数。data 保留——旧筛选的结果比一块骨架更适合当过渡画面
          recommendCachedAt: null,
        }),

      /**
       * 推荐歌单（stale-while-revalidate）：
       * - 缓存新鲜 → 直接返回，不打网络（冷启动首屏零等待）；
       * - 缓存过期 / 没有缓存 → 打网络，但**不清空已有数据**：请求期间旧列表继续显示，
       *   成功原地替换并刷新 `cachedAt`；
       * - 请求失败 / 无可用音源 → 保留旧数据、只置 error。旧数据被抹掉是最糟的结果：
       *   用户看到的是「整块内容突然消失」，而他刚才还能正常浏览。
       */
      loadRecommend: async (force = false) => {
        const current = get().recommend
        if (current.loading) return
        if (!force && isHallCacheFresh(get().recommendCachedAt)) return
        const source = pickHallSource()
        if (!source) {
          // 缓存不清：用户可能只是临时禁用/选错了源，配回来时那份列表还能当兜底
          set({ recommend: { loading: false, error: hallUnavailableReason(), data: current.data } })
          return
        }
        set({ recommend: { ...current, loading: true, error: null } })
        try {
          const { query } = get()
          const list = await hallRecommend(source, {
            categoryId: query.categoryId,
            sortId: query.sortId,
            page: query.page,
            limit: 30,
          })
          // 空结果也记时刻：源确实回了「没有推荐」，TTL 内不必为同一组筛选反复打它
          set({
            recommend: { loading: false, error: null, data: list },
            recommendCachedAt: Date.now(),
          })
        } catch (err) {
          set({ recommend: { loading: false, error: messageOf(err), data: current.data } })
        }
      },

      /** 榜单列表：与推荐歌单同一套落盘 + 新鲜度口径，见 `loadRecommend` 的注释 */
      loadToplists: async (force = false) => {
        const current = get().toplists
        if (current.loading) return
        if (!force && isHallCacheFresh(get().toplistsCachedAt)) return
        const source = pickHallSource()
        if (!source) {
          set({ toplists: { loading: false, error: hallUnavailableReason(), data: current.data } })
          return
        }
        set({ toplists: { ...current, loading: true, error: null } })
        try {
          const groups = await hallToplists(source, { preview: 3 })
          set({
            toplists: { loading: false, error: null, data: groups },
            toplistsCachedAt: Date.now(),
          })
        } catch (err) {
          set({ toplists: { loading: false, error: messageOf(err), data: current.data } })
        }
      },

      loadToplistDetail: async (id, force = false) => {
        const key = String(id)
        const current = get().toplistDetail[key]
        if (current?.loading) return
        if (!force && current?.data) return
        const source = pickHallSource()
        if (!source) {
          set({
            toplistDetail: {
              ...get().toplistDetail,
              [key]: { loading: false, error: hallUnavailableReason(), data: null },
            },
          })
          return
        }
        set({
          toplistDetail: {
            ...get().toplistDetail,
            [key]: { loading: true, error: null, data: current?.data ?? null },
          },
        })
        try {
          const detail = await hallToplistSongs(source, { id, limit: 100 })
          set({
            toplistDetail: { ...get().toplistDetail, [key]: { loading: false, error: null, data: detail } },
          })
        } catch (err) {
          set({
            toplistDetail: {
              ...get().toplistDetail,
              [key]: { loading: false, error: messageOf(err), data: null },
            },
          })
        }
      },

      /**
       * 歌单详情：复用**既有**歌单解析端点（`{url}` 协议，支持 `?server=qq&id=` 直取）。
       * 走 shared 的 parsePlaylistLink 而非新端点，避免为同一能力再定义一套协议。
       *
       * **两段式加载**（首屏快 + 全量准）：
       *   1. 先用 `?limit=` 只取前 `PLAYLIST_FIRST_PAGE` 首 —— 大歌单（实测 647 首）上游要吐
       *      ~1.1MB JSON，服务端解析与客户端 JSON.parse 都压在首屏上；只取一页即可先渲染出列表；
       *   2. 源回了 `truncated` 说明不是全量，再后台补一次全量替换。
       *   补全量失败时**静默保留首屏**：已经显示出来的列表不该因为一次补齐失败变成错误页。
       *
       * 曲目字段与榜单详情**同名同义**（album / duration / coverUrl / songmid）：音源服务侧
       * 的 /aurora/playlist 与 /aurora/toplist 由同一份口径描述，客户端不因「这是歌单」
       * 就少认字段——过去正是在这一层把曲目裁成两个字段，歌单详情页才只剩歌名 + 歌手。
       */
      loadPlaylistDetail: async (id, force = false) => {
        const key = String(id)
        const current = get().playlistDetail[key]
        if (current?.loading) return
        if (!force && current?.data) return
        set({
          playlistDetail: {
            ...get().playlistDetail,
            [key]: { loading: true, error: null, data: current?.data ?? null },
          },
        })
        const setData = (name: string, songs: ParsedSong[]) =>
          set({
            playlistDetail: {
              ...get().playlistDetail,
              [key]: {
                loading: false,
                error: null,
                // 整份曲目透传：源给多少字段就留多少（见 PlaylistDetailData 的说明）
                data: { name, songs },
              },
            },
          })
        try {
          const sources = useLibraryStore.getState().onlineSources.filter((s) => s.enabled && searchEndpointOf(s))
          if (sources.length === 0) {
            set({
              playlistDetail: {
                ...get().playlistDetail,
                [key]: { loading: false, error: hallUnavailableReason(), data: null },
              },
            })
            return
          }
          const { parsePlaylistLink } = await import('@aurora/shared')
          const shareUrl = `https://y.qq.com/n/ryqq/playlist/${key}`
          const first = await parsePlaylistLink(sources, shareUrl, { limit: PLAYLIST_FIRST_PAGE })
          setData(first.name || '', first.songs)
          if (first.truncated) {
            try {
              const full = await parsePlaylistLink(sources, shareUrl)
              setData(full.name || first.name || '', full.songs)
            } catch (err) {
              // 首屏已经可用了：补齐失败只留日志，不把列表换成错误态
              console.warn('[音乐库] 歌单全量补齐失败，保留首屏曲目:', err)
            }
          }
        } catch (err) {
          set({
            playlistDetail: {
              ...get().playlistDetail,
              [key]: { loading: false, error: messageOf(err), data: null },
            },
          })
        }
      },
    }),
    {
      name: 'aurora-hall-cache',
      // 白名单落盘：只有两段列表与时刻进 localStorage。loading / error 是运行期状态，
      // 详情（toplistDetail / playlistDetail）按天变且体量大，都不在这里
      partialize: (state) => ({
        recommend:
          state.recommendCachedAt === null
            ? null
            : { data: state.recommend.data, cachedAt: state.recommendCachedAt, query: state.query },
        toplists:
          state.toplistsCachedAt === null
            ? null
            : { data: state.toplists.data, cachedAt: state.toplistsCachedAt },
      }),
      /**
       * 水合（持久化数据是**外部输入**：旧版本写入、手改、半截写入）。
       *
       * 两条边界：
       * - 形状不对（不是数组 / 时刻不是数字）→ 当作没有缓存，不把半个对象塞进 `Resource`；
       * - 恢复出来的一律是「已就绪」三态（loading=false / error=null）：上次的失败文案
       *   不该跨重启留到这一次。
       */
      merge: (persisted, current) => {
        const snap = (persisted ?? {}) as Partial<PersistedHallCache>
        const recommend = readRecommendCacheEntry(snap.recommend, current.query)
        const toplists = readHallCacheEntry<ToplistGroup>(snap.toplists)
        return {
          ...current,
          recommend: emptyResource<RecommendPlaylist[]>(recommend?.data ?? []),
          recommendCachedAt: recommend?.cachedAt ?? null,
          toplists: emptyResource<ToplistGroup[]>(toplists?.data ?? []),
          toplistsCachedAt: toplists?.cachedAt ?? null,
        }
      },
    }
  )
)
