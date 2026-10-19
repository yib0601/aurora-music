import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowLeft,
  Play,
  Loader2,
  Music2,
  TrendingUp,
  Sparkles,
  RefreshCw,
  Shuffle,
  Volume2,
} from 'lucide-react'
import { PageLayout } from '@/components/PageLayout'
import { SubPageTitle } from '@/components/PageHeading'
import { useBindScrollElement } from '@/components/VirtualTrackTable'
import { HallEmpty } from '@/pages/MusicHallPage'
import { cn, formatTime } from '@/lib/utils'
import { useGoBack } from '@/lib/navigation'
import { ROUTE_PATHS, isRoute, LIBRARY_ROUTE, NAV_LABEL_KEYS, ROUTES } from '@/lib/routes'
import { useMusicHallStore, hallUnavailableReason } from '@/stores/musicHallStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { useT } from '@/i18n'
import { matchTracksByNames, musicHallSourceOf } from '@aurora/shared'
import { buildLibraryBuckets, matchLibraryDuration } from '@/lib/hallTrackDuration'
import type { MusicHallSource, Track } from '@/types'

/**
 * 曲目行高（px）：36px 封面 + 上下各 8px（``py-2``）。
 *
 * ⚠️ 必须与行内实际高度严格一致，否则虚拟列表会累积偏移（与 ``VirtualTrackTable`` 同款约束）。
 * 歌名与歌手都是单行截断，行高不会随文案变化。
 */
const ROW_HEIGHT = 52

/**
 * 音乐库详情页：推荐歌单 / 榜单共用。
 *
 * 数据来源按路由分派：
 *  - `/hall/toplist/:id`  → 榜单详情端点（名次来自上游 rank，带时长）
 *  - `/hall/playlist/:id` → 歌单解析端点（`?server=qq&id=` 直取，复用既有协议）
 *
 * 两页曲目行**同一套渲染**：序号 + 歌名 + 歌手 + 时长。歌单没有上游名次，序号用行号；
 * 时长来自源的 duration（源不给则整列隐藏，不显示 0:00）。
 *
 * **只展示不落库**：这两个集合都是临时浏览对象，点歌才按需取址。
 * 播放优先本地：本地曲库里已有同名曲目就直接播本地副本（不依赖网络），
 * 没有地址的在线曲目交给 playerStore 的 playQueue 按需取址——页面不预取，
 * 用户点下去立刻能看到「正在播放哪一首」，取址在网络往返里完成。
 */
export function MusicHallDetailPage() {
  const navigate = useNavigate()
  const goBack = useGoBack()
  const t = useT()
  const params = useParams<{ id: string }>()
  const id = params.id || ''
  // 详情类型由路由模式判定（同一组件承接榜单与歌单两种详情），不手写字符串比较
  const location = useLocation()
  const isToplist = isRoute(ROUTE_PATHS.hallToplist, location.pathname)

  const toplistDetail = useMusicHallStore((s) => s.toplistDetail[id])
  const playlistDetail = useMusicHallStore((s) => s.playlistDetail[id])
  const loadToplistDetail = useMusicHallStore((s) => s.loadToplistDetail)
  const loadPlaylistDetail = useMusicHallStore((s) => s.loadPlaylistDetail)

  const libraryTracks = useLibraryStore((s) => s.tracks)
  // 音源配置：构造可播放曲目时要带上「来源 id + 源内 id」（见 baseTracks），
  // 订阅它则保证设置页改过音源后本页曲目立即跟着换源
  const onlineSources = useLibraryStore((s) => s.onlineSources)
  // 正在播放的曲目：用于把列表里对应的那一行点亮（详情页属于「浏览中」，必须能看出
  // 当前在放的是本页第几首，否则点下去只有底部播放条有反应，列表看起来毫无变化）
  const currentTrack = usePlayerStore((s) => s.currentTrack)

  useEffect(() => {
    if (!id) return
    if (isToplist) void loadToplistDetail(id)
    else void loadPlaylistDetail(id)
  }, [id, isToplist, loadToplistDetail, loadPlaylistDetail])

  const resource = isToplist ? toplistDetail : playlistDetail
  const loading = resource?.loading ?? true
  const error = resource?.error ?? null

  /**
   * 统一的展示行：序号 / 封面 / 歌名+歌手 / 时长。
   *
   * 两页共用同一个序号列：榜单的名次来自上游 rank，歌单没有名次语义，用行号充当。
   * 时长同理：歌单从歌单解析端点拿真实秒数，源没给则按 0 走、该列自动隐藏。
   * 封面两页都有（榜单 coverUrl 由 albummid 拼、歌单由源的 coverUrl 给），缺则退化为占位块。
   *
   * ⚠️ 刻意**不做专辑列**：实测这歌单 66 首里 65 首的专辑名与歌名逐字相同（上游把单曲
   * 发行时的专辑就命名为同名），单独占一列只是把同一串字重复一遍，还挤掉歌名组的宽度。
   */
  const rows = useMemo(() => {
    if (isToplist && toplistDetail?.data) {
      return toplistDetail.data.songs.map((s, i) => ({
        key: `${s.songmid || s.title}-${i}`,
        rank: s.rank || i + 1,
        title: s.title,
        artist: s.artist,
        duration: s.duration,
        coverUrl: s.coverUrl,
        songmid: s.songmid,
      }))
    }
    if (!isToplist && playlistDetail?.data) {
      return playlistDetail.data.songs.map((s, i) => ({
        // 有 songmid 时用它做 key：同名不同版本（翻唱 / remix）不会撞 key
        key: `${s.songmid || s.title}-${i}`,
        rank: i + 1,
        title: s.title,
        artist: s.artist,
        duration: s.duration ?? 0,
        coverUrl: s.coverUrl,
        songmid: s.songmid,
      }))
    }
    return []
  }, [isToplist, toplistDetail, playlistDetail])

  // 曲目表虚拟化：歌单详情动辄几百首（实测 647 首），整表铺开等于几百个 button + 封面节点
  // 一次性进 DOM，进入/返回都在重建整表。这里只渲染视口内的行（与本地曲库 VirtualTrackTable
  // 同一套 @tanstack/react-virtual 方案），滚动时按需挂载。
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  // 列表相对滚动容器顶部的偏移：Hero 与列头都在同一个滚动容器里，虚拟列表必须知道
  // 自己的起点，否则滚动位置与渲染窗口整体错位（行会「跳」到错误的位置）
  const [scrollMargin, setScrollMargin] = useState(0)
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: useCallback(() => ROW_HEIGHT, []),
    overscan: 10,
    scrollMargin,
  })
  useBindScrollElement(rowVirtualizer, scrollRef)

  useEffect(() => {
    const list = listRef.current
    const container = scrollRef.current
    if (!list || !container) return
    const sync = () => setScrollMargin(list.offsetTop)
    sync()
    // Hero 高度随封面图/标题换行变化，容器尺寸也会变（窗口缩放）—— 偏移必须跟着重算
    const observer = new ResizeObserver(sync)
    observer.observe(list)
    observer.observe(container)
    return () => observer.disconnect()
  }, [rows.length, loading, error])

  // 上游没给名称时退到类型名：榜单「榜单」/ 歌单「推荐歌单」，两者语义不同故各占一键
  const title = isToplist
    ? toplistDetail?.data?.name || t('hall.toplist.fallbackName')
    : playlistDetail?.data?.name || t('hall.recommend.title')

  /**
   * 把展示行转成可播放的 Track 列表。
   * 本地已有同名曲目优先用本地副本（播放不依赖网络）；其余为在线占位（path 为空，
   * 播放时由 playerStore 的取址闸门按需取址）——与歌单导入的在线曲目同一套语义。
   *
   * ⚠️ id 必须**确定性**（`hall-<详情id>-<序号>`）：早先用 generateId() 每次调用都生成新 id，
   * 导致「按 id 把取到地址的曲目替换回队列」永远匹配不上，点歌静默无声。
   *
   * ⚠️ 在线占位要带上来源（onlineSource）与源内 id（onlineId / songmid）：缓存键由
   * 「来源 + 源内 id」推导，缺了它每次播放都要重下一遍；来源也是「网络来源曲目加载
   * 失败不踢队列」判据（isNetworkBackedTrack）的依据之一。封面同理——不带就只能显示占位图标。
   *
   * ⚠️ 源没给时长（duration 为 0）时用本地曲库同曲的时长补值（见 matchLibraryDuration）：
   * 乐源对无权益曲目回落到兜底音源时 duration 恒为 0，条目变成「时长未知」，播放器只能靠
   * 实际解码时长兜底；补上准确时长才能恢复「元数据与实际是否相符」这条判据。
   * 只补这里交给播放器的值，**不动展示列**：展示列的时长仍只认真实源数据（源没给就整列隐藏），
   * 把推定值当真实数据展示等于替源编数据。
   *
   * 同时整表用 useMemo 冻结，播放时不再重复构造。
   */
  const baseTracks = useMemo<Track[]>(() => {
    const localMatches = matchTracksByNames(
      rows.map((r) => ({ title: r.title, artist: r.artist })),
      libraryTracks
    )
    // 按歌名前两字分桶只建一次，供下面逐行补时长时复用（见 matchLibraryDuration）
    const buckets = buildLibraryBuckets(libraryTracks)
    // 与 musicHallStore 内部同一判据（首个「已启用 + 服务形态」的音源）
    const source = musicHallSourceOf(onlineSources as unknown as MusicHallSource[])
    return rows.map((r, i) => {
      const local = localMatches[i]
      if (local) return local
      // 源没给时长（无权益回落时恒为 0）：用本地曲库同曲的时长补上。
      // 补不到就保持 0，交给播放器的提示音闸门按实际解码时长兜底，不猜
      const duration = r.duration > 0 ? r.duration : matchLibraryDuration(r, buckets)
      return {
        id: `hall-${id}-${i}`,
        path: '',
        title: r.title,
        artist: r.artist,
        album: '',
        duration,
        addedAt: 0,
        playCount: 0,
        liked: false,
        coverUrl: r.coverUrl,
        onlineSource: source?.id,
        onlineId: r.songmid || undefined,
      }
    })
  }, [rows, libraryTracks, id, onlineSources])

  const handlePlayAll = () => {
    if (baseTracks.length === 0) return
    // 队列先落地：取址由 playQueue 内部按需完成，不在页面上等全部取完
    // （早先是先 resolvePlayableTracks 全量取址、再跳到「第一首能取到地址的」曲目起播：
    //  既让按钮长时间无响应，又会出现「点了第一首却在放第四首」的错位。
    //  现在固定从第一首开始，取不到地址就明确报错，不再静默跳曲）
    usePlayerStore.getState().playQueue(baseTracks, 0)
  }

  const handlePlayRow = (index: number) => {
    const track = baseTracks[index]
    if (!track) return
    usePlayerStore.getState().playQueue(baseTracks, index)
  }

  /**
   * 随机播放：洗一份**副本**再交给队列，不动 baseTracks 本身的顺序。
   * 与「播放全部」同一个入口语义（都是整单起播），差别只在起始顺序。
   */
  const handleShuffle = () => {
    if (baseTracks.length === 0) return
    const shuffled = [...baseTracks]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    usePlayerStore.getState().playQueue(shuffled, 0)
  }

  /** 是否有时长数据：整列没有就整列隐藏（源不给时长的老音源不该看到一列 0:00） */
  const hasDuration = useMemo(() => rows.some((r) => r.duration > 0), [rows])

  /** 当前正在播放的行号（按歌名 + 歌手匹配，因为本地命中时队列里放的是本地副本的 id） */
  const currentIndex = useMemo(() => {
    if (!currentTrack) return -1
    return rows.findIndex((r) => r.title === currentTrack.title && r.artist === currentTrack.artist)
  }, [rows, currentTrack])

  /**
   * Hero 封面：取前四首**互不相同**的曲目封面拼 2x2。
   *
   * 歌单解析协议不带歌单自身的封面（上游只回名称 + 曲目），曲目封面是唯一可用的视觉线索；
   * 同一张图重复四次比只放一张更难看，所以先去重，不足四张时退化成单图。
   */
  const heroCovers = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const r of rows) {
      if (!r.coverUrl || seen.has(r.coverUrl)) continue
      seen.add(r.coverUrl)
      out.push(r.coverUrl)
      if (out.length === 4) break
    }
    return out
  }, [rows])

  const unavailable = hallUnavailableReason(t)
  if (unavailable) {
    return (
      <PageLayout header={<BackBar onBack={goBack} />}>
        <HallEmpty
          title={t('hall.empty.title', { hall: t(NAV_LABEL_KEYS.hall) })}
          desc={unavailable}
          action={{ label: t('hall.empty.configureSource'), onClick: () => navigate(ROUTES.settings) }}
          secondaryAction={{
            label: t('hall.empty.goLibrary', { library: t(NAV_LABEL_KEYS.library) }),
            onClick: () => navigate(LIBRARY_ROUTE),
          }}
        />
      </PageLayout>
    )
  }

  return (
    <PageLayout header={<BackBar onBack={goBack} />}>
      {loading && rows.length === 0 ? (
        <div className="flex items-center justify-center py-20 text-white/40">
          <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.6} />
        </div>
      ) : error ? (
        // 错误态必须能给重试入口：上游偶发超时/限流时，用户不该被迫退出再进
        <div className="inset-note flex items-center justify-between gap-3 px-4 py-3">
          <span className="font-text text-[12px] text-white/60 truncate">{error}</span>
          <button
            type="button"
            className="btn-icon flex-shrink-0"
            title={t('hall.detail.reload')}
            onClick={() => (isToplist ? void loadToplistDetail(id, true) : void loadPlaylistDetail(id, true))}
          >
            <RefreshCw className="h-4 w-4" strokeWidth={1.6} />
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="font-text text-[13px] text-white/50 py-6">
          {isToplist ? t('hall.detail.empty.toplist') : t('hall.detail.empty.playlist')}
        </p>
      ) : (
        <div
          ref={scrollRef}
          className="hall-detail-scroll relative flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin pr-2 -mr-2"
        >
          {/* ⚠️ 上面的 overflow-x-hidden 不是可选项：只声明 overflow-y:auto 时，CSS 会把
              另一轴的 visible 计算成 auto —— 容器因此变成**横向可滚动容器**，Hero 在窄容器
              里超出几像素（实测 390px 视口溢出 7px、320px 溢出 77px），整页就能被手指左右
              拖动，且拖动后 Hero 被推到屏幕外、左边露出空白。见 DetailHero 的宽度推导。 */}
          {/* Hero 与曲目表同宽：列表限宽 720 后，Hero 若铺满内容区，页面上会同时存在
              两个视觉轴（宽的 Hero + 窄的表），读起来像是拼错版 */}
          <div className="max-w-[720px]">
            <DetailHero
              title={title}
              icon={
                isToplist ? (
                  <TrendingUp className="h-5 w-5 text-mint flex-shrink-0" strokeWidth={1.6} />
                ) : (
                  <Sparkles className="h-5 w-5 text-mint flex-shrink-0" strokeWidth={1.6} />
                )
              }
              covers={heroCovers}
            >
              <button
                type="button"
                onClick={handlePlayAll}
                disabled={rows.length === 0}
                className="pill pill-md pill-mint inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <Play className="h-4 w-4" strokeWidth={1.8} fill="currentColor" />
                {t('hall.detail.playAll')}
              </button>
              <button
                type="button"
                onClick={handleShuffle}
                disabled={rows.length === 0}
                className="pill pill-md pill-soft inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <Shuffle className="h-4 w-4" strokeWidth={1.8} />
                {t('hall.detail.shuffle')}
              </button>
            </DetailHero>

            {/* 列头：长列表没有列头时，每一行都是一段无从对齐的裸文本；有了它整块
                才读成一张表。宽度与行内的三列严格一致（w-6 / w-9 / flex-1 / w-12） */}
            <div className="flex items-center gap-3 px-2 pb-2 mb-1 border-b border-white/[0.06] font-text text-[12px] text-white/35">
              <span className="w-6 flex-shrink-0 text-center">#</span>
              <span className="w-9 flex-shrink-0" />
              <span className="flex-1">{t('hall.detail.column.song')}</span>
              {hasDuration && (
                <span className="w-12 flex-shrink-0 text-right">{t('common.label.duration')}</span>
              )}
            </div>

            <ul
              ref={listRef}
              className="relative w-full m-0 p-0 list-none"
              style={{ height: rowVirtualizer.getTotalSize() }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const i = virtualRow.index
                const row = rows[i]
                if (!row) return null
                const isCurrent = i === currentIndex
                return (
                  <li
                    key={row.key}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: virtualRow.size,
                      // scrollMargin = 列表相对滚动容器顶部的偏移：start 里已含它，这里减掉才是
                      // 相对列表自身的位移（Hero 与列头占掉的那段高度不算在列表内）
                      transform: `translateY(${virtualRow.start - rowVirtualizer.options.scrollMargin}px)`,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => void handlePlayRow(i)}
                      className={cn(
                        'group row-hover w-full flex items-center gap-3 px-2 py-2 rounded-ds-sm text-left',
                        // 正在播放的行：铺一层常驻 mint 底 + 左侧一道竖条。竖条是必需的——
                        // hover 用的也是同色系的底，只靠底色的话「鼠标停在哪」和「正在放哪首」
                        // 读起来一模一样
                        isCurrent &&
                          'relative bg-mint/[0.07] before:content-[\'\'] before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-full before:bg-mint'
                      )}
                    >
                      {/* 序号列兼作播放键：hover 时序号让位给播放三角，这是「这一行可点」最省地方的暗示 */}
                      <span className="w-6 flex-shrink-0 flex items-center justify-center">
                        {isCurrent ? (
                          <Volume2 className="h-3.5 w-3.5 text-mint" strokeWidth={1.8} />
                        ) : (
                          <>
                            <span
                              className={cn(
                                'font-text text-[12px] tabular-nums group-hover:hidden',
                                // 前三名高亮只对榜单成立：歌单的序号只是行号，没有名次语义
                                isToplist && row.rank <= 3 ? 'text-mint font-semibold' : 'text-white/40'
                              )}
                            >
                              {row.rank}
                            </span>
                            <Play
                              className="hidden group-hover:block h-3.5 w-3.5 text-mint"
                              strokeWidth={1.8}
                              fill="currentColor"
                            />
                          </>
                        )}
                      </span>
                      <RowCover url={row.coverUrl} />
                      {/* 歌名与歌手**同组左对齐**：此前歌手单占一列、被 flex-1 顶到中间，
                          与歌名之间空出一大片，一行读起来像被切成互不相干的三段 */}
                      <span className="flex-1 min-w-0">
                        <span
                          className={cn(
                            'block font-text text-body truncate tracking-[-0.2px]',
                            isCurrent ? 'text-mint' : 'text-white/88'
                          )}
                        >
                          {row.title}
                        </span>
                        <span className="block font-text text-caption text-white/45 truncate tracking-[-0.12px] mt-0.5">
                          {row.artist}
                        </span>
                      </span>
                      {hasDuration && (
                        <span className="font-text text-caption text-white/35 tabular-nums w-12 text-right flex-shrink-0">
                          {row.duration > 0 ? formatTime(row.duration) : '--:--'}
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      )}
    </PageLayout>
  )
}

/**
 * 行封面：36px 圆角方块。
 *
 * 缺封面（老音源只回歌名歌手、Meting 兜底、榜单预览条目）与加载失败都退化成**同尺寸**
 * 的音符占位块——尺寸必须一致，否则一列里有图没图参差不齐，比不放图更难看。
 */
function RowCover({ url }: { url?: string }) {
  const [failed, setFailed] = useState(false)
  const box = 'w-9 h-9 rounded-ds-sm flex-shrink-0 bg-white/[0.06]'
  if (!url || failed) {
    return (
      <span className={cn(box, 'flex items-center justify-center')}>
        <Music2 className="h-3.5 w-3.5 text-white/30" strokeWidth={1.5} />
      </span>
    )
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      className={cn(box, 'object-cover')}
    />
  )
}

/** 详情页顶栏：只剩返回入口。标题与操作已下沉到 Hero（随内容滚动，不长期占用顶部空间） */
function BackBar({ onBack }: { onBack: () => void }) {
  const t = useT()
  return (
    <div className="flex items-center mb-3">
      <button className="btn-icon" onClick={onBack} title={t('common.action.back')}>
        <ArrowLeft className="h-4 w-4" strokeWidth={1.6} />
      </button>
    </div>
  )
}

/**
 * 详情页 Hero：拼图封面 + 标题 + 主操作。
 *
 * 加它的原因：详情页此前只有「一行标题 + 一张 66 行的表」，页面上没有任何视觉锚点，
 * 一整屏都是同密度、同明度的小字，看上去就是「单调」。Hero 给出封面与整单起播入口，
 * 页面才有头有身。
 *
 * ⚠️ 刻意**不显示副标题**（曲目数 / 总时长 / 更新时间）：这一排元信息与下方曲目表、
 * 列头说的是同一件事，只在标题下重复一遍，还让 Hero 多出一行可换行的窄字。
 *
 * 歌单解析协议不提供歌单自身的封面（上游只回名称 + 曲目列表），所以封面用曲目封面拼
 * 2x2——这是「歌单没有自己的封面时用曲目封面顶上」的通行做法，比一个音符占位块交代
 * 的信息多得多：一眼能看出这个歌单的画风。
 */
function DetailHero({
  title,
  icon,
  covers,
  children,
}: {
  title: string
  icon: React.ReactNode
  covers: string[]
  children: React.ReactNode
}) {
  return (
    // 与封面底部对齐（items-end），标题组自然落在封面下沿，而不是悬在封面半腰。
    // 窄容器（手机）由 .hall-hero 的容器查询改成纵向堆叠：132px 封面 + 20px 间距横向
    // 摆开时标题列只剩约 214px（歌单名几乎全部截断），操作按钮也会被挤到换行（见 globals.css）
    <div className="hall-hero flex items-end gap-5 mb-6">
      <HeroCover covers={covers} />
      <div className="min-w-0 flex-1 pb-0.5">
        <SubPageTitle className="truncate flex items-center gap-2">
          {icon}
          {title}
        </SubPageTitle>
        {/* flex-wrap 是必需的：两个 pill 都是 white-space:nowrap 且不许收缩，不放行的
            窄容器里它们会把整行顶宽（实测按钮行 min-content 221px）。换行只作兜底，
            真正的分档在 .hall-hero 的容器查询里 */}
        <div className="hall-hero__actions flex flex-wrap items-center gap-2 mt-4">{children}</div>
      </div>
    </div>
  )
}

/**
 * Hero 封面：132px 圆角方块。
 *
 * 四张以上不同封面 → 2x2 拼图（3px 缝，中间那道十字分割让它读起来像是「多张图的集合」
 * 而不是一张被划花的图）；一到三张 → 单图铺满；一张都没有 → 同尺寸音符占位块。
 * 三种形态**外框尺寸完全一致**，切换数据源时页面不会跳。
 */
function HeroCover({ covers }: { covers: string[] }) {
  // hall-hero__cover 供 .hall-hero 的容器查询在窄档缩小封面（见 globals.css）；
  // 三个形态共用同一个 box 常量，尺寸因此始终一致，切换数据源时页面不会跳
  const box = 'hall-hero__cover w-[132px] h-[132px] flex-shrink-0 rounded-ds-panel overflow-hidden bg-white/[0.05]'
  if (covers.length >= 4) {
    return (
      <div className={cn(box, 'grid grid-cols-2 grid-rows-2 gap-[3px]')}>
        {covers.slice(0, 4).map((url, i) => (
          <CoverTile key={`${url}-${i}`} url={url} />
        ))}
      </div>
    )
  }
  if (covers.length > 0) return <CoverTile url={covers[0]} className={box} />
  return (
    <div className={cn(box, 'flex items-center justify-center border border-white/[0.06]')}>
      <Music2 className="h-9 w-9 text-white/25" strokeWidth={1.2} />
    </div>
  )
}

/** 拼图单元格：加载失败时留同色的空格子，不出现破图图标 */
function CoverTile({ url, className }: { url: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <span className={cn('w-full h-full bg-white/[0.05]', className)} />
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
      className={cn('w-full h-full object-cover', className)}
    />
  )
}
