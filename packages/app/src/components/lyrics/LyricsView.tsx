import React, { useEffect, useRef, useState, useMemo } from 'react'
import type { LyricLine } from '@/types'
import { parseLRC, findActiveLine } from '@/services/lyrics.service'
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
  const containerRef = useRef<HTMLDivElement>(null)

  const [lyrics, setLyrics] = useState<LyricLine[]>([])
  const activeLineRef = useRef<number>(-1)
  const lastScrollRef = useRef<number>(0)

  useEffect(() => {
    if (!lyricsText) {
      setLyrics([])
      return
    }
    setLyrics(parseLRC(lyricsText))
  }, [lyricsText])

  // ⚠️ 性能：单次计算 activeIdx，避免重复调用 findActiveLine
  const activeIdx = useMemo(
    () => (lyrics.length > 0 ? findActiveLine(lyrics, progress) : -1),
    [lyrics, progress]
  )

  // ⚠️ 性能：节流滚动到 ~10fps，避免每个 progress tick（4fps）触发 smooth scroll 重排
  useEffect(() => {
    if (lyrics.length === 0 || activeIdx < 0) return
    if (activeLineRef.current === activeIdx) return
    activeLineRef.current = activeIdx

    const now = performance.now()
    if (now - lastScrollRef.current < 100) return
    lastScrollRef.current = now

    const container = containerRef.current
    if (!container) return
    const activeEl = container.children[activeIdx] as HTMLElement | undefined
    if (!activeEl) return

    const containerH = container.clientHeight
    const elTop = activeEl.offsetTop
    const elH = activeEl.offsetHeight
    container.scrollTo({
      top: elTop - containerH / 2 + elH / 2,
      behavior: isPlaying ? 'smooth' : 'auto',
    })
  }, [activeIdx, lyrics, isPlaying])

  return (
    <div
      ref={containerRef}
      className={cn('overflow-y-auto scrollbar-hide px-4 py-8 space-y-6 text-center', className)}
      style={{ maskImage: 'linear-gradient(to bottom, transparent, black 12%, black 88%, transparent)' }}
    >
      {lyrics.length === 0 && (
        <p className="text-white/20 text-[15px] pt-20">暂无歌词</p>
      )}
      {lyrics.map((line, idx) => {
        const distance = Math.abs(idx - activeIdx)
        return (
          <p
            key={`${line.time}-${idx}`}
            className={cn(
              'transition-all duration-500 ease-apple cursor-pointer leading-relaxed',
              idx === activeIdx
                ? 'text-white text-[17px] font-semibold scale-105 [text-shadow:0_0_14px_rgba(168,246,255,.38),0_0_36px_rgba(143,233,255,.30)] [background:linear-gradient(180deg,rgba(246,253,255,1)_0%,rgba(168,246,255,1)_55%,rgba(126,205,255,1)_100%)] [-webkit-background-clip:text] [-webkit-text-fill-color:transparent]'
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
