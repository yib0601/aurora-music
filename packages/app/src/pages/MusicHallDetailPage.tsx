import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
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
import { PageSubtitle, SubPageTitle } from '@/components/PageHeading'
import { HallEmpty } from '@/pages/MusicHallPage'
import { cn, formatTime } from '@/lib/utils'
import { useGoBack } from '@/lib/navigation'
import { ROUTE_PATHS, isRoute, LIBRARY_ROUTE, NAV_LABEL_KEYS, ROUTES } from '@/lib/routes'
import { useMusicHallStore, hallUnavailableReason } from '@/stores/musicHallStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { useT } from '@/i18n'
import { matchTracksByNames, type AppTranslator } from '@aurora/shared'
import type { Track } from '@/types'

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
      }))
    }
    return []
  }, [isToplist, toplistDetail, playlistDetail])

  // 上游没给名称时退到类型名：榜单「榜单」/ 歌单「推荐歌单」，两者语义不同故各占一键
  const title = isToplist
    ? toplistDetail?.data?.name || t('hall.toplist.fallbackName')
    : playlistDetail?.data?.name || t('hall.recommend.title')
  const total = isToplist ? toplistDetail?.data?.total ?? rows.length : rows.length

  /**
   * 把展示行转成可播放的 Track 列表。
   * 本地已有同名曲目优先用本地副本（播放不依赖网络）；其余为在线占位（path 为空，
   * 播放时由 playerStore 的取址闸门按需取址）——与歌单导入的在线曲目同一套语义。
   *
   * ⚠️ id 必须**确定性**（`hall-<详情id>-<序号>`）：早先用 generateId() 每次调用都生成新 id，
   * 导致「按 id 把取到地址的曲目替换回队列」永远匹配不上，点歌静默无声。
   * 同时整表用 useMemo 冻结，播放时不再重复构造。
   */
  const baseTracks = useMemo<Track[]>(() => {
    const localMatches = matchTracksByNames(
      rows.map((r) => ({ title: r.title, artist: r.artist })),
      libraryTracks
    )
    return rows.map((r, i) => {
      const local = localMatches[i]
      if (local) return local
      return {
        id: `hall-${id}-${i}`,
        path: '',
        title: r.title,
        artist: r.artist,
        album: '',
        duration: r.duration,
        addedAt: 0,
        playCount: 0,
        liked: false,
      }
    })
  }, [rows, libraryTracks, id])

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

  /** 全单总时长：Hero 里最直观的一份量化信息（比「66 首」更能说明这个歌单的体量） */
  const totalDuration = useMemo(() => rows.reduce((sum, r) => sum + (r.duration || 0), 0), [rows])

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

  /**
   * Hero 副标题：来源性质 / 曲目数 / 总时长 / 榜单更新时间。
   * 各片段本身就是字典里的整句，这里只是把同级元信息用「 · 」摆成一排，不构成句子拼接。
   */
  const heroMeta = useMemo(() => {
    const shown = rows.length
    const parts = [isToplist ? t('hall.toplist.title') : t('hall.recommend.title')]
    // 榜单的上游 total 是 300 而本次只取了 100 首：写「100 / 300 首」而不是照抄 total，
    // 否则页面宣称有 300 首、列表却只有 100 行，用户会以为还没加载完
    if (shown > 0) {
      parts.push(
        total > shown
          ? t('hall.detail.meta.songsOfTotal', { shown, total })
          : t('hall.detail.meta.songs', { count: shown })
      )
    }
    if (totalDuration > 0) parts.push(formatTotalDuration(totalDuration, t))
    const updated = isToplist ? toplistDetail?.data?.updateTime : ''
    if (updated) parts.push(t('hall.detail.meta.updated', { time: updated }))
    return parts.join(' · ')
  }, [isToplist, rows.length, total, totalDuration, toplistDetail, t])

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
        <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
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
              meta={loading ? t('common.state.loading') : heroMeta}
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

            <ul className="flex flex-col">
              {rows.map((row, i) => {
                const isCurrent = i === currentIndex
                return (
                  <li key={row.key}>
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
 * 详情页 Hero：拼图封面 + 标题 + 元信息 + 主操作。
 *
 * 加它的原因：详情页此前只有「一行标题 + 一张 66 行的表」，页面上没有任何视觉锚点，
 * 一整屏都是同密度、同明度的小字，看上去就是「单调」。Hero 给出封面、体量（曲目数 +
 * 总时长）与整单起播入口三件事，页面才有头有身。
 *
 * 歌单解析协议不提供歌单自身的封面（上游只回名称 + 曲目列表），所以封面用曲目封面拼
 * 2x2——这是「歌单没有自己的封面时用曲目封面顶上」的通行做法，比一个音符占位块交代
 * 的信息多得多：一眼能看出这个歌单的画风。
 */
function DetailHero({
  title,
  icon,
  meta,
  covers,
  children,
}: {
  title: string
  icon: React.ReactNode
  meta: string
  covers: string[]
  children: React.ReactNode
}) {
  return (
    <div className="flex items-end gap-5 mb-6">
      <HeroCover covers={covers} />
      {/* 与封面底部对齐（items-end），标题组自然落在封面下沿，而不是悬在封面半腰 */}
      <div className="min-w-0 flex-1 pb-0.5">
        <SubPageTitle className="truncate flex items-center gap-2">
          {icon}
          {title}
        </SubPageTitle>
        {meta && <PageSubtitle className="mt-1.5 truncate">{meta}</PageSubtitle>}
        <div className="flex items-center gap-2 mt-4">{children}</div>
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
  const box = 'w-[132px] h-[132px] flex-shrink-0 rounded-ds-panel overflow-hidden bg-white/[0.05]'
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

/**
 * 整单时长：够一小时按「X 小时 Y 分」，否则「Y 分钟」——秒级精度在这一层没有意义。
 * 分钟 / 小时这类数量单位复用 common.unit（两种语言各自补复数形态），
 * 「X 小时 Y 分」这种组合式表述才是本域自己的键。
 */
function formatTotalDuration(seconds: number, t: AppTranslator): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('common.unit.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0
    ? t('common.unit.hours', { count: hours })
    : t('hall.detail.meta.hoursMinutes', { hours, minutes: rest })
}
