import { memo, useCallback, useEffect, useState, type CSSProperties, type RefObject } from 'react'
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
import { CoverImage } from '@/components/common/CoverImage'
import { PlaylistSubmenuItems } from '@/components/VirtualTrackTable'
import { DuplicateBadge } from '@/components/common/DuplicateInfo'
import type { DuplicateGroup } from '@aurora/shared'
import type { Track } from '@/types'

/**
 * 虚拟化歌曲卡片网格（专辑/艺术家分组网格同构复用）。
 * 只渲染可视区域内的行，数千首歌曲的网格视图不再一次性创建全部卡片。
 *
 * 行高按当前列宽估算（卡片 ≈ 正方形封面 + 两行文字），
 * 列数按滚动容器宽度匹配 Tailwind 断点：2 / sm:3 / md:4 / lg:5。
 * 注意：列数必须由容器宽度决定（而非视口断点 class）——右侧 Now Playing 面板
 * 展开时容器比视口窄，若行用视口断点列数会与切片/行高估算的列数不一致，
 * 卡片被 grid 行高拉伸出现大片空白。
 */

function getColumnCount(width: number): number {
  if (width >= 1024) return 5
  if (width >= 768) return 4
  if (width >= 640) return 3
  return 2
}

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
            className="aspect-square rounded-[8px] bg-white/[0.04] mb-2.5 flex items-center justify-center overflow-hidden relative cursor-pointer transition-transform duration-200 ease-apple group-hover:scale-[1.02]"
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
                'absolute top-2 right-2 h-7 w-7 flex items-center justify-center rounded-full transition-opacity duration-200 ease-apple bg-black/40 hover:scale-105',
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

/** 卡片行高估算：正方形封面（列宽 - 20px 内边距）+ 间距与两行文字 + 卡片内边距 */
const CARD_EXTRA_HEIGHT = 52

export const VirtualCardGrid = memo(function VirtualCardGrid({
  tracks,
  scrollRef,
  onPlayRow,
  onCreatePlaylist,
  duplicateMap,
}: {
  tracks: Track[]
  scrollRef: RefObject<HTMLDivElement>
  onPlayRow: (index: number) => void
  onCreatePlaylist: (trackId: string) => void
  /** 胜出副本 id → 重复组：卡片「重复」徽标的数据来源 */
  duplicateMap?: ReadonlyMap<string, DuplicateGroup<Track>>
}) {
  const likedTracks = useLibraryStore((s) => s.likedTracks)
  const [containerWidth, setContainerWidth] = useState(() => scrollRef.current?.clientWidth ?? 800)

  // 容器宽度变化（窗口缩放 / 侧栏显隐）时更新列数与行高估算
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setContainerWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollRef])

  const colCount = getColumnCount(containerWidth)
  const colWidth = Math.max(80, (containerWidth - 16 * (colCount - 1)) / colCount)
  const rowHeight = colWidth + CARD_EXTRA_HEIGHT

  const rowCount = Math.ceil(tracks.length / colCount)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: useCallback(() => rowHeight, [rowHeight]),
    overscan: 6,
  })

  useEffect(() => {
    virtualizer.measure()
  }, [virtualizer, rowHeight, colCount])

  return (
    <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((vi) => {
        const start = vi.index * colCount
        const rowTracks = tracks.slice(start, start + colCount)
        return (
          <div
            key={vi.key}
            className="absolute left-0 w-full grid gap-4"
            style={{
              height: vi.size,
              transform: `translateY(${vi.start}px)`,
              // 与 getColumnCount(containerWidth) 同一列数，保证卡片宽度与行高估算一致
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
