import { Howl, Howler } from 'howler'
import type { Track } from '@/types'
import { audioEvents } from './audioEvents'

let tickInterval: ReturnType<typeof setInterval> | null = null
let currentHowl: Howl | null = null
let audioContext: AudioContext | null = null
let analyserNode: AnalyserNode | null = null

function getPlatformSrc(path: string): string {
  const cap = (window as any).Capacitor
  if (cap) {
    return cap.convertFileSrc(path)
  }
  if ((window as any).electronAPI) {
    return `file://${path}`
  }
  return path
}

function startTick(howl: Howl) {
  if (tickInterval) clearInterval(tickInterval)
  // ⚠️ 性能：500ms 足够进度条显示，过高频率会触发 LyricsView/PlayerBar 频繁更新
  tickInterval = setInterval(() => {
    const progress = howl.seek() as number
    if (typeof progress === 'number' && !isNaN(progress)) {
      audioEvents.emit('progress', { currentTime: progress })
    }
  }, 500)
}

function stopTick() {
  if (tickInterval) {
    clearInterval(tickInterval)
    tickInterval = null
  }
}

export function initAudioAnalyser(): AnalyserNode | null {
  try {
    const AC = window.AudioContext || (window as any).webkitAudioContext
    if (!AC) return null

    if (!audioContext) {
      audioContext = new AC()
      analyserNode = audioContext.createAnalyser()
      analyserNode.fftSize = 2048
      analyserNode.smoothingTimeConstant = 0.8
      analyserNode.connect(audioContext.destination)
    }
    return analyserNode
  } catch {
    return null
  }
}

export function getAnalyser(): AnalyserNode | null {
  return analyserNode
}

export function playTrack(track: Track, volume: number = 0.7, muted: boolean = false): void {
  if (currentHowl) {
    currentHowl.unload()
    currentHowl = null
  }
  stopTick()

  const src = getPlatformSrc(track.path)

  const howl = new Howl({
    src: [src],
    html5: true,
    format: detectFormat(track.path),
    volume: muted ? 0 : volume,
    onplay: () => {
      audioEvents.emit('play', { track })
      if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume()
      }
      startTick(howl)
    },
    onpause: () => {
      audioEvents.emit('pause', {})
      stopTick()
    },
    onstop: () => {
      audioEvents.emit('stop', {})
      stopTick()
    },
    onend: () => {
      stopTick()
      audioEvents.emit('end', {})
    },
    onload: () => {
      const dur = howl.duration()
      audioEvents.emit('duration', { duration: dur })
    },
    onloaderror: (_id, error) => {
      console.error('Audio load error:', error)
      audioEvents.emit('error', { error })
    },
    onplayerror: (_id, error) => {
      console.error('Audio play error:', error)
      howl.once('unlock', () => howl.play())
    },
  })

  currentHowl = howl
  audioEvents.emit('trackChange', { track })

  howl.play()

  connectAnalyser(howl)
}

function connectAnalyser(howl: Howl) {
  if (!analyserNode) {
    initAudioAnalyser()
  }
  if (!analyserNode || !audioContext) return

  try {
    const audioEl = (howl as any)._sounds?.[0]?._node
    if (audioEl && audioEl instanceof HTMLMediaElement) {
      const source = audioContext.createMediaElementSource(audioEl)
      source.connect(analyserNode)
    }
  } catch (e) {
    console.warn('Analyser connection failed:', e)
  }
}

export function pausePlayback(): void {
  if (currentHowl && currentHowl.playing()) {
    currentHowl.pause()
  }
}

export function resumePlayback(): void {
  if (currentHowl) {
    currentHowl.play()
  }
}

export function seekTo(seconds: number): void {
  if (currentHowl) {
    currentHowl.seek(seconds)
    audioEvents.emit('progress', { currentTime: seconds })
  }
}

export function setVolume(volume: number): void {
  if (currentHowl) {
    currentHowl.volume(volume)
  }
}

export function setMuted(muted: boolean, volume: number = 0.7): void {
  if (currentHowl) {
    currentHowl.volume(muted ? 0 : volume)
  }
}

export function togglePlayPause(isPlaying: boolean): void {
  if (isPlaying) {
    pausePlayback()
  } else {
    resumePlayback()
  }
}

export function stopPlayback(): void {
  if (currentHowl) {
    currentHowl.stop()
    currentHowl.unload()
    currentHowl = null
  }
  stopTick()
}

function detectFormat(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase()
  if (!ext) return undefined
  const map: Record<string, string> = {
    mp3: 'mp3',
    flac: 'flac',
    m4a: 'mp4',
    aac: 'aac',
    ogg: 'ogg',
    wav: 'wav',
    wma: 'wma',
  }
  return map[ext]
}

export function cleanupAudio(): void {
  stopPlayback()
  if (audioContext) {
    audioContext.close()
    audioContext = null
    analyserNode = null
  }
}
