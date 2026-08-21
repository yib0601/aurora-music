import React, { useEffect, useRef, useState, useMemo } from 'react'
import type { LyricLine } from '@/types'
import { parseLRC, findActiveLine, loadLyricsForTrack } from '@/services/lyrics.service'
import { usePlayerStore } from '@/stores/playerStore'
import { cn } from '@/lib/utils'

interface LyricsViewProps {
  lyricsText?: string
  className?: string
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

export function LyricsView({ lyricsText, className, onLineClick }: LyricsViewProps) {
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

  return (
    <div
      ref={containerRef}
      className={cn('overflow-y-auto scrollbar-hide px-4 py-8 space-y-6 text-center', className)}
      style={{ maskImage: 'linear-gradient(to bottom, transparent, black 12%, black 88%, transparent)' }}
    >
      {lyrics.length === 0 && (
        <p className="text-white/20 text-[15px] pt-20">{loading ? '搜索歌词中...' : '暂无歌词'}</p>
      )}
      {lyrics.map((line, idx) => {
        const distance = Math.abs(idx - activeIdx)
        return (
          <p
            key={`${line.time}-${idx}`}
            className={cn(
              'transition-all duration-500 ease-apple cursor-pointer leading-relaxed',
              idx === activeIdx
                ? 'lyric-active'
                : distance <= 2
                ? 'text-white/50 text-[15px]'
                : 'text-white/28 text-[13px]'
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
