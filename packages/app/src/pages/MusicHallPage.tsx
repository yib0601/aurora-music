import { useEffect, useMemo, useState } from 'react'
import { Compass, RefreshCw, Music2, TrendingUp, Sparkles } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { PageLayout } from '@/components/PageLayout'
import { SearchEntry } from '@/components/common/SearchEntry'
import { cn } from '@/lib/utils'
import { ROUTE_BUILDERS, ROUTES } from '@/lib/routes'
import { useMusicHallStore, hallUnavailableReason } from '@/stores/musicHallStore'
import type { RecommendPlaylist, ToplistBrief, ToplistGroup, ToplistPreviewSong } from '@/types'

/**
 * 音乐馆：推荐歌单 + 排行榜（在线发现入口，只读浏览）。
 *
 * 数据来自用户配置的音源服务（协议见 @aurora/shared 的 musicHall.ts）。
 * 应用不内置任何平台抓取器——未配音源时整页是引导空态，而不是内置的假数据。
 *
 * 视觉遵循 DS：长列表卡片用 `.card-solid`（无 blur，避免滚动时逐帧重采样），
 * 一屏只有一个强调色（mint，仅用于选中/焦点），hover 只改背景与描边、不做位移。
 */
export function MusicHallPage() {
  const navigate = useNavigate()
  const recommend = useMusicHallStore((s) => s.recommend)
  const toplists = useMusicHallStore((s) => s.toplists)
  const loadRecommend = useMusicHallStore((s) => s.loadRecommend)
  const loadToplists = useMusicHallStore((s) => s.loadToplists)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    void loadRecommend()
    void loadToplists()
  }, [loadRecommend, loadToplists])

  const unavailable = hallUnavailableReason()

  const handleRefresh = async () => {
    setRefreshing(true)
    await Promise.all([loadRecommend(true), loadToplists(true)])
    setRefreshing(false)
  }

  const loading = recommend.loading || toplists.loading

  return (
    <PageLayout
      header={
        <div className="flex items-end justify-between gap-4 mb-6 md:mb-8">
          <div className="min-w-0">
            <h1 className="font-display text-[24px] md:text-[32px] font-semibold tracking-[-0.374px] text-white/98 leading-tight">
              音乐馆
            </h1>
            <p className="font-text text-[13px] text-white/50 mt-1 tracking-[-0.2px]">
              推荐歌单与排行榜，点开即可试听
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 pb-1 page-toolbar">
            <SearchEntry />
            <button
              type="button"
              className="btn-icon"
              title="刷新"
              onClick={handleRefresh}
              disabled={loading || Boolean(unavailable)}
            >
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} strokeWidth={1.6} />
            </button>
          </div>
        </div>
      }
    >
      {unavailable ? (
        <HallEmpty
          title="音乐馆暂不可用"
          desc={unavailable}
          action={{ label: '去配置音源', onClick: () => navigate(ROUTES.settings) }}
        />
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
          {/* ── 推荐歌单 ── */}
          <Section
            icon={<Sparkles className="h-4 w-4 text-mint" strokeWidth={1.6} />}
            title="推荐歌单"
            subtitle={recommend.data.length > 0 ? `${recommend.data.length} 个` : undefined}
          >
            {recommend.loading && recommend.data.length === 0 ? (
              <SkeletonRow />
            ) : recommend.error ? (
              <InlineError message={recommend.error} onRetry={() => void loadRecommend(true)} />
            ) : recommend.data.length === 0 ? (
              <p className="font-text text-[13px] text-white/50 py-3">暂无推荐歌单</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {recommend.data.map((pl) => (
                  <PlaylistCard
                    key={pl.id}
                    playlist={pl}
                    onOpen={() => navigate(ROUTE_BUILDERS.hallPlaylist(pl.id))}
                  />
                ))}
              </div>
            )}
          </Section>

          {/* ── 排行榜 ── */}
          <Section
            icon={<TrendingUp className="h-4 w-4 text-mint" strokeWidth={1.6} />}
            title="排行榜"
            subtitle={toplists.data.length > 0 ? `${totalBoards(toplists.data)} 个榜单` : undefined}
            className="mt-10"
          >
            {toplists.loading && toplists.data.length === 0 ? (
              <SkeletonRow />
            ) : toplists.error ? (
              <InlineError message={toplists.error} onRetry={() => void loadToplists(true)} />
            ) : toplists.data.length === 0 ? (
              <p className="font-text text-[13px] text-white/50 py-3">暂无榜单</p>
            ) : (
              <div className="flex flex-col gap-8">
                {toplists.data.map((group) => (
                  <div key={`${group.groupId ?? group.groupName}`}>
                    <h3 className="font-text text-[12px] font-semibold text-white/65 uppercase tracking-wider mb-3">
                      {group.groupName}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                      {group.toplists.map((board) => (
                        <ToplistCard
                          key={board.id}
                          board={board}
                          onOpen={() => navigate(ROUTE_BUILDERS.hallToplist(String(board.id)))}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      )}
    </PageLayout>
  )
}

/** 榜单总数（分组扁平化后计数） */
function totalBoards(groups: ToplistGroup[]): number {
  return groups.reduce((n, g) => n + g.toplists.length, 0)
}

function Section({
  icon,
  title,
  subtitle,
  className,
  children,
}: {
  icon: React.ReactNode
  title: string
  subtitle?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={className}>
      <div className="flex items-baseline gap-2 mb-4">
        {icon}
        <h2 className="font-display text-[18px] font-semibold text-white/95 tracking-[-0.3px]">{title}</h2>
        {subtitle && <span className="font-text text-[12px] text-white/45">{subtitle}</span>}
      </div>
      {children}
    </section>
  )
}

/** 推荐歌单卡片：封面 + 名称 + 播放量 */
function PlaylistCard({ playlist, onOpen }: { playlist: RecommendPlaylist; onOpen: () => void }) {
  const [failed, setFailed] = useState(false)
  const cover = playlist.coverUrl
  useEffect(() => setFailed(false), [cover])

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group card-solid rounded-ds-card p-3 text-left transition-colors duration-200 ease-mineradio hover:bg-white/[0.08] border border-white/[0.06] hover:border-white/[0.12]"
    >
      <div className="relative aspect-square rounded-ds-media overflow-hidden bg-white/[0.05] mb-3">
        {cover && !failed ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-white/25">
            <Music2 className="h-8 w-8" strokeWidth={1.2} />
          </div>
        )}
      </div>
      <p className="font-text text-[13px] text-white/90 leading-snug line-clamp-2 tracking-[-0.2px]">
        {playlist.name}
      </p>
      <p className="font-text text-[11px] text-white/45 mt-1 truncate tracking-[-0.12px]">
        {playlist.listenNum ? `${formatCount(playlist.listenNum)} 次播放` : playlist.creatorName || '推荐歌单'}
      </p>
    </button>
  )
}

/** 榜单卡片：榜单名 + 前几首预览（带排名序号） */
function ToplistCard({ board, onOpen }: { board: ToplistBrief; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group card-solid rounded-ds-panel p-4 text-left transition-colors duration-200 ease-mineradio hover:bg-white/[0.08] border border-white/[0.06] hover:border-white/[0.12]"
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <p className="font-text text-[14px] font-semibold text-white/92 tracking-[-0.2px] truncate">
          {board.name}
        </p>
        {board.updateTime && (
          <span className="font-text text-[11px] text-white/40 flex-shrink-0 tabular-nums">
            {board.updateTime}
          </span>
        )}
      </div>
      {board.songs.length === 0 ? (
        <p className="font-text text-[12px] text-white/40 py-1">点击查看完整榜单</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {board.songs.slice(0, 3).map((song, i) => (
            <PreviewRow key={`${song.rank}-${song.title}`} song={song} index={i} />
          ))}
        </ol>
      )}
    </button>
  )
}

function PreviewRow({ song, index }: { song: ToplistPreviewSong; index: number }) {
  // 前三名用 mint 强调（一屏一个强调色：这里只染序号文字，不铺色块）
  const highlight = index === 0
  return (
    <li className="flex items-center gap-2 min-w-0">
      <span
        className={cn(
          'font-text text-[11px] tabular-nums w-4 flex-shrink-0',
          highlight ? 'text-mint font-semibold' : 'text-white/40'
        )}
      >
        {song.rank || index + 1}
      </span>
      <span className="font-text text-[12px] text-white/75 truncate flex-1 tracking-[-0.15px]">
        {song.title}
      </span>
      <span className="font-text text-[11px] text-white/40 truncate max-w-[40%] tracking-[-0.12px]">
        {song.artist}
      </span>
    </li>
  )
}

/** 播放量：上万折算为「万 / 亿」，避免长数字撑破卡片 */
export function formatCount(n: number): string {
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return String(n)
}

function SkeletonRow() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="card-solid rounded-ds-card p-3 animate-pulse">
          <div className="aspect-square rounded-ds-media bg-white/[0.05] mb-3" />
          <div className="h-3 rounded bg-white/[0.06] mb-2" />
          <div className="h-2.5 w-2/3 rounded bg-white/[0.05]" />
        </div>
      ))}
    </div>
  )
}

function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="inset-note flex items-center justify-between gap-3 px-4 py-3">
      <span className="font-text text-[12px] text-white/60 truncate">{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="font-text text-[12px] text-mint hover:text-mint/80 flex-shrink-0 transition-colors"
      >
        重试
      </button>
    </div>
  )
}

/** 空态：未配音源 / 环境不支持时的统一引导 */
export function HallEmpty({
  title,
  desc,
  action,
}: {
  title: string
  desc: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center">
      <div className="relative mb-6">
        <div className="absolute -inset-16 bg-gradient-to-b from-mint/[0.06] to-transparent rounded-full blur-3xl" />
        <div className="relative w-[120px] h-[120px] rounded-ds-card bg-white/[0.03] border border-white/[0.08] flex items-center justify-center">
          <Compass className="h-[52px] w-[52px] text-mint/60" strokeWidth={1} />
        </div>
      </div>
      <h2 className="font-display text-[22px] font-semibold text-white/90 mb-2 tracking-[-0.3px]">{title}</h2>
      <p className="font-text text-[14px] text-white/50 mb-6 tracking-[-0.15px] text-center max-w-md px-6 leading-relaxed">
        {desc}
      </p>
      {action && (
        <button onClick={action.onClick} className="pill pill-lg pill-mint">
          {action.label}
        </button>
      )}
    </div>
  )
}