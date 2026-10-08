import React, { useState } from 'react'
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Volume2, VolumeX, Music2, ListMusic, Loader2 } from 'lucide-react'
import { cn, formatTime } from '@/lib/utils'
import { useT } from '@/i18n'
import { useOpenSongDetail } from '@/lib/navigation'
import type { RepeatMode, ShuffleMode, Track } from '@/types'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { CoverImage } from '@/components/common/CoverImage'
import { useContainerWidth } from '@/hooks/useContainerWidth'

interface PlayerBarProps {
  currentTrack?: Track | null
  volume: number
  muted: boolean
  repeatMode: RepeatMode
  shuffleMode: ShuffleMode
  onTogglePlay: () => void
  onNext: () => void
  onPrevious: () => void
  onSeek: (seconds: number) => void
  onVolumeChange: (v: number) => void
  onToggleMute: () => void
  onCyclePlayMode: () => void
  onOpenNowPlaying?: () => void
}

/**
 * 紧凑档阈值（播放条自身可用宽度，px）。
 * 三列网格的需求是刚性的：左右两列各要 ~190px 才不让歌名与音量条缩到不可用，
 * 中间传输控制再占 ~190px，加上容器 48px 横向内边距，600px 才谈得上舒展；
 * 560px 是「仍按三列排版而不互相挤压」的下限。
 *
 * 判据刻意取容器宽度，不取平台、也不取视口宽度：
 * - 同一份 UI 会落在手机、平板分屏、折叠屏展开、桌面窄窗口上，平台名
 *   （isMobile）与可用宽度没有稳定对应关系；
 * - 视口宽度也不等价——桌面播放条被 clamp 到 640px，视口 1440px 时它同样只有
 *   640px，媒体查询会按 1440px 判成「宽敞」。
 * 峰值实测：手机 390px 视口 → 播放条 358px（紧凑档）；桌面 1200px 窗口 →
 * 播放条 640px（完整档）。
 */
const COMPACT_MAX_WIDTH = 560

/**
 * PlayerBar（DS 皮肤）
 * - 底部悬浮面板沿用项目既有玻璃类 glass-saved-panel（内部是纯透明 blur，不启用 SVG 位移滤镜），
 *   它已登记在 globals.css 的 .glass-perf-lite / .resizing 降级名单中：
 *   详情页折叠动画与窗口拖拽缩放期间 blur 会被强制关闭，不会逐帧重算模糊。
 *   ⚠️ 不要新增未登记的自定义玻璃类——换掉类名的同时也就脱离了降级管辖。
 * - 发丝描边 + DS 的 16/24px 圆角阶梯，去掉多层大投影
 * - 完整档圆角 `rounded-[24px]`（DS 卡片档），**必须在使用处显式写**：
 *   `.glass-saved-panel` 类内自带 `--saved-panel-glass-radius: 100px`，
 *   漏写就会退化成两端半圆的胶囊。水平内边距 24px（大屏 32px）与圆角同量级，
 *   内容不会贴到弧线区
 * - 主播放按钮为圆形实心 mint 块（DS 的 pill 语义 + 项目品牌色）
 * - 普通控制按钮使用 btn-icon（28×28，8px 圆角）
 *
 * ⚠️ 性能：isPlaying / progress / duration 在各自档位的组件内订阅，
 * 避免向上冒泡到 AppLayout 触发整树重渲染；外壳只做一次宽度测量，
 * 不订阅任何播放状态。
 */
export function PlayerBar(props: PlayerBarProps) {
  // 外壳宽度 = 定位容器宽度（移动端 `100%-32px`、桌面 clamp 到 640px），
  // 与视口宽度不成正比，必须实测。测量用 useLayoutEffect 同步落值，
  // 首帧即定格在正确档位，不会先画完整档再翻紧凑档
  const { ref, width } = useContainerWidth<HTMLDivElement>()

  return (
    <div ref={ref} className="w-full">
      {/* width 为 null = 尚未测量（首帧）。此帧给完整档：它是功能超集，
          且内部各有 flex-wrap 兜底，极窄下只会换行不会溢出 */}
      {width !== null && width < COMPACT_MAX_WIDTH ? (
        <CompactBar {...props} />
      ) : (
        <FullBar {...props} />
      )}
    </div>
  )
}

/**
 * 紧凑档（可用宽度 < COMPACT_MAX_WIDTH）
 *
 * 单行结构：封面 / 标题 / 播放 / 下一首 / 队列，触控目标 ≥ 44×44，
 * 整条点击进全屏播放详情页。取舍：
 * 1. 传输控制只留「播放暂停 + 下一曲」：这一档的宽度放不下 shuffle / 上一首 /
 *    音量滑块而不牺牲曲目信息，回退语义（回到开头 / 上一首）交给全屏详情页；
 *    音量交给系统音量键。注意这是**宽度取舍**而非终端取舍——桌面窗口窄到
 *    这一档时同样收起，手机横屏放到足够宽时同样展开。
 * 2. 播放键 46px、其余 44px；曲目信息吃掉省下的宽度。
 * 3. 进度线左右各内缩 16px：原来 inset-x-0 让线头切在 16px 圆角弧线上，
 *    看起来像卡片边缘崩了一角。
 * 4. 空态下两个传输按钮统一切到 35% 透明；队列按钮不跟着禁用——
 *    队列浮层在空态下也要能打开（那里有「队列为空」的引导）。
 */
function CompactBar({
  currentTrack,
  onTogglePlay,
  onNext,
  onOpenNowPlaying,
}: PlayerBarProps) {
  const t = useT()
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const progress = usePlayerStore((s) => s.progress)
  const duration = usePlayerStore((s) => s.duration)
  // 取址中（在线曲目按 id 换直链的网络往返，见 playerStore.resolvingTrackId）：
  // 主按钮转菊花，表示「已收到点播、正在取地址」
  const resolving = usePlayerStore((s) => s.resolvingTrackId) !== null
  const showQueuePanel = usePlaylistStore((s) => s.showQueuePanel)
  const toggleQueuePanel = usePlaylistStore((s) => s.toggleQueuePanel)
  // 已在详情页时不重复 push 同路径，避免返回按钮「退回」同一页
  const openSongDetail = useOpenSongDetail()

  // ⚠️ 必须同时判 currentTrack：playerStore 会把 progress/duration 一起持久化，
  // 上次会话残留的进度会在「当前没有曲目」时仍画出一条进度线
  const progressPercent = currentTrack && duration > 0 ? (progress / duration) * 100 : 0

  const openNowPlaying = () => {
    // 空态（无当前歌曲）也允许展开全屏播放器，由它展示空态引导，
    // 避免「点哪都没反应」；有歌曲时展开全屏 Now Playing
    if (onOpenNowPlaying) onOpenNowPlaying()
    else if (currentTrack) openSongDetail(currentTrack.id)
  }

  return (
    <div
      onClick={openNowPlaying}
      role="button"
      aria-label={t('player.bar.expand')}
      className="glass-saved-panel rounded-[16px] border border-white/[0.07] pl-2 pr-1.5 py-1.5 flex items-center gap-0.5 relative overflow-hidden cursor-pointer active:bg-white/[0.03] transition-colors"
    >
      {/* 顶部进度细线：左右各内缩 16px，避开 16px 圆角弧线——原先 inset-x-0
          让线头正好切在弧线上，像卡片边缘崩了一角 */}
      <div className="absolute top-[3px] left-4 right-4 h-[2px] rounded-full bg-white/[0.08] overflow-hidden">
        <div
          className="h-full rounded-full transition-[width] duration-300 ease-linear"
          style={{
            width: `${progressPercent}%`,
            background:
              'linear-gradient(to right, rgba(var(--fc-accent-rgb),.55), rgba(var(--fc-accent-rgb),1))',
          }}
        />
      </div>
      {/* 封面 + 标题：整条热区的一部分，点击事件由外层容器统一处理 */}
      <div className="flex items-center gap-2.5 min-w-0 flex-1 pl-0.5 py-1">
        <div className="w-9 h-9 rounded-[9px] flex-shrink-0 overflow-hidden bg-white/[0.05] flex items-center justify-center">
          <CoverImage
            track={currentTrack}
            alt={currentTrack?.title}
            className="w-full h-full object-cover"
            fallback={<Music2 className="h-4 w-4 text-white/30" strokeWidth={1.5} />}
          />
        </div>
        <div className="min-w-0 flex flex-col gap-px">
          <p className="text-[13px] font-medium text-white/[0.94] truncate tracking-[-0.224px]">
            {currentTrack?.title || t('player.state.notPlaying')}
          </p>
          <p className="text-[10.5px] text-white/60 truncate tracking-[-0.12px]">
            {currentTrack?.artist || t('player.state.idle')}
          </p>
        </div>
      </div>

      {/* disabled 时 pointer-events-none：React 对 disabled 按钮跳过 onClick（stopPropagation
          随之失效）且真实点击不派发事件，会让热区出现「死区」；穿透到外层容器后，
          空态下点任意位置都统一展开全屏播放器 */}
      {/* 主播放按钮与全屏播放页保持一致：mint 实心圆 + 深色图标 */}
      <button
        className="w-[46px] h-[46px] flex items-center justify-center rounded-full bg-mint text-mint-fg shadow-[0_4px_12px_-6px_rgba(var(--fc-accent-rgb),.18),0_1px_4px_rgba(15,23,42,.10),inset_0_1px_0_rgba(255,255,255,.26)] dark:shadow-[0_4px_12px_-4px_rgba(var(--fc-accent-rgb),.38),0_2px_4px_rgba(0,0,0,.2),inset_0_1px_0_rgba(255,255,255,.2)] active:scale-95 transition disabled:opacity-35 disabled:pointer-events-none"
        onClick={(e) => {
          e.stopPropagation()
          onTogglePlay()
        }}
        disabled={!currentTrack}
        aria-label={resolving ? t('common.state.loading') : isPlaying ? t('common.action.pause') : t('common.action.play')}
      >
        {resolving ? (
          // 取址中：主按钮转菊花，明确「已经收到你的点播，正在取地址」
          <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2} />
        ) : isPlaying ? (
          <Pause className="h-5 w-5" fill="currentColor" strokeWidth={1.2} />
        ) : (
          <Play className="h-5 w-5 ml-[2px]" fill="currentColor" strokeWidth={1.2} />
        )}
      </button>
      <button
        className="w-11 h-11 flex items-center justify-center rounded-full text-white/80 active:scale-90 transition disabled:opacity-35 disabled:pointer-events-none"
        onClick={(e) => {
          e.stopPropagation()
          onNext()
        }}
        disabled={!currentTrack}
        aria-label={t('common.action.next')}
      >
        <SkipForward className="h-[18px] w-[18px]" fill="currentColor" strokeWidth={1.2} />
      </button>
      {/* 队列：次级权重的功能图标（描边族），激活时只染 mint 不给底色块 */}
      <button
        className={cn(
          'w-11 h-11 flex-shrink-0 flex items-center justify-center rounded-full active:scale-90 transition',
          showQueuePanel ? 'text-mint' : 'text-white/55',
        )}
        onClick={(e) => {
          // 同完整档：阻止冒泡，避免刚打开的浮层被 document 外部点击监听立刻关掉
          e.stopPropagation()
          toggleQueuePanel()
        }}
        aria-label={t('player.queue.toggle')}
      >
        <ListMusic className="h-[19px] w-[19px]" strokeWidth={1.7} />
      </button>
    </div>
  )
}

/**
 * 完整档（可用宽度 ≥ COMPACT_MAX_WIDTH）
 *
 * 单行放不下的功能在此全部展开：进度条 + 三列网格（曲目信息 / 传输控制 / 音量），
 * 传输控制含 shuffle·循环、上一首、播放暂停、下一首、队列。
 * 大屏（视口 ≥1500px，如 1080p@125% 全屏）整体放大一档，避免全屏下控件显得过小。
 */
function FullBar({
  currentTrack,
  volume,
  muted,
  repeatMode,
  shuffleMode,
  onTogglePlay,
  onNext,
  onPrevious,
  onSeek,
  onVolumeChange,
  onToggleMute,
  onCyclePlayMode,
}: PlayerBarProps) {
  const t = useT()
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const progress = usePlayerStore((s) => s.progress)
  const duration = usePlayerStore((s) => s.duration)
  // 取址中：主按钮转菊花（与紧凑档同一语义，各自在档内订阅，
  // 不把播放状态冒泡到外壳——外壳只做宽度测量）
  const resolving = usePlayerStore((s) => s.resolvingTrackId) !== null
  // 已在详情页时不重复 push 同路径，避免返回按钮「退回」同一页
  const openSongDetail = useOpenSongDetail()
  const [seeking, setSeeking] = useState(false)
  const [seekValue, setSeekValue] = useState(0)
  const [seekingVolume, setSeekingVolume] = useState(false)
  const [volumeValue, setVolumeValue] = useState(0)
  const showQueuePanel = usePlaylistStore((s) => s.showQueuePanel)
  const toggleQueuePanel = usePlaylistStore((s) => s.toggleQueuePanel)

  const displayedProgress = seeking ? seekValue : progress
  const displayedVolume = seekingVolume ? volumeValue : (muted ? 0 : volume)
  // ⚠️ 必须同时判 currentTrack：playerStore 会把 progress/duration 一起持久化，
  // 上次会话残留的进度会在「当前没有曲目」时仍画出一条进度线
  const progressPercent = currentTrack && duration > 0 ? (displayedProgress / duration) * 100 : 0
  const volumePercent = displayedVolume * 100

  const handleSeekStart = () => {
    setSeeking(true)
    setSeekValue(progress)
  }

  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSeekValue(parseFloat(e.target.value))
  }

  const handleSeekCommit = () => {
    setSeeking(false)
    onSeek(seekValue)
  }

  const handleVolumeStart = () => {
    setSeekingVolume(true)
    setVolumeValue(muted ? 0 : volume)
  }

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setVolumeValue(parseFloat(e.target.value))
  }

  const handleVolumeCommit = () => {
    setSeekingVolume(false)
    onVolumeChange(volumeValue)
  }

  // 播放模式激活：shuffle 开启 或 repeat 非 off
  const playModeActive = shuffleMode === 'on' || repeatMode !== 'off'

  return (
    <div className="glass-saved-panel border border-white/[0.06] rounded-[24px] px-6 min-[1500px]:px-8 py-2 min-[1500px]:py-3 flex flex-col gap-1.5 min-[1500px]:gap-2">
      {/* 进度条 - 居中 */}
      <div className="flex items-center gap-3">
        <span className="text-[12px] min-[1500px]:text-[13px] text-white/50 w-12 text-right tabular-nums">
          {formatTime(displayedProgress)}
        </span>
        <div className="flex-1 relative flex items-center">
          <input
            type="range"
            min={0}
            max={duration || 100}
            value={displayedProgress}
            step={0.1}
            disabled={!currentTrack}
            onMouseDown={handleSeekStart}
            onTouchStart={handleSeekStart}
            onChange={handleSeekChange}
            onMouseUp={handleSeekCommit}
            onTouchEnd={handleSeekCommit}
            onMouseLeave={() => seeking && handleSeekCommit()}
            className="seek-bar seek-xl w-full cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
            style={{ '--seek': `${progressPercent}%` } as React.CSSProperties}
          />
        </div>
        <span className="text-[12px] min-[1500px]:text-[13px] text-white/50 w-12 tabular-nums">
          {formatTime(duration)}
        </span>
      </div>

      {/* 三列控制网格：曲目信息 / 播放控制 / 音量。
          这一档的下界由外壳宽度保证（≥ COMPACT_MAX_WIDTH），三列在最窄处仍放得下 */}
      <div className="grid grid-cols-[minmax(0,1fr)_max-content_minmax(0,1fr)] gap-3 items-center">
        {/* 左列：曲目信息（封面 + 标题 + 艺术家） */}
        <div className="flex items-center gap-3 min-w-0 justify-start">
          <button
            onClick={() => currentTrack && openSongDetail(currentTrack.id)}
            title={t('player.track.viewDetail')}
            className="w-[40px] h-[40px] min-[1500px]:w-12 min-[1500px]:h-12 rounded-[10px] flex-shrink-0 overflow-hidden bg-white/[0.04] flex items-center justify-center cursor-pointer transition-transform duration-200 ease-apple hover:scale-105"
            style={{
              boxShadow:
                '0 2px 6px rgba(0,0,0,.18), inset 0 0 0 1px rgba(255,255,255,.06)',
            }}
          >
            <CoverImage
              track={currentTrack}
              alt={currentTrack?.title}
              className="w-full h-full object-cover"
              fallback={<Music2 className="h-4 w-4 text-white/30" strokeWidth={1.5} />}
            />
          </button>
          <div className="min-w-0 flex flex-col gap-0.5">
            <p className="text-[12.5px] min-[1500px]:text-[14px] font-medium text-white/92 truncate transition-colors hover:text-white">
              {currentTrack?.title || t('player.state.notPlaying')}
            </p>
            <p className="text-[10.5px] min-[1500px]:text-[12px] text-white/65 truncate">
              {currentTrack?.artist || t('player.state.idleHint')}
            </p>
          </div>
        </div>

        {/* 中列：播放控制（shuffle / prev / play / next / queue） */}
        <div className="flex items-center gap-2 min-[1500px]:gap-2.5 justify-center">
          <button
            className={cn(
              'btn-icon btn-xl',
              playModeActive && 'text-mint',
            )}
            onClick={onCyclePlayMode}
            title={t(
              shuffleMode === 'on'
                ? 'player.mode.shuffle'
                : repeatMode === 'one'
                  ? 'player.mode.repeatOne'
                  : repeatMode === 'all'
                    ? 'player.mode.repeatAll'
                    : 'player.mode.shuffle'
            )}
          >
            {shuffleMode === 'on' ? (
              <Shuffle className="h-[16px] w-[16px] min-[1500px]:h-[18px] min-[1500px]:w-[18px]" strokeWidth={1.5} />
            ) : repeatMode === 'one' ? (
              <Repeat1 className="h-[16px] w-[16px] min-[1500px]:h-[18px] min-[1500px]:w-[18px]" strokeWidth={1.5} />
            ) : repeatMode === 'all' ? (
              <Repeat className="h-[16px] w-[16px] min-[1500px]:h-[18px] min-[1500px]:w-[18px]" strokeWidth={1.5} />
            ) : (
              <Shuffle className="h-[16px] w-[16px] min-[1500px]:h-[18px] min-[1500px]:w-[18px]" strokeWidth={1.5} />
            )}
          </button>
          <button
            className="btn-icon btn-xl"
            onClick={onPrevious}
            disabled={!currentTrack}
          >
            <SkipBack className="h-[16px] w-[16px] min-[1500px]:h-[18px] min-[1500px]:w-[18px]" strokeWidth={1.5} />
          </button>
          {/* 主播放按钮：圆形实心 mint（44×44），DS 的 pill 语义 + 项目品牌色 */}
          <button
            className="w-[44px] h-[44px] min-[1500px]:w-[52px] min-[1500px]:h-[52px] rounded-full bg-mint flex items-center justify-center disabled:opacity-40 disabled:pointer-events-none shadow-[0_2px_6px_rgba(0,0,0,.18),inset_0_1px_0_rgba(255,255,255,.18)] transition-transform duration-200 ease-apple hover:scale-[1.03]"
            onClick={onTogglePlay}
            disabled={!currentTrack}
            style={{ color: 'rgb(var(--tw-mint-fg))' }}
          >
            {resolving ? (
              <Loader2 className="h-[18px] w-[18px] min-[1500px]:h-[22px] min-[1500px]:w-[22px] animate-spin" strokeWidth={2} />
            ) : isPlaying ? (
              <Pause className="h-[18px] w-[18px] min-[1500px]:h-[22px] min-[1500px]:w-[22px]" fill="currentColor" strokeWidth={1.5} />
            ) : (
              <Play className="h-[18px] w-[18px] ml-0.5 min-[1500px]:h-[22px] min-[1500px]:w-[22px]" fill="currentColor" strokeWidth={1.5} />
            )}
          </button>
          <button
            className="btn-icon btn-xl"
            onClick={onNext}
            disabled={!currentTrack}
          >
            <SkipForward className="h-[16px] w-[16px] min-[1500px]:h-[18px] min-[1500px]:w-[18px]" strokeWidth={1.5} />
          </button>
          <button
            className={cn(
              'btn-icon btn-xl',
              showQueuePanel && 'is-on',
            )}
            onClick={(e) => {
              // 阻止冒泡到 document：React 对 click 同步渲染，浮层会在事件冒泡到
              // document 前挂载并注册“外部点击关闭”监听，若冒泡上去会把刚打开的
              // 浮层立刻关掉；因此开关按钮自行处理 toggle，外部关闭只走 document 监听
              e.stopPropagation()
              toggleQueuePanel()
            }}
            title={t('player.queue.toggle')}
          >
            <ListMusic className="h-[16px] w-[16px] min-[1500px]:h-[18px] min-[1500px]:w-[18px]" strokeWidth={1.5} />
          </button>
        </div>

        {/* 右列：音量控制 */}
        <div className="flex items-center gap-2 justify-end">
          <button
            className="btn-icon btn-xl"
            onClick={onToggleMute}
            title={muted || volume === 0 ? t('player.volume.unmute') : t('player.volume.mute')}
          >
            {muted || volume === 0 ? (
              <VolumeX className="h-[14px] w-[14px] min-[1500px]:h-4 min-[1500px]:w-4" strokeWidth={1.5} />
            ) : (
              <Volume2 className="h-[14px] w-[14px] min-[1500px]:h-4 min-[1500px]:w-4" strokeWidth={1.5} />
            )}
          </button>
          <div className="w-24 min-[1500px]:w-32 h-4 min-[1500px]:h-5 flex items-center">
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={displayedVolume}
              onMouseDown={handleVolumeStart}
              onTouchStart={handleVolumeStart}
              onChange={handleVolumeChange}
              onMouseUp={handleVolumeCommit}
              onTouchEnd={handleVolumeCommit}
              onMouseLeave={() => seekingVolume && handleVolumeCommit()}
              className="volume-bar volume-xl w-full rounded-full cursor-pointer"
              style={{ '--volume': `${volumePercent}%` } as React.CSSProperties}
            />
          </div>
        </div>
      </div>
    </div>
  )
}