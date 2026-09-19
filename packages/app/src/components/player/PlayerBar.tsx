import React, { useState } from 'react'
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Volume2, VolumeX, Music2, ListMusic } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { cn, formatTime, isMobile } from '@/lib/utils'
import type { RepeatMode, ShuffleMode, Track } from '@/types'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { CoverImage } from '@/components/common/CoverImage'

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
 * PlayerBar（DS 皮肤）
 * - 底部悬浮面板沿用项目既有玻璃类 glass-saved-panel（内部是纯透明 blur，不启用 SVG 位移滤镜），
 *   它已登记在 globals.css 的 .glass-perf-lite / .resizing 降级名单中：
 *   详情页折叠动画与窗口拖拽缩放期间 blur 会被强制关闭，不会逐帧重算模糊。
 *   ⚠️ 不要新增未登记的自定义玻璃类——换掉类名的同时也就脱离了降级管辖。
 * - 发丝描边 + DS 的 16/24px 圆角阶梯，去掉多层大投影
 * - 顶部进度条 + 三列控制网格（曲目信息 / 播放控制 / 音量）
 * - 主播放按钮为圆形实心 mint 块（DS 的 pill 语义 + 项目品牌色）
 * - 普通控制按钮使用 btn-icon（28×28，8px 圆角）
 *
 * ⚠️ 性能：isPlaying / progress / duration 在此自行订阅，
 * 避免向上冒泡到 AppLayout 触发整树重渲染
 */
export function PlayerBar({
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
  onOpenNowPlaying,
}: PlayerBarProps) {
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const progress = usePlayerStore((s) => s.progress)
  const duration = usePlayerStore((s) => s.duration)
  const navigate = useNavigate()
  const [seeking, setSeeking] = useState(false)
  const [seekValue, setSeekValue] = useState(0)
  const [seekingVolume, setSeekingVolume] = useState(false)
  const [volumeValue, setVolumeValue] = useState(0)
  const showQueuePanel = usePlaylistStore((s) => s.showQueuePanel)
  const toggleQueuePanel = usePlaylistStore((s) => s.toggleQueuePanel)

  const mobile = isMobile()
  const displayedProgress = seeking ? seekValue : progress
  const displayedVolume = seekingVolume ? volumeValue : (muted ? 0 : volume)
  const progressPercent = duration > 0 ? (displayedProgress / duration) * 100 : 0
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

  // ───────────────────────── 移动端紧凑布局 ─────────────────────────
  // 去掉桌面 grid + 音量控件；触控目标 ≥ 44×44；整条点击进全屏 Now Playing
  if (mobile) {
    const openNowPlaying = () => {
      // 空态（无当前歌曲）也允许展开全屏播放器，由它展示空态引导，
      // 避免「点哪都没反应」；有歌曲时展开全屏 Now Playing
      if (onOpenNowPlaying) onOpenNowPlaying()
      else if (currentTrack) navigate(`/song/${currentTrack.id}`)
    }
    return (
      <div
        onClick={openNowPlaying}
        role="button"
        aria-label="展开播放器"
        className="glass-saved-panel rounded-[16px] border border-white/[0.06] px-3 py-2 flex items-center gap-1.5 relative overflow-hidden cursor-pointer active:bg-white/[0.03] transition-colors"
      >
        {/* 顶部进度细线：迷你条上一眼可见播放进度 */}
        <div className="absolute inset-x-0 top-0 h-[2px] bg-white/[0.06]">
          <div
            className="h-full rounded-r-full transition-[width] duration-300 ease-linear"
            style={{
              width: `${progressPercent}%`,
              background: 'linear-gradient(to right, rgba(var(--fc-accent-rgb),.35), rgba(var(--fc-accent-rgb),.95))',
              boxShadow: progressPercent > 0 ? '0 0 6px rgba(var(--fc-accent-rgb),.32)' : 'none',
            }}
          />
        </div>
        {/* 封面 + 标题：整条热区的一部分，点击事件由外层容器统一处理 */}
        <div className="flex items-center gap-2.5 min-w-0 flex-1 py-1">
          <div className="w-10 h-10 rounded-[10px] flex-shrink-0 overflow-hidden bg-white/[0.04] flex items-center justify-center">
            <CoverImage
              track={currentTrack}
              alt={currentTrack?.title}
              className="w-full h-full object-cover"
              fallback={<Music2 className="h-4 w-4 text-white/30" strokeWidth={1.5} />}
            />
          </div>
          <div className="min-w-0 flex flex-col">
            <p className="text-[13px] font-medium text-white/92 truncate tracking-[-0.224px]">
              {currentTrack?.title || '未在播放'}
            </p>
            <p className="text-[10.5px] text-white/48 truncate tracking-[-0.12px]">
              {currentTrack?.artist || '选择一首歌曲'}
            </p>
          </div>
        </div>

        {/* disabled 时 pointer-events-none：React 对 disabled 按钮跳过 onClick（stopPropagation
            随之失效）且真实点击不派发事件，会让热区出现「死区」；穿透到外层容器后，
            空态下点任意位置都统一展开全屏播放器 */}
        <button
          className="w-11 h-11 flex items-center justify-center rounded-full text-white/90 active:scale-90 transition disabled:opacity-40 disabled:pointer-events-none"
          onClick={(e) => {
            e.stopPropagation()
            onPrevious()
          }}
          disabled={!currentTrack}
          aria-label="上一首"
        >
          <SkipBack className="h-5 w-5" fill="currentColor" strokeWidth={1.5} />
        </button>
        {/* 主播放按钮与全屏播放页保持一致：mint 实心圆 + 深色图标 */}
        <button
          className="w-12 h-12 flex items-center justify-center rounded-full bg-mint text-mint-fg shadow-[0_2px_4px_rgba(0,0,0,.16),inset_0_1px_0_rgba(255,255,255,.18)] active:scale-95 transition disabled:opacity-40 disabled:pointer-events-none"
          onClick={(e) => {
            e.stopPropagation()
            onTogglePlay()
          }}
          disabled={!currentTrack}
          aria-label={isPlaying ? '暂停' : '播放'}
        >
          {isPlaying ? (
            <Pause className="h-5 w-5" fill="currentColor" strokeWidth={1.5} />
          ) : (
            <Play className="h-5 w-5 ml-0.5" fill="currentColor" strokeWidth={1.5} />
          )}
        </button>
        <button
          className="w-11 h-11 flex items-center justify-center rounded-full text-white/90 active:scale-90 transition disabled:opacity-40 disabled:pointer-events-none"
          onClick={(e) => {
            e.stopPropagation()
            onNext()
          }}
          disabled={!currentTrack}
          aria-label="下一首"
        >
          <SkipForward className="h-5 w-5" fill="currentColor" strokeWidth={1.5} />
        </button>
        <button
          className={cn(
            'w-11 h-11 flex-shrink-0 flex items-center justify-center rounded-full active:scale-90 transition',
            showQueuePanel ? 'text-mint bg-mint/[0.10]' : 'text-white/60',
          )}
          onClick={(e) => {
            // 同桌面端：阻止冒泡，避免刚打开的浮层被 document 外部点击监听立刻关掉
            e.stopPropagation()
            toggleQueuePanel()
          }}
          aria-label="队列"
        >
          <ListMusic className="h-5 w-5" strokeWidth={1.5} />
        </button>
      </div>
    )
  }

  // ───────────────────────── 桌面端三列网格（原布局） ─────────────────────────
  // 大屏（≥1500px，如 1080p@125% 全屏）整体放大一档，避免全屏下控件显得过小
  return (
    <div className="glass-saved-panel border border-white/[0.06] rounded-[24px] px-[18px] min-[1500px]:px-6 py-2 min-[1500px]:py-3 flex flex-col gap-1.5 min-[1500px]:gap-2">
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

      {/* 三列控制网格：曲目信息 / 播放控制 / 音量 */}
      <div className="grid grid-cols-[minmax(0,1fr)_max-content_minmax(0,1fr)] gap-3 items-center">
        {/* 左列：曲目信息（封面 + 标题 + 艺术家） */}
        <div className="flex items-center gap-3 min-w-0 justify-start">
          <button
            onClick={() => currentTrack && navigate(`/song/${currentTrack.id}`)}
            title="查看歌曲详情"
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
              {currentTrack?.title || '未在播放'}
            </p>
            <p className="text-[10.5px] min-[1500px]:text-[12px] text-white/48 truncate">
              {currentTrack?.artist || '选择一首歌曲开始'}
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
            title={
              shuffleMode === 'on'
                ? '随机播放'
                : repeatMode === 'one'
                  ? '单曲循环'
                  : repeatMode === 'all'
                    ? '列表循环'
                    : '随机播放'
            }
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
            {isPlaying ? (
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
            title="队列"
          >
            <ListMusic className="h-[16px] w-[16px] min-[1500px]:h-[18px] min-[1500px]:w-[18px]" strokeWidth={1.5} />
          </button>
        </div>

        {/* 右列：音量控制 */}
        <div className="flex items-center gap-2 justify-end">
          <button
            className="btn-icon btn-xl"
            onClick={onToggleMute}
            title={muted || volume === 0 ? '取消静音' : '静音'}
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
