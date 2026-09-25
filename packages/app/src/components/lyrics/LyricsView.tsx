import React, { useEffect, useRef, useState, useMemo } from 'react'
import type { LyricLine } from '@/types'
import { parseLRC, findActiveLine, loadLyricsForTrack } from '@/services/lyrics.service'
import { usePlayerStore } from '@/stores/playerStore'
import { cn } from '@/lib/utils'

interface LyricsViewProps {
  lyricsText?: string
  className?: string
  /** 大字号模式：详情页全屏场景下放大歌词行，避免宽屏显得空旷 */
  large?: boolean
  onLineClick?: (time: number) => void
}

const sampleLyrics = `[00:00.00]Aurora Music
[00:03.00]优雅的音乐播放器
[00:06.00]
[00:10.00]点击歌曲开始播放
[00:14.00]歌词将在此处同步显示
[00:18.00]
[00:22.00]享受音乐，享受生活
`

export function LyricsView({ lyricsText, className, large, onLineClick }: LyricsViewProps) {
  const progress = usePlayerStore((s) => s.progress)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const containerRef = useRef<HTMLDivElement>(null)

  const [lyrics, setLyrics] = useState<LyricLine[]>([])
  const [loadedLyrics, setLoadedLyrics] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const activeLineRef = useRef<number>(-2)
  const lastScrollRef = useRef<number>(0)

  useEffect(() => {
    if (!currentTrack) {
      setLoadedLyrics('')
      return
    }
    // 如果外部传了 lyricsText 优先用外部的
    if (lyricsText) {
      setLoadedLyrics(lyricsText)
      return
    }
    setLoading(true)
    loadLyricsForTrack(currentTrack)
      .then((lrc) => setLoadedLyrics(lrc || ''))
      .finally(() => setLoading(false))
  }, [currentTrack, lyricsText])

  useEffect(() => {
    if (!loadedLyrics) {
      setLyrics([])
      return
    }
    // 歌词变化（切歌）时重置滚动跟踪，确保新歌重新定位
    activeLineRef.current = -2
    setLyrics(parseLRC(loadedLyrics))
  }, [loadedLyrics])

  // ⚠️ 性能：单次计算 activeIdx，避免重复调用 findActiveLine
  const activeIdx = useMemo(
    () => (lyrics.length > 0 ? findActiveLine(lyrics, progress) : -1),
    [lyrics, progress]
  )

  const scrollTimerRef = useRef<number | null>(null)

  // ⚠️ 性能：节流滚动到 ~10fps，避免每个 progress tick（4fps）触发 smooth scroll 重排；
  // 节流窗口内的变化延迟补滚，确保滚动最终与高亮行一致
  useEffect(() => {
    if (lyrics.length === 0 || activeIdx < 0) return
    if (activeLineRef.current === activeIdx) return
    activeLineRef.current = activeIdx

    const doScroll = () => {
      scrollTimerRef.current = null
      lastScrollRef.current = performance.now()
      const container = containerRef.current
      if (!container) return
      const activeEl = container.children[activeLineRef.current] as HTMLElement | undefined
      if (!activeEl) return

      // 用视口矩形计算相对滚动容器的位置：
      // offsetTop 相对 offsetParent（移动端 fixed 全屏层会干扰），导致滚动偏移
      const containerRect = container.getBoundingClientRect()
      const elRect = activeEl.getBoundingClientRect()
      const elTop = elRect.top - containerRect.top + container.scrollTop

      container.scrollTo({
        top: elTop - container.clientHeight / 2 + elRect.height / 2,
        behavior: isPlaying ? 'smooth' : 'auto',
      })
    }

    const elapsed = performance.now() - lastScrollRef.current
    if (elapsed >= 100) {
      if (scrollTimerRef.current != null) {
        window.clearTimeout(scrollTimerRef.current)
        scrollTimerRef.current = null
      }
      doScroll()
    } else if (scrollTimerRef.current == null) {
      // 节流窗口内：合并为一次延迟补滚，不丢失滚动目标
      scrollTimerRef.current = window.setTimeout(doScroll, 100 - elapsed)
    }
  }, [activeIdx, lyrics, isPlaying])

  // 卸载时清理延迟滚动定时器
  useEffect(() => {
    return () => {
      if (scrollTimerRef.current != null) window.clearTimeout(scrollTimerRef.current)
    }
  }, [])

  // 上下渐隐带宽度：按行高给固定像素而非百分比——百分比在矮容器里会偏大，
  // 把刚滚进来的整行一起吃掉，再叠加非当前行自身的不透明度，顶部歌词会淡成读不出的残影
  const fade = large ? 52 : 40

  return (
    <div
      ref={containerRef}
      // h-full：撑满父级分配的高度，确保容器自身可滚动（桌面右栏父级无 overflow-hidden，
      // 缺省高度会撑成内容高度导致 scrollTo 失效、当前行无法居中）
      // before 仅留小段顶部留白：歌曲开头歌词从顶部自然起排，避免「首行强制居中」导致上半区大片空白；
      // 当前行超过中线后滚动逻辑自动接管居中（前几行居中目标为负值，被 clamp 到 0）
      // after 50% 占位：保证末行也能滚动到区域正中央
      // （伪元素不计入 container.children，不影响按索引定位歌词行）
      className={cn(
        'h-full overflow-y-auto scrollbar-hide px-4 text-center',
        lyrics.length === 0
          // 空态（暂无歌词/搜索中）：去掉上下占位伪元素，提示垂直居中
          ? 'flex items-center justify-center'
          : cn(
              // ⚠️ 段间距必须大于行内行距（leading-[1.5]）：窄栏 28px vs 19.5px、
              // 宽栏 36px vs 24px。否则折行后「同一句的两半」和「相邻两句」间距接近，
              // 语义分组消失、整块糊成文字墙（详见 globals.css 的歌词段注释）
              large ? 'space-y-9' : 'space-y-7',
              'before:block before:h-16 before:content-[""] after:block after:h-1/2 after:content-[""]'
            ),
        className
      )}
      style={{
        maskImage: `linear-gradient(to bottom, transparent 0, black ${fade}px, black calc(100% - ${fade}px), transparent 100%)`,
      }}
    >
      {lyrics.length === 0 && (
        <p className={cn('text-white/25', large ? 'text-[16px]' : 'text-[14px]')}>
          {loading ? '搜索歌词中...' : '暂无歌词'}
        </p>
      )}
      {lyrics.map((line, idx) => {
        const distance = Math.abs(idx - activeIdx)
        // 非当前行按与当前行的距离分三级透明度。原先近行 14px / 远行 13px 只差 1px
        // 且颜色完全相同，肉眼分不出，却让每行宽度不一致、破坏左右边缘的节奏感。
        // activeIdx < 0（前奏，还没进入第一句）时没有聚焦行，统一走中档——
        // 否则整块歌词会一起落到最远档，看上去像没有歌词。
        // ⚠️ 透明度取值必须落在 globals.css 浅色主题可读性分档里（/30 /35 /40 /45 /50 /55
        // /60 /70），否则浅底上会退化成对比度不足的浅灰墨
        const idleTone =
          activeIdx < 0
            ? 'text-white/50'
            : distance === 1
            ? 'text-white/70'
            : distance === 2
            ? 'text-white/50'
            : 'text-white/40'
        return (
          <p
            key={`${line.time}-${idx}`}
            className={cn(
              // lyric-line 提供 text-wrap:balance，把折行断点摊平，避免把词劈成两半
              // ⚠️ 不能写 transition-all：它会把 font-size 也纳入过渡，切行时字号在
              // 13 ↔ 16px 之间插值数百毫秒，全程按非整数 px 渲染（实测 14.5px 字形边缘
              // 明显发毛），且逐帧触发布局重排——「跟着歌词变糊」就是这么来的。
              // 只过渡颜色与发光滤镜，字号瞬时切换，文字始终按整数 px 光栅化。
              'lyric-line transition-[color,filter] duration-300 ease-apple cursor-pointer leading-[1.5]',
              idx === activeIdx
                ? cn('lyric-active', large && 'lyric-active-lg')
                : cn(idleTone, large ? 'text-[16px]' : 'text-[13px]')
            )}
            onClick={() => onLineClick?.(line.time)}
          >
            {line.text}
          </p>
        )
      })}
    </div>
  )
}
