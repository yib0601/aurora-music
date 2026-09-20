import { memo, useCallback, useEffect, type CSSProperties, type RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Heart, Play, Plus, ListPlus, ListEnd, Music as MusicIcon } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { useLibraryStore } from '@/stores/libraryStore'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { isDesktop, cn } from '@/lib/utils'
import {
  GRID_GAP,
  getCardHeight,
  getGridColumnCount,
  getVirtualRowHeight,
} from '@/lib/gridLayout'
import { CoverImage } from '@/components/common/CoverImage'
import { PlaylistSubmenuItems } from '@/components/VirtualTrackTable'
import { DuplicateBadge } from '@/components/common/DuplicateInfo'
import type { DuplicateGroup } from '@aurora/shared'
import type { Track } from '@/types'

/**
 * 虚拟化歌曲卡片网格（专辑/艺术家分组网格同构复用）。
 * 只渲染可视区域内的行，数千首歌曲的网格视图不再一次性创建全部卡片。
 *
 * 几何全部取自 `@/lib/gridLayout`（唯一来源），本文件不再自持任何尺寸常量：
 *   - 列数 / 列宽：按**滚动容器宽度**计算（而非视口断点 class）——右侧 Now Playing
 *     面板展开时容器比视口窄，用视口断点会与切片/行高估算的列数不一致。
 *   - 行高：`getVirtualRowHeight(...)`（**绝对定位行**语义，见下）。
 *   - 列间距：行容器的 `gap`（对 grid 子元素生效）。
 *
 * ⚠️ 本网格的行是 `absolute` + `translateY` 定位的，**CSS `gap` 的 row-gap 对绝对
 *    定位子元素不生效**（实测 computed gap 16px 而实际垂直间距为 0）。因此：
 *      - 行间距只能由 virtualizer 的 `vi.start` 步进承担，步进值 = `getVirtualRowHeight`
 *        （= 卡片高 + GRID_GAP），它同时决定了下一行的 translateY 偏移；
 *      - 行盒高度必须**等于卡片自然高度** `getCardHeight(...)`，绝不能写成 `vi.size`：
 *        `vi.size` 含 16px 行间距，用它当行盒高度会把卡片拉伸 16px
 *        （实测 bug 态 cardH 266 vs 自然高 262.61）。
 *    `gap` 的 column-gap 仍然有效（卡片是行容器的 grid item，处于正常流），
 *    所以水平间距照常由 `column-gap` 产生。
 */

/**
 * 歌曲卡片（列表网格视图单卡）。
 * 从原 LibraryPage 内联实现抽出，供虚拟网格复用。
 */
export const TrackCard = memo(function TrackCard({
  track,
  idx,
  liked,
  onPlay,
  onCreatePlaylist,
  duplicateGroup,
}: {
  track: Track
  idx: number
  liked: boolean
  onPlay: (idx: number) => void
  onCreatePlaylist: (trackId: string) => void
  /** 该副本另有被隐藏的重复副本时传入，卡片展示「重复」徽标 */
  duplicateGroup?: DuplicateGroup<Track>
}) {
  const navigate = useNavigate()

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="group card-utility p-2.5 cursor-pointer"
          // 移动端单击卡片即播放；桌面端保留双击，封面单击仍进详情
          onClick={isDesktop() ? undefined : () => onPlay(idx)}
          onDoubleClick={() => onPlay(idx)}
        >
          <div
            onClick={(e) => {
              e.stopPropagation()
              // 桌面端保留单击进详情；移动端与点击播放条一致：播放并打开全屏 Now Playing 浮层（不推进路由）
              if (isDesktop()) navigate(`/song/${track.id}`)
              else {
                onPlay(idx)
                usePlaylistStore.getState().setMobileNowPlaying(true)
              }
            }}
            title="查看歌曲详情"
            className="aspect-square rounded-[10px] bg-white/[0.04] mb-2.5 flex items-center justify-center overflow-hidden relative cursor-pointer transition-transform duration-200 ease-apple group-hover:scale-[1.02]"
          >
            <CoverImage
              track={track}
              alt={track.title}
              className="w-full h-full object-cover product-shadow"
              fallback={<MusicIcon className="h-8 w-8 text-white/20" strokeWidth={1.5} />}
            />
            <button
              onClick={(e) => {
                e.stopPropagation()
                useLibraryStore.getState().toggleLike(track.id)
              }}
              // 移动端无 hover：已收藏的红心常显，未收藏的保持隐藏避免遮挡封面
              className={cn(
                'absolute top-2 right-2 h-7 w-7 flex items-center justify-center rounded-full transition-opacity duration-200 ease-apple bg-black/35 hover:scale-105',
                liked ? 'opacity-100 md:opacity-0 md:group-hover:opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
            >
              <Heart
                className={cn('h-3.5 w-3.5', liked ? 'text-coral fill-coral' : 'text-white')}
                strokeWidth={1.5}
              />
            </button>
          </div>
          <p className="flex items-center gap-1.5 min-w-0 font-text text-[14px] font-semibold text-white tracking-[-0.224px]">
            <span className="truncate">{track.title}</span>
            {duplicateGroup && <DuplicateBadge group={duplicateGroup} />}
          </p>
          <p className="font-text text-[12px] text-white/50 truncate mt-0.5 tracking-[-0.12px]">
            {track.artist}
          </p>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={() => onPlay(idx)}>
          <Play className="h-4 w-4 mr-2" strokeWidth={1.5} />
          立即播放
        </ContextMenuItem>
        <ContextMenuItem onClick={() => usePlayerStore.getState().addToPlayNext(track)}>
          <ListEnd className="h-4 w-4 mr-2" strokeWidth={1.5} />
          下一首播放
        </ContextMenuItem>
        <ContextMenuItem onClick={() => usePlayerStore.getState().addToQueue(track)}>
          <Plus className="h-4 w-4 mr-2" strokeWidth={1.5} />
          添加到队列
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <ListPlus className="h-4 w-4 mr-2" strokeWidth={1.5} />
            添加到播放列表
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48">
            <PlaylistSubmenuItems trackId={track.id} onCreatePlaylist={onCreatePlaylist} />
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => useLibraryStore.getState().toggleLike(track.id)}>
          <Heart className={cn('h-4 w-4 mr-2', liked && 'fill-coral text-coral')} strokeWidth={1.5} />
          {liked ? '取消收藏' : '收藏'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

export const VirtualCardGrid = memo(function VirtualCardGrid({
  tracks,
  scrollRef,
  containerWidth,
  onPlayRow,
  onCreatePlaylist,
  duplicateMap,
}: {
  tracks: Track[]
  scrollRef: RefObject<HTMLDivElement>
  /**
   * 滚动容器的 content-box 宽度（px），由调用方（LibraryPage）用 ResizeObserver 测量。
   *
   * ⚠️ 必须由父组件传入，**不要**在本组件内自己测：滚动容器是本组件的**父节点**，
   *    本组件挂载那一刻 `scrollRef.current` 仍为 null（同一 commit 内父节点 ref 尚未
   *    赋值），effect 里 `if (!el) return` 会直接早退；而 deps 里的 ref 对象引用稳定、
   *    effect 永不重跑 ⇒ observer 永不建立 ⇒ 宽度永久停在兜底常量，几何整体错位
   *    （实测表现为行盒高按 800 算、卡片被拉伸并与下一行重叠）。
   *    由父组件测量还带来第二个好处：歌曲网格与专辑/艺术家网格共用**同一套**测量逻辑，
   *    宽度只有一个来源，「三视图同源」更彻底。
   */
  containerWidth: number
  onPlayRow: (index: number) => void
  onCreatePlaylist: (trackId: string) => void
  /** 胜出副本 id → 重复组：卡片「重复」徽标的数据来源 */
  duplicateMap?: ReadonlyMap<string, DuplicateGroup<Track>>
}) {
  const likedTracks = useLibraryStore((s) => s.likedTracks)

  // 几何全部来自共享模块，保证与专辑/艺术家网格同源
  const colCount = getGridColumnCount(containerWidth)
  /** 行盒高度 = 卡片自然高度（不含行间距），避免卡片被拉伸 */
  const rowHeight = getCardHeight(containerWidth, colCount)
  /** virtualizer 步进 = 卡片高 + GRID_GAP（含行间距，由 translateY 承担） */
  const virtualRowHeight = getVirtualRowHeight(containerWidth, colCount)

  const rowCount = Math.ceil(tracks.length / colCount)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    // 步进必须等于含间距的总占位，否则相邻行重叠/空洞；行盒高度另用 rowHeight
    estimateSize: useCallback(() => virtualRowHeight, [virtualRowHeight]),
    overscan: 6,
  })

  useEffect(() => {
    virtualizer.measure()
  }, [virtualizer, virtualRowHeight, rowHeight, colCount])

  // ⚠️ 宽度未知（首帧，父组件的 observer 尚未回调）时**不渲染卡片**：用兜底常量算几何
  //    会得到看似合理但整体错位的结果（列数/列宽/行高全错、卡片被拉伸、相邻行重叠），
  //    比闪一帧空白糟糕得多。这里必须放在所有 Hook 之后，避免违反 Hooks 调用顺序。
  if (containerWidth <= 0) return null

  return (
    <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((vi) => {
        const start = vi.index * colCount
        const rowTracks = tracks.slice(start, start + colCount)
        return (
          <div
            key={vi.key}
            // gap 提供列间距（column-gap 对 grid item 有效）；row-gap 对绝对定位行无效，
            // 行间距已由 vi.start 步进（virtualRowHeight）承担
            className="absolute left-0 w-full grid"
            style={{
              // 行盒高度 = 卡片自然高度，不用 vi.size（后者含 GRID_GAP，会拉伸卡片）
              height: rowHeight,
              gap: GRID_GAP,
              transform: `translateY(${vi.start}px)`,
              // 与 getGridColumnCount(containerWidth) 同一列数，保证卡片宽度与行高估算一致
              gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))`,
            }}
          >
            {rowTracks.map((track, i) => (
              <TrackCard
                key={track.id}
                track={track}
                idx={start + i}
                liked={likedTracks.has(track.id)}
                onPlay={onPlayRow}
                onCreatePlaylist={onCreatePlaylist}
                duplicateGroup={duplicateMap?.get(track.id)}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
})
