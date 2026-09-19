import { memo, useCallback, useEffect, useState, type CSSProperties, type RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Heart, Play, Plus, ListPlus, ListEnd, Disc3, Cloud } from 'lucide-react'
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
import { isDesktop, formatTime, cn } from '@/lib/utils'
import { CoverImage } from '@/components/common/CoverImage'
import { DuplicateBadge } from '@/components/common/DuplicateInfo'
import type { DuplicateGroup } from '@aurora/shared'
import type { Track } from '@/types'

/**
 * 虚拟化歌曲表格。
 *
 * 背景：音乐库原先一次性渲染全部歌曲行（数千首 = 数千个 ContextMenu + CoverImage），
 * 进入歌曲详情页再返回时整表重建，是"返回列表很卡"的主因。
 * 这里改用 @tanstack/react-virtual 只渲染可视区域内的行。
 *
 * 滚动容器由调用方持有（scrollRef）：页面被隐藏/重新显示时调用方可以
 * 记录并恢复滚动位置，虚拟列表会自动跟随容器当前的 scrollTop 渲染。
 */

/** 行高（含 1px 分隔线）：桌面 36 封面 + 上下各 10；移动 44 封面 + 上下各 8 */
const ROW_HEIGHT_DESKTOP = 56
const ROW_HEIGHT_MOBILE = 60

/** 行与表头共用的列模板：标题(弹性) / 艺术家 10rem / 专辑 12rem / 收藏 2.5rem / 时长 */
const GRID_TEMPLATE =
  'grid-cols-[minmax(0,1fr)_2.5rem_3rem] md:grid-cols-[minmax(0,1fr)_10rem_12rem_2.5rem_4rem]'

function useIsDesktopWidth() {
  const [isMd, setIsMd] = useState(() => window.matchMedia('(min-width: 768px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const onChange = (e: MediaQueryListEvent) => setIsMd(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return isMd
}

/**
 * 「添加到播放列表」子菜单内容。
 * 单独抽成组件订阅 playlistStore：播放列表增删只重渲染这个小组件，
 * 不会牵连整张歌曲表（数千行时一次全表重渲染就是几百毫秒的卡顿）。
 */
export const PlaylistSubmenuItems = memo(function PlaylistSubmenuItems({
  trackId,
  onCreatePlaylist,
}: {
  trackId: string
  onCreatePlaylist: (trackId: string) => void
}) {
  const playlists = usePlaylistStore((s) => s.playlists)

  if (playlists.length === 0) {
    return (
      <ContextMenuItem onClick={() => onCreatePlaylist(trackId)}>
        <Plus className="h-4 w-4 mr-2" strokeWidth={1.5} />
        新建播放列表...
      </ContextMenuItem>
    )
  }

  return (
    <>
      {playlists.map((pl) => (
        <ContextMenuItem
          key={pl.id}
          onClick={() => usePlaylistStore.getState().addTracksToPlaylist(pl.id, [trackId])}
        >
          <ListPlus className="h-4 w-4 mr-2 opacity-50" strokeWidth={1.5} />
          {pl.name}
        </ContextMenuItem>
      ))}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onCreatePlaylist(trackId)}>
        <Plus className="h-4 w-4 mr-2" strokeWidth={1.5} />
        新建播放列表...
      </ContextMenuItem>
    </>
  )
})

/**
 * 歌曲行。网格布局替代原 <tr>，行高固定以便虚拟定位。
 * 传 style 时作为虚拟化行（绝对定位）使用；不传则按普通文档流渲染
 * （分组详情等歌曲量小的列表直接平铺即可，无需虚拟化）。
 * ⚠️ 必须定义在页面组件之外，否则每次父级 render 都会生成新组件类型导致整表卸载重建。
 */
export const VirtualTrackRow = memo(function VirtualTrackRow({
  track,
  idx,
  liked,
  onPlay,
  onCreatePlaylist,
  style,
  duplicateGroup,
}: {
  track: Track
  idx: number
  liked: boolean
  onPlay: (idx: number) => void
  onCreatePlaylist: (trackId: string) => void
  style?: CSSProperties
  /** 该副本另有被隐藏的重复副本时传入，行内展示「重复」徽标 */
  duplicateGroup?: DuplicateGroup<Track>
}) {
  const navigate = useNavigate()
  // 网络存储曲目的来源名：用来在列表里区分「本机」与 NAS 曲目。
  // 注：虚拟化下同时挂载的行只有二三十行，且该 selector 返回稳定引用
  // （库内数组不重建就不触发重渲染），逐行订阅的代价可以忽略
  const librarySources = useLibraryStore((s) => s.librarySources)
  const sourceName = track.sourceId
    ? librarySources.find((s) => s.id === track.sourceId)?.name || '网络存储'
    : undefined

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          style={style}
          className={cn(
            'group grid items-center h-[60px] md:h-[56px] cursor-pointer border-b border-white/[0.05] row-hover',
            GRID_TEMPLATE,
          )}
          // 移动端无 hover/double-click 概念，改用单击触发播放；
          // 桌面端保留双击（避免误触，且单击只是 hover 显示播放图标）
          onClick={isDesktop() ? undefined : () => onPlay(idx)}
          onDoubleClick={isDesktop() ? () => onPlay(idx) : undefined}
        >
          <div className="flex items-center gap-3 min-w-0 px-1.5 md:px-3 h-full">
            <button
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
              className="w-11 h-11 md:w-9 md:h-9 rounded-[10px] bg-white/[0.04] flex items-center justify-center overflow-hidden flex-shrink-0 transition-transform duration-200 ease-apple hover:scale-105"
            >
              <CoverImage
                track={track}
                className="w-full h-full object-cover product-shadow"
                fallback={<Disc3 className="h-4 w-4 text-white/30" strokeWidth={1.5} />}
              />
            </button>
            <div className="min-w-0">
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="font-text font-semibold text-[14px] truncate text-white tracking-[-0.224px]">
                  {track.title}
                </span>
                {duplicateGroup && <DuplicateBadge group={duplicateGroup} />}
                {sourceName && (
                  <span
                    title={`来自网络存储「${sourceName}」`}
                    className="flex-shrink-0 inline-flex items-center gap-1 rounded-full bg-mint/[0.08] border border-mint/20 px-1.5 py-[1px] font-text text-[10px] text-mint/85 tracking-[-0.1px]"
                  >
                    <Cloud className="h-2.5 w-2.5" strokeWidth={1.8} />
                    {/* 窄列放不下来源名，只留图标；宽屏才展开文字 */}
                    <span className="hidden lg:inline max-w-[88px] truncate">{sourceName}</span>
                  </span>
                )}
              </span>
              {/* 移动端隐藏艺术家列，改为标题下方第二行展示 */}
              <span className="block md:hidden font-text text-[12px] text-white/40 truncate mt-0.5 tracking-[-0.12px]">
                {track.artist}
              </span>
            </div>
          </div>
          <div className="hidden md:block px-3 font-text text-white/50 text-[14px] truncate tracking-[-0.224px]">
            {track.artist}
          </div>
          <div className="hidden md:block px-3 font-text text-white/45 text-[14px] truncate tracking-[-0.224px]">
            {track.album}
          </div>
          <div className="flex items-center justify-center">
            <button
              onClick={(e) => {
                e.stopPropagation()
                useLibraryStore.getState().toggleLike(track.id)
              }}
              // 移动端无 hover，收藏按钮常显；桌面端保持 hover 显示
              className="btn-icon opacity-100 md:opacity-0 md:group-hover:opacity-100"
            >
              <Heart
                className={cn('h-4 w-4 md:h-3.5 md:w-3.5', liked ? 'text-coral fill-coral' : 'text-white/40')}
                strokeWidth={1.5}
              />
            </button>
          </div>
          <div className="px-1.5 md:px-3 text-right font-text text-white/45 text-[12px] md:text-[13px] tabular-nums tracking-[-0.12px]">
            {formatTime(track.duration)}
          </div>
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

export const VirtualTrackTable = memo(function VirtualTrackTable({
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
  /** 胜出副本 id → 重复组：行内「重复」徽标的数据来源 */
  duplicateMap?: ReadonlyMap<string, DuplicateGroup<Track>>
}) {
  const likedTracks = useLibraryStore((s) => s.likedTracks)
  const isMd = useIsDesktopWidth()
  const rowHeight = isMd ? ROW_HEIGHT_DESKTOP : ROW_HEIGHT_MOBILE

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: useCallback(() => rowHeight, [rowHeight]),
    overscan: 10,
  })

  // 行高随视口宽度（桌面/移动）变化时强制重算布局
  useEffect(() => {
    virtualizer.measure()
  }, [virtualizer, rowHeight])

  return (
    <>
      {/* 表头：移动端隐藏（列表语义已由双行布局表达） */}
      <div className={cn('hidden md:grid items-center border-b border-white/[0.08]', GRID_TEMPLATE)}>
        <div className="text-left py-2 px-3 font-semibold text-white/45 text-[12px] tracking-[-0.12px]">标题</div>
        <div className="text-left py-2 px-3 font-semibold text-white/45 text-[12px] tracking-[-0.12px]">艺术家</div>
        <div className="text-left py-2 px-3 font-semibold text-white/45 text-[12px] tracking-[-0.12px]">专辑</div>
        <div />
        <div className="text-right py-2 px-3 font-semibold text-white/45 text-[12px] tracking-[-0.12px]">时长</div>
      </div>
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const track = tracks[vi.index]
          return (
            <VirtualTrackRow
              key={track.id}
              track={track}
              idx={vi.index}
              liked={likedTracks.has(track.id)}
              onPlay={onPlayRow}
              onCreatePlaylist={onCreatePlaylist}
              duplicateGroup={duplicateMap?.get(track.id)}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: vi.size,
                transform: `translateY(${vi.start}px)`,
              }}
            />
          )
        })}
      </div>
    </>
  )
})
