import { useEffect, useMemo } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Play, Loader2, Music2, TrendingUp, Sparkles, RefreshCw } from 'lucide-react'
import { PageLayout } from '@/components/PageLayout'
import { PageSubtitle, SubPageTitle } from '@/components/PageHeading'
import { HallEmpty, formatCount } from '@/pages/MusicHallPage'
import { cn, formatTime } from '@/lib/utils'
import { useGoBack } from '@/lib/navigation'
import { ROUTE_PATHS, isRoute, HALL_LABEL, LIBRARY_LABEL, LIBRARY_ROUTE, ROUTES } from '@/lib/routes'
import { useMusicHallStore, hallUnavailableReason } from '@/stores/musicHallStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { matchTracksByNames } from '@aurora/shared'
import type { Track } from '@/types'

/**
 * 音乐库详情页：推荐歌单 / 榜单共用。
 *
 * 数据来源按路由分派：
 *  - `/hall/toplist/:id`  → 榜单详情端点（带排名序号与时长）
 *  - `/hall/playlist/:id` → 歌单解析端点（`?server=qq&id=` 直取，复用既有协议）
 *
 * **只展示不落库**：这两个集合都是临时浏览对象，点歌才按需取址。
 * 播放优先本地：本地曲库里已有同名曲目就直接播本地副本（不依赖网络），
 * 没有地址的在线曲目交给 playerStore 的 playQueue 按需取址——页面不预取，
 * 用户点下去立刻能看到「正在播放哪一首」，取址在网络往返里完成。
 */
export function MusicHallDetailPage() {
  const navigate = useNavigate()
  const goBack = useGoBack()
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

  useEffect(() => {
    if (!id) return
    if (isToplist) void loadToplistDetail(id)
    else void loadPlaylistDetail(id)
  }, [id, isToplist, loadToplistDetail, loadPlaylistDetail])

  const resource = isToplist ? toplistDetail : playlistDetail
  const loading = resource?.loading ?? true
  const error = resource?.error ?? null

  /** 统一的展示行：歌名 / 歌手 / 时长（榜单有序号，歌单没有） */
  const rows = useMemo(() => {
    if (isToplist && toplistDetail?.data) {
      return toplistDetail.data.songs.map((s, i) => ({
        key: `${s.songmid || s.title}-${i}`,
        rank: s.rank || i + 1,
        title: s.title,
        artist: s.artist,
        duration: s.duration,
      }))
    }
    if (!isToplist && playlistDetail?.data) {
      return playlistDetail.data.songs.map((s, i) => ({
        key: `${s.title}-${i}`,
        rank: 0,
        title: s.title,
        artist: s.artist,
        duration: 0,
      }))
    }
    return []
  }, [isToplist, toplistDetail, playlistDetail])

  const title = isToplist
    ? toplistDetail?.data?.name || '榜单'
    : playlistDetail?.data?.name || '推荐歌单'
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

  const unavailable = hallUnavailableReason()
  if (unavailable) {
    return (
      <PageLayout header={<DetailHeader title={HALL_LABEL} onBack={goBack} />}>
        <HallEmpty
          title={`${HALL_LABEL}暂不可用`}
          desc={unavailable}
          action={{ label: '去配置音源', onClick: () => navigate(ROUTES.settings) }}
          secondaryAction={{ label: `去${LIBRARY_LABEL}`, onClick: () => navigate(LIBRARY_ROUTE) }}
        />
      </PageLayout>
    )
  }

  return (
    <PageLayout
      header={
        <DetailHeader
          title={title}
          subtitle={loading ? '加载中…' : `${total} 首${isToplist ? ' · 榜单' : ''}`}
          onBack={goBack}
          icon={isToplist ? <TrendingUp className="h-4 w-4 text-mint" strokeWidth={1.6} /> : <Sparkles className="h-4 w-4 text-mint" strokeWidth={1.6} />}
          action={
            <button
              type="button"
              onClick={handlePlayAll}
              disabled={rows.length === 0}
              className="pill pill-sm pill-mint inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" strokeWidth={1.8} />
              播放全部
            </button>
          }
        />
      }
    >
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
            title="重新加载"
            onClick={() => (isToplist ? void loadToplistDetail(id, true) : void loadPlaylistDetail(id, true))}
          >
            <RefreshCw className="h-4 w-4" strokeWidth={1.6} />
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="font-text text-[13px] text-white/50 py-6">这个{isToplist ? '榜单' : '歌单'}里没有曲目</p>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
          <ul className="flex flex-col">
            {rows.map((row, i) => (
              <li key={row.key}>
                <button
                  type="button"
                  onClick={() => void handlePlayRow(i)}
                  className="row-hover w-full flex items-center gap-3 px-2 py-2.5 rounded-ds-sm text-left"
                >
                  {isToplist && (
                    <span
                      className={cn(
                        'font-text text-[12px] tabular-nums w-6 flex-shrink-0 text-center',
                        row.rank <= 3 ? 'text-mint font-semibold' : 'text-white/40'
                      )}
                    >
                      {row.rank}
                    </span>
                  )}
                  <Music2 className="h-3.5 w-3.5 text-white/30 flex-shrink-0" strokeWidth={1.5} />
                  <span className="font-text text-body text-white/88 truncate flex-1 tracking-[-0.2px]">
                    {row.title}
                  </span>
                  <span className="font-text text-caption text-white/50 truncate max-w-[28%] tracking-[-0.12px]">
                    {row.artist}
                  </span>
                  {row.duration > 0 && (
                    <span className="font-text text-caption text-white/35 tabular-nums w-10 text-right flex-shrink-0">
                      {formatTime(row.duration)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </PageLayout>
  )
}

/** 详情页头部：返回 + 标题 + 播放全部（与歌单页头部同款结构） */
function DetailHeader({
  title,
  subtitle,
  icon,
  action,
  onBack,
}: {
  title: string
  subtitle?: string
  icon?: React.ReactNode
  action?: React.ReactNode
  onBack: () => void
}) {
  return (
    <div className="flex items-end justify-between gap-4 mb-6">
      <div className="flex items-center gap-3 min-w-0">
        <button className="btn-icon" onClick={onBack} title="返回">
          <ArrowLeft className="h-4 w-4" strokeWidth={1.6} />
        </button>
        <div className="min-w-0">
          <SubPageTitle className="truncate flex items-center gap-2">
            {icon}
            {title}
          </SubPageTitle>
          {subtitle && <PageSubtitle className="mt-0.5">{subtitle}</PageSubtitle>}
        </div>
      </div>
      {/* 右侧动作区：搜索入口已上移到应用顶栏，这里只在调用方给了动作时渲染 */}
      {action && (
        <div className="flex items-center gap-2 flex-shrink-0 pb-1 page-toolbar">{action}</div>
      )}
    </div>
  )
}