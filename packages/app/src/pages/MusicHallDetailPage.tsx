import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Play, Loader2, Music2, TrendingUp, Sparkles } from 'lucide-react'
import { PageLayout } from '@/components/PageLayout'
import { SearchEntry } from '@/components/common/SearchEntry'
import { toast } from '@/components/common/Toast'
import { HallEmpty, formatCount } from '@/pages/MusicHallPage'
import { cn, formatTime } from '@/lib/utils'
import { useGoBack } from '@/lib/navigation'
import { ROUTE_PATHS, isRoute, HALL_LABEL } from '@/lib/routes'
import { useMusicHallStore, hallUnavailableReason } from '@/stores/musicHallStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { ensurePlayableTrack, resolvePlayableTracks } from '@/services/playlistIO.service'
import { matchTracksByNames } from '@aurora/shared'
import type { Track } from '@/types'

/**
 * 在线音乐详情页：推荐歌单 / 榜单共用。
 *
 * 数据来源按路由分派：
 *  - `/hall/toplist/:id`  → 榜单详情端点（带排名序号与时长）
 *  - `/hall/playlist/:id` → 歌单解析端点（`?server=qq&id=` 直取，复用既有协议）
 *
 * **只展示不落库**：这两个集合都是临时浏览对象，点歌才按需取址。
 * 播放优先本地：本地曲库里已有同名曲目就直接播本地副本（不依赖网络），
 * 没有的走 ensurePlayableTrack 按名搜索取在线地址。
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

  const [playing, setPlaying] = useState(false)
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
   * 播放时由 ensurePlayableTrack 取址）——与歌单导入的在线曲目同一套语义。
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

  const handlePlayAll = async () => {
    if (baseTracks.length === 0) return
    setPlaying(true)
    try {
      const queue = await resolvePlayableTracks(baseTracks)
      const start = queue.findIndex((t) => t.path || t.onlineUrl)
      if (start < 0) {
        toast('无法播放：未配置可用的音源，或搜索均无结果', { type: 'error', duration: 5000 })
        return
      }
      usePlayerStore.getState().playQueue(queue, start)
    } finally {
      setPlaying(false)
    }
  }

  const handlePlayRow = async (index: number) => {
    const track = baseTracks[index]
    if (!track) return
    // 本地副本：直接进队列播，无需取址
    if (track.path) {
      usePlayerStore.getState().playQueue(baseTracks, index)
      return
    }
    const playable = await ensurePlayableTrack(track)
    if (!playable) {
      toast('无法播放该曲目：未配置音源或搜索无结果', { type: 'error', duration: 5000 })
      return
    }
    // 用同 id 把取到地址的曲目替换回队列（baseTracks 的 id 是确定性的，一定能命中）
    const queue = baseTracks.map((t) => (t.id === playable.id ? playable : t))
    usePlayerStore.getState().playQueue(queue, index)
  }

  const unavailable = hallUnavailableReason()
  if (unavailable) {
    return (
      <PageLayout header={<DetailHeader title={HALL_LABEL} onBack={goBack} />}>
        <HallEmpty
          title={`${HALL_LABEL}暂不可用`}
          desc={unavailable}
          action={{ label: '去配置音源', onClick: () => navigate('/settings') }}
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
              disabled={playing || rows.length === 0}
              className="pill pill-sm pill-mint inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              {playing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
              ) : (
                <Play className="h-3.5 w-3.5" strokeWidth={1.8} />
              )}
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
        <div className="inset-note px-4 py-3">
          <span className="font-text text-[12px] text-white/60">{error}</span>
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
          <h1 className="font-display text-[22px] md:text-[28px] font-semibold tracking-[-0.374px] text-white/98 leading-tight truncate flex items-center gap-2">
            {icon}
            {title}
          </h1>
          {subtitle && (
            <p className="font-text text-[13px] text-white/50 mt-0.5 tracking-[-0.2px]">{subtitle}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0 pb-1 page-toolbar">
        <SearchEntry />
        {action}
      </div>
    </div>
  )
}