import type { LyricLine } from '@/types'

export function parseLRC(content: string): LyricLine[] {
  const lines = content.split(/\r?\n/)
  const result: LyricLine[] = []

  const timeTagRegex = /\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g

  for (const line of lines) {
    const matches = [...line.matchAll(timeTagRegex)]
    if (matches.length === 0) continue

    const text = line.replace(timeTagRegex, '').trim()
    if (!text) continue

    for (const match of matches) {
      const minutes = parseInt(match[1], 10)
      const seconds = parseInt(match[2], 10)
      const millisStr = match[3] || '0'
      const millis = parseInt(millisStr.padEnd(3, '0').slice(0, 3), 10)
      const time = minutes * 60 + seconds + millis / 1000
      result.push({ time, text })
    }
  }

  result.sort((a, b) => a.time - b.time)
  return result
}

export function findActiveLine(lines: LyricLine[], currentTime: number): number {
  if (lines.length === 0) return -1

  let left = 0
  let right = lines.length - 1
  let result = -1

  while (left <= right) {
    const mid = Math.floor((left + right) / 2)
    if (lines[mid].time <= currentTime) {
      result = mid
      left = mid + 1
    } else {
      right = mid - 1
    }
  }

  return result
}

export function formatLyricTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
