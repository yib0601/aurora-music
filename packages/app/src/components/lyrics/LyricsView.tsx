import React, { useEffect, useRef, useState } from 'react'
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

  useEffect(() => {
    const text = lyricsText || sampleLyrics
    setLyrics(parseLRC(text))
  }, [lyricsText])

  useEffect(() => {
    if (lyrics.length === 0) return
    const activeIdx = findActiveLine(lyrics, progress)
    activeLineRef.current = activeIdx

    if (containerRef.current && activeIdx >= 0) {
      const activeEl = containerRef.current.children[activeIdx] as HTMLElement
      if (activeEl) {
        const container = containerRef.current
        const containerH = container.clientHeight
        const elTop = activeEl.offsetTop
        const elH = activeEl.offsetHeight
        container.scrollTo({
          top: elTop - containerH / 2 + elH / 2,
          behavior: isPlaying ? 'smooth' : 'auto',
        })
      }
    }
  }, [progress, lyrics, isPlaying])

  const activeIdx = lyrics.length > 0 ? findActiveLine(lyrics, progress) : -1

  return (
    <div
      ref={containerRef}
      className={cn('overflow-y-auto scrollbar-hide px-4 py-8 space-y-5 text-center', className)}
      style={{ maskImage: 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)' }}
    >
      {lyrics.map((line, idx) => (
        <p
          key={`${line.time}-${idx}`}
          className={cn(
            'transition-all duration-500 cursor-pointer leading-relaxed',
            idx === activeIdx
              ? 'text-foreground text-lg font-semibold scale-105'
              : Math.abs(idx - activeIdx) <= 2
              ? 'text-foreground/55 text-base'
              : 'text-foreground/30 text-sm'
          )}
          onClick={() => onLineClick?.(line.time)}
        >
          {line.text}
        </p>
      ))}
    </div>
  )
}
