import { create } from 'zustand'
import { musicHallSourceOf, searchEndpointOf } from '@aurora/shared'
import type { MusicHallSource, ParsedSong, RecommendPlaylist, ToplistGroup, ToplistDetail } from '@/types'
import { hallRecommend, hallToplists, hallToplistSongs, supportsMusicHall } from '@/services/platform'
import { useLibraryStore } from '@/stores/libraryStore'
import { HALL_LABEL, LIBRARY_LABEL } from '@/lib/routes'

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

/** 无音源 / 平台不支持的统一提示文案（UI 空态与错误态共用一处） */
export function hallUnavailableReason(): string {
  // 本页是应用首屏，空态文案要同时交代「为什么空」与「本地内容仍可用」——
  // 只说原因会让用户以为应用坏了
  if (!supportsMusicHall()) return `当前环境不支持${HALL_LABEL}（浏览器版无在线能力），可先到「${LIBRARY_LABEL}」听本地曲库`
  const sources = useLibraryStore.getState().onlineSources
  if (sources.length === 0) return `${HALL_LABEL}的推荐与榜单由音源服务提供，尚未配置音源；本地曲库不受影响`
  if (!sources.some((s) => s.enabled)) return '音源已全部停用，请在设置页启用音乐源'
  if (!pickHallSource()) return `当前音源不支持${HALL_LABEL}（需填写服务地址形态的音源）`
  return ''
}

/**
 * IPC 错误前缀：Electron 把主进程抛出的错误重建成 `Error`，message 前拼一句
 * `Error invoking remote method '<channel>': `（name 一律退化成 Error），
 * 这层前缀对用户没有任何信息量，剥掉后剩下的才是执行器的中文结论。
 */
const IPC_PREFIX_RE = /^Error invoking remote method '[^']*':\s*/

/** 剥掉 IPC 前缀后剩下的「异常类名:」前缀（含嵌套，如 `AbortError: `、`TypeError: `） */
const ERROR_TAG_RE = /^(?:[A-Za-z]*Error|DOMException):\s*/

/**
 * 错误文案归一：保证用户看到的是结论而非堆栈。
 *
 * 单独处理三种底座英文错误——它们在桌面端经 IPC 回传后，name 已经退化，
 * 只能按 message 里的类名/message 判定，直接上屏就是用户看到的那句
 * "The operation was aborted."：
 *   - AbortError：请求被中止（超时或取消）
 *   - TypeError: Failed to fetch：网络不可达（DNS / 连接被拒 / 代理拦截）
 * 执行器自己抛的中文错误原样保留。
 */
export function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  let msg = raw.replace(IPC_PREFIX_RE, '').trim()
  if (!msg) return '加载失败'
  // 可能连着几层类名前缀（`Error: AbortError: …`），逐层剥
  for (let i = 0; i < 3; i++) {
    const next = msg.replace(ERROR_TAG_RE, '').trim()
    if (next === msg) break
    msg = next
  }
  if (isAbortMessage(msg) || isAbortMessage(raw)) return '请求超时：音源服务未在超时时间内响应'
  if (/failed to fetch|networkerror|load failed|fetch failed/i.test(msg)) {
    return '网络不可达：请检查音源服务是否在运行、地址与端口是否正确'
  }
  return msg
}

/** 中止类错误判定：类名或浏览器/Node 自带的那两句固定 message */
function isAbortMessage(msg: string): boolean {
  return /abort/i.test(msg)
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
      const result = await parsePlaylistLink(sources, `https://y.qq.com/n/ryqq/playlist/${key}`)
      set({
        playlistDetail: {
          ...get().playlistDetail,
          [key]: {
            loading: false,
            error: null,
            // 整份曲目透传：源给多少字段就留多少（见 PlaylistDetailData 的说明）
            data: { name: result.name || '', songs: result.songs },
          },
        },
      })
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