import { Howl, Howler } from 'howler'
import type { Track } from '@/types'
import { usePlayerStore } from '@/stores/playerStore'

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
  tickInterval = setInterval(() => {
    const progress = howl.seek() as number
    if (typeof progress === 'number' && !isNaN(progress)) {
      usePlayerStore.getState().setProgress(progress)
    }
  }, 250)
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

export function playTrack(track: Track): void {
  const state = usePlayerStore.getState()

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
    volume: state.muted ? 0 : state.volume,
    onplay: () => {
      usePlayerStore.getState().setIsPlaying(true)
      if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume()
      }
      startTick(howl)
    },
    onpause: () => {
      usePlayerStore.getState().setIsPlaying(false)
      stopTick()
    },
    onstop: () => {
      usePlayerStore.getState().setIsPlaying(false)
      usePlayerStore.getState().setProgress(0)
      stopTick()
    },
    onend: () => {
      stopTick()
      usePlayerStore.getState().next()
    },
    onload: () => {
      const dur = howl.duration()
      usePlayerStore.getState().setDuration(dur)
    },
    onloaderror: (_id, error) => {
      console.error('Audio load error:', error)
    },
    onplayerror: (_id, error) => {
      console.error('Audio play error:', error)
      howl.once('unlock', () => howl.play())
    },
  })

  currentHowl = howl
  usePlayerStore.setState({ currentTrack: track, duration: 0, progress: 0 })

  howl.play()

  connectAnalyser(howl)
}

export function playQueue(queue: Track[], startIndex: number = 0): void {
  const track = queue[startIndex]
  if (!track) return
  usePlayerStore.setState({ queue, currentIndex: startIndex })
  playTrack(track)
}

export function addToQueue(track: Track): void {
  const { queue } = usePlayerStore.getState()
  const newQueue = [...queue, track]
  usePlayerStore.setState({ queue: newQueue })
}

export function playNextAdd(track: Track): void {
  const { queue, currentIndex } = usePlayerStore.getState()
  const insertAt = currentIndex < 0 ? 0 : currentIndex + 1
  const newQueue = [...queue.slice(0, insertAt), track, ...queue.slice(insertAt)]
  usePlayerStore.setState({ queue: newQueue })
}

export function clearQueue(): void {
  stopPlayback()
  usePlayerStore.setState({ queue: [], currentIndex: -1, currentTrack: null })
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
    usePlayerStore.getState().setProgress(seconds)
  }
}

export function setVolume(volume: number): void {
  if (currentHowl) {
    currentHowl.volume(volume)
  }
  Howler.volume(1)
}

export function setMuted(muted: boolean): void {
  const { volume } = usePlayerStore.getState()
  if (currentHowl) {
    currentHowl.volume(muted ? 0 : volume)
  }
}

export function togglePlayPause(): void {
  const { isPlaying } = usePlayerStore.getState()
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
