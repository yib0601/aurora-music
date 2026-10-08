import { useEffect, useState } from 'react'
import {
  Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1,
  ChevronDown, Heart, ListMusic, Music2, Loader2,
} from 'lucide-react'
import { cn, formatTime } from '@/lib/utils'
import { usePlaybackProgress } from '@/hooks/usePlaybackProgress'
import { usePlayerStore } from '@/stores/playerStore'
import { usePlaylistStore } from '@/stores/playlistStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { LyricsView } from '@/components/lyrics/LyricsView'
import { CoverImage } from '@/components/common/CoverImage'

interface Props {
  open: boolean
  onClose: () => void
}

/**
 * 移动端全屏 Now Playing 视图（DS 皮肤）
 *
 * 版式取向：**封面驱动 + 单焦点**。自上而下依次是
 *   氛围底 → 顶栏（只有收起/队列两个图标）→ 封面 → 标题区 → 歌词 → 进度 → 控件
 *
 * 三个关键决定：
 * 1. **标题从顶栏下沉到封面下方**。顶栏放歌名是桌面工具栏思路，移动端一行
 *    13px 的灰字既压不住大封面，也读不出层级；下沉后标题成为画面第二焦点，
 *    顶栏只剩两枚图标，视线自然从封面流到控件。
 * 2. **背景改由封面提取色点亮**（--ambient-from/to，由 useThemeColor 写入），
 *    下半部用 background 渐变压回深底保证控件对比。原先是 bg-background/95 +
 *    全屏 backdrop-blur：既盖住了 App 根部的色场（一片死黑、封面像贴在黑板上），
 *    又在 WebView 里逐帧重算模糊。
 * 3. **氛围层是静态 radial-gradient，不带 filter、不带动画**——本项目已实测
 *    「filter + 动画同元素 = 逐帧全屏模糊」（见 globals.css 色斑注释），移动端
 *    软件渲染更吃不住。色斑用多段色标压平边缘，替代 blur 的过渡带。
 *
 * 触控目标 ≥ 44×44，主播放按钮 72×72；不含音量控件（移动端交由系统硬件音量键）。
 */
export function MobileNowPlaying({ open, onClose }: Props) {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const duration = usePlayerStore((s) => s.duration)
  const repeatMode = usePlayerStore((s) => s.repeatMode)
  const shuffleMode = usePlayerStore((s) => s.shuffleMode)
  const toggleQueuePanel = usePlaylistStore((s) => s.toggleQueuePanel)
  const likedTracks = useLibraryStore((s) => s.likedTracks)
  const toggleLike = useLibraryStore((s) => s.toggleLike)

  const hasTrack = !!currentTrack
  // 取址中（在线曲目换直链的网络往返）：主按钮转菊花，与桌面播放条同一语义
  const resolving = usePlayerStore((s) => s.resolvingTrackId) !== null

  // 进度刻意不订阅 store：原生快照每 500ms 轮询回来一次，走 React 会连带歌词
  // 一起重渲染；交给 hook 用 rAF 外推 + 命令式写 DOM，见 usePlaybackProgress。
  // active 传 open && hasTrack：浮层收起或空态时归零，不残留上次会话的进度
  const { sliderRef, timeRef, onSeekStart, onSeekCommit } = usePlaybackProgress({
    duration,
    active: open && hasTrack,
  })

  // 歌词可用性：null = 还没结论（首帧或加载中），false = 确定这首歌没有歌词。
  // 无歌词时把「封面 + 标题 + 提示」整块收进剩余空间居中，见下方 wrapper 的注释。
  // 初值必须是 null 而不是 false：否则每首歌都会先按空态排一帧再跳回填满态
  const [hasLyrics, setHasLyrics] = useState<boolean | null>(null)
  const lyricsEmpty = hasLyrics === false

  // 阻止背景滚动
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // 注意：所有 hooks 必须在 early return 之前调用，避免 React hooks 顺序错误
  if (!open) return null

  const playModeActive = shuffleMode === 'on' || repeatMode !== 'off'
  const isLiked = currentTrack ? likedTracks.has(currentTrack.id) : false

  const cyclePlayMode = () => usePlayerStore.getState().cyclePlayMode()

  return (
    // 注意：这里**不写 md:hidden**。是否显示完全由 App 层的 `{mobile && ...}` 决定，
    // 再叠一层宽度断点会让平板（≥768px 宽但 isMobile 为真）点开播放页后什么也看不到
    <div className="now-playing fixed inset-0 z-50 flex flex-col bg-background overflow-hidden">
      {/* 氛围底：两层静态色斑 + 底部压暗。
          色斑刻意用 5 档色标（0/18/36/54/70/86%），把过渡带摊平到肉眼不可见的
          程度，替代 blur——不用 filter 是为了避开「滤镜 + 逐帧变化」的性能陷阱
          （见 globals.css 色斑注释）。最下面那层渐变同时承担「下半屏回到稳定
          深底」的兜底，保证歌词与控件的对比度不被封面浅色冲淡。 */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div
          className="absolute inset-0 opacity-[0.42] dark:opacity-[0.72]"
          style={{
            background:
              'radial-gradient(104% 42% at 50% -16%, var(--ambient-from) 0%,' +
              ' color-mix(in srgb, var(--ambient-from) 70%, transparent) 20%,' +
              ' color-mix(in srgb, var(--ambient-from) 38%, transparent) 40%,' +
              ' color-mix(in srgb, var(--ambient-from) 14%, transparent) 58%,' +
              ' color-mix(in srgb, var(--ambient-from) 5%, transparent) 74%, transparent 90%)',
          }}
        />
        <div
          className="absolute inset-0 opacity-35 dark:opacity-50"
          style={{
            background:
              'radial-gradient(62% 34% at 0% -8%, var(--ambient-to) 0%,' +
              ' color-mix(in srgb, var(--ambient-to) 52%, transparent) 24%,' +
              ' color-mix(in srgb, var(--ambient-to) 22%, transparent) 46%,' +
              ' color-mix(in srgb, var(--ambient-to) 7%, transparent) 66%, transparent 84%)',
          }}
        />
        <div className="absolute inset-x-0 bottom-0 h-[58%] bg-gradient-to-t from-background via-background/90 to-transparent" />
      </div>

      {/* 顶栏：只剩收起与队列。歌名下沉到封面下方（见文件头说明第 1 条） */}
      <header className="relative flex items-center justify-between px-2 pt-[calc(env(safe-area-inset-top)+4px)]">
        <button
          onClick={onClose}
          aria-label="收起播放页"
          className="w-11 h-11 flex items-center justify-center rounded-full text-white/70 active:text-white active:bg-white/[0.07] active:scale-95 transition"
        >
          <ChevronDown className="h-[22px] w-[22px]" strokeWidth={1.9} />
        </button>
        <button
          onClick={(e) => {
            // 阻止冒泡，避免刚打开的队列浮层被 document 外部点击监听立刻关掉
            e.stopPropagation()
            toggleQueuePanel()
            onClose()
          }}
          aria-label="播放队列"
          className="w-11 h-11 flex items-center justify-center rounded-full text-white/70 active:text-white active:bg-white/[0.07] active:scale-95 transition"
        >
          <ListMusic className="h-[21px] w-[21px]" strokeWidth={1.7} />
        </button>
      </header>

      {/* 封面 + 标题 + 歌词的整体分组。
          有歌词：歌词区 flex-1 吃掉剩余高度（与拆分前的逐像素布局一致）；
          无歌词：歌词区只剩一行提示，若仍让它占满，封面与控件之间会空出近半屏
          纯黑（真机实测约 400px），整页重心被推到上半屏。改为整组在剩余空间内
          垂直居中，上下留白对称，控件仍贴底 */}
      <div className={cn('relative flex-1 min-h-0 flex flex-col', lyricsEmpty && 'justify-center')}>
      {/* 封面：宽度同时受视口宽与视口高约束（矮屏自动缩小，把高度让给歌词）。
          -inset-* 那层是封面自身的色雾（静态 radial，无 filter），
          让封面「压」在氛围底上而不是浮在纯黑里 */}
      <div className="relative px-7 pt-1 flex justify-center">
        {/* 无歌词时整组已在剩余空间内居中，空白上下对称；此时封面再放大一档
            （70vw/34vh → 80vw/42vh），把居中后仍然松散的下半屏填起来，
            否则「居中」只是把同一块纯黑从下方搬到了上下两侧 */}
        <div className={cn(
          'relative aspect-square',
          lyricsEmpty ? 'w-[min(80vw,42vh)]' : 'w-[min(70vw,34vh)]'
        )}>
          <div
            aria-hidden
            className="absolute -inset-6 rounded-[46px] opacity-35 dark:opacity-70"
            style={{ background: 'radial-gradient(circle at 50% 44%, var(--ambient-from), transparent 70%)' }}
          />
          {/* 投影必须分主题：深色下用重黑投影把封面从暗底上「抬」起来；
              浅色下同一份重黑投影会在白底上糊成一团灰雾，换成极轻的冷灰 */}
          <div className="relative w-full h-full rounded-[14px] overflow-hidden bg-white/[0.04] flex items-center justify-center shadow-[0_16px_34px_-20px_rgba(15,23,42,.18),0_2px_8px_rgba(15,23,42,.06)] dark:shadow-[0_28px_64px_-22px_rgba(0,0,0,.92),0_6px_18px_rgba(0,0,0,.5)] ring-1 ring-white/[0.08]">
            <CoverImage
              track={currentTrack}
              alt={currentTrack?.title || ''}
              className="w-full h-full object-cover"
              fallback={<Music2 className="h-16 w-16 text-mint/35" strokeWidth={1} />}
            />
          </div>
        </div>
      </div>

      {/* 标题区：歌名是画面第二焦点，曲目信息层级用字号+透明度两档表达 */}
      <div className="relative px-10 pt-5 text-center">
        <p className="font-display text-[19px] font-semibold text-white/[0.96] tracking-[-0.4px] truncate">
          {currentTrack?.title || '未在播放'}
        </p>
        <p className="mt-1 text-[12.5px] text-white/55 truncate tracking-[-0.1px]">
          {currentTrack?.artist || '选择一首歌曲开始'}
        </p>
      </div>

      {/* 歌词：占据剩余高度。用 large 档——全屏页与桌面详情页同属「大面积」场景，
          13px 的默认档在整屏宽度上显得空；行高与上下渐隐由 LyricsView 内部给出 */}
      <div className={cn('relative px-5 pt-3', lyricsEmpty ? 'flex-none' : 'flex-1 min-h-0')}>
        <LyricsView
          large
          className="h-full"
          onLineClick={(t) => usePlayerStore.getState().seekTo(t)}
          onHasLyricsChange={setHasLyrics}
        />
      </div>
      </div>

      {/* 进度条：32px 触控高度 + 常显圆形滑块（seek-lg 专属，见 globals.css）。
          限宽居中：平板/折叠屏展开后整屏拉通会让时间标签离轨道过远。
          值与 --seek 全部由 usePlaybackProgress 的 rAF 命令式写入（input 非受控），
          所以这里不接 value / style —— 进度每帧推进不再重渲染整页 */}
      <div className="relative mx-auto w-full max-w-[480px] px-5 pb-1">
        <div className="flex items-center gap-2.5">
          <span
            ref={timeRef}
            className="min-w-[34px] text-right text-[11.5px] text-white/45 tabular-nums"
          >
            0:00
          </span>
          <input
            ref={sliderRef}
            type="range"
            min={0}
            max={duration || 100}
            // 粒度取 0.01 秒而不是 0.1：range 的 value 会被浏览器量化到 step 的
            // 整数倍，粗粒度会把逐帧外推重新打成台阶，thumb 只能一跳一跳地跟
            step={0.01}
            defaultValue={0}
            disabled={!hasTrack}
            aria-label="播放进度"
            onPointerDown={onSeekStart}
            onPointerUp={onSeekCommit}
            onPointerCancel={onSeekCommit}
            className="seek-bar seek-lg flex-1 cursor-pointer disabled:opacity-40"
          />
          <span className="min-w-[34px] text-[11.5px] text-white/45 tabular-nums">
            {formatTime(duration)}
          </span>
        </div>
      </div>

      {/* 控件行：五列等分网格——列宽相等，图标在各自列内居中，
          比 justify-between 更稳（窄屏 320px 下两端图标不会被挤到贴边）。
          限宽 440px 居中：大屏（平板/折叠屏展开）下不把五个按钮摊到屏幕两端 */}
      <div className="relative mx-auto w-full max-w-[440px] px-3 pt-0.5 pb-[calc(env(safe-area-inset-bottom)+10px)] grid grid-cols-5 items-center justify-items-center">
        <button
          onClick={cyclePlayMode}
          aria-label="播放模式"
          className={cn(
            'w-11 h-11 flex items-center justify-center rounded-full active:scale-90 transition',
            playModeActive ? 'text-mint' : 'text-white/55',
          )}
        >
          {shuffleMode === 'on' ? (
            <Shuffle className="h-[21px] w-[21px]" strokeWidth={1.9} />
          ) : repeatMode === 'one' ? (
            <Repeat1 className="h-[21px] w-[21px]" strokeWidth={1.9} />
          ) : repeatMode === 'all' ? (
            <Repeat className="h-[21px] w-[21px]" strokeWidth={1.9} />
          ) : (
            <Shuffle className="h-[21px] w-[21px]" strokeWidth={1.9} />
          )}
        </button>
        <button
          onClick={() => usePlayerStore.getState().previous()}
          disabled={!hasTrack}
          aria-label="上一首"
          className="w-12 h-12 flex items-center justify-center rounded-full text-white/[0.88] active:scale-90 transition disabled:opacity-35"
        >
          <SkipBack className="h-[23px] w-[23px]" fill="currentColor" strokeWidth={1.2} />
        </button>
        {/* 主播放按钮：72px 圆形 mint 实心。投影带一点品牌色（收在 -8px 扩散内，
            属于落地阴影而非大面积 glow），让它在暗底上有「发光但不糊」的质感；
            浅色主题下换成轻投影 + 一层白内高光，避免绿光晕在白底上发脏 */}
        <button
          onClick={() => usePlayerStore.getState().togglePlay()}
          disabled={!hasTrack}
          aria-label={resolving ? '加载中' : isPlaying ? '暂停' : '播放'}
          className="w-[72px] h-[72px] rounded-full flex items-center justify-center bg-mint text-mint-fg disabled:opacity-35 active:scale-95 transition-transform duration-200 ease-apple shadow-[0_8px_20px_-10px_rgba(var(--fc-accent-rgb),.22),0_1px_6px_rgba(15,23,42,.08),inset_0_1px_0_rgba(255,255,255,.28)] dark:shadow-[0_8px_22px_-8px_rgba(var(--fc-accent-rgb),.55),0_2px_8px_rgba(0,0,0,.35),inset_0_1px_0_rgba(255,255,255,.22)]"
        >
          {resolving ? (
            <Loader2 className="h-[27px] w-[27px] animate-spin" strokeWidth={2} />
          ) : isPlaying ? (
            <Pause className="h-[27px] w-[27px]" fill="currentColor" strokeWidth={1.2} />
          ) : (
            <Play className="h-[27px] w-[27px] ml-[3px]" fill="currentColor" strokeWidth={1.2} />
          )}
        </button>
        <button
          onClick={() => usePlayerStore.getState().next()}
          disabled={!hasTrack}
          aria-label="下一首"
          className="w-12 h-12 flex items-center justify-center rounded-full text-white/[0.88] active:scale-90 transition disabled:opacity-35"
        >
          <SkipForward className="h-[23px] w-[23px]" fill="currentColor" strokeWidth={1.2} />
        </button>
        <button
          onClick={() => currentTrack && toggleLike(currentTrack.id)}
          disabled={!hasTrack}
          aria-label={isLiked ? '取消收藏' : '收藏'}
          className={cn(
            'w-11 h-11 flex items-center justify-center rounded-full active:scale-90 transition disabled:opacity-35',
            isLiked ? 'text-coral' : 'text-white/55',
          )}
        >
          <Heart className={cn('h-[21px] w-[21px]', isLiked && 'fill-coral')} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  )
}
