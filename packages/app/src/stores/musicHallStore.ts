import { create } from 'zustand'
import {
  musicHallSourceOf,
  searchEndpointOf,
  translateError,
  type AppTranslator,
  type TFunction,
} from '@aurora/shared'
import type { MusicHallSource, ParsedSong, RecommendPlaylist, ToplistGroup, ToplistDetail } from '@/types'
import { hallRecommend, hallToplists, hallToplistSongs, supportsMusicHall } from '@/services/platform'
import { useLibraryStore } from '@/stores/libraryStore'
import { NAV_LABEL_KEYS } from '@/lib/routes'
import { appTranslate } from '@/i18n'

/**
 * 音乐库（旧称「音乐馆」，store / 类型 / 路由段名沿用 hall / MusicHall*）状态：
 * 推荐歌单 / 榜单列表 / 榜单详情的加载态与数据缓存。
 *
 * **刻意不持久化**：榜单与推荐每天都在变，落盘的旧数据只会让用户看到过期的排行，
 * 且首屏还要先渲染缓存再替换造成闪烁。每次进入页面按需拉取即可（数据量小、上游快）。
 *
 * 详情缓存同样只在会话内保留：点开过的榜单/歌单重进无需再拉一次，
 * 但**不做跨重启复用**（榜单内容按天更新，隔天必须重取）。
 */

/** 推荐歌单筛选条件（分类 / 排序 / 页码） */
export interface RecommendQuery {
  categoryId: string
  sortId: string
  page: number
}

const DEFAULT_QUERY: RecommendQuery = { categoryId: '10000000', sortId: '5', page: 1 }

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
  /** 推荐歌单筛选条件 */
  query: RecommendQuery
  /** 榜单列表 */
  toplists: Resource<ToplistGroup[]>
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
 * 条件是「已启用 + 服务地址形态（在线音乐端点由协议派生）」——
 * 接口模板形态的音源没有这三个端点，选它只会得到空结果。
 */
export function pickHallSource(): MusicHallSource | null {
  const sources = useLibraryStore.getState().onlineSources
  return musicHallSourceOf(sources as unknown as MusicHallSource[]) as MusicHallSource | null
}

/**
 * 无音源 / 平台不支持的统一提示（UI 空态与列表错误态共用一处）。
 * 返回**已按当前语言渲染**的文案；空串表示可用。
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
  if (!supportsMusicHall()) return t('hall.unavailable.unsupportedEnv', names)
  const sources = useLibraryStore.getState().onlineSources
  if (sources.length === 0) return t('hall.unavailable.noSource', names)
  if (!sources.some((s) => s.enabled)) return t('hall.unavailable.allDisabled')
  if (!pickHallSource()) return t('hall.unavailable.sourceUnsupported', names)
  return ''
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

export const useMusicHallStore = create<MusicHallState>()((set, get) => ({
  recommend: emptyResource<RecommendPlaylist[]>([]),
  query: DEFAULT_QUERY,
  toplists: emptyResource<ToplistGroup[]>([]),
  toplistDetail: {},
  playlistDetail: {},

  setQuery: (patch) => set({ query: { ...get().query, ...patch } }),

  loadRecommend: async (force = false) => {
    const current = get().recommend
    if (current.loading) return
    if (!force && current.data.length > 0) return
    const source = pickHallSource()
    if (!source) {
      set({ recommend: { loading: false, error: hallUnavailableReason(), data: [] } })
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
      set({ recommend: { loading: false, error: null, data: list } })
    } catch (err) {
      set({ recommend: { loading: false, error: messageOf(err), data: [] } })
    }
  },

  loadToplists: async (force = false) => {
    const current = get().toplists
    if (current.loading) return
    if (!force && current.data.length > 0) return
    const source = pickHallSource()
    if (!source) {
      set({ toplists: { loading: false, error: hallUnavailableReason(), data: [] } })
      return
    }
    set({ toplists: { ...current, loading: true, error: null } })
    try {
      const groups = await hallToplists(source, { preview: 3 })
      set({ toplists: { loading: false, error: null, data: groups } })
    } catch (err) {
      set({ toplists: { loading: false, error: messageOf(err), data: [] } })
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
}))