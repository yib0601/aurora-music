import React, { useEffect, useRef, useState } from 'react'
import { AudioLines, Music2 } from 'lucide-react'
import type { LyricLine } from '@/types'
import {
  findActiveLine,
  lyricLineWindow,
  loadLyricsForTrack,
  lyricsLoadKey,
  nextLyricsText,
  parseLRC,
} from '@/services/lyrics.service'
import { usePlayerStore } from '@/stores/playerStore'
import { buildFillPlan } from '@/lib/lyricFill'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'

/**
 * 歌词区（桌面右栏 / 歌曲详情页 / 移动端全屏播放页共用）。
 *
 * ## 这一版的执行模型：DOM 更新不进 React
 *
 * 播放进度在 store 里是 2~4Hz 的快照（见 audio.service 的轮询），而歌词要「跟着唱」：
 *   - 高亮行切换必须落在**真实时间**上，不能最多晚半秒；
 *   - 逐字填充要连续，不能每 250ms 跳一格。
 *
 * 因此这里把进度当成**时钟**而不是状态：订阅 store 只更新一个 ref 锚点
 * （position + 采样时刻 + 是否播放中），再用一条 rAF 循环按帧外推出当前时间。
 * 当前行索引、卡拉OK填充、居中滚动全部由这条循环**命令式**写 DOM，
 * 只有「当前行变了」才 setState 重渲染。副作用是顺带修掉一个旧性能问题：
 * 改造前每次 progress 更新都会重渲染整块歌词（几十条 <p> + 渐变滤镜）。
 *
 * 与 usePlaybackProgress 的关系：同一个思路（外推 + 命令式写），但那边服务的是
 * 进度条滑块与时间文本，还需要 seek 锁定；歌词只需要「读时间」，不重复造那套锁定逻辑。
 *
 * ## 切行不再有横向抖动
 *
 * 旧实现把声波图标放在当前行文字**前面**（inline），而歌词是居中排版：图标一出现，
 * 整行文字被挤得右移约 10px，换行时再退回去——每切一句，两行文字都抖一下。
 * 现在声波标记改成一条**跟随当前行的游标**（绝对定位在左内边距里，只动 transform），
 * 文字排版与图标完全解耦。
 */

interface LyricsViewProps {
  lyricsText?: string
  className?: string
  /** 大字号模式：详情页全屏场景下放大歌词行，避免宽屏显得空旷 */
  large?: boolean
  onLineClick?: (time: number) => void
  /**
   * 歌词可用性回调：`true` = 已有歌词行可渲染，`false` = 确定无歌词（非加载中）。
   *
   * 全屏播放页需要据此改纵向分配：无歌词时歌词区只剩一行提示，若仍按
   * `flex-1` 占满剩余高度，封面与控件之间会空出近半屏的纯黑（真机实测
   * 约 400px），整页重心飘在上半屏。加载中一律回报 `true`，避免「先按空态
   * 排一次 → 歌词到位后再跳回」的抖动。
   */
  onHasLyricsChange?: (hasLyrics: boolean) => void
  /**
   * 本实例当前是否真的在画面上。默认 true。
   *
   * 为什么需要它：进入歌曲详情页时，右侧 Now Playing 瓷砖只是**宽度折叠成 0**
   * （见 App.tsx 的 aside 注释：卸载会让内容列宽度突变、播放条横移），歌词组件仍完整
   * 挂载在 `overflow-hidden` 的 0 宽父级里、DOM 照旧参与布局。不告知的话详情页上会有
   * 两份歌词同时逐帧写逐字填充与滚动（实测两份并行时 rAF 帧 >33ms 占比约 15%，
   * 单份为 0），而用户只看得到其中一份。
   *
   * 试过用 IntersectionObserver 自测：祖先 `overflow:hidden` 折叠成 0 宽时，同一个
   * observer **收不到回调**（新建的 observer 才算出 0 面积），拿它做门控会静默失效；
   * 因此改成由调用方显式声明 —— 折叠与否本来只有 App 那一层知道。
   */
  active?: boolean
}

/** 切行居中动画时长：短于一句的间隔，读作「跟过去」而不是「跳过去」（毫秒） */
const SCROLL_DURATION_MS = 460
/** 用户手动滚动后暂停自动居中的窗口（毫秒）：手指还在找位置时不要跟它抢 */
const USER_SCROLL_PAUSE_MS = 3600
/**
 * 卡拉OK填充的刷新间隔（毫秒）。
 *
 * 填充是改 `background-image` 的硬停点，每改一次该行字形就要重新光栅化一次；
 * 60fps 全量刷新在低端机上纯属浪费。50ms（20fps）是这类「进度类」视觉的常用档位：
 * 肉眼已看不出台阶，而重绘次数只剩三分之一。
 */
const KARAOKE_MIN_INTERVAL_MS = 50
/** 帧间隔超过它即认定页面被挂起过（后台窗口 / WebView 冻结），不外推这段时间（毫秒） */
const FRAME_GAP_RESYNC_MS = 800

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function LyricsView({
  lyricsText,
  className,
  large,
  onLineClick,
  onHasLyricsChange,
  active = true,
}: LyricsViewProps) {
  const t = useT()
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const cursorRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<Array<HTMLParagraphElement | null>>([])

  const [lyrics, setLyrics] = useState<LyricLine[]>([])
  const [loadedLyrics, setLoadedLyrics] = useState<string>('')
  const [loading, setLoading] = useState(false)
  /**
   * 当前行与**它所属的歌词数组**绑在一起存。
   *
   * 只存一个索引的话，切歌那一帧旧索引会落到新歌的同一行号上：新歌词已经渲染、
   * 却顶着上一首的「第 N 句高亮」，于是切歌瞬间会闪一下错误的高亮行（并把它滚到中央），
   * 下一帧才被重置回顶部。带上数组引用后，引用不等即视为「还没有当前行」。
   */
  const [activeState, setActiveState] = useState<{ index: number; lyrics: LyricLine[] }>({
    index: -1,
    lyrics: [],
  })
  const activeIdx = activeState.lyrics === lyrics ? activeState.index : -1
  const activeIdxRef = useRef(-1)
  /** 上一次写进 state 的歌词数组：帧循环用它发现「换歌了」 */
  const activeLyricsRef = useRef<LyricLine[]>(lyrics)

  // 只按「曲目 id + 外部歌词」这个键重新加载：currentTrack 在播放中会被封面补齐
  // （CoverImage 的 syncPlayerStoreCover）、取址回填、persist rehydrate 换成新对象，
  // 依赖整个对象会让这些「字段没变、只是新引用」的更新也重跑加载——而重跑里一次
  // 失败/超时的搜索就会把已经显示出来的歌词清成「暂无歌词」。
  const loadKey = lyricsLoadKey(currentTrack, lyricsText)
  const trackId = currentTrack?.id ?? null

  // 真正发起加载要用曲目的完整字段（title/artist/album/duration），而加载 effect 又不能
  // 依赖 currentTrack 对象本身，所以用 ref 持有最新值。本 effect 先于下面的加载 effect
  // 声明，同一次 commit 里 ref 先更新，切歌时读到的就是新曲目。
  const trackRef = useRef(currentTrack)
  useEffect(() => {
    trackRef.current = currentTrack
  }, [currentTrack])

  useEffect(() => {
    if (!trackId) {
      setLoadedLyrics('')
      setLoading(false)
      return
    }
    // 如果外部传了 lyricsText 优先用外部的
    if (lyricsText) {
      setLoadedLyrics(lyricsText)
      setLoading(false)
      return
    }
    const track = trackRef.current
    if (!track || track.id !== trackId) {
      setLoading(false)
      return
    }
    // 切歌（id 变化）时清空上一首的歌词；同一首歌重复进入由服务层的同曲缓存兜底，
    // 落地失败也不降级为空态
    let cancelled = false
    setLoadedLyrics('')
    setLoading(true)
    loadLyricsForTrack(track)
      .then((lrc) => {
        // 竞态守卫：结果回来时已经切到别的歌，过期结果一律丢弃
        if (cancelled) return
        setLoadedLyrics((prev) => nextLyricsText(prev, lrc))
      })
      .catch((err) => {
        // 拒绝一律吞掉：这里没有任何可补救的信息，把拒绝放出去只会让整棵 React 树
        // 吃掉一个 unhandled rejection，而 UI 该做的是保持现状（已显示的歌词不清空）
        console.warn('[lyrics] 歌词加载失败:', track.id, err)
      })
      .finally(() => {
        // 收尾必须无条件进行：否则 loading 卡在 true，父级的纵向分配一直按「有歌词」排
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // trackId / lyricsText 单独列出只是为了让依赖数组自洽：两者都是 loadKey 的组成，
    // 值不变则键不变、effect 不重跑，行为与只看 loadKey 一致
  }, [loadKey, trackId, lyricsText])

  useEffect(() => {
    if (!loadedLyrics) {
      setLyrics([])
      return
    }
    // 歌词变化（切歌）时重置滚动跟踪，确保新歌重新定位
    setLyrics(parseLRC(loadedLyrics))
  }, [loadedLyrics])

  // ===== 平滑时钟：store 快照 → 每帧外推 =====
  // 只订阅、不渲染：progress 每 500ms 变一次，走 React 会连带几十条歌词 <p> 一起重渲染。
  const clockRef = useRef({ position: 0, at: 0, playing: false })

  useEffect(() => {
    const resync = (position: number, playing: boolean) => {
      clockRef.current = { position, at: performance.now(), playing }
    }
    const state = usePlayerStore.getState()
    resync(state.progress, state.isPlaying)
    return usePlayerStore.subscribe((next, prev) => {
      // 切歌 / seek（乐观写 progress）/ 轮询快照 / 播放暂停：一律以最新快照为新锚点。
      // 不区分来源是刻意的——任何一次位置跳变都错的是锚点，而不是「某类更新」。
      if (
        next.currentTrack?.id !== prev.currentTrack?.id ||
        next.progress !== prev.progress ||
        next.isPlaying !== prev.isPlaying
      ) {
        resync(next.progress, next.isPlaying)
      }
    })
  }, [])

  // 歌词数组的稳定引用：rAF 循环里不能读 state，否则闭包会一直拿到首次渲染的空数组
  const lyricsRef = useRef<LyricLine[]>(lyrics)
  lyricsRef.current = lyrics

  /** 当前行的卡拉OK目标：词元/整行 span + 每段的起止时间（秒） */
  const karaokeRef = useRef<{ spans: HTMLElement[]; segments: Array<{ start: number; end: number }> } | null>(
    null
  )
  /** 已写入的填充值：值没变就不碰 DOM（避免无意义的光栅化） */
  const karaokeWriteRef = useRef<{ at: number; values: number[] }>({ at: 0, values: [] })
  /** 滚动的补间状态；null 表示静止 */
  const scrollAnimRef = useRef<{ from: number; to: number; startAt: number } | null>(null)
  /** 用户手动滚动的截止时刻：窗口内不强行把我们拉回当前行 */
  const userScrollUntilRef = useRef(0)
  /**
   * 本实例是否真的“在显示”。由调用方通过 `active` 告知，见该 prop 的注释。
   * 用 ref 而不是在帧循环里读 prop：rAF 闭包只能建立一次，读 state 会拿到首帧的旧值。
   */
  const activeRef = useRef(active !== false)
  activeRef.current = active !== false

  // ===== 每帧循环：当前行 / 卡拉OK填充 / 滚动补间 =====
  useEffect(() => {
    let raf = 0
    let lastFrameAt = performance.now()

    const frame = () => {
      raf = requestAnimationFrame(frame)
      const now = performance.now()

      // 帧间出现大空档 = 页面被挂起过：这段时长不属于播放进度，先把锚点挪到当下，
      // 否则回前台时当前行会瞬间冲出好几行（真实位置由随后的轮询快照校准）
      if (now - lastFrameAt > FRAME_GAP_RESYNC_MS) {
        clockRef.current = { ...clockRef.current, at: now }
      }
      lastFrameAt = now

      const clock = clockRef.current
      const time = clock.position + (clock.playing ? (now - clock.at) / 1000 : 0)

      const lines = lyricsRef.current
      if (lines.length === 0) return

      // 没有在显示的实例不做任何逐帧工作（见 active prop 的注释）。
      if (!activeRef.current) return

      // 1) 当前行：只在这一行真的变了时才让 React 重渲染。
      //    条件里的「歌词数组换了」同样重要：切到另一首时行号可能恰好相同，
      //    但 state 里绑的还是上一首的数组，必须重写一次才能重新建立绑定。
      const idx = findActiveLine(lines, time)
      if (idx !== activeIdxRef.current || activeLyricsRef.current !== lines) {
        activeIdxRef.current = idx
        activeLyricsRef.current = lines
        setActiveState({ index: idx, lyrics: lines })
      }

      // 2) 逐字填充
      const karaoke = karaokeRef.current
      if (karaoke && now - karaokeWriteRef.current.at >= KARAOKE_MIN_INTERVAL_MS) {
        const write = karaokeWriteRef.current
        write.at = now
        for (let i = 0; i < karaoke.segments.length; i++) {
          const span = karaoke.spans[i]
          if (!span) continue
          const { start, end } = karaoke.segments[i]
          const duration = end - start
          const raw = duration > 0 ? (time - start) / duration : 1
          const progress = raw <= 0 ? 0 : raw >= 1 ? 1 : raw
          const previous = write.values[i]
          // 端点必须写：否则「刚好唱到」与「还没唱到」在视觉上没有区别
          if (previous === progress) continue
          if (
            progress !== 0 &&
            progress !== 1 &&
            previous !== undefined &&
            Math.abs(progress - previous) < 0.02
          ) {
            continue
          }
          write.values[i] = progress
          span.style.setProperty('--lp', progress.toFixed(3))
        }
      }

      // 3) 滚动补间：自己插值而不是 scrollTo({behavior:'smooth'})。
      //    原生 smooth 每次调用都会**重启**缓动，旧实现 100ms 节流重发时滚动永远
      //    走不完一次缓动，读起来是「一顿一顿地蹭」。自绘的 from/to 可以随时换目标，
      //    从当前 scrollTop 接着走，视觉上是连续的一条曲线。
      const anim = scrollAnimRef.current
      const scroller = scrollerRef.current
      if (anim && scroller) {
        const k = Math.min(1, (now - anim.startAt) / SCROLL_DURATION_MS)
        const eased = 1 - Math.pow(1 - k, 3)
        scroller.scrollTop = anim.from + (anim.to - anim.from) * eased
        if (k >= 1) scrollAnimRef.current = null
      }
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ===== 切行时的收尾：定位游标、采集卡拉OK目标、居中滚动 =====
  useEffect(() => {
    const scroller = scrollerRef.current
    const lineEl = lineRefs.current[activeIdx]
    const cursor = cursorRef.current

    if (!scroller || !lineEl) {
      karaokeRef.current = null
      if (cursor) cursor.style.opacity = '0'
      return
    }

    // 游标：只写 transform（合成层），永远不参与文字排版
    if (cursor) {
      const centerY = lineEl.offsetTop + lineEl.offsetHeight / 2
      cursor.style.transform = `translate3d(0, ${Math.round(centerY)}px, 0) translateY(-50%)`
      cursor.style.opacity = '1'
    }

    // 采集当前行的填充目标。span 是本次渲染才挂上的，必须在这个 effect（DOM 已提交）里取
    const spans = Array.from(lineEl.querySelectorAll<HTMLElement>('[data-lyric-fill]'))
    const line = lyricsRef.current[activeIdx]
    if (spans.length > 0 && line) {
      const window = lyricLineWindow(lyricsRef.current, activeIdx)
      const plan = buildFillPlan(line, window.end)
      // 渲染时按同一份 plan 切 span，数量必然一致；不一致说明渲染与计划脱节，
      // 宁可退回「无填充」也不要按错位的时间去点亮错误的字
      if (plan.tokens.length === spans.length) {
        karaokeRef.current = { spans, segments: plan.segments }
        karaokeWriteRef.current = { at: 0, values: spans.map(() => -1) }
      } else {
        karaokeRef.current = null
      }
    } else {
      karaokeRef.current = null
    }

    // 用户刚手动滚动过就让他看：等下一次切行再接管，避免「滚不动」
    if (performance.now() < userScrollUntilRef.current) return

    const target = lineEl.offsetTop + lineEl.offsetHeight / 2 - scroller.clientHeight / 2
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const clamped = Math.min(max, Math.max(0, target))
    if (prefersReducedMotion()) {
      scroller.scrollTop = clamped
      scrollAnimRef.current = null
      return
    }
    scrollAnimRef.current = { from: scroller.scrollTop, to: clamped, startAt: performance.now() }
  }, [activeIdx, lyrics])

  // 换歌词（切歌）：回到顶部，清掉上一首的游标与填充目标。
  // 这个 effect 必须与上面的切行 effect 分开：同一首歌词内部切行不能把滚动位置清零。
  useEffect(() => {
    activeIdxRef.current = -1
    activeLyricsRef.current = lyrics
    setActiveState({ index: -1, lyrics })
    karaokeRef.current = null
    scrollAnimRef.current = null
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollTop = 0
    if (cursorRef.current) cursorRef.current.style.opacity = '0'
  }, [lyrics])

  // 手动滚动意图：一段时间内不自动居中。只认 wheel / touchmove，
  // 不认 pointerdown / touchstart —— 点击歌词行是「跳转到这句」，恰恰需要立刻居中。
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const pause = () => {
      userScrollUntilRef.current = performance.now() + USER_SCROLL_PAUSE_MS
      scrollAnimRef.current = null
    }
    scroller.addEventListener('wheel', pause, { passive: true })
    scroller.addEventListener('touchmove', pause, { passive: true })
    return () => {
      scroller.removeEventListener('wheel', pause)
      scroller.removeEventListener('touchmove', pause)
    }
    // 空态时不渲染 scroll 容器，所以要在歌词到位后重新挂监听
  }, [lyrics.length])

  // 尺寸变化（窗口缩放 / 侧栏折叠 / 移动端旋转）：行高与容器高都变，游标与居中都作废
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || lyrics.length === 0) return
    const reposition = () => {
      const lineEl = lineRefs.current[activeIdxRef.current]
      const cursor = cursorRef.current
      if (lineEl && cursor) {
        const centerY = lineEl.offsetTop + lineEl.offsetHeight / 2
        cursor.style.transform = `translate3d(0, ${Math.round(centerY)}px, 0) translateY(-50%)`
      }
      const activeLine = lineRefs.current[activeIdxRef.current]
      if (!activeLine || performance.now() < userScrollUntilRef.current) return
      const target = activeLine.offsetTop + activeLine.offsetHeight / 2 - scroller.clientHeight / 2
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      scroller.scrollTop = Math.min(max, Math.max(0, target))
    }
    const observer = new ResizeObserver(reposition)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [lyrics.length])

  // 报告「有没有歌词」给父级（全屏播放页据此决定歌词区是否占满剩余高度）。
  // loading 期间按「有」上报：加载完成通常只在百毫秒内，若此刻先按空态排一次，
  // 歌词到位后整页会立刻跳一下
  const hasLyrics = loading || lyrics.length > 0
  useEffect(() => {
    onHasLyricsChange?.(hasLyrics)
  }, [hasLyrics, onHasLyricsChange])

  // 上下渐隐带宽度：按行高给固定像素而非百分比——百分比在矮容器里会偏大，
  // 把刚滚进来的整行一起吃掉，再叠加非当前行自身的不透明度，顶部歌词会淡成读不出的残影
  const fade = large ? 56 : 44
  // 渐隐必须挂在**不滚动**的外层：挂在滚动元素上时，每一帧滚动都要按新位置重新
  // 合成一次整块蒙版（低端机上这是实打实的掉帧点）。外层固定，内容在它下面滚，
  // 蒙版结果全程不变，只做一次合成。
  const maskStyle = {
    maskImage: `linear-gradient(to bottom, transparent 0, black ${fade}px, black calc(100% - ${fade}px), transparent 100%)`,
    WebkitMaskImage: `linear-gradient(to bottom, transparent 0, black ${fade}px, black calc(100% - ${fade}px), transparent 100%)`,
  } as React.CSSProperties

  return (
    <div className={cn('relative h-full', className)} style={maskStyle}>
      {lyrics.length === 0 ? (
        // 空态给出图标 + 文案两档：全屏播放页里这一段是画面下半区的唯一内容，
        // 只留一行 14px 灰字会显得「什么都没加载出来」而不是「这首歌没有歌词」
        // ⚠️ 透明度落在浅色主题可读性分档（/30）上，见 globals.css
        <div className="flex h-full flex-col items-center justify-center gap-2.5 px-4 text-center">
          <Music2
            aria-hidden
            className={cn('text-white/30', large ? 'h-7 w-7' : 'h-6 w-6')}
            strokeWidth={1.4}
          />
          <p className={cn('text-white/30', large ? 'text-[15px]' : 'text-[13px]')}>
            {loading ? t('player.lyrics.searching') : t('player.lyrics.empty')}
          </p>
        </div>
      ) : (
        <div
          ref={scrollerRef}
          // h-full：撑满父级分配的高度，确保容器自身可滚动（桌面右栏父级无 overflow-hidden，
          // 缺省高度会撑成内容高度导致滚动失效、当前行无法居中）
          // before 仅留小段顶部留白：歌曲开头歌词从顶部自然起排，避免「首行强制居中」导致上半区大片空白；
          // 当前行超过中线后滚动逻辑自动接管居中（前几行居中目标为负值，被 clamp 到 0）
          // after 50% 占位：保证末行也能滚动到区域正中央
          className={cn(
            'relative h-full overflow-y-auto scrollbar-hide px-4 text-center',
            // ⚠️ 段间距必须大于行内行距（leading-[1.5]）：窄栏 28px vs 21px、
            // 宽栏 36px vs 24px。否则折行后「同一句的两半」和「相邻两句」间距接近，
            // 语义分组消失、整块糊成文字墙（详见 globals.css 的歌词段注释）
            large ? 'space-y-9' : 'space-y-7',
            'before:block before:h-16 before:content-[""] after:block after:h-1/2 after:content-[""]'
          )}
        >
          {/* 当前行游标：绝对定位在左内边距里，只动 transform，永不参与文字排版 */}
          <div ref={cursorRef} className="lyric-cursor" aria-hidden>
            <AudioLines className="h-[13px] w-[13px]" strokeWidth={2.2} />
          </div>

          {lyrics.map((line, idx) => {
            const isActive = idx === activeIdx
            const distance = Math.abs(idx - activeIdx)
            // 非当前行按与当前行的距离分三级透明度。activeIdx < 0（前奏，还没进入第一句）
            // 时没有聚焦行，统一走中档——否则整块歌词会一起落到最远档，看上去像没有歌词。
            // ⚠️ 透明度取值必须落在 globals.css 浅色主题可读性分档里（/45 /55 /70），
            // 否则浅底上会退化成对比度不足的浅灰墨
            const idleTone =
              activeIdx < 0
                ? 'text-white/55'
                : distance === 1
                  ? 'text-white/70'
                  : distance === 2
                    ? 'text-white/55'
                    : 'text-white/45'
            return (
              <p
                key={`${line.time}-${idx}`}
                ref={(el) => {
                  lineRefs.current[idx] = el
                }}
                aria-current={isActive ? 'true' : undefined}
                className={cn(
                  // lyric-line 提供 text-wrap:balance，把折行断点摊平，避免把词劈成两半
                  // ⚠️ 不能写 transition-all：它会把 font-size 也纳入过渡，切行时字号在
                  // 14 ↔ 17px 之间插值数百毫秒，全程按非整数 px 渲染（实测字形边缘明显发毛），
                  // 且逐帧触发布局重排——「跟着歌词变糊」就是这么来的。
                  // 只过渡颜色与发光滤镜，字号瞬时切换，文字始终按整数 px 光栅化。
                  'lyric-line cursor-pointer leading-[1.5] transition-[color,filter] duration-300 ease-apple',
                  isActive
                    ? cn('lyric-active', large && 'lyric-active-lg')
                    : cn(idleTone, large ? 'text-[16px]' : 'text-[14px]')
                )}
                onClick={() => onLineClick?.(line.time)}
              >
                {isActive ? (
                  // 填充单元：增强 LRC 逐词元、普通 LRC 按字/词摊（见 lib/lyricFill）。
                  // 每个单元一个 span，各自按 plan 里的区间点亮，折行也不会断。
                  buildFillPlan(line, lyricLineWindow(lyrics, idx).end).tokens.map((token, tokenIdx) => (
                    <span key={tokenIdx} data-lyric-fill className="lyric-word">
                      {token}
                    </span>
                  ))
                ) : (
                  line.text
                )}
              </p>
            )
          })}
        </div>
      )}
    </div>
  )
}
