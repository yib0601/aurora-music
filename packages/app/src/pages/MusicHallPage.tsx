import { useEffect, useState } from 'react'
import { ArrowUpRight, Compass, RefreshCw, TrendingUp, Sparkles } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { PageLayout } from '@/components/PageLayout'
import { PageTitle, EmptyText, EmptyTitle, SectionTitle, GroupLabel } from '@/components/PageHeading'
import { CoverPlaceholder } from '@/components/common/CoverPlaceholder'
import { cn } from '@/lib/utils'
import { NAV_LABEL_KEYS, LIBRARY_ROUTE, ROUTE_BUILDERS, ROUTES } from '@/lib/routes'
import { useMusicHallStore, hallUnavailableReason } from '@/stores/musicHallStore'
import { useT, useLocale } from '@/i18n'
import { formatNumber, type Locale } from '@aurora/shared'
import type { RecommendPlaylist, ToplistBrief, ToplistPreviewSong } from '@/types'

/**
 * 音乐库：推荐歌单 + 排行榜（由音源服务实时提供，只读浏览、即点即播、不入库）。
 *
 * 数据来自用户配置的音源服务（协议见 @aurora/shared 的 musicHall.ts）。
 * 应用不内置任何平台抓取器——未配音源时整页是引导空态，而不是内置的假数据。
 * 不过这个空态现在基本看不到：无可用音源时入口被隐藏、App 层还会把停在本页的用户
 * 重定向回主屏（见 App.tsx 的重定向 effect）。空态保留为自保：重定向在 effect 里跑，
 * 首帧仍会渲染本页，且「入口看不见就删掉兜底」会让这一页在异常数据下变成白屏。
 *
 * 视觉遵循 DS：长列表卡片用 `.card-solid`（无 blur，避免滚动时逐帧重采样），
 * 一屏只有一个强调色（mint，仅用于选中/焦点），hover 只改背景与描边、不做位移。
 *
 * 文案全部走字典：页面名取 `nav.item.hall`（英文 Discover，选词理由见 lib/routes.ts），
 * 「去我的音乐」这类带页面名的句子用占位符注入名字，不在字典里复制第二份名字。
 */
export function MusicHallPage() {
  const navigate = useNavigate()
  const t = useT()
  const recommend = useMusicHallStore((s) => s.recommend)
  const toplists = useMusicHallStore((s) => s.toplists)
  const loadRecommend = useMusicHallStore((s) => s.loadRecommend)
  const loadToplists = useMusicHallStore((s) => s.loadToplists)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    void loadRecommend()
    void loadToplists()
  }, [loadRecommend, loadToplists])

  // 传 t 而不是让它读 store 快照：组件要订阅语言变化，切语言后台词立刻跟着变
  const unavailable = hallUnavailableReason(t)

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
            <PageTitle>{t(NAV_LABEL_KEYS.hall)}</PageTitle>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 pb-1 page-toolbar">
            <button
              type="button"
              className="btn-icon"
              title={t('common.action.refresh')}
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
          title={t('hall.empty.title', { hall: t(NAV_LABEL_KEYS.hall) })}
          desc={unavailable}
          action={{ label: t('hall.empty.configureSource'), onClick: () => navigate(ROUTES.settings) }}
          // 本页是应用首屏：空态必须给出「不配也能用」的出路，否则冷启动像坏掉
          secondaryAction={{
            label: t('hall.empty.goLibrary', { library: t(NAV_LABEL_KEYS.library) }),
            onClick: () => navigate(LIBRARY_ROUTE),
          }}
        />
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
          {/* ── 推荐歌单 ── */}
          <Section
            icon={<Sparkles className="h-4 w-4 text-mint-text" strokeWidth={1.6} />}
            title={t('hall.recommend.title')}
          >
            {/* 有缓存就先渲染缓存：后台刷新失败只会在没数据时才升级成错误态，
                否则一次网络抖动会把整块已经能看的内容换成一条报错（见 store 的落盘口径） */}
            {recommend.data.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {recommend.data.map((pl) => (
                  <PlaylistCard
                    key={pl.id}
                    playlist={pl}
                    onOpen={() => navigate(ROUTE_BUILDERS.hallPlaylist(pl.id))}
                  />
                ))}
              </div>
            ) : recommend.loading ? (
              <SkeletonRow />
            ) : recommend.error ? (
              <InlineError message={recommend.error} onRetry={() => void loadRecommend(true)} />
            ) : (
              <p className="font-text text-[13px] text-white/50 py-3">{t('hall.recommend.empty')}</p>
            )}
          </Section>

          {/* ── 排行榜 ── */}
          <Section
            icon={<TrendingUp className="h-4 w-4 text-mint-text" strokeWidth={1.6} />}
            title={t('hall.toplist.title')}
            className="mt-10"
          >
            {/* 与推荐歌单同一口径：数据优先，错误只填空白 */}
            {toplists.data.length > 0 ? (
              <div className="flex flex-col gap-8">
                {toplists.data.map((group) => (
                  <div key={`${group.groupId ?? group.groupName}`}>
                    <GroupLabel className="block mb-3">
                      {/* 组名由音源服务提供；上游缺名时数据层给空串（不再烧「榜单」这类展示名），这里补字典兜底 */}
                      {group.groupName || t('hall.toplist.fallbackName')}
                    </GroupLabel>
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
            ) : toplists.loading ? (
              <SkeletonRow />
            ) : toplists.error ? (
              <InlineError message={toplists.error} onRetry={() => void loadToplists(true)} />
            ) : (
              <p className="font-text text-[13px] text-white/50 py-3">{t('hall.toplist.empty')}</p>
            )}
          </Section>
        </div>
      )}
    </PageLayout>
  )
}

function Section({
  icon,
  title,
  className,
  children,
}: {
  icon: React.ReactNode
  title: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={className}>
      <div className="flex items-center gap-2.5 mb-4">
        {icon}
        <SectionTitle>{title}</SectionTitle>
      </div>
      {children}
    </section>
  )
}

/** 推荐歌单卡片：封面 + 名称 + 播放量 */
function PlaylistCard({ playlist, onOpen }: { playlist: RecommendPlaylist; onOpen: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [failed, setFailed] = useState(false)
  const cover = playlist.coverUrl
  useEffect(() => setFailed(false), [cover])

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group playlist-card card-solid card-tappable rounded-ds-panel p-3 text-left hover:bg-white/[0.06] border border-white/[0.06]"
    >
      <div className="relative aspect-square rounded-ds-media overflow-hidden bg-white/[0.05] mb-3">
        {cover && !failed ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            className="media-card-image w-full h-full object-cover"
          />
        ) : (
          // 上游歌单封面缺失时走统一占位（名称首字 + 稳定配色）：一屏几十张卡片
          // 共用同一个音符图标会被读成「整页加载失败」，见 AGENTS.md 的占位约定
          <CoverPlaceholder title={playlist.name} artist={playlist.creatorName} />
        )}
        <span className="card-affordance absolute right-2.5 top-2.5" aria-hidden="true">
          <ArrowUpRight className="h-4 w-4" strokeWidth={1.7} />
        </span>
      </div>
      <p className="font-text text-[14px] font-medium text-white/90 leading-snug line-clamp-2 tracking-[-0.2px]">
        {playlist.name}
      </p>
      <p className="font-text text-[12px] text-white/65 mt-1 truncate tracking-[-0.12px]">
        {playlist.listenNum
          ? // count 只用于选复数形态，plays 是已按语言压缩的显示值（万 / 亿 与 K / M 不同形）
            t('hall.recommend.plays', {
              count: playlist.listenNum,
              plays: compactCount(playlist.listenNum, locale),
            })
          : playlist.creatorName || t('hall.recommend.title')}
      </p>
    </button>
  )
}

/** 榜单卡片：榜单名 + 前几首预览（带排名序号） */
function ToplistCard({ board, onOpen }: { board: ToplistBrief; onOpen: () => void }) {
  const t = useT()
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group card-solid card-tappable rounded-ds-panel p-4 text-left hover:bg-white/[0.08] border border-white/[0.06]"
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <p className="font-text text-[14px] font-medium text-white/90 tracking-[-0.2px] truncate">
          {board.name}
        </p>
        {board.updateTime && (
          <span className="font-text text-[12px] text-white/50 flex-shrink-0 tabular-nums">
            {board.updateTime}
          </span>
        )}
      </div>
      {board.songs.length === 0 ? (
        <p className="font-text text-[12px] text-white/50 py-1">{t('hall.toplist.viewFull')}</p>
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
          'font-text text-[12px] tabular-nums w-4 flex-shrink-0',
          highlight ? 'text-mint-text font-semibold' : 'text-white/50'
        )}
      >
        {song.rank || index + 1}
      </span>
      {/* 榜内预览的前三首是**卡片正文**：字号比卡片标题小一档、比注脚大一档（13px），
          否则一屏 30 张榜单卡里的 90 行歌名会全部退化成 11~12px 的细灰线，
          读起来像「加载中的占位」而不是歌名。 */}
      <span className="font-text text-[13px] text-white/85 truncate flex-1 tracking-[-0.15px]">
        {song.title}
      </span>
      <span className="font-text text-[12px] text-white/65 truncate max-w-[40%] tracking-[-0.12px]">
        {song.artist}
      </span>
    </li>
  )
}

/**
 * 播放量：走 Intl 的 compact 记数法（中文「万 / 亿」、英文 K / M / B），避免长数字撑破卡片。
 *
 * 不手写单位表：换算基数本来就随语言不同（中文四位一进、英文三位一进），
 * Intl 各语言的 compact 形态就是这件事的真源；手写等于在界面层再放一份语言数据，
 * 而且字面量中文还会被 i18n 扫描判成「未国际化的界面文案」。
 */
function compactCount(n: number, locale: Locale): string {
  return formatNumber(n, locale, { notation: 'compact', maximumFractionDigits: 1 })
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
  const t = useT()
  return (
    <div className="inset-note flex items-center justify-between gap-3 px-4 py-3">
      <span className="font-text text-[12px] text-white/65 truncate">{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="font-text text-[12px] text-mint-text hover:text-mint-text/80 flex-shrink-0 transition-colors"
      >
        {t('common.action.retry')}
      </button>
    </div>
  )
}

/** 空态：未配音源 / 环境不支持时的统一引导 */
export function HallEmpty({
  title,
  desc,
  action,
  secondaryAction,
}: {
  title: string
  desc: string
  action?: { label: string; onClick: () => void }
  /** 次要出路：本页是应用首屏，空态不能只留一条路（本地内容始终可用） */
  secondaryAction?: { label: string; onClick: () => void }
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center">
      <div className="relative mb-6">
        <div className="absolute -inset-16 bg-gradient-to-b from-mint/[0.06] to-transparent rounded-full blur-3xl" />
        <div className="card-solid relative w-[120px] h-[120px] rounded-ds-card flex items-center justify-center">
          <Compass className="h-[52px] w-[52px] text-mint-text/70" strokeWidth={1} />
        </div>
      </div>
      <EmptyTitle>{title}</EmptyTitle>
      <EmptyText className="text-center max-w-md px-6 leading-relaxed">{desc}</EmptyText>
      {(action || secondaryAction) && (
        <div className="flex items-center gap-3">
          {action && (
            <button onClick={action.onClick} className="pill pill-lg pill-mint">
              {action.label}
            </button>
          )}
          {secondaryAction && (
            <button onClick={secondaryAction.onClick} className="pill pill-lg pill-soft">
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
